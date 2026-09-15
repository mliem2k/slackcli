import { describe, expect, it } from 'bun:test';
import { buildCellLocatorExpression, editCanvasCell } from './canvas-editor';
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
}

function makeFakeSession(opts: FakeOptions): { session: CdpSession; calls: Array<{ method: string; params?: any }> } {
  const calls: Array<{ method: string; params?: any }> = [];
  const handlers = new Map<string, Array<(params: any) => void>>();
  let locatorIndex = 0;
  let navigateCount = 0;
  let scrollStepCount = 0;

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

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('scrollBy')) {
          scrollStepCount += 1;
          const atBottom = scrollStepCount >= (opts.scrollStepsBeforeBottom ?? 0);
          return { result: { value: { scrolled: !atBottom, atBottom } } } as T;
        }
        if (expression.includes('selectAllChildren')) {
          return { result: { value: true } } as T;
        }
        if (!expression.startsWith('(() => {')) {
          const ready =
            opts.loadReadyAfterNavigateCount !== undefined
              ? navigateCount >= opts.loadReadyAfterNavigateCount
              : opts.loadReady !== false;
          return { result: { value: ready } } as T;
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
    // Select-all-in-cell via JS, then a single Backspace (keyDown+keyUp) to delete it.
    expect(methods.filter((m) => m === 'Input.dispatchKeyEvent').length).toBe(2);
    expect(
      calls.some(
        (c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('selectAllChildren')
      )
    ).toBe(true);
    expect(calls.find((c) => c.method === 'Input.insertText')?.params).toEqual({ text: 'Done' });
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
