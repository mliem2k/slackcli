// `messages edit --file` and `--keep-files`, in process with a recording client: the browser session is required first,
// the current message is read only when the edit needs it, the file count is checked before anything is uploaded, files
// are uploaded before chat.update and their ids ride on it, and a bad path, a bad combination or a dry run changes nothing.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { InvalidInputError } from '../lib/cli-errors.ts';
import { createMessagesCommand } from './messages.ts';

type Call = { method: string; args: unknown[] };

const CHANNEL = 'C0123456789';
const TS = '1712345678.000100';
const PARENT = '1712345600.000200';
const PERMALINK = `https://acme.slack.com/archives/${CHANNEL}/p1712345678000100`;

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
      // The real client checks its token synchronously (it throws), so the stand in does too.
      if (name === 'requireBrowserAuth') {
        return (...args: unknown[]) => {
          calls.push({ method: name, args });
          return methods[name]!(...args);
        };
      }
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

  const target = ['--channel-id', CHANNEL, '--timestamp', TS];

  async function run(client: unknown, argv: string[], where: string[] = target) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(client as any);
    await createMessagesCommand().parseAsync(['edit', ...where, ...argv, '--json'], { from: 'user' });
  }

  const methodsOf = (calls: Call[]) => calls.map((call) => call.method);
  const errorCode = () => JSON.parse(stderr.trimEnd().split('\n').at(-1)!).error.code as string;

  it('replaces the files: needs the browser session first, uploads each in order and sends only the new ids with the text', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'New text', '--file', first, '--file', second]);

    expect(process.exitCode).toBe(0);
    expect(methodsOf(calls)).toEqual(['requireBrowserAuth', 'uploadFileForDraft', 'uploadFileForDraft', 'updateMessage']);
    expect(calls[1]!.args).toEqual([first]);
    expect(calls[2]!.args).toEqual([second]);
    expect(calls[3]!.args).toEqual([CHANNEL, TS, 'New text', { file_ids: ['FNEW1', 'FNEW2'] }]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: CHANNEL, ts: TS, file_ids: ['FNEW1', 'FNEW2'] });
  });

  it('keeps the text when only files are given, sending back the text it read and never looking up mentions', async () => {
    const calls: Call[] = [];
    const read = { getMessage: async () => ({ text: 'Ask @someone about it', fileIds: ['FOLD1'] }) };

    await run(recordingClient(calls, read), ['--file', first]);

    expect(process.exitCode).toBe(0);
    expect(methodsOf(calls)).toEqual(['requireBrowserAuth', 'getMessage', 'uploadFileForDraft', 'updateMessage']);
    expect(calls[3]!.args).toEqual([CHANNEL, TS, 'Ask @someone about it', { file_ids: ['FNEW1'] }]);
  });

  it('with --keep-files, sends the current ids first and then the new ones, once', async () => {
    const calls: Call[] = [];
    const sameAsCurrent = { uploadFileForDraft: async () => 'FOLD2' };

    await run(recordingClient(calls), ['--message', 'T', '--file', first, '--keep-files']);
    expect(calls.at(-1)!.args[3]).toEqual({ file_ids: ['FOLD1', 'FOLD2', 'FNEW1'] });

    const again: Call[] = [];
    await run(recordingClient(again, sameAsCurrent), ['--message', 'T', '--file', first, '--keep-files']);
    expect(again.at(-1)!.args[3]).toEqual({ file_ids: ['FOLD1', 'FOLD2'] });
  });

  it('refuses a keep that would pass ten files before it uploads anything, and in a dry run too', async () => {
    const nine = { getMessage: async () => ({ text: 'x', fileIds: Array.from({ length: 9 }, (_, i) => `FOLD${i}`) }) };

    for (const extra of [[], ['--dry-run']]) {
      stderr = '';
      process.exitCode = 0;
      const calls: Call[] = [];
      await run(recordingClient(calls, nine), ['--message', 'T', '--file', first, '--file', second, '--keep-files', ...extra]);

      expect(process.exitCode).toBe(1);
      expect(errorCode()).toBe('invalid_input');
      expect(methodsOf(calls)).toEqual(['requireBrowserAuth', 'getMessage']);
    }
  });

  it('a text only edit sends no file ids, needs no browser session, and reads nothing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'Only text']);

    expect(methodsOf(calls)).toEqual(['updateMessage']);
    expect(calls[0]!.args).toEqual([CHANNEL, TS, 'Only text', {}]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: CHANNEL, ts: TS });
  });

  it('refuses a file edit on a token that is not a browser session, before anything else, in a dry run too', async () => {
    const appToken = {
      requireBrowserAuth: () => {
        throw new InvalidInputError('Attaching files to an edited message requires browser authentication');
      },
    };

    for (const extra of [[], ['--dry-run']]) {
      stderr = '';
      process.exitCode = 0;
      const calls: Call[] = [];
      await run(recordingClient(calls, appToken), ['--message', 'T', '--file', first, ...extra]);

      expect(process.exitCode).toBe(1);
      expect(methodsOf(calls)).toEqual(['requireBrowserAuth']);
    }
  });

  it('refuses a file only edit of a message with no text, or with text too long to send back, and changes nothing', async () => {
    for (const text of ['', '   ', 'x'.repeat(3901)]) {
      stderr = '';
      process.exitCode = 0;
      const calls: Call[] = [];
      await run(recordingClient(calls, { getMessage: async () => ({ text, fileIds: [] }) }), ['--file', first]);

      expect(process.exitCode).toBe(1);
      expect(errorCode()).toBe('invalid_input');
      expect(methodsOf(calls)).toEqual(['requireBrowserAuth', 'getMessage']);
    }
  });

  it('sends back text of exactly the allowed size', async () => {
    const calls: Call[] = [];
    const edge = 'x'.repeat(3900);

    await run(recordingClient(calls, { getMessage: async () => ({ text: edge, fileIds: [] }) }), ['--file', first]);

    expect(process.exitCode).toBe(0);
    expect(calls.at(-1)!.args[2]).toBe(edge);
  });

  it('uploads nothing when a later path is missing', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--message', 'T', '--file', first, '--file', join(dir, 'missing.png')]);

    expect(process.exitCode).toBe(1);
    expect(methodsOf(calls)).not.toContain('uploadFileForDraft');
    expect(methodsOf(calls)).not.toContain('updateMessage');
  });

  it.each([
    [['--message', 'T', '--keep-files']],
    [[]],
  ])('refuses the combination %j before any Slack call', async (argv) => {
    const calls: Call[] = [];

    await run(recordingClient(calls), argv);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
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

    await run(recordingClient(calls), ['--file', first, '--thread-ts', PARENT]);

    const read = calls.find((call) => call.method === 'getMessage')!;
    expect(read.args).toEqual([CHANNEL, TS, PARENT]);
  });

  it('reads a threaded reply through the thread_ts of a permalink', async () => {
    const calls: Call[] = [];

    await run(recordingClient(calls), ['--file', first], ['--permalink', `${PERMALINK}?thread_ts=${PARENT}`]);

    const read = calls.find((call) => call.method === 'getMessage')!;
    expect(read.args).toEqual([CHANNEL, TS, PARENT]);
  });

  it('accepts a --thread-ts that agrees with the permalink and refuses one that does not', async () => {
    const agree: Call[] = [];
    await run(recordingClient(agree), ['--file', first, '--thread-ts', PARENT], ['--permalink', `${PERMALINK}?thread_ts=${PARENT}`]);
    expect(process.exitCode).toBe(0);

    process.exitCode = 0;
    stderr = '';
    const clash: Call[] = [];
    await run(recordingClient(clash), ['--file', first, '--thread-ts', '1712345600.000999'], ['--permalink', `${PERMALINK}?thread_ts=${PARENT}`]);
    expect(process.exitCode).toBe(1);
    expect(errorCode()).toBe('invalid_input');
    expect(clash).toEqual([]);
  });
});
