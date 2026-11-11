import { InvalidInputError } from './cli-errors.ts';
import { MAX_DRAFT_FILES } from './drafts.ts';

// The longest text, in bytes, that a file only edit sends back as it read it. chat.update refuses text over 4,000
// bytes once Slack has escaped it, and an earlier edit may already have trimmed the text it stored, so a message near
// the limit needs its text given again with --message.
export const MAX_READ_BACK_TEXT_BYTES = 3900;

export interface EditFileOptions {
  /** Local files to upload and attach (--file, repeatable). */
  paths: string[];
  /** Keep the files the message already carries and add the new ones (--keep-files). */
  keepFiles: boolean;
}

/** True when the edit changes the message's files at all. */
export function editsFiles(options: EditFileOptions): boolean {
  return options.paths.length > 0;
}

// The checks that need no Slack call, so a bad combination is refused before a
// byte is uploaded and `--dry-run` reports it too.
export function validateEditFileOptions(options: EditFileOptions): void {
  if (options.keepFiles && options.paths.length === 0) {
    throw new InvalidInputError('--keep-files adds to the current files, so it needs at least one --file');
  }
  if (options.paths.length > MAX_DRAFT_FILES) {
    throw new InvalidInputError(`A message can carry at most ${MAX_DRAFT_FILES} files, got ${options.paths.length}`);
  }
}

// The count the message would carry after the edit, checked once the current files are known and before anything is
// uploaded (and in a dry run), so a refused edit leaves no orphaned upload behind.
export function assertFileCount(options: EditFileOptions, currentIds: string[] = []): void {
  if (!options.keepFiles) return;
  const total = currentIds.length + options.paths.length;
  if (total > MAX_DRAFT_FILES) {
    throw new InvalidInputError(
      `The message would carry ${total} files (${currentIds.length} current and ${options.paths.length} new); the limit is ${MAX_DRAFT_FILES}`,
    );
  }
}

// The ids the message carries after the edit: the uploaded files, preceded by the current ones with --keep-files.
// Without a file option the edit leaves the files alone (undefined).
export function finalFileIds(
  options: EditFileOptions,
  uploadedIds: string[],
  currentIds: string[] = [],
): string[] | undefined {
  if (uploadedIds.length === 0) return undefined;
  const ids = options.keepFiles ? [...currentIds, ...uploadedIds.filter((id) => !currentIds.includes(id))] : uploadedIds;
  if (ids.length > MAX_DRAFT_FILES) {
    throw new InvalidInputError(`The message would carry ${ids.length} files; the limit is ${MAX_DRAFT_FILES}`);
  }
  return ids;
}

// The text a file only edit sends back: what Slack returned, unchanged. It is refused when the message has no text (an
// empty text is not a valid update) or when it is too close to the update limit to be sent back safely.
export function readBackText(currentText: string): string {
  if (currentText.trim() === '') {
    throw new InvalidInputError('The message has no text to keep, so pass --message or --message-file with the new text');
  }
  if (Buffer.byteLength(currentText, 'utf8') > MAX_READ_BACK_TEXT_BYTES) {
    throw new InvalidInputError(
      `The message text is over ${MAX_READ_BACK_TEXT_BYTES} bytes, too long to send back as read; pass --message or --message-file with the text`,
    );
  }
  return currentText;
}
