import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkDraftFiles,
  collectDraftFile,
  extractDraftText,
  fetchActiveRawDrafts,
  fetchDrafts,
  findActiveDraft,
  loadActiveDraft,
  findDraftById,
  findDraftForDestination,
  isScheduledDraft,
  MAX_DRAFT_FILES,
  parseDraftLimit,
  projectDraft,
  sendDraft,
  uploadDraftFiles,
  validateSendableDraft,
} from './drafts.ts';
import type { SlackDraft, SlackDraftListResponse } from '../types/index.ts';

describe('parseDraftLimit', () => {
  it('accepts positive integers', () => {
    expect(parseDraftLimit('1')).toBe(1);
    expect(parseDraftLimit('100')).toBe(100);
  });

  it('rejects zero, negatives, decimals, trailing junk, and unsafe integers', () => {
    for (const value of ['0', '-1', '1.5', '10drafts', 'abc', '9007199254740992']) {
      expect(() => parseDraftLimit(value)).toThrow('--limit must be a positive integer');
    }
  });
});

describe('extractDraftText', () => {
  it('projects formatted text, emoji, links, and mentions without exposing raw blocks', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'emoji', name: 'wave' },
          { type: 'text', text: ' — ' },
          { type: 'link', text: 'runbook', url: 'https://example.com/runbook' },
          { type: 'text', text: ' ' },
          { type: 'user', user_id: 'U123' },
          { type: 'text', text: ' in ' },
          { type: 'channel', channel_id: 'C123' },
          { type: 'text', text: ' ' },
          { type: 'usergroup', usergroup_id: 'S123' },
          { type: 'text', text: ' ' },
          { type: 'broadcast', range: 'here' },
        ],
      }],
    }]);

    expect(text).toBe(
      'Hello :wave: — runbook <@U123> in <#C123> <!subteam^S123> <!here>',
    );
  });

  it('uses a link URL without a label and separates list items and blocks with newlines', () => {
    const text = extractDraftText([
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_list',
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'First' }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Second' }] },
          ],
        }],
      },
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'link', url: 'https://example.com' }],
        }],
      },
    ]);

    expect(text).toBe('First\nSecond\nhttps://example.com');
  });

  it('keeps fallback text from date and unfamiliar future elements', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'date', fallback: 'Sep 21' },
          { type: 'future_element', text: ' preserved' },
        ],
      }],
    }]);

    expect(text).toBe('Sep 21 preserved');
  });

  it('degrades malformed leaf elements the same way as before, without throwing', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 42 },
          { type: 'emoji', name: null },
          { type: 'link' },
          // Missing ids fall through to the element's own text.
          { type: 'channel', text: '#general' },
          { type: 'user', text: ' @someone' },
          { type: 'date', text: ' tomorrow' },
          // Type names that are Object.prototype keys are not renderers.
          { type: 'toString', text: ' kept' },
          { type: 'constructor' },
          'not an element',
          null,
        ],
      }],
    }]);

    expect(text).toBe('#general @someone tomorrow kept');
  });
});

describe('projectDraft', () => {
  it('produces the approved stable projection and omits unset optional fields', () => {
    expect(projectDraft({
      id: 'Dr123',
      date_created: 1700000000,
      date_scheduled: 0,
      destinations: [{ channel_id: 'C123' }],
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Deploy later' }],
        }],
      }],
    })).toEqual({
      draft_id: 'Dr123',
      channel_id: 'C123',
      text: 'Deploy later',
      date_created: 1700000000,
      file_ids: [],
    });
  });

  it('includes thread, schedule, and file fields when present', () => {
    expect(projectDraft({
      id: 'Dr456',
      date_created: 1700000000,
      date_scheduled: 1700003600,
      destinations: [{ channel_id: 'C456', thread_ts: '1699999999.000100' }],
      file_ids: ['F1', 'F2'],
    })).toEqual({
      draft_id: 'Dr456',
      channel_id: 'C456',
      text: '',
      date_created: 1700000000,
      file_ids: ['F1', 'F2'],
      thread_ts: '1699999999.000100',
      date_scheduled: 1700003600,
    });
  });

  it('fails clearly when Slack omits a required projected field', () => {
    expect(() => projectDraft({
      date_created: 1700000000,
      destinations: [{ channel_id: 'C123' }],
    })).toThrow('without an id');
    expect(() => projectDraft({ id: 'Dr123', date_created: 1700000000 }))
      .toThrow('without a channel destination');
    expect(() => projectDraft({ id: 'Dr123', destinations: [{ channel_id: 'C123' }] }))
      .toThrow('without a creation date');
  });
});

