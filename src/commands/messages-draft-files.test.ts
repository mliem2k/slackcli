// `messages draft --file` and `messages update-draft --file`, in process with a
// recording client: files are uploaded first, privately, and their ids ride on
// the draft call. A bad path or a dry run uploads nothing.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

type Call = { method: string; args: unknown[] };

function recordingClient(calls: Call[], overrides: Record<string, (...args: any[]) => unknown> = {}): unknown {
  let uploads = 0;
  const methods: Record<string, (...args: any[]) => unknown> = {
    requireBrowserAuth: () => undefined,
    uploadFileForDraft: async () => `F${++uploads}`,
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

describe('messages draft --file, in process', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;
  let dir: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
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
    dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-cmd-'));
    first = join(dir, 'before.png');
    second = join(dir, 'after.png');
    await Bun.write(first, 'before bytes');
    await Bun.write(second, 'after bytes');
  });

  afterEach(async () => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  async function run(client: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client as any);
    await createMessagesCommand().parseAsync([...argv, '--json'], { from: 'user' });
  }

  it('uploads each file first, in order, and creates the draft with their ids', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'Before and after', '--file', first, '--file', second,
    ]);

    expect(process.exitCode).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(['uploadFileForDraft', 'uploadFileForDraft', 'createDraft']);
    expect(calls[0]!.args).toEqual([first]);
    expect(calls[1]!.args).toEqual([second]);
    expect(calls[2]!.args[2]).toEqual({ thread_ts: undefined, file_ids: ['F1', 'F2'] });
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', draft_id: 'Dr1', file_ids: ['F1', 'F2'] });
  });

  it('creates a draft without files exactly as before, with no file_ids in the output', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['draft', '--recipient-id', 'C0123456789', '--message', 'text only']);

    expect(calls.map((call) => call.method)).toEqual(['createDraft']);
    expect(calls[0]!.args[2]).toEqual({ thread_ts: undefined, file_ids: [] });
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', draft_id: 'Dr1' });
  });

  it('uploads nothing when a later path is missing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'x', '--file', first, '--file', join(dir, 'missing.png'),
    ]);

    expect(process.exitCode).toBe(1);
    expect(calls.map((call) => call.method)).not.toContain('uploadFileForDraft');
    expect(calls.map((call) => call.method)).not.toContain('createDraft');
    expect(JSON.parse(stderr.trimEnd().split('\n').at(-1)!).error.code).toBe('invalid_input');
  });

  it('a dry run checks the files and reports them, but uploads and creates nothing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'x', '--file', first, '--dry-run',
    ]);

    expect(process.exitCode).toBe(0);
    expect(calls.map((call) => call.method)).not.toContain('uploadFileForDraft');
    expect(calls.map((call) => call.method)).not.toContain('createDraft');
    expect(stdout).toContain('before.png');
    expect(stdout).toContain(String('before bytes'.length));
  });

  it('with --replace, puts the new files on the existing draft', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: ['FOld'],
    };

    await run(recordingClient(calls, { listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }) }), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'x', '--file', second, '--replace',
    ]);

    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({ file_ids: ['F1'] });
    expect(calls.map((call) => call.method)).not.toContain('createDraft');
  });

  it('with --replace and no --file, leaves the existing draft files to the client to keep', async () => {
    const calls: Call[] = [];
    const existing = {
      id: 'DrOld',
      last_updated_ts: '1791356033.208141',
      destinations: [{ channel_id: 'C0123456789' }],
      file_ids: ['FOld'],
    };

    await run(recordingClient(calls, { listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }) }), [
      'draft', '--recipient-id', 'C0123456789', '--message', 'x', '--replace',
    ]);

    const update = calls.find((call) => call.method === 'updateDraft')!;
    expect(update.args[2]).toEqual({});
  });
});

describe('messages update-draft --file, in process', () => {
  let stdout: string;
  let savedExitCode: typeof process.exitCode;
  let dir: string;
  let file: string;
  const existing = {
    id: 'Dr0123456789',
    last_updated_ts: '1791356033.208141',
    destinations: [{ channel_id: 'C0123456789' }],
    file_ids: ['FOld'],
  };

  beforeEach(async () => {
    stdout = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    dir = await mkdtemp(join(tmpdir(), 'slackcli-update-draft-cmd-'));
    file = join(dir, 'after.png');
    await Bun.write(file, 'after bytes');
  });

  afterEach(async () => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  async function run(calls: Call[], argv: string[]) {
    const client = recordingClient(calls, { listDrafts: async () => ({ ok: true, drafts: [existing], has_more: false }) });
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client as any);
    await createMessagesCommand().parseAsync(['update-draft', '--draft-id', existing.id, '--message', 'x', ...argv, '--json'], { from: 'user' });
  }

  it('replaces the draft files with the uploaded ones', async () => {
    const calls: Call[] = [];

    await run(calls, ['--file', file]);

    expect(calls.map((call) => call.method)).toEqual(['listDrafts', 'uploadFileForDraft', 'updateDraft']);
    expect(calls[2]!.args[2]).toEqual({ file_ids: ['F1'] });
    expect(JSON.parse(stdout)).toEqual({ draft_id: existing.id, channel_id: 'C0123456789', file_ids: ['F1'] });
  });

  it('without --file passes no file list, so the client keeps the draft files', async () => {
    const calls: Call[] = [];

    await run(calls, []);

    expect(calls.map((call) => call.method)).toEqual(['listDrafts', 'updateDraft']);
    expect(calls[1]!.args[2]).toEqual({});
    expect(JSON.parse(stdout)).toEqual({ draft_id: existing.id, channel_id: 'C0123456789' });
  });
});
