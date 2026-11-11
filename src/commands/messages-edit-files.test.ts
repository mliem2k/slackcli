// `messages edit --file`, `--keep-files` and `--clear-files`, in process with a
// recording client: files are uploaded first and their ids ride on chat.update,
// the current files are read only when they are kept, and a bad path, a bad
// combination or a dry run changes nothing.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

type Call = { method: string; args: unknown[] };

const CHANNEL = 'C0123456789';
const TS = '1712345678.000100';

function recordingClient(calls: Call[], overrides: Record<string, (...args: any[]) => unknown> = {}): unknown {
  let uploads = 0;
  const methods: Record<string, (...args: any[]) => unknown> = {
    requireBrowserAuth: () => undefined,
    uploadFileForDraft: async () => `FNEW${++uploads}`,
    getMessage: async () => ({ text: 'Current text', fileIds: ['FOLD1', 'FOLD2'] }),
    updateMessage: async (_channel: string, ts: string) => ({ ok: true, ts }),
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

describe('messages edit with files, in process', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'slackcli-edit-files-'));
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
    await createMessagesCommand().parseAsync(['edit', '--channel-id', CHANNEL, '--timestamp', TS, ...argv, '--json'], { from: 'user' });
  }

  const methodsOf = (calls: Call[]) => calls.map((call) => call.method);

  it('replaces the files: uploads each in order and sends only the new ids with the text', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'New text', '--file', first, '--file', second]);

    expect(process.exitCode).toBe(0);
    expect(methodsOf(calls)).toEqual(['uploadFileForDraft', 'uploadFileForDraft', 'updateMessage']);
    expect(calls[0]!.args).toEqual([first]);
    expect(calls[1]!.args).toEqual([second]);
    expect(calls[2]!.args).toEqual([CHANNEL, TS, 'New text', { file_ids: ['FNEW1', 'FNEW2'] }]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: CHANNEL, ts: TS, file_ids: ['FNEW1', 'FNEW2'] });
  });

  it('keeps the text when only files are given, reading it from the message', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--file', first]);

    expect(process.exitCode).toBe(0);
    expect(methodsOf(calls)).toEqual(['getMessage', 'uploadFileForDraft', 'updateMessage']);
    expect(calls[2]!.args).toEqual([CHANNEL, TS, 'Current text', { file_ids: ['FNEW1'] }]);
  });

  it('with --keep-files, sends the current ids first and then the new ones', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'T', '--file', first, '--keep-files']);

    expect(methodsOf(calls)).toEqual(['getMessage', 'uploadFileForDraft', 'updateMessage']);
    expect(calls[2]!.args[3]).toEqual({ file_ids: ['FOLD1', 'FOLD2', 'FNEW1'] });
  });

  it('refuses to keep files when the message would carry more than ten', async () => {
    const calls: Call[] = [];
    const eight = { getMessage: async () => ({ text: 'x', fileIds: Array.from({ length: 9 }, (_, i) => `FOLD${i}`) }) };

    await run(recordingClient(calls, eight), ['--message', 'T', '--file', first, '--file', second, '--keep-files']);

    expect(process.exitCode).toBe(1);
    expect(methodsOf(calls)).not.toContain('updateMessage');
    expect(JSON.parse(stderr.trimEnd().split('\n').at(-1)!).error.code).toBe('invalid_input');
  });

  it('with --clear-files, sends an empty id list', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'T', '--clear-files']);

    expect(methodsOf(calls)).toEqual(['updateMessage']);
    expect(calls[0]!.args[3]).toEqual({ file_ids: [] });
    expect(JSON.parse(stdout)).toEqual({ channel_id: CHANNEL, ts: TS, file_ids: [] });
  });

  it('a text only edit sends no file ids, as before, and reads nothing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'Only text']);

    expect(methodsOf(calls)).toEqual(['updateMessage']);
    expect(calls[0]!.args).toEqual([CHANNEL, TS, 'Only text', {}]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: CHANNEL, ts: TS });
  });

  it('uploads nothing when a later path is missing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'T', '--file', first, '--file', join(dir, 'missing.png')]);

    expect(process.exitCode).toBe(1);
    expect(methodsOf(calls)).not.toContain('uploadFileForDraft');
    expect(methodsOf(calls)).not.toContain('updateMessage');
  });

  it.each([
    [['--message', 'T', '--clear-files', '--file', '__FILE__']],
    [['--message', 'T', '--clear-files', '--keep-files']],
    [['--message', 'T', '--keep-files']],
    [[]],
  ])('refuses the combination %j before any Slack call', async (argv) => {
    const calls: Call[] = [];

    await run(recordingClient(calls), argv.map((arg) => (arg === '__FILE__' ? first : arg)));

    expect(process.exitCode).toBe(1);
    expect(calls.map((call) => call.method)).not.toContain('updateMessage');
    expect(calls.map((call) => call.method)).not.toContain('uploadFileForDraft');
  });

  it('a dry run reports the files and the kept ids, and uploads and edits nothing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--file', first, '--keep-files', '--dry-run']);

    expect(process.exitCode).toBe(0);
    expect(methodsOf(calls)).not.toContain('uploadFileForDraft');
    expect(methodsOf(calls)).not.toContain('updateMessage');
    const preview = JSON.parse(stdout);
    expect(preview.payload.text).toBe('Current text');
    expect(preview.payload.kept_file_ids).toEqual(['FOLD1', 'FOLD2']);
    expect(preview.payload.files).toEqual([{ file: first, file_size: 'before bytes'.length }]);
  });

  it('reads a threaded reply through its parent, from --thread-ts', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--file', first, '--thread-ts', '1712345600.000200']);

    expect(calls[0]!.method).toBe('getMessage');
    expect(calls[0]!.args).toEqual([CHANNEL, TS, '1712345600.000200']);
  });
});