describe('fetchDrafts', () => {
  it('passes the limit, filters inactive entries, projects fields, and reports progress', async () => {
    const calls: unknown[] = [];
    const progress: string[] = [];
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [
        {
          id: 'DrActive',
          date_created: 1700000000,
          destinations: [{ channel_id: 'C1' }],
          blocks: [],
        },
        {
          id: 'DrDeleted',
          date_created: 1700000001,
          destinations: [{ channel_id: 'C2' }],
          is_deleted: true,
        },
        {
          id: 'DrSent',
          date_created: 1700000002,
          destinations: [{ channel_id: 'C3' }],
          is_sent: true,
        },
      ],
    };
    const client = {
      listDrafts: async (options: { limit?: number }) => {
        calls.push(options);
        return response;
      },
    };

    const drafts = await fetchDrafts(client, {
      limit: 10,
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual([{ limit: 10 }]);
    expect(progress).toEqual(['Fetching active drafts...']);
    expect(drafts).toEqual([{
      draft_id: 'DrActive',
      channel_id: 'C1',
      text: '',
      date_created: 1700000000,
      file_ids: [],
    }]);
  });

  const listOf = (drafts: SlackDraftListResponse['drafts']) => ({
    listDrafts: async () => ({ ok: true, drafts }),
  });
  const active = (id: string, channel: string) => ({
    id,
    date_created: 1700000000,
    destinations: [{ channel_id: channel }],
  });

  it.each([
    ['no destinations', {}],
    ['an empty destinations array', { destinations: [] }],
    ['a destination with only user_ids', { destinations: [{ user_ids: ['U1'] }] }],
    ['an empty channel_id', { destinations: [{ channel_id: '' }] }],
  ])('skips a draft with %s and lists the others', async (_label, shape) => {
    const drafts = await fetchDrafts(listOf([
      active('DrBefore', 'C1'),
      { id: 'DrNoRecipient', date_created: 1700000001, ...shape } as SlackDraft,
      active('DrAfter', 'C2'),
    ]), { limit: 10 });

    expect(drafts.map((draft) => draft.draft_id)).toEqual(['DrBefore', 'DrAfter']);
  });

  it('applies the limit after skipping drafts with no recipient', async () => {
    const drafts = await fetchDrafts(listOf([
      { id: 'DrNoRecipient1', date_created: 1700000000 },
      active('Dr1', 'C1'),
      { id: 'DrNoRecipient2', date_created: 1700000000, destinations: [] },
      active('Dr2', 'C2'),
      active('Dr3', 'C3'),
    ]), { limit: 2 });

    expect(drafts.map((draft) => draft.draft_id)).toEqual(['Dr1', 'Dr2']);
  });

  it('still fails on a draft with a recipient but no id or creation date', async () => {
    await expect(fetchDrafts(listOf([
      active('Dr1', 'C1'),
      { destinations: [{ channel_id: 'C2' }], date_created: 1700000000 },
    ]), { limit: 10 })).rejects.toThrow('without an id');
    await expect(fetchDrafts(listOf([
      { id: 'DrUndated', destinations: [{ channel_id: 'C2' }] },
    ]), { limit: 10 })).rejects.toThrow('without a creation date');
  });

  it('returns an empty list when every active draft has no recipient', async () => {
    expect(await fetchDrafts(listOf([{ id: 'DrNoRecipient', date_created: 1700000000 }]), { limit: 10 }))
      .toEqual([]);
  });
});

const sendableDraft = {
  id: 'Dr123',
  destinations: [{ channel_id: 'C123', thread_ts: '1700000000.000001' }],
  blocks: [{
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [{ type: 'text', text: 'Reviewed *reply*', style: { bold: true } }],
    }],
  }],
};

