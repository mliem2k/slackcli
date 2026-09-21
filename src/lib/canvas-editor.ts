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
  /** Which match to use when rowAnchorText is not unique in the document: 1-indexed, in
   *  top-to-bottom scroll order. Defaults to 1 (the first match). A long canvas commonly repeats
   *  the same short cell value (a name, a role) across several unrelated tables, so relying on
   *  the first match alone risks silently editing the wrong row. */
  occurrence?: number;
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
  /** The row's own data-row-id and this cell's index within it, stable identity for re-locating
   *  after the cell's own text has changed (an anchor is only reliable before it stops matching
   *  its own pre-edit content, which breaks the moment columnOffset is 0 or a shared anchor cell
   *  is itself edited by a separate call). */
  rowId: string;
  targetIndex: number;
}
interface CellNotFound {
  found: false;
  reason: 'row_not_found' | 'column_out_of_range';
  /** Set on a `row_not_found` that came from the search deadline passing, not from confirming
   *  there is nothing left to reveal (the scroll container's height and mounted cell count both
   *  stopped changing across a jump). A caller must not tell the user the whole canvas was
   *  searched when this is true, since the row may still exist further down. */
  timedOut?: boolean;
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
 *
 * `excludeRowIds` skips rows already ruled out (already matched and confirmed not to be the
 * target occurrence, or already edited by an earlier step of the same operation), so the caller
 * can walk forward through repeated matches one at a time rather than always landing on the
 * first. See `locateCellByScrolling`'s `occurrence` parameter, the actual disambiguation logic.
 */
export function buildCellLocatorExpression(
  rowAnchorText: string,
  columnOffset: number,
  excludeRowIds: string[] = []
): string {
  return `(() => {
    const rowAnchorText = ${JSON.stringify(rowAnchorText)};
    const columnOffset = ${JSON.stringify(columnOffset)};
    const excludeRowIds = new Set(${JSON.stringify(excludeRowIds)});
    const cells = Array.from(document.querySelectorAll('td.table-cell'));
    const anchorCell = cells.find((td) => {
      const content = td.querySelector('.table-cell-content');
      if (!content || content.textContent.trim() !== rowAnchorText) return false;
      return !excludeRowIds.has(td.getAttribute('data-row-id'));
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
      rowId,
      targetIndex,
    };
  })()`;
}

/**
 * Build the in-page expression that re-locates a cell by stable row/column identity rather than
 * by matching an anchor cell's text, since the anchor's own text is exactly what may have just
 * changed (columnOffset 0, or any anchor cell edited by an earlier step in the same operation).
 */
export function buildCellLocatorByIdExpression(rowId: string, targetIndex: number): string {
  return `(() => {
    const rowId = ${JSON.stringify(rowId)};
    const targetIndex = ${JSON.stringify(targetIndex)};
    const rowCells = Array.from(document.querySelectorAll('td.table-cell[data-row-id="' + CSS.escape(rowId) + '"]'));
    if (targetIndex < 0 || targetIndex >= rowCells.length) {
      return { found: false, reason: 'column_out_of_range' };
    }
    const editable = rowCells[targetIndex].querySelector('.table-cell-content');
    if (!editable) return { found: false, reason: 'column_out_of_range' };
    const rect = editable.getBoundingClientRect();
    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      currentText: editable.textContent.trim(),
      rowId,
      targetIndex,
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
 * Clears whatever the target cell currently holds, verified against a real readback rather than
 * assumed.
 *
 * Three approaches were tried and confirmed broken against this editor before this one, all live,
 * all against the real canvas. Home + Shift+End only clears the current VISUAL line, so a value
 * long enough to wrap across several rendered lines within one cell gets partially deleted, its
 * remainder left mixed in with whatever gets typed next. Setting a DOM Selection via
 * `Selection.selectAllChildren` and then dispatching one Backspace does nothing at all, this
 * editor keeps its own internal selection model (confirmed React/Slate-shaped) that a
 * programmatic browser Selection is not synced into, so a subsequent Backspace has no selection
 * to act on from the editor's own point of view even though the raw DOM API reports one.
 * Real per-character Backspace keypresses fired back to back with no delay also only partially
 * work, on a ~290 character cell roughly half the presses landed and the rest were silently
 * dropped, confirmed by pressing one at a time with a short delay between each: the exact same
 * key sequence, slowed down, reliably deletes everything. So this presses one key at a time with
 * a small delay, re-reading the cell periodically and stopping the moment it is actually empty.
 */
async function clearFocusedCell(
  session: CdpSession,
  rowId: string,
  targetIndex: number,
  currentLength: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const checkEvery = 20;
  const maxPresses = currentLength + 50; // safety margin over the known length
  const keyDelayMs = 40; // fired back to back with no delay, roughly half the presses were dropped

  const pressUntilEmpty = async (key: { key: string; code: string; windowsVirtualKeyCode: number }) => {
    let pressed = 0;
    while (pressed < maxPresses) {
      const thisBatch = Math.min(checkEvery, maxPresses - pressed);
      for (let i = 0; i < thisBatch; i++) {
        await dispatchKey(session, key);
        await sleep(keyDelayMs);
      }
      pressed += thisBatch;
      const cell = await locateCellById(session, rowId, targetIndex);
      if (cell.found && cell.currentText.length === 0) return true;
    }
    return false;
  };

  // The click that focused this cell can land anywhere in it. Backspace clears everything from
  // that point back to the true start of the cell (a cross-cell boundary was already confirmed
  // not to bleed into a neighbor), which handles content before the click. Delete then clears
  // whatever was after the click point, which Backspace alone never reaches.
  if (await pressUntilEmpty({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })) return;
  await pressUntilEmpty({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
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
  columnOffset: number,
  excludeRowIds: string[] = []
): Promise<CellLocatorResult> {
  const result = await session.send<{ result?: { value?: CellLocatorResult } }>('Runtime.evaluate', {
    expression: buildCellLocatorExpression(rowAnchorText, columnOffset, excludeRowIds),
    returnByValue: true,
  });
  return result?.result?.value ?? { found: false, reason: 'row_not_found' };
}

/** Re-locate by stable row/column identity, see `buildCellLocatorByIdExpression`. */
async function locateCellById(session: CdpSession, rowId: string, targetIndex: number): Promise<CellLocatorResult> {
  const result = await session.send<{ result?: { value?: CellLocatorResult } }>('Runtime.evaluate', {
    expression: buildCellLocatorByIdExpression(rowId, targetIndex),
    returnByValue: true,
  });
  return result?.result?.value ?? { found: false, reason: 'row_not_found' };
}

/**
 * Jump the canvas's own inner scroll container straight to its current bottom.
 *
 * The canvas virtualizes its content: a long document (this Sprint canvas runs to hundreds of
 * table cells) only mounts rows into the DOM near the current scroll position, confirmed live,
 * a fresh page load sits at the top with zero `td.table-cell` anywhere until something scrolls
 * it. `window.scrollBy` does nothing here, the actual scrollable element is an inner
 * `div.parts-screen-body.scrollable`-style container, found generically (largest element whose
 * content overflows its own box) rather than hardcoding that class name, since it is an
 * implementation detail of Slack's own app, not a public contract; confirmed correct by walking
 * up from a real `td.table-cell` to its nearest scrollable ancestor, there is exactly one.
 *
 * Nudging that container by a small increment (roughly a viewport height, repeated) never mounts
 * anything, confirmed live: 8 such steps with a full 1500ms settle after each one, well over 2000px
 * of real cumulative scrollTop movement, still left the cell count at its initial value. This is
 * not windowed virtualization reacting to proximity; it is a single large reveal triggered only by
 * reaching the container's true scroll boundary. Jumping straight to `scrollHeight - clientHeight`
 * does mount a large batch (confirmed live: 32 cells to 233 in one jump), and since previously
 * unmeasured content becomes real, measured content once mounted, `scrollHeight` itself can change
 * after a jump, so the caller repeats the jump against the fresh value until it stops changing.
 */
export const SCROLL_CONTAINER_STEP_EXPRESSION = `(() => {
  const candidates = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200
  );
  if (candidates.length === 0) return { found: false };
  // Pick the candidate with the largest actual overflow, not just the first DOM match: the page
  // carries several small scrollable widgets (a table-of-contents drawer, a scrollbar wrapper)
  // that also pass the filter above but scroll almost nothing, confirmed live on the real canvas.
  // The true virtualized content pane has by far the largest scrollHeight-minus-clientHeight gap.
  const container = candidates.reduce((best, el) =>
    (el.scrollHeight - el.clientHeight) > (best.scrollHeight - best.clientHeight) ? el : best
  );
  const scrollHeightBeforeJump = container.scrollHeight;
  container.scrollTop = container.scrollHeight - container.clientHeight;
  // A native scrollTop assignment does not itself bubble, but that only matters for listeners on
  // an ANCESTOR of the container; this dispatch is aimed at the container itself, which receives
  // it regardless of bubbling. Kept anyway since it costs nothing and covers a listener elsewhere.
  container.dispatchEvent(new Event('scroll', { bubbles: true }));
  // Cell count alongside scrollHeight: a mount batch whose real measured height happens to equal
  // the placeholder it replaced would leave scrollHeight unchanged even though content mounted, a
  // single-line-row table (this one) is exactly the shape a virtualizer estimates accurately. Cell
  // count cannot be fooled the same way, it is what the 32-to-233 reveal was actually measured by.
  const cellCount = document.querySelectorAll('td.table-cell').length;
  return { found: true, scrollHeightBeforeJump, cellCount };
})()`;

type ScrollStep =
  | { found: false }
  | { found: true; scrollHeightBeforeJump: number; cellCount: number };

/**
 * Locate a cell in a virtualized canvas by scrolling down until it mounts into the DOM.
 *
 * Tries the locator first (covers the case where the target row is already on screen), then
 * alternates bottom-jump and re-locate until found, a definitive column_out_of_range (more
 * scrolling cannot fix that), no scrollable container exists at all, the jumps stop revealing
 * anything new, or the deadline passes. "Stops revealing anything new" is two consecutive jumps
 * measuring the same pre-jump scrollHeight AND the same mounted cell count: scrollHeight alone can
 * stay put across a real reveal if a mount batch's measured height happens to equal the placeholder
 * it replaced, so both signals have to agree before giving up. The container cannot report being at
 * its own true bottom either way, since each reveal can grow or shrink the number that would define
 * it. Once both signals agree nothing changed, one further locate is still made (using the DOM the
 * last jump's settle window already paid for) before concluding the row genuinely is not there,
 * distinct from a deadline cutoff, which the caller must not describe as a completed search.
 *
 * `occurrence` (1-indexed, default 1) picks the Nth cell matching `rowAnchorText` in top-to-
 * bottom document order, not just the first. A short cell value (a name, a role, a status word)
 * commonly repeats across unrelated tables in one long canvas (multiple weeks of the same
 * stand-up template, in the case this was built for), so always taking the first match risks
 * silently editing the wrong row's real data instead of the intended one. Matches already passed
 * over (found, but not yet the target occurrence) are tracked by their stable `rowId` in
 * `excludeRowIds` so they are skipped on every subsequent locate call. This assumes a row's
 * `data-row-id` survives being unmounted and remounted by a later jump, true of every jump
 * observed live so far, not independently verified against Quip's own internals.
 */
async function locateCellByScrolling(
  session: CdpSession,
  rowAnchorText: string,
  columnOffset: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  occurrence: number = 1
): Promise<CellLocatorResult> {
  const deadline = Date.now() + timeoutMs;
  const excludeRowIds: string[] = [];
  let matchesSeen = 0;
  // Tracks the previous jump's readings, so a jump that reveals nothing new (both readings
  // unchanged from last time) is recognized as "truly at the bottom" rather than retried forever;
  // -1 never matches a real reading, so the first jump always proceeds.
  let previousScrollHeight = -1;
  let previousCellCount = -1;
  let stabilized = false;
  let last: CellLocatorResult = { found: false, reason: 'row_not_found' };
  while (true) {
    if (Date.now() >= deadline) {
      return last.found ? last : { ...last, timedOut: !stabilized };
    }

    last = await locateCell(session, rowAnchorText, columnOffset, excludeRowIds);
    if (last.found) {
      matchesSeen += 1;
      if (matchesSeen >= occurrence) return last;
      // Not the occurrence we want: rule this row out and keep looking, without scrolling first,
      // in case another match is already mounted alongside this one in the current DOM.
      excludeRowIds.push(last.rowId);
      continue;
    }
    if (last.reason === 'column_out_of_range') return last;
    // The previous jump's settle window already produced this locate's DOM; if it also confirmed
    // stabilization, this miss is a genuine, fully-searched absence, not one more thing to retry.
    if (stabilized) return last;

    const scrollResult = await session.send<{ result?: { value?: ScrollStep } }>('Runtime.evaluate', {
      expression: SCROLL_CONTAINER_STEP_EXPRESSION,
      returnByValue: true,
    });
    const step = scrollResult?.result?.value ?? { found: false };
    if (!step.found) return last; // no scrollable container at all
    // Quip mounts more content in one large batch only once the container actually reaches its
    // scroll boundary, not incrementally as the boundary is approached; shorter settle windows
    // after the jump were tried live and the batch had not landed yet, so 1500ms is empirical, not
    // an arbitrary round number.
    await sleep(1500);
    stabilized = step.scrollHeightBeforeJump === previousScrollHeight && step.cellCount === previousCellCount;
    previousScrollHeight = step.scrollHeightBeforeJump;
    previousCellCount = step.cellCount;
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
  // Confirmed live: the debounced save this now waits for (one sent no earlier than the final
  // edit, see finalInputAt below) can take well over 8s to fire on a long clear/replace, so the
  // old 8s default produced real false negatives (edit correctly persisted, reported as unsaved).
  const saveTimeoutMs = options.saveTimeoutMs ?? 15_000;

  // A save request being sent is not the same property as it succeeding: Slack's autosave is
  // debounced, and the response can be a non-2xx (e.g. a version conflict) with no visible
  // effect other than the edit silently not persisting. Track the response status of each
  // edit-document request by id, not just whether one was dispatched.
  //
  // The debounce also fires WHILE clearing, not only after the final text lands: confirmed live,
  // a long clear/replace reliably produces an early save request mid-Backspace that captures a
  // partially-cleared, intermediate snapshot, with its 2xx response arriving well before the
  // clear or the later Input.insertText even finish. A check that accepts the first save response
  // it ever sees is satisfied by that stale one, so the function reports success (the DOM readback
  // below is genuinely correct at that moment) while what actually persists server-side is the
  // intermediate text, not the final replacement, the exact shape of corruption this was written
  // to catch: a clean front truncation with the untouched tail of the old value left behind. The
  // fix is to require a save REQUEST sent no earlier than the final DOM mutation (`finalInputAt`,
  // set below), correlated to ITS OWN response by request id, not just "some response arrived".
  const saveRequestIds = new Set<string>();
  const saveResponsesByRequestId = new Map<string, number>();
  let lastSaveRequestId: string | null = null;
  let lastSaveRequestSentAt: number | null = null;
  session.on('Network.requestWillBeSent', (params: any) => {
    const url = params?.request?.url;
    if (typeof url === 'string' && url.includes('/canvas/-/edit-document') && typeof params?.requestId === 'string') {
      saveRequestIds.add(params.requestId);
      lastSaveRequestId = params.requestId;
      lastSaveRequestSentAt = Date.now();
    }
  });
  session.on('Network.responseReceived', (params: any) => {
    if (typeof params?.requestId === 'string' && saveRequestIds.has(params.requestId)) {
      const status = params?.response?.status;
      if (typeof status === 'number') {
        saveResponsesByRequestId.set(params.requestId, status);
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

  const occurrence = options.occurrence ?? 1;
  const cell = await locateCellByScrolling(
    session,
    options.rowAnchorText,
    options.columnOffset,
    loadTimeoutMs,
    sleep,
    occurrence
  );
  if (!cell.found) {
    // "Scrolled to the bottom" is only true once the search actually confirmed nothing more could
    // be revealed; a search that instead ran out of time may have stopped well short of the real
    // bottom, and telling the caller otherwise sends them looking for a row that may well exist.
    const searchDescription = cell.reason === 'row_not_found' && cell.timedOut
      ? 'ran out of time scrolling through the canvas before confirming the whole document had been searched'
      : 'scrolled to the bottom of the canvas';
    return {
      ok: false,
      reason: cell.reason,
      message:
        cell.reason === 'row_not_found'
          ? occurrence > 1
            ? `Found fewer than ${occurrence} cells with the exact text "${options.rowAnchorText}" (${searchDescription} looking for occurrence ${occurrence}).`
            : `No cell in the canvas contains the exact text "${options.rowAnchorText}", ${searchDescription} looking for it.`
          : `Found ${occurrence > 1 ? `occurrence ${occurrence} of ` : 'the row for '}"${options.rowAnchorText}", but column offset ${options.columnOffset} is out of range for it.`,
    };
  }

  await clickAt(session, cell.x, cell.y);
  await sleep(150);

  const before = cell.currentText;
  if (before.length > 0) {
    await clearFocusedCell(session, cell.rowId, cell.targetIndex, before.length, sleep);
  }
  if (options.text.length > 0) {
    await session.send('Input.insertText', { text: options.text });
  }
  // Any save request sent before this point may only reflect an intermediate state from clearing,
  // never the final text; only a request sent at or after this instant is evidence of anything.
  const finalInputAt = Date.now();

  await waitFor(
    () =>
      lastSaveRequestSentAt !== null &&
      lastSaveRequestSentAt >= finalInputAt &&
      lastSaveRequestId !== null &&
      saveResponsesByRequestId.has(lastSaveRequestId),
    saveTimeoutMs,
    sleep
  );
  // Give a save response that arrives right at the deadline a moment to actually be processed
  // server-side before anything (including the caller closing the browser) can race it.
  await sleep(500);
  const saveResponseStatus =
    lastSaveRequestSentAt !== null && lastSaveRequestSentAt >= finalInputAt && lastSaveRequestId !== null
      ? saveResponsesByRequestId.get(lastSaveRequestId) ?? null
      : null;

  // Re-locate by the row/column identity captured at the initial locate, not by re-matching
  // options.rowAnchorText: when columnOffset is 0, or the anchor cell is itself the one just
  // edited, the anchor text is exactly what changed, so text-based re-lookup can never find it
  // again even though the edit succeeded (confirmed live: reported "cell no longer found" for a
  // perfectly successful clear).
  const readBack = await locateCellById(session, cell.rowId, cell.targetIndex);
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
