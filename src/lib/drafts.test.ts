import { describe, expect, it } from 'bun:test';
import {
  extractDraftText,
  fetchActiveRawDrafts,
  fetchDrafts,
  findDraftById,
  findDraftForDestination,
  parseDraftLimit,
  projectDraft,
} from './drafts.ts';
import type { SlackDraftListResponse } from '../types/index.ts';

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
