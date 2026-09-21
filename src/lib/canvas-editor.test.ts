import { describe, expect, it } from 'bun:test';
import { SCROLL_CONTAINER_STEP_EXPRESSION, buildCellLocatorExpression, editCanvasCell } from './canvas-editor';
import type { CdpSession } from './cdp-client';

// --- buildCellLocatorExpression, evaluated against a hand-built fake DOM ---
// so the row/column indexing logic is checked directly, with no CDP or
// browser involved.

function makeFakeTd(rowId: string, text: string) {
  const editable = {
    textContent: text,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 50, height: 20 }),
  };
  return {
    getAttribute: (name: string) => (name === 'data-row-id' ? rowId : null),
    querySelector: (sel: string) => (sel === '.table-cell-content' ? editable : null),
  };
}

function locate(rowAnchorText: string, columnOffset: number, tds: unknown[]): any {
  const fakeDocument = { querySelectorAll: (sel: string) => (sel === 'td.table-cell' ? tds : []) };
  const expression = buildCellLocatorExpression(rowAnchorText, columnOffset);
  const fn = new Function('document', `return ${expression};`);
  return fn(fakeDocument);
}

describe('buildCellLocatorExpression', () => {
  const row1 = [makeFakeTd('row_1', 'Michael'), makeFakeTd('row_1', 'Working'), makeFakeTd('row_1', '')];
  const row2 = [makeFakeTd('row_2', 'Kevin'), makeFakeTd('row_2', ''), makeFakeTd('row_2', '')];
  const table = [...row1, ...row2];

  it('finds the anchor cell itself at offset 0', () => {
    const result = locate('Michael', 0, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('Michael');
  });

  it('finds a cell to the right of the anchor', () => {
    const result = locate('Michael', 1, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('Working');
  });

  it('finds an empty cell to the right of the anchor', () => {
    const result = locate('Michael', 2, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('');
  });

  it('does not bleed into a different row', () => {
    // row2 also has an offset-1 cell; a bug that filters on index within the
    // whole table instead of within the matched row would return Kevin's.
    const result = locate('Kevin', 1, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('');
  });

  it('reports row_not_found for text that matches no cell', () => {
    const result = locate('Nobody', 0, table);
    expect(result).toEqual({ found: false, reason: 'row_not_found' });
  });

  it('reports column_out_of_range past the end of the row', () => {
    const result = locate('Michael', 5, table);
    expect(result).toEqual({ found: false, reason: 'column_out_of_range' });
  });

  it('reports column_out_of_range before the start of the row', () => {
    const result = locate('Michael', -1, table);
    expect(result).toEqual({ found: false, reason: 'column_out_of_range' });
  });
});

// --- excludeRowIds, the disambiguation primitive occurrence support is built on ---
// A short cell value (a name, a role) commonly repeats across unrelated tables in one long
// canvas; without this, the locator always returns the first match, silently pointing an edit
// at the wrong row.

describe('buildCellLocatorExpression with excludeRowIds', () => {
  const row1 = [makeFakeTd('row_1', 'Michael'), makeFakeTd('row_1', 'Old work')];
  const row2 = [makeFakeTd('row_2', 'Michael'), makeFakeTd('row_2', 'New work')];
  const table = [...row1, ...row2];

  function locateExcluding(rowAnchorText: string, columnOffset: number, tds: unknown[], excludeRowIds: string[]): any {
    const fakeDocument = { querySelectorAll: (sel: string) => (sel === 'td.table-cell' ? tds : []) };
    const expression = buildCellLocatorExpression(rowAnchorText, columnOffset, excludeRowIds);
    const fn = new Function('document', `return ${expression};`);
    return fn(fakeDocument);
  }

  it('returns the first match when nothing is excluded', () => {
    const result = locateExcluding('Michael', 1, table, []);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('Old work');
    expect(result.rowId).toBe('row_1');
  });

  it('skips an excluded row and returns the next match', () => {
    const result = locateExcluding('Michael', 1, table, ['row_1']);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('New work');
    expect(result.rowId).toBe('row_2');
  });

  it('reports row_not_found once every matching row is excluded', () => {
    const result = locateExcluding('Michael', 1, table, ['row_1', 'row_2']);
    expect(result).toEqual({ found: false, reason: 'row_not_found' });
  });

  it('excluding an unrelated rowId does not affect the match', () => {
    const result = locateExcluding('Michael', 1, table, ['row_does_not_exist']);
    expect(result.found).toBe(true);
    expect(result.rowId).toBe('row_1');
  });
});

// --- SCROLL_CONTAINER_STEP_EXPRESSION, evaluated against a hand-built fake DOM ---
// with multiple candidate scrollable elements, mirroring what the real Sprint canvas page
// actually contains: several small unrelated scrollable widgets alongside the true virtualized
// content pane.

function makeFakeScrollable(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  const el = {
    scrollHeight,
    clientHeight,
    scrollTop,
    scrollBy(_x: number, y: number) {
      const max = scrollHeight - clientHeight;
      el.scrollTop = Math.max(0, Math.min(max, el.scrollTop + y));
    },
  };
  return el;
}

function runScrollStep(candidates: unknown[]): any {
  const fakeDocument = { querySelectorAll: (sel: string) => (sel === '*' ? candidates : []) };
  const fn = new Function('document', `return ${SCROLL_CONTAINER_STEP_EXPRESSION};`);
  return fn(fakeDocument);
}

describe('SCROLL_CONTAINER_STEP_EXPRESSION', () => {
  it('scrolls the candidate with the largest overflow, not the first DOM match', () => {
    // Real values captured from the live Sprint canvas: a small scrollbar wrapper happens to
    // appear first in document order, while the true content pane (by far the largest gap
    // between scrollHeight and clientHeight) appears second.
    const scrollbarWrapper = makeFakeScrollable(365, 307);
    const contentPane = makeFakeScrollable(32775, 310);
    const result = runScrollStep([scrollbarWrapper, contentPane]);

    expect(result.scrolled).toBe(true);
    expect(contentPane.scrollTop).toBeGreaterThan(0);
    expect(scrollbarWrapper.scrollTop).toBe(0);
  });

  it('does not report atBottom just because a small unrelated widget is already maxed out', () => {
    const scrollbarWrapper = makeFakeScrollable(365, 307, 58); // already at its own bottom
    const contentPane = makeFakeScrollable(32775, 310, 0); // real content, nowhere near the bottom
    const result = runScrollStep([scrollbarWrapper, contentPane]);

    expect(result.atBottom).toBe(false);
  });

  it('reports atBottom once the true content pane itself is exhausted', () => {
    const contentPane = makeFakeScrollable(32775, 310, 32775 - 310 - 1); // one step from the end
    const result = runScrollStep([contentPane]);

    expect(result.atBottom).toBe(true);
  });

  it('returns scrolled false and atBottom true when nothing on the page is scrollable', () => {
    const result = runScrollStep([]);
    expect(result).toEqual({ scrolled: false, atBottom: true });
  });
});

// --- editCanvasCell orchestration, against a fake CdpSession ---

interface FakeOptions {
  loadReady?: boolean;
  /** Load check reports ready only once at least this many Page.navigate calls have fired. */
  loadReadyAfterNavigateCount?: number;
  locatorResults: Array<{ found: true; x: number; y: number; currentText: string } | { found: false; reason: string }>;
  /** Fire a matching request + response pair for the edit-document save on the click. */
  fireSaveRequestOnClick?: boolean;
  /** HTTP status of the simulated save response. Defaults to 200 (success) when firing. */
  saveResponseStatus?: number;
  /** Scroll-step probes report "moved, not at bottom" until this many scroll calls have fired. */
  scrollStepsBeforeBottom?: number;
  /** Simulates a click that landed mid-content: Backspace batches alone never report empty, only Delete does. */
  requireDeleteToEmpty?: boolean;
}

function makeFakeSession(opts: FakeOptions): { session: CdpSession; calls: Array<{ method: string; params?: any }> } {
  const calls: Array<{ method: string; params?: any }> = [];
  const handlers = new Map<string, Array<(params: any) => void>>();
  let locatorIndex = 0;
  let navigateCount = 0;
  let scrollStepCount = 0;
  // The clear loop presses Backspace/Delete and re-locates in between: once clearing has
  // started (and before the replacement text is typed), every locate call reports the cell
  // empty, exactly as the real editor would once enough keypresses have landed. This keeps
  // clearFocusedCell's own batch/retry mechanics out of the locatorResults sequence, which
  // otherwise only needs to describe the state before clicking and after typing.
  let backspacePressed = false;
  let deletePressed = false;
  let insertedText = false;

  const session: CdpSession = {
    on(method, handler) {
      const list = handlers.get(method);
      if (list) list.push(handler);
      else handlers.set(method, [handler]);
    },
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });

      if (method === 'Page.navigate') {
        navigateCount += 1;
      }

      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Backspace') backspacePressed = true;
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Delete') deletePressed = true;
      const clearingStarted = opts.requireDeleteToEmpty ? deletePressed : backspacePressed || deletePressed;
      if (method === 'Input.insertText') {
        insertedText = true;
      }

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('scrollBy')) {
          scrollStepCount += 1;
          const atBottom = scrollStepCount >= (opts.scrollStepsBeforeBottom ?? 0);
          return { result: { value: { scrolled: !atBottom, atBottom } } } as T;
        }
        if (!expression.startsWith('(() => {')) {
          const ready =
            opts.loadReadyAfterNavigateCount !== undefined
              ? navigateCount >= opts.loadReadyAfterNavigateCount
              : opts.loadReady !== false;
          return { result: { value: ready } } as T;
        }
        if (clearingStarted && !insertedText) {
          return { result: { value: { found: true, x: 10, y: 20, currentText: '' } } } as T;
        }
        const value = opts.locatorResults[Math.min(locatorIndex, opts.locatorResults.length - 1)];
        locatorIndex += 1;
        return { result: { value } } as T;
      }

      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed' && opts.fireSaveRequestOnClick) {
        const requestId = 'save-request-1';
        for (const handler of handlers.get('Network.requestWillBeSent') ?? []) {
          handler({ requestId, request: { url: 'https://team.slack.com/canvas/-/edit-document?_x_version_ts=1' } });
        }
        for (const handler of handlers.get('Network.responseReceived') ?? []) {
          handler({ requestId, response: { status: opts.saveResponseStatus ?? 200 } });
        }
      }

      return {} as T;
    },
    close() {},
  };

  return { session, calls };
}