describe('draft lifecycle', () => {
  it('finds only a matching active draft', () => {
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [{ ...sendableDraft, is_deleted: true }, { id: 'DrOther' }],
    };
    expect(() => findActiveDraft(response, 'Dr123')).toThrow('was not found');
    expect(findActiveDraft({ ok: true, drafts: [sendableDraft] }, 'Dr123')).toEqual(sendableDraft);
  });

  it('loads a requested draft and reports a truncated listing', async () => {
    const client = { listDrafts: async () => ({ ok: true, drafts: [], has_more: true }) };
    await expect(loadActiveDraft(client, 'DrMissing')).rejects.toThrow('first 1000 active drafts');
    await expect(loadActiveDraft(client, ' ')).rejects.toThrow('cannot be empty');
  });

  it('refuses scheduled, attached, multiple-destination, and empty drafts', () => {
    expect(() => validateSendableDraft({ ...sendableDraft, date_scheduled: 1700000100 }))
      .toThrow('Scheduled drafts');
    expect(() => validateSendableDraft({ ...sendableDraft, file_ids: ['F1'] }))
      .toThrow('file attachments');
    expect(() => validateSendableDraft({ ...sendableDraft, destinations: [{ channel_id: 'C1' }, { channel_id: 'C2' }] }))
      .toThrow('exactly one');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [] }))
      .toThrow('supported rich-text');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [{ type: 'rich_text', elements: [] }] }))
      .toThrow('no text');
  });

  it('accepts a DM destination carrying its recipient user id', () => {
    expect(validateSendableDraft({
      ...sendableDraft,
      destinations: [{ channel_id: 'D123', user_ids: ['U123'] }],
    }).channelId).toBe('D123');
  });

  it('posts the original blocks in the saved thread, then deletes and gets a link', async () => {
    const calls: unknown[] = [];
    const client = {
      postMessage: async (channel: string, text: string, options: unknown) => {
        calls.push(['post', channel, text, options]);
        return { ts: '1700000001.000002' };
      },
      deleteDraft: async (id: string) => { calls.push(['delete', id]); },
      getPermalink: async (channel: string, ts: string) => {
        calls.push(['link', channel, ts]);
        return { permalink: 'https://example.slack.com/archives/C123/p1700000001000002' };
      },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002',
      permalink: 'https://example.slack.com/archives/C123/p1700000001000002',
    });
    expect(calls).toEqual([
      ['post', 'C123', 'Reviewed *reply*', { thread_ts: '1700000000.000001', blocks: sendableDraft.blocks }],
      ['delete', 'Dr123'],
      ['link', 'C123', '1700000001.000002'],
    ]);
  });

  it('leaves the draft untouched when posting fails', async () => {
    let deleted = false;
    const client = {
      postMessage: async () => { throw new Error('post failed'); },
      deleteDraft: async () => { deleted = true; },
      getPermalink: async () => ({}),
    };
    await expect(sendDraft(client, 'Dr123', sendableDraft)).rejects.toThrow('post failed');
    expect(deleted).toBe(false);
  });

  it('returns the posted identity when cleanup fails, without inviting a duplicate retry', async () => {
    const client = {
      postMessage: async () => ({ ts: '1700000001.000002' }),
      deleteDraft: async () => { throw new Error('draft_has_conflict'); },
      getPermalink: async () => { throw new Error('link unavailable'); },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002', cleanup_error: 'draft_has_conflict',
    });
  });
});

describe('finding drafts to replace or delete', () => {
  const channelDraft = { id: 'DrChannel', last_updated_ts: '10.000000', destinations: [{ channel_id: 'C1' }] };
  const threadDraft = {
    id: 'DrThread',
    last_updated_ts: '20.000000',
    destinations: [{ channel_id: 'C1', thread_ts: '1.000000', broadcast: false }],
  };
  const otherChannel = { id: 'DrOther', last_updated_ts: '30.000000', destinations: [{ channel_id: 'C2' }] };
  const all = [channelDraft, threadDraft, otherChannel];

  it('matches a channel draft only when no thread is asked for, and a thread draft only for that thread', () => {
    expect(findDraftForDestination(all, 'C1')?.id).toBe('DrChannel');
    expect(findDraftForDestination(all, 'C1', '1.000000')?.id).toBe('DrThread');
    expect(findDraftForDestination(all, 'C1', '2.000000')).toBeUndefined();
    expect(findDraftForDestination(all, 'C3')).toBeUndefined();
  });

  it('takes the newest when Slack returns several for one destination', () => {
    const newer = { ...channelDraft, id: 'DrNewer', last_updated_ts: '99.000000' };

    expect(findDraftForDestination([channelDraft, newer], 'C1')?.id).toBe('DrNewer');
  });

  it('prefers the unscheduled draft of a destination over a scheduled one, even a newer one', () => {
    const scheduledNewer = { ...channelDraft, id: 'DrScheduled', last_updated_ts: '99.000000', date_scheduled: 4102444800 };

    expect(findDraftForDestination([channelDraft, scheduledNewer], 'C1')?.id).toBe('DrChannel');
    expect(findDraftForDestination([scheduledNewer, channelDraft], 'C1')?.id).toBe('DrChannel');
  });

  it('finds the scheduled draft when it is the only one, and treats a past send time as unscheduled', () => {
    const scheduled = { ...channelDraft, id: 'DrScheduled', date_scheduled: 4102444800 };
    const pastSchedule = { ...channelDraft, id: 'DrPast', last_updated_ts: '5.000000', date_scheduled: 1000 };

    expect(findDraftForDestination([scheduled], 'C1')?.id).toBe('DrScheduled');
    expect(findDraftForDestination([scheduled, pastSchedule], 'C1')?.id).toBe('DrPast');
    expect(isScheduledDraft(scheduled)).toBe(true);
    expect(isScheduledDraft(pastSchedule)).toBe(false);
    expect(isScheduledDraft(channelDraft)).toBe(false);
  });

  it('finds a draft by id', () => {
    expect(findDraftById(all, 'DrOther')?.id).toBe('DrOther');
    expect(findDraftById(all, 'Missing')).toBeUndefined();
  });

  it('keeps only still-unsent drafts, with the fields update and delete need', async () => {
    const client = {
      listDrafts: async () => ({
        ok: true,
        drafts: [
          channelDraft,
          { ...threadDraft, id: 'DrDeleted', is_deleted: true },
          { ...otherChannel, id: 'DrSent', is_sent: true },
        ],
      }),
    };

    const drafts = await fetchActiveRawDrafts(client);

    expect(drafts.map((draft) => draft.id)).toEqual(['DrChannel']);
    expect(drafts[0]?.last_updated_ts).toBe('10.000000');
  });
});

