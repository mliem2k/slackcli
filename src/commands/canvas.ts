import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import { readFile } from 'node:fs/promises';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { getWorkspace } from '../lib/workspaces.ts';
import { editCanvasCellAuto } from '../lib/canvas-editor.ts';
import { error, success, formatCanvasList, formatCanvasContent, warning, writeJson } from '../lib/formatter.ts';
import { canvasHtmlToMarkdown, canvasEditPersisted } from '../lib/canvas-parser.ts';
import {
  applyCanvasMentions,
  CanvasReadError,
  fetchCanvasHtml,
  resolveCanvasId,
  resolveCanvasMentions,
} from '../lib/canvas-read.ts';
import { normalizeIdentifier, workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackCanvas, CanvasEditChange } from '../types/index.ts';

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const EDIT_OPERATIONS = ['insert_after', 'insert_before', 'insert_at_start', 'insert_at_end', 'replace', 'delete'] as const;
type EditOperation = typeof EDIT_OPERATIONS[number];

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading not-found error.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// Expected failures keep their own exit code (some have always exited 0);
// anything else is an unexpected error and exits 1.
function reportCanvasReadFailure(spinner: Ora, err: any): void {
  if (err instanceof CanvasReadError) {
    spinner.fail(err.summary);
    if (err.detail) error(err.detail);
    if (err.exitCode !== 0) process.exit(err.exitCode);
    return;
  }
  spinner.fail('Failed to read canvas');
  error(err.message);
  process.exit(1);
}