const instantSleep = () => Promise.resolve();

describe('editCanvasCell', () => {
  it('re-locates by row id after the initial find, not by re-matching the anchor text', async () => {
    // Reproduces a real live bug: with columnOffset 0, the anchor IS the cell being edited, so
    // once its text changes, a text-based re-lookup for the readback can never find it again
    // even though the edit succeeded ("cell no longer found" reported for a clean clear).
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working', rowId: 'row_abc123', targetIndex: 2 } as any,
        { found: true, x: 10, y: 20, currentText: 'Done', rowId: 'row_abc123', targetIndex: 2 } as any,
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Working', // same as the cell's own pre-edit text: anchor === target
      columnOffset: 0,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });

    // The final readback is the last Runtime.evaluate call (nothing else touches it after).
    // It must be the id-based locator, not a re-search by the now-stale anchor text: with
    // columnOffset 0 the anchor is the cell itself, so once its text actually changed a
    // text-based re-lookup could never find it again even though the edit succeeded.
    const evaluateCalls = calls.filter((c) => c.method === 'Runtime.evaluate');
    const lastExpression = String(evaluateCalls[evaluateCalls.length - 1]?.params?.expression ?? '');
    expect(lastExpression).toContain('CSS.escape');
    expect(lastExpression).toContain('row_abc123');
    expect(lastExpression).not.toContain('rowAnchorText');
  });
  it('clicks the located cell, clears it, types the replacement, and confirms the save', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });

    const methods = calls.map((c) => c.method);
    expect(methods).toContain('Page.navigate');
    expect(calls.find((c) => c.method === 'Page.navigate')?.params?.url).toBe(
      'https://app.slack.com/client/T1/unified-files/doc/F1'
    );
    expect(methods.filter((m) => m === 'Input.dispatchMouseEvent')).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    // One full batch of 20 Backspace presses (keyDown+keyUp each = 40 events) fires before the
    // fake session reports the cell empty; "Working" (7 chars) never needs a second batch.
    const keyEvents = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keyEvents).toHaveLength(40);
    expect(keyEvents.every((c) => c.params?.key === 'Backspace')).toBe(true);
    expect(calls.find((c) => c.method === 'Input.insertText')?.params).toEqual({ text: 'Done' });
  });

  it('falls back to Delete when Backspace alone cannot reach content after the click point', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnClick: true,
      requireDeleteToEmpty: true, // the click landed before some content; only Delete clears it
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });
    const keyEvents = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keyEvents.some((c) => c.params?.key === 'Backspace')).toBe(true);
    expect(keyEvents.some((c) => c.params?.key === 'Delete')).toBe(true);
  });

  it('skips the clear sequence when the cell was already empty', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: '' },
        { found: true, x: 10, y: 20, currentText: 'Working' },
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 3,
      text: 'Working',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: '', after: 'Working' });
    expect(calls.filter((c) => c.method === 'Input.dispatchKeyEvent')).toHaveLength(0);
  });

  it('fails with row_not_found without touching the page', async () => {
    const { session, calls } = makeFakeSession({ locatorResults: [{ found: false, reason: 'row_not_found' }] });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Nobody',
      columnOffset: 0,
      text: 'x',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('row_not_found');
    expect(calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(calls.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('fails with column_out_of_range without touching the page', async () => {
    const { session, calls } = makeFakeSession({ locatorResults: [{ found: false, reason: 'column_out_of_range' }] });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 99,
      text: 'x',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('column_out_of_range');
    expect(calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('fails with canvas_load_timeout when the table never renders', async () => {
    const { session } = makeFakeSession({ loadReady: false, locatorResults: [] });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 0,
      text: 'x',
      loadTimeoutMs: 1,
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('canvas_load_timeout');
  });

  it('recovers from a slow first load by re-navigating once before giving up', async () => {
    const { session, calls } = makeFakeSession({
      loadReadyAfterNavigateCount: 2, // not ready after the initial navigate, ready after the retry navigate
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 0,
      text: 'Done',
      loadTimeoutMs: 1,
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(2);
  });

  it('finds a row that only mounts after scrolling a virtualized canvas', async () => {
    const { session, calls } = makeFakeSession({
      // Not found on the first two locate attempts (row lives further down, not yet mounted),
      // found on the third, after two scroll steps.
      locatorResults: [
        { found: false, reason: 'row_not_found' },
        { found: false, reason: 'row_not_found' },
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      scrollStepsBeforeBottom: 5, // plenty of room; the row is found before the container bottoms out
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 0,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });
    // Two scroll steps before the third locate call finds it.
    expect(calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollBy'))).toHaveLength(2);
  });

  it('gives up with row_not_found once the scroll container bottoms out', async () => {
    const { session } = makeFakeSession({
      locatorResults: [{ found: false, reason: 'row_not_found' }],
      scrollStepsBeforeBottom: 1, // already at the bottom on the first scroll step
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Nobody',
      columnOffset: 0,
      text: 'x',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('row_not_found');
  });

  it('fails with save_not_confirmed when the cell reads back unchanged', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Working' }, // readback: edit never applied
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('save_not_confirmed');
      expect(result.message).toContain('Cell now reads');
    }
  });

  it('fails with save_not_confirmed when the save request gets a non-2xx response', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' }, // DOM shows the edit applied locally...
      ],
      fireSaveRequestOnClick: true,
      saveResponseStatus: 409, // ...but the server rejected the save (e.g. a version conflict)
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('save_not_confirmed');
      expect(result.message).toContain('409');
    }
  });

  it('edits the second occurrence of a repeated anchor, not the first', async () => {
    // Reproduces the real hazard this option exists for: "Michael" matching an already-filled
    // historical row before the intended blank one further down the same canvas. Without
    // occurrence support, this would click and clear row_1's real content instead of row_2's.
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 5, y: 5, currentText: 'Old work', rowId: 'row_1', targetIndex: 1 } as any,
        { found: true, x: 10, y: 20, currentText: 'New work', rowId: 'row_2', targetIndex: 1 } as any,
        { found: true, x: 10, y: 20, currentText: 'Done', rowId: 'row_2', targetIndex: 1 } as any,
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      occurrence: 2,
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'New work', after: 'Done' });
    // The click must land on the second occurrence's coordinates, never the first's, proof the
    // skipped-over row was never touched.
    const click = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
    expect(click?.params).toMatchObject({ x: 10, y: 20 });
  });

  it('defaults to occurrence 1 (the first match) when occurrence is not specified', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 5, y: 5, currentText: 'Old work' },
        { found: true, x: 5, y: 5, currentText: 'Done' },
      ],
      fireSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Old work', after: 'Done' });
    const click = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
    expect(click?.params).toMatchObject({ x: 5, y: 5 });
  });

  it('fails with row_not_found, and names the occurrence, when fewer matches exist than requested', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 5, y: 5, currentText: 'Old work', rowId: 'row_1', targetIndex: 1 } as any,
        { found: true, x: 10, y: 20, currentText: 'New work', rowId: 'row_2', targetIndex: 1 } as any,
        { found: false, reason: 'row_not_found' },
      ],
      scrollStepsBeforeBottom: 1, // already at the bottom by the time the third locate comes up empty
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      occurrence: 3,
      columnOffset: 1,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('row_not_found');
      expect(result.message).toContain('occurrence 3');
    }
  });

  it('fails with save_not_confirmed when no autosave request is observed', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnClick: false,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      saveTimeoutMs: 1,
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('save_not_confirmed');
      expect(result.message).toContain('no save response');
    }
  });
});
