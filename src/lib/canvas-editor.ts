/**
 * Edit one table cell in a Slack canvas by driving a real browser tab.
 *
 * Slack's canvas write API (`canvases.edit`) rejects the xoxc/xoxd session
 * tokens this CLI authenticates with (`not_allowed_token_type`), and the web
 * client's own internal endpoint (`/canvas/-/edit-document`) takes an opaque
 * protobuf operational-transform delta with content-addressed node hashes,
 * not something worth reverse-engineering for a rare, low-volume edit. So
 * this drives the real canvas UI instead: click the cell, clear it, type the
 * replacement, and confirm both that the DOM now shows the new text and that
 * Slack's own autosave request actually fired.
 *
 * Built on the same `CdpSession` seam `browser-auth.ts` uses, so the
 * orchestration below is testable against a fake session with no browser.
 */

import type { CdpSession } from './cdp-client.ts';
import { openBrowserSession } from './browser-auth.ts';
import type { BrowserSessionFailure } from './browser-auth.ts';
import type { LaunchOptions } from './browser-launcher.ts';

export type CanvasEditCellFailure =
  | 'canvas_load_timeout'
  | 'row_not_found'
  | 'column_out_of_range'
  | 'save_not_confirmed';

export type CanvasEditCellResult =
  | { ok: true; before: string; after: string }
  | { ok: false; reason: CanvasEditCellFailure; message: string };

export interface CanvasEditCellOptions {
  /** Full https://app.slack.com/client/<team>/unified-files/doc/<id> URL. */
  canvasUrl: string;
  /** Exact text of an existing cell that identifies the target row. */
  rowAnchorText: string;
  /** Cells to the right of the anchor cell within its row, 0 edits the anchor cell itself. */
  columnOffset: number;
  /** Replacement text. Empty string clears the cell. */
  text: string;
  loadTimeoutMs?: number;
  saveTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface CellFound {
  found: true;
  x: number;
  y: number;
  currentText: string;
}
interface CellNotFound {
  found: false;
  reason: 'row_not_found' | 'column_out_of_range';
}
type CellLocatorResult = CellFound | CellNotFound;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build the in-page expression that locates one cell.
 *
 * Exported so tests can pin the query against fixed HTML without a browser.
 * Matches the real canvas table markup: `td.table-cell[data-row-id]` wraps a
 * `.table-cell-content[contenteditable]` div holding the cell's text,
 * confirmed by walking the live DOM, not guessed.
 */
export function buildCellLocatorExpression(rowAnchorText: string, columnOffset: number): string {
  return `(() => {
    const rowAnchorText = ${JSON.stringify(rowAnchorText)};
    const columnOffset = ${JSON.stringify(columnOffset)};
    const cells = Array.from(document.querySelectorAll('td.table-cell'));
    const anchorCell = cells.find((td) => {
      const content = td.querySelector('.table-cell-content');
      return !!content && content.textContent.trim() === rowAnchorText;
    });
    if (!anchorCell) return { found: false, reason: 'row_not_found' };
    const rowId = anchorCell.getAttribute('data-row-id');
    const rowCells = cells.filter((td) => td.getAttribute('data-row-id') === rowId);
    const targetIndex = rowCells.indexOf(anchorCell) + columnOffset;
    if (targetIndex < 0 || targetIndex >= rowCells.length) {
      return { found: false, reason: 'column_out_of_range' };
    }
    const editable = rowCells[targetIndex].querySelector('.table-cell-content');
    if (!editable) return { found: false, reason: 'column_out_of_range' };
    editable.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = editable.getBoundingClientRect();
    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      currentText: editable.textContent.trim(),
    };
  })()`;
}

async function dispatchKey(
  session: CdpSession,
  key: { key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }
): Promise<void> {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
    modifiers: key.modifiers ?? 0,
  };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Selects every child node of the target cell's editable element via the DOM Selection API,
 * re-located the same way `buildCellLocatorExpression` finds it.
 *
 * Home/Shift+End only clears the current VISUAL line: on a long value that wraps across
 * several rendered lines within one cell (confirmed live, corrupted a real cell this way),
 * Shift+End stops at the wrap point, not the end of the cell's actual content, and Backspace
 * then deletes only that first visual line, leaving the rest behind mixed in with whatever gets
 * typed next. `Selection.selectAllChildren` operates on the DOM tree, not layout, so it selects
 * the whole cell regardless of how many lines it wraps to on screen.
 */
function buildSelectAllInCellExpression(rowAnchorText: string, columnOffset: number): string {
  return `(() => {
    const rowAnchorText = ${JSON.stringify(rowAnchorText)};
    const columnOffset = ${JSON.stringify(columnOffset)};
    const cells = Array.from(document.querySelectorAll('td.table-cell'));
    const anchorCell = cells.find((td) => {
      const content = td.querySelector('.table-cell-content');
      return !!content && content.textContent.trim() === rowAnchorText;
    });
    if (!anchorCell) return false;
    const rowId = anchorCell.getAttribute('data-row-id');
    const rowCells = cells.filter((td) => td.getAttribute('data-row-id') === rowId);
    const targetIndex = rowCells.indexOf(anchorCell) + columnOffset;
    if (targetIndex < 0 || targetIndex >= rowCells.length) return false;
    const editable = rowCells[targetIndex].querySelector('.table-cell-content');
    if (!editable) return false;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.selectAllChildren(editable);
    return true;
  })()`;
}

/**
 * Clears whatever the target cell currently holds, selecting the whole cell (not just the
 * current visual line) before deleting, then dispatching a real Backspace so the app's own
 * input pipeline processes the delete exactly as it would for a user keypress.
 */
async function clearFocusedCell(session: CdpSession, rowAnchorText: string, columnOffset: number): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: buildSelectAllInCellExpression(rowAnchorText, columnOffset),
    returnByValue: true,
  });
  await dispatchKey(session, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
}