export function createCanvasCommand(): Command {
  const canvas = new Command('canvas')
    .description('List and read Slack canvas documents');

  // List canvases
  canvas
    .command('list')
    .description('List canvas documents in the workspace')
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'Channel ID or URL whose shared canvases to list')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const limit = parseInt(options.limit);
        if (isNaN(limit) || limit < 1 || limit > 1000) {
          spinner.fail('Invalid limit');
          error('Limit must be a number between 1 and 1000');
          process.exit(1);
        }

        const channel = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(options.channel));

        const response = await client.listCanvases({
          limit,
          channel,
        });

        const files: SlackCanvas[] = response.files || [];

        if (files.length === 0) {
          spinner.succeed('No canvases found');
          return;
        }

        spinner.succeed(`Found ${files.length} canvases`);

        if (options.json) {
          writeJson({
            canvas_count: files.length,
            canvases: files.map(f => ({
              id: f.id,
              title: f.title || f.name,
              created: f.created,
              edit_timestamp: f.edit_timestamp,
              user: f.user,
              editors: f.editors,
              size: f.size,
              permalink: f.permalink,
            })),
          });
          return;
        }

        console.log('\n' + formatCanvasList(files));
      } catch (err: any) {
        spinner.fail('Failed to fetch canvases');
        error(err.message);
        process.exit(1);
      }
    });

  // Read canvas content
  canvas
    .command('read')
    .description('Read canvas content as markdown')
    .argument('[canvas-id]', 'Canvas file ID or URL (e.g., F1234567890)')
    .option('--channel <id>', 'Channel ID or URL whose canvas to read')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasIdArg, options) => {
      const spinner = ora('Fetching canvas...').start();
      const onProgress = (message: string) => {
        spinner.text = message;
      };

      try {
        const canvasId = canvasIdArg
          ? normalizeIdentifier(canvasIdArg, 'file', '<canvas-id>')
          : undefined;
        const channel = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(canvasIdArg) ?? workspaceOf(options.channel));

        const fileId = await resolveCanvasId(client, { canvasId, channel }, onProgress);
        const { file, html } = await fetchCanvasHtml(client, fileId, onProgress);
        const title = `Canvas: ${file.title || file.name || fileId}`;

        // Raw mode: output HTML directly
        if (options.raw) {
          spinner.succeed(title);
          console.log(html);
          return;
        }

        const rawMarkdown = canvasHtmlToMarkdown(html);
        const mentions = await resolveCanvasMentions(client, rawMarkdown, onProgress);
        const markdown = applyCanvasMentions(rawMarkdown, mentions);
        spinner.succeed(title);

        if (options.json) {
          writeJson({
            id: file.id,
            title: file.title || file.name,
            created: file.created,
            edit_timestamp: file.edit_timestamp,
            user: file.user,
            editors: file.editors,
            size: file.size,
            permalink: file.permalink,
            markdown,
          });
          return;
        }

        console.log('\n' + formatCanvasContent(file, markdown));
      } catch (err: any) {
        reportCanvasReadFailure(spinner, err);
      }
    });

  // Find sections within a canvas, to get the section_id an edit needs to target
  canvas
    .command('sections')
    .description('Find sections within a canvas, to get the section_id an edit needs to target')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--contains-text <text>', 'Only return sections whose content contains this text')
    .option('--types <types>', 'Comma-separated section types to match (e.g., h1,h2,default_section)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      const spinner = ora('Looking up canvas sections...').start();

      try {
        if (!CANVAS_ID_PATTERN.test(canvasId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        const client = await getAuthenticatedClient(options.workspace);

        const criteria: { section_types?: string[]; contains_text?: string } = {};
        if (options.types) criteria.section_types = options.types.split(',').map((t: string) => t.trim());
        if (options.containsText) criteria.contains_text = options.containsText;

        const response = await client.lookupCanvasSections(canvasId, criteria);
        const sections = response.sections || [];

        if (sections.length === 0) {
          spinner.succeed('No matching sections found');
          return;
        }

        spinner.succeed(`Found ${sections.length} section(s)`);

        if (options.json) {
          writeJson({ sections });
          return;
        }

        for (const section of sections) {
          console.log(`  ${section.id}${section.section_type ? ` (${section.section_type})` : ''}`);
        }
      } catch (err: any) {
        spinner.fail('Failed to look up canvas sections');
        error(err.message);
        process.exit(1);
      }
    });

  // Apply one change operation to a canvas document
  canvas
    .command('edit')
    .description('Apply one change operation to a canvas document (insert, replace, or delete a section)')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .requiredOption('--operation <operation>', `Change operation: ${EDIT_OPERATIONS.join(', ')}`)
    .option('--section-id <id>', 'Target section ID (required for every operation except insert_at_start/insert_at_end)')
    .option('--markdown <text>', 'Markdown content for insert/replace operations')
    .option('--markdown-file <path>', 'Read markdown content from a file instead of --markdown')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      const spinner = ora('Applying canvas edit...').start();

      try {
        if (!CANVAS_ID_PATTERN.test(canvasId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        const operation = options.operation as string;
        if (!EDIT_OPERATIONS.includes(operation as EditOperation)) {
          spinner.fail('Invalid operation');
          error(`Operation must be one of: ${EDIT_OPERATIONS.join(', ')}`);
          process.exit(1);
        }

        if (operation !== 'insert_at_start' && operation !== 'insert_at_end' && !options.sectionId) {
          spinner.fail('Missing --section-id');
          error(`--section-id is required for the ${operation} operation. Use "canvas sections" to find it.`);
          process.exit(1);
        }

        let markdown: string | undefined = options.markdown;
        if (options.markdownFile) {
          markdown = await readFile(options.markdownFile, 'utf-8');
        }

        if (operation !== 'delete' && !markdown) {
          spinner.fail('Missing content');
          error(`--markdown or --markdown-file is required for the ${operation} operation.`);
          process.exit(1);
        }

        const change: CanvasEditChange = { operation: operation as EditOperation };
        if (options.sectionId) change.section_id = options.sectionId;
        if (operation !== 'delete') {
          change.document_content = { type: 'markdown', markdown: markdown! };
        }

        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.editCanvas(canvasId, [change]);

        spinner.succeed('Canvas updated');

        if (options.json) {
          writeJson(response);
          return;
        }

        success(`Applied ${operation} to ${canvasId}`);
      } catch (err: any) {
        spinner.fail('Failed to edit canvas');
        error(err.message);
        process.exit(1);
      }
    });

  // Edit one table cell by driving a real browser. `canvas edit` above hits
  // canvases.edit, which Slack rejects for xoxc/xoxd session tokens
  // (not_allowed_token_type); this works around that for the one shape of
  // edit that comes up in practice, setting a cell in an existing table.
  canvas
    .command('edit-cell')
    .description('Edit one table cell in a canvas by driving a real browser (for workspaces where canvases.edit is blocked)')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .requiredOption('--row-anchor <text>', 'Exact text of an existing cell that identifies the target row')
    .option(
      '--occurrence <n>',
      'Which match to use when --row-anchor text is not unique in the canvas, 1-indexed in top-to-bottom document order (default: 1, the first match). Run "canvas sections --contains-text" first to check how many matches exist before assuming 1 is correct.',
      '1'
    )
    .requiredOption('--column-offset <n>', 'Cells to the right of the anchor cell to edit (0 edits the anchor cell itself)')
    .requiredOption('--text <text>', 'Replacement text for the target cell (pass "" to clear it)')
    .option('--headless', 'Run without a visible browser window (only works if already signed in)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      const spinner = ora('Opening a browser to edit the canvas...').start();

      try {
        if (!CANVAS_ID_PATTERN.test(canvasId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        const columnOffset = parseInt(options.columnOffset, 10);
        if (!Number.isFinite(columnOffset) || String(columnOffset) !== options.columnOffset.trim()) {
          spinner.fail('Invalid --column-offset');
          error('--column-offset must be an integer.');
          process.exit(1);
        }

        const occurrence = parseInt(options.occurrence, 10);
        if (!Number.isFinite(occurrence) || String(occurrence) !== options.occurrence.trim() || occurrence < 1) {
          spinner.fail('Invalid --occurrence');
          error('--occurrence must be a positive integer (1 = the first match).');
          process.exit(1);
        }

        const workspace = await getWorkspace(options.workspace);
        if (!workspace) {
          spinner.fail('No workspace configured');
          error(
            options.workspace
              ? `Workspace not found: ${options.workspace}`
              : 'No workspace configured. Run "slackcli auth login-auto" first.'
          );
          process.exit(1);
        }

        const canvasUrl = `https://app.slack.com/client/${workspace.workspace_id}/unified-files/doc/${canvasId}`;

        const result = await editCanvasCellAuto(
          { canvasUrl, rowAnchorText: options.rowAnchor, occurrence, columnOffset, text: options.text },
          { headless: options.headless === true }
        );

        if (!result.ok) {
          spinner.fail('Canvas edit failed');
          error(result.message);
          process.exit(1);
        }

        // Belt and suspenders: editCanvasCellAuto already confirms the save via the in-browser
        // network response, but that alone has been observed to report success for an edit that
        // is not actually what ends up persisted, most likely several debounced saves from a
        // multi-keystroke clear racing each other server-side. Re-fetching through the same REST
        // path `canvas read` uses is a genuinely separate confirmation, not just a second look at
        // the same browser session, and empirically needs real time (rapid retries too soon see
        // stale content), so this polls with real delay rather than checking once.
        spinner.text = 'Confirming the edit actually persisted...';
        const client = await getAuthenticatedClient(options.workspace);
        let persisted = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            const fileInfo = await client.getFileInfo(canvasId);
            const downloadUrl = fileInfo.file?.url_private_download || fileInfo.file?.url_private;
            if (!downloadUrl) continue;
            const html = await client.downloadFile(downloadUrl, MAX_FILE_SIZE);
            const markdown = canvasHtmlToMarkdown(html);
            const matches = canvasEditPersisted(markdown, options.text, result.before);
            if (matches) {
              persisted = true;
              break;
            }
          } catch {
            // Transient fetch failure, the retry loop covers it.
          }
        }

        if (!persisted) {
          spinner.fail('Canvas edit did not persist');
          error(
            'The browser reported a successful save, but re-fetching the canvas does not show the new text. ' +
              'Run "slackcli canvas read" to check the live state before retrying.'
          );
          process.exit(1);
        }

        spinner.succeed(`Cell updated and confirmed persisted: "${result.before}" to "${result.after}"`);

        if (options.json) {
          writeJson(result);
        }
      } catch (err: any) {
        spinner.fail('Failed to edit canvas cell');
        error(err.message);
        process.exit(1);
      }
    });

  return canvas;
}
