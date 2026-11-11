import { describe, expect, it } from 'bun:test';
import { assertFileCount, editsFiles, finalFileIds, readBackText, validateEditFileOptions } from './message-edit-files.ts';

const files = (count: number, keepFiles = false) => ({ paths: Array.from({ length: count }, (_, i) => `f${i}.png`), keepFiles });

describe('message edit file options', () => {
  it('edits files only when a file is given', () => {
    expect(editsFiles(files(0))).toBe(false);
    expect(editsFiles(files(1))).toBe(true);
  });

  it('refuses --keep-files without a file and more than ten files', () => {
    expect(() => validateEditFileOptions(files(0, true))).toThrow('needs at least one --file');
    expect(() => validateEditFileOptions(files(11))).toThrow('at most 10');
    expect(() => validateEditFileOptions(files(10))).not.toThrow();
  });

  it('counts the current files only when they are kept', () => {
    const current = Array.from({ length: 9 }, (_, i) => `F${i}`);
    expect(() => assertFileCount(files(2, true), current)).toThrow('would carry 11 files (9 current and 2 new)');
    expect(() => assertFileCount(files(1, true), current)).not.toThrow();
    expect(() => assertFileCount(files(2, false), current)).not.toThrow();
  });

  it('builds the final ids: new only, or current then new without repeating one', () => {
    expect(finalFileIds(files(1), [])).toBeUndefined();
    expect(finalFileIds(files(2), ['N1', 'N2'], ['O1'])).toEqual(['N1', 'N2']);
    expect(finalFileIds(files(2, true), ['O2', 'N1'], ['O1', 'O2'])).toEqual(['O1', 'O2', 'N1']);
    expect(() => finalFileIds(files(2, true), ['N1', 'N2'], Array.from({ length: 9 }, (_, i) => `O${i}`))).toThrow('limit is 10');
  });

  it('sends back text as read, up to 3,900 bytes, and refuses empty or longer text', () => {
    expect(readBackText('Hello @someone')).toBe('Hello @someone');
    expect(readBackText('é'.repeat(1950))).toHaveLength(1950);
    expect(() => readBackText('é'.repeat(1951))).toThrow('too long to send back');
    expect(() => readBackText('  \n')).toThrow('no text to keep');
  });
});