async function clickAt(session: CdpSession, x: number, y: number): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function locateCell(
  session: CdpSession,
  rowAnchorText: string,
  columnOffset: number
): Promise<CellLocatorResult> {
  const result = await session.send<{ result?: { value?: CellLocatorResult } }>('Runtime.evaluate', {
    expression: buildCellLocatorExpression(rowAnchorText, columnOffset),
    returnByValue: true,
  });
  return result?.result?.value ?? { found: false, reason: 'row_not_found' };
}

/**
 * Scroll the canvas's own inner scroll container down by roughly a viewport height.
 *
 * The canvas virtualizes its content: a long document (this Sprint canvas runs to hundreds of
 * table cells) only mounts rows into the DOM near the current scroll position, confirmed live,
 * a fresh page load sits at the top with zero `td.table-cell` anywhere until something scrolls
 * it. `window.scrollBy` does nothing here, the actual scrollable element is an inner
 * `div.parts-screen-body.scrollable`-style container, found generically (largest element whose
 * content overflows its own box) rather than hardcoding that class name, since it is an
 * implementation detail of Slack's own app, not a public contract.
 */
const SCROLL_CONTAINER_STEP_EXPRESSION = `(() => {
  const candidates = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200
  );
  if (candidates.length === 0) return { scrolled: false, atBottom: true };
  const container = candidates[0];
  const before = container.scrollTop;
  container.scrollBy(0, container.clientHeight * 0.9);
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
  return { scrolled: container.scrollTop > before, atBottom };
})()`;

/**
 * Locate a cell in a virtualized canvas by scrolling down until it mounts into the DOM.
 *
 * Tries the locator first (covers the case where the target row is already on screen), then
 * alternates scroll-step and re-locate until found, a definitive column_out_of_range (more
 * scrolling cannot fix that), the container reports it has reached the bottom, or the deadline
 * passes.
 */