describe('draft attachments', () => {
  async function withFiles<T>(names: string[], run: (paths: string[]) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-files-'));
    try {
      const paths = [];
      for (const name of names) {
        const path = join(dir, name);
        await Bun.write(path, `bytes of ${name}`);
        paths.push(path);
      }
      return await run(paths);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('collects a repeated --file in the order given', () => {
    expect(collectDraftFile('b.png', collectDraftFile('a.png', []))).toEqual(['a.png', 'b.png']);
    expect(collectDraftFile('a.png')).toEqual(['a.png']);
  });

  it('accepts no files, and reports each file name and size', async () => {
    expect(await checkDraftFiles()).toEqual([]);
    await withFiles(['one.png'], async ([path]) => {
      expect(await checkDraftFiles([path!])).toEqual([{ path, filename: 'one.png', size: 'bytes of one.png'.length }]);
    });
  });

  it('refuses more than the Slack limit before touching any file', async () => {
    const paths = Array.from({ length: MAX_DRAFT_FILES + 1 }, (_, index) => `/tmp/slackcli-missing-${index}.png`);
    await expect(checkDraftFiles(paths)).rejects.toThrow(`at most ${MAX_DRAFT_FILES} files`);
  });

  it('refuses the same path twice', async () => {
    await withFiles(['one.png'], async ([path]) => {
      await expect(checkDraftFiles([path!, path!])).rejects.toThrow('given twice');
    });
  });

  it('refuses a missing or empty file', async () => {
    await expect(checkDraftFiles(['/tmp/slackcli-missing-file.png'])).rejects.toThrow('File not found');
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-empty-'));
    try {
      const empty = join(dir, 'empty.png');
      await Bun.write(empty, '');
      await expect(checkDraftFiles([empty])).rejects.toThrow('empty file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uploads in the order given and returns the ids in that order', async () => {
    await withFiles(['a.png', 'b.png', 'c.png'], async (paths) => {
      const uploaded: string[] = [];
      const progress: string[] = [];
      const client = {
        uploadFileForDraft: async (path: string) => {
          uploaded.push(path);
          return `F${uploaded.length}`;
        },
      };

      const ids = await uploadDraftFiles(client, paths, { onProgress: (message) => progress.push(message) });

      expect(ids).toEqual(['F1', 'F2', 'F3']);
      expect(uploaded).toEqual(paths);
      expect(progress).toEqual(['Uploading file 1 of 3...', 'Uploading file 2 of 3...', 'Uploading file 3 of 3...']);
    });
  });

  it('uploads nothing when a later path is bad', async () => {
    await withFiles(['a.png'], async ([path]) => {
      let uploads = 0;
      const client = { uploadFileForDraft: async () => `F${++uploads}` };

      await expect(uploadDraftFiles(client, [path!, '/tmp/slackcli-missing-file.png'])).rejects.toThrow('File not found');
      expect(uploads).toBe(0);
    });
  });

  it('returns no ids and makes no call for no files', async () => {
    let uploads = 0;
    const client = { uploadFileForDraft: async () => `F${++uploads}` };

    expect(await uploadDraftFiles(client)).toEqual([]);
    expect(uploads).toBe(0);
  });
});
