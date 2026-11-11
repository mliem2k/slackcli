import { InvalidInputError } from './cli-errors.ts';
import { MAX_DRAFT_FILES } from './drafts.ts';

export interface EditFileOptions {
  /** Local files to upload and attach (--file, repeatable). */
  paths: string[];
  /** Keep the files the message already carries and add the new ones (--keep-files). */
  keepFiles: boolean;
  /** Detach every file the message carries (--clear-files). */
  clearFiles: boolean;
}

/** True when the edit changes the message's files at all. */
export function editsFiles(options: EditFileOptions): boolean {
  return options.paths.length > 0 || options.clearFiles;
}

// The checks that need no Slack call, so a bad combination is refused before a
// byte is uploaded and `--dry-run` reports it too.
export function validateEditFileOptions(options: EditFileOptions): void {
  if (options.clearFiles && options.paths.length > 0) {
    throw new InvalidInputError('--clear-files removes every file, so it cannot be combined with --file');
  }
  if (options.clearFiles && options.keepFiles) {
    throw new InvalidInputError('--clear-files removes every file, so it cannot be combined with --keep-files');
  }
  if (options.keepFiles && options.paths.length === 0) {
    throw new InvalidInputError('--keep-files adds to the current files, so it needs at least one --file');
  }
  if (options.paths.length > MAX_DRAFT_FILES) {
    throw new InvalidInputError(`A message can carry at most ${MAX_DRAFT_FILES} files, got ${options.paths.length}`);
  }
}

// The ids the message carries after the edit: the uploaded files, preceded by
// the current ones with --keep-files; an empty list with --clear-files. Without
// either flag the edit leaves the files alone (undefined).
export function finalFileIds(
  options: EditFileOptions,
  uploadedIds: string[],
  currentIds: string[] = [],
): string[] | undefined {
  if (options.clearFiles) return [];
  if (uploadedIds.length === 0) return undefined;
  const ids = options.keepFiles ? [...currentIds, ...uploadedIds.filter((id) => !currentIds.includes(id))] : uploadedIds;
  if (ids.length > MAX_DRAFT_FILES) {
    throw new InvalidInputError(
      `The message would carry ${ids.length} files (${currentIds.length} current and ${uploadedIds.length} new); the limit is ${MAX_DRAFT_FILES}`,
    );
  }
  return ids;
}