async function locateCellByScrolling(
  session: CdpSession,
  rowAnchorText: string,
  columnOffset: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<CellLocatorResult> {
  const deadline = Date.now() + timeoutMs;
  let last: CellLocatorResult = { found: false, reason: 'row_not_found' };
  while (true) {
    last = await locateCell(session, rowAnchorText, columnOffset);
    if (last.found || last.reason === 'column_out_of_range') return last;
    if (Date.now() >= deadline) return last;

    const scrollResult = await session.send<{ result?: { value?: { scrolled: boolean; atBottom: boolean } } }>(
      'Runtime.evaluate',
      { expression: SCROLL_CONTAINER_STEP_EXPRESSION, returnByValue: true }
    );
    const { scrolled, atBottom } = scrollResult?.result?.value ?? { scrolled: false, atBottom: true };
    await sleep(300); // let virtualized rows mount before the next locate attempt
    if (!scrolled && atBottom) return last;
  }
}

/**
 * Core orchestration, driven over an already-attached `CdpSession`.
 *
 * Takes the session directly (rather than opening its own browser) so the
 * whole flow, locate, click, clear, type, confirm, is testable against a
 * fake session, matching how `captureSlackTokens` in `browser-auth.ts` is
 * structured.
 */
export async function editCanvasCell(
  session: CdpSession,
  options: CanvasEditCellOptions
): Promise<CanvasEditCellResult> {
  const sleep = options.sleep ?? defaultSleep;
  const loadTimeoutMs = options.loadTimeoutMs ?? 20_000;
  const saveTimeoutMs = options.saveTimeoutMs ?? 8_000;

  // A save request being sent is not the same property as it succeeding: Slack's autosave is
  // debounced, and the response can be a non-2xx (e.g. a version conflict) with no visible
  // effect other than the edit silently not persisting. Track the response status of each
  // edit-document request by id, not just whether one was dispatched.
  const saveRequestIds = new Set<string>();
  let saveResponseStatus: number | null = null;
  session.on('Network.requestWillBeSent', (params: any) => {
    const url = params?.request?.url;
    if (typeof url === 'string' && url.includes('/canvas/-/edit-document') && typeof params?.requestId === 'string') {
      saveRequestIds.add(params.requestId);
    }
  });
  session.on('Network.responseReceived', (params: any) => {
    if (typeof params?.requestId === 'string' && saveRequestIds.has(params.requestId)) {
      const status = params?.response?.status;
      if (typeof status === 'number') {
        // Keep the latest: typing that continues past the first debounce can produce more than
        // one save request, and the last one is the one that matters.
        saveResponseStatus = status;
      }
    }
  });

  await session.send('Network.enable');
  await session.send('Page.navigate', { url: options.canvasUrl });

  const waitForBoot = () =>
    waitFor(
      async () => {
        const result = await session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText.length > 500',
          returnByValue: true,
        });
        return result?.result?.value === true;
      },
      loadTimeoutMs,
      sleep
    );

  let booted = await waitForBoot();
  if (!booted) {
    // A cold browser launch can leave the Slack client mid-boot (session cookie still settling,
    // or just a slow first paint) past the first wait. One fresh navigate and a second full wait
    // recovers that without treating every slow load as a hard failure.
    await session.send('Page.navigate', { url: options.canvasUrl });
    booted = await waitForBoot();
  }
  if (!booted) {
    return {
      ok: false,
      reason: 'canvas_load_timeout',
      message: `The canvas did not finish loading within ${loadTimeoutMs}ms, even after a retry navigation.`,
    };
  }

  const cell = await locateCellByScrolling(session, options.rowAnchorText, options.columnOffset, loadTimeoutMs, sleep);
  if (!cell.found) {
    return {
      ok: false,
      reason: cell.reason,
      message:
        cell.reason === 'row_not_found'
          ? `No cell in the canvas contains the exact text "${options.rowAnchorText}", scrolled to the bottom looking for it.`
          : `Found the row for "${options.rowAnchorText}", but column offset ${options.columnOffset} is out of range for it.`,
    };
  }

  await clickAt(session, cell.x, cell.y);
  await sleep(150);

  const before = cell.currentText;
  if (before.length > 0) {
    await clearFocusedCell(session, options.rowAnchorText, options.columnOffset);
  }
  if (options.text.length > 0) {
    await session.send('Input.insertText', { text: options.text });
  }

  await waitFor(() => saveResponseStatus !== null, saveTimeoutMs, sleep);
  // Give a save response that arrives right at the deadline a moment to actually be processed
  // server-side before anything (including the caller closing the browser) can race it.
  await sleep(500);

  const readBack = await locateCell(session, options.rowAnchorText, options.columnOffset);
  const after = readBack.found ? readBack.currentText : null;

  if (after !== options.text) {
    return {
      ok: false,
      reason: 'save_not_confirmed',
      message: `Cell now reads "${after ?? '(cell no longer found)'}", expected "${options.text}". The edit may not have applied.`,
    };
  }
  if (saveResponseStatus === null) {
    return {
      ok: false,
      reason: 'save_not_confirmed',
      message: `Cell content matches, but no save response from /canvas/-/edit-document was observed within ${saveTimeoutMs}ms. It may not be persisted.`,
    };
  }
  if (saveResponseStatus >= 400) {
    return {
      ok: false,
      reason: 'save_not_confirmed',
      message: `Cell content matches locally, but the save request to /canvas/-/edit-document returned HTTP ${saveResponseStatus}. It is not persisted.`,
    };
  }

  return { ok: true, before, after };
}

export type CanvasEditCellAutoFailure = BrowserSessionFailure | CanvasEditCellFailure;
export type CanvasEditCellAutoResult =
  | { ok: true; before: string; after: string }
  | { ok: false; reason: CanvasEditCellAutoFailure; message: string };

/**
 * Launch (or attach to) the CLI's dedicated browser profile, edit one cell,
 * and always close the browser afterward. The IO edge, thin on purpose.
 */
export async function editCanvasCellAuto(
  options: CanvasEditCellOptions,
  launchOptions: LaunchOptions = {}
): Promise<CanvasEditCellAutoResult> {
  const opened = await openBrowserSession({ ...launchOptions, startUrl: options.canvasUrl });
  if (!opened.ok) return opened;

  try {
    return await editCanvasCell(opened.session, options);
  } finally {
    await opened.stop();
  }
}
