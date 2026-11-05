// `messages draft --at` / `--in`: a draft can be handed to Slack with a send
// time, through drafts.create then drafts.update. In process, with a recording
// client, so the test can see the time that reached the write and prove a bad
// time makes no Slack call.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

type Call = { method: string; args: unknown[] };

// A local time a few days from now, inside Slack's 120-day scheduling window.
function futureLocal(days = 10, hour = 9): { text: string; timestamp: number } {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    text: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:00`,
    timestamp: Math.floor(date.getTime() / 1000),
  };
}

function recordingClient(calls: Call[], overrides: Record<string, (...args: any[]) => unknown> = {}): unknown {
  const methods: Record<string, (...args: any[]) => unknown> = {
    requireBrowserAuth: () => undefined,
    uploadFileForDraft: async () => 'F1',
    createDraft: async () => ({ ok: true, draft: { id: 'Dr1' } }),
    updateDraft: async (draft: { id?: string }) => ({ ok: true, draft: { id: draft.id } }),
    listDrafts: async () => ({ ok: true, drafts: [], has_more: false }),
    ...overrides,
  };
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      const name = String(prop);
      return async (...args: unknown[]) => {
        calls.push({ method: name, args });
        return methods[name] ? methods[name]!(...args) : { ok: true };
      };
    },
  });
}

describe('messages draft scheduling, in process', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(client: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client as any);
    await createMessagesCommand().parseAsync([...argv, '--json'], { from: 'user' });
  }

  function json(): any {
    return JSON.parse(stdout);
  }

  function lastError(): any {
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines.at(-1)!).error;
  }

  it('passes --at through as the draft send time and reports it', async () => {
    const calls: Call[] = [];
    const when = futureLocal();

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'Heads-up @alice', '--at', when.text,
    ]);

    expect(process.exitCode).toBe(0);
    const create = calls.find((call) => call.method === 'createDraft')!;
    expect(create.args[2]).toEqual({
      thread_ts: undefined,
      file_ids: [],
      date_scheduled: when.timestamp,
    });
    expect(json()).toEqual({
      channel_id: 'C0123456789',
      draft_id: 'Dr1',
      date_scheduled: when.timestamp,
    });
  });

  it('resolves a plain @handle in the draft text to a real mention', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls, {
      listUsers: async () => ({ ok: true, members: [{ id: 'U0123456789', name: 'alice', real_name: 'Alice' }] }),
    }), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'Heads-up @alice',
    ]);

    const create = calls.find((call) => call.method === 'createDraft')!;
    expect(create.args[1]).toBe('Heads-up <@U0123456789>');
  });

  it('accepts "tomorrow 9am" directly', async () => {
    const calls: Call[] = [];
    const tomorrow = futureLocal(1, 9);

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'Standup', '--at', 'tomorrow 9am',
    ]);

    const create = calls.find((call) => call.method === 'createDraft')!;
    expect((create.args[2] as { date_scheduled: number }).date_scheduled).toBe(tomorrow.timestamp);
  });

  it('turns --in into a send time relative to now', async () => {
    const calls: Call[] = [];
    const before = Math.floor(Date.now() / 1000) + 7200;

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'Standup', '--in', '2h',
    ]);

    const after = Math.floor(Date.now() / 1000) + 7200;
    const sent = (calls[0]!.args[2] as { date_scheduled: number }).date_scheduled;
    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(after);
    expect(json().date_scheduled).toBe(sent);
  });

  it.each([
    ['both --at and --in', ['--at', futureLocal().text, '--in', '2h']],
    ['a past time', ['--at', '2020-01-01 09:00']],
    ['an unreadable time', ['--at', 'next monday 9am']],
  ])('refuses %s before any Slack call', async (_label, scheduleArgs) => {
    const calls: Call[] = [];

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'hi', ...scheduleArgs,
    ]);

    expect(process.exitCode).toBe(1);
    expect(lastError().code).toBe('invalid_input');
    expect(calls).toEqual([]);
    expect(stdout).toBe('');
  });

  it('schedules an existing draft with --replace', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: ['FOld'],
      date_scheduled: 0,
    };
    const when = futureLocal();

    await run(recordingClient(calls, {
      listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }),
    }), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'New text', '--replace', '--at', when.text,
    ]);

    expect(calls.map((call) => call.method)).not.toContain('createDraft');
    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({ date_scheduled: when.timestamp });
    expect(json()).toEqual({
      channel_id: 'C0123456789',
      draft_id: 'DrOld',
      replaced: true,
      date_scheduled: when.timestamp,
    });
  });

  it('reports the send time an existing scheduled draft keeps on --replace', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: [],
      date_scheduled: 1893456000,
    };

    await run(recordingClient(calls, {
      listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }),
    }), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'New text', '--replace',
    ]);

    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({});
    expect(json().date_scheduled).toBe(1893456000);
  });

  it('keeps and reports an existing send time when update-draft changes the text', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: [],
      date_scheduled: 1893456000,
    };

    await run(recordingClient(calls, {
      listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }),
    }), [
      'update-draft', '--draft-id', 'DrOld', '--message', 'New text',
    ]);

    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({});
    expect(json()).toEqual({
      draft_id: 'DrOld',
      channel_id: 'C0123456789',
      date_scheduled: 1893456000,
    });
  });

  it('reschedules a draft with update-draft --at', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: [],
      date_scheduled: 1893456000,
    };
    const when = futureLocal();

    await run(recordingClient(calls, {
      listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }),
    }), [
      'update-draft', '--draft-id', 'DrOld', '--message', 'New text', '--at', when.text,
    ]);

    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({ date_scheduled: when.timestamp });
    expect(json()).toEqual({
      draft_id: 'DrOld',
      channel_id: 'C0123456789',
      date_scheduled: when.timestamp,
    });
  });

  it('refuses a past update-draft time before reading the draft', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), [
      'update-draft', '--draft-id', 'DrOld', '--message', 'New text', '--at', '2020-01-01 09:00',
    ]);

    expect(process.exitCode).toBe(1);
    expect(lastError().code).toBe('invalid_input');
    expect(calls).toEqual([]);
  });

  it('previews an update-draft send time without writing', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: [],
    };
    const when = futureLocal();

    await run(recordingClient(calls, {
      listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }),
    }), [
      'update-draft', '--draft-id', 'DrOld', '--message', 'New text', '--at', when.text, '--dry-run',
    ]);

    expect(calls.map((call) => call.method)).not.toContain('updateDraft');
    expect(json()).toMatchObject({
      dry_run: true,
      action: 'update draft',
      payload: { text: 'New text', date_scheduled: when.timestamp },
    });
  });

  it('previews the send time and writes nothing on --dry-run', async () => {
    const calls: Call[] = [];
    const when = futureLocal();

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'hi', '--at', when.text, '--dry-run',
    ]);

    expect(calls.map((call) => call.method)).not.toContain('createDraft');
    expect(json()).toMatchObject({
      dry_run: true,
      action: 'create draft',
      payload: { text: 'hi', date_scheduled: when.timestamp },
    });
  });
});
