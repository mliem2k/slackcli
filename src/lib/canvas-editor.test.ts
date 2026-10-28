import { describe, expect, it } from 'bun:test';
import { SCROLL_CONTAINER_STEP_EXPRESSION, buildCellLocatorExpression, editCanvasCell } from './canvas-editor';
import type { CdpSession } from './cdp-client';

// --- buildCellLocatorExpression, evaluated against a hand-built fake DOM ---
// so the row/column indexing logic is checked directly, with no CDP or
// browser involved.

function makeFakeTd(rowId: string, text: string) {
  const editable = {
    textContent: text,
    // No <p class="line"> children: a plain single-line cell, matching every existing fixture
    // here. cellText() falls back to .textContent whenever this returns 0 or 1 results.
    querySelectorAll: (_sel: string) => [],
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

function makeFakeHeading(text: string) {
  return { getAttribute: (name: string) => (name === 'role' ? 'heading' : null), textContent: text };
}

function locateUnder(rowAnchorText: string, columnOffset: number, underHeading: string, nodes: unknown[]): any {
  const tds = nodes.filter((node: any) => node.getAttribute('role') !== 'heading');
  const fakeDocument = {
    querySelectorAll: (sel: string) =>
      sel === 'td.table-cell' ? tds : sel === 'td.table-cell, .section[role="heading"]' ? nodes : [],
  };
  const expression = buildCellLocatorExpression(rowAnchorText, columnOffset, [], underHeading);
  return new Function('document', `return ${expression};`)(fakeDocument);
}

describe('buildCellLocatorExpression under a heading', () => {
  const weekOne = [makeFakeHeading('Week #1'), ...[0, 1, 2, 3, 4, 5].map((i) => makeFakeTd('row_w1', i === 0 ? 'Michael' : `w1c${i}`))];
  const weekTwo = [makeFakeHeading('Week #2'), makeFakeTd('row_w2', 'Michael'), makeFakeTd('row_w2', 'w2c1')];
  const nodes = [...weekOne, ...weekTwo];

  it('finds the row under the named heading, not the first row with the same text', () => {
    const result = locateUnder('Michael', 1, 'Week #2', nodes);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('w2c1');
    expect(result.rowId).toBe('row_w2');
  });

  it('reports out of range for a narrow row under the heading instead of moving to another table', () => {
    const result = locateUnder('Michael', 4, 'Week #2', nodes);
    expect(result).toEqual({ found: false, reason: 'column_out_of_range', rowId: 'row_w2', rowCellCount: 2 });
  });

  it('reports row_not_found when no table sits under that heading', () => {
    expect(locateUnder('Michael', 1, 'Week #9', nodes)).toEqual({ found: false, reason: 'row_not_found' });
  });

  it('ignores a heading styled paragraph inside a table cell', () => {
    const cellHeading = {
      getAttribute: (name: string) => (name === 'role' ? 'heading' : null),
      textContent: 'Today\'s Plan',
      closest: (sel: string) => (sel === 'td.table-cell' ? {} : null),
    };
    const result = locateUnder('Michael', 1, 'Week #2', [...weekOne, cellHeading, ...weekTwo.slice(0, 0), makeFakeHeading('Week #2'), cellHeading, makeFakeTd('row_w2', 'Michael'), makeFakeTd('row_w2', 'w2c1')]);
    expect(result.rowId).toBe('row_w2');
    expect(result.currentText).toBe('w2c1');
  });

  it('keeps today\'s behaviour without a heading', () => {
    expect(locateUnder('Michael', 4, '', nodes).rowId).toBe('row_w1');
  });
});

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

  it('reports column_out_of_range past the end of the row, with the row id and cell count so the caller can exclude it once confirmed stable', () => {
    const result = locate('Michael', 5, table);
    expect(result).toEqual({ found: false, reason: 'column_out_of_range', rowId: 'row_1', rowCellCount: 3 });
  });

  it('reports column_out_of_range before the start of the row, with the row id and cell count so the caller can exclude it once confirmed stable', () => {
    const result = locate('Michael', -1, table);
    expect(result).toEqual({ found: false, reason: 'column_out_of_range', rowId: 'row_1', rowCellCount: 3 });
  });
});

// --- multi-line cells: two different DOM shapes hold a cell's lines depending on whether it is
// currently focused for editing, and plain .textContent concatenates either one's children with
// no separator at all, silently dropping every line break on readback ---
//
// At rest (never clicked into), a multi-line cell renders each line as a sibling <p class="line">.
// The moment it is focused for editing, confirmed live via a diagnostic script instrumenting the
// real DOM after each step, it re-renders into a different shape instead: each line becomes its
// own sibling .section, and each .section wraps exactly one .content div holding that line's text
// (true even for a single-line cell, which still gets wrapped in one .section > .content once
// focused). A readback taken right after an edit is checking a cell that is still focused, so it
// needs the .section shape, not <p>; an earlier version of this checked only 'p', always found
// zero elements on a just-edited cell, and silently fell back to the run-on .textContent.

function makeFakeSectionTd(rowId: string, lines: string[]) {
  const sectionContents = lines.map((text) => ({ textContent: text }));
  const editable = {
    textContent: lines.join(''), // what plain .textContent would report, no separator
    querySelectorAll: (sel: string) => (sel === ':scope > .section > .content' ? sectionContents : []),
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 50, height: 20 }),
  };
  return {
    getAttribute: (name: string) => (name === 'data-row-id' ? rowId : null),
    querySelector: (sel: string) => (sel === '.table-cell-content' ? editable : null),
  };
}

function makeFakeParagraphTd(rowId: string, lines: string[]) {
  const paragraphs = lines.map((text) => ({ textContent: text }));
  const editable = {
    textContent: lines.join(''), // what plain .textContent would report, no separator
    querySelectorAll: (sel: string) => (sel === 'p' ? paragraphs : []),
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 50, height: 20 }),
  };
  return {
    getAttribute: (name: string) => (name === 'data-row-id' ? rowId : null),
    querySelector: (sel: string) => (sel === '.table-cell-content' ? editable : null),
  };
}

describe('buildCellLocatorExpression with multi-line cells', () => {
  it('joins sibling .section > .content lines with a newline (the focused/editing shape)', () => {
    const table = [
      makeFakeTd('row_1', 'Michael'),
      makeFakeSectionTd('row_1', ['fix: [F22-6659] one thing', 'fix: [F22-6531] another thing']),
    ];
    const result = locate('Michael', 1, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('fix: [F22-6659] one thing\nfix: [F22-6531] another thing');
  });

  it('joins sibling <p> lines with a newline (the at-rest/unfocused shape)', () => {
    const table = [
      makeFakeTd('row_1', 'Michael'),
      makeFakeParagraphTd('row_1', ['fix: [F22-6659] one thing', 'fix: [F22-6531] another thing']),
    ];
    const result = locate('Michael', 1, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('fix: [F22-6659] one thing\nfix: [F22-6531] another thing');
  });

  it('matches a row-anchor against the newline-joined text, not the run-on .textContent', () => {
    const table = [
      makeFakeSectionTd('row_1', ['Last workday', 'Today\'s plan']),
      makeFakeTd('row_1', 'Tue'),
    ];
    const result = locate("Last workday\nToday's plan", 1, table);
    expect(result.found).toBe(true);
    expect(result.currentText).toBe('Tue');
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
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
    dispatchedEvents: [] as string[],
    dispatchEvent(event: { type: string }) {
      this.dispatchedEvents.push(event.type);
    },
  };
}

function runScrollStep(candidates: unknown[], tableCells: unknown[] = []): any {
  const fakeDocument = {
    querySelectorAll: (sel: string) => (sel === '*' ? candidates : sel === 'td.table-cell' ? tableCells : []),
  };
  const fn = new Function('document', `return ${SCROLL_CONTAINER_STEP_EXPRESSION};`);
  return fn(fakeDocument);
}

describe('SCROLL_CONTAINER_STEP_EXPRESSION', () => {
  it('jumps the candidate with the largest overflow straight to its own bottom', () => {
    // Real values captured from the live Sprint canvas: a small scrollbar wrapper happens to
    // appear first in document order, while the true content pane (by far the largest gap
    // between scrollHeight and clientHeight) appears second. Nudging by a fraction of a viewport
    // was confirmed live to mount nothing at all; only landing exactly on the scroll boundary
    // triggers the reveal, so the assertion is the exact bottom, not merely "moved".
    const scrollbarWrapper = makeFakeScrollable(365, 307);
    const contentPane = makeFakeScrollable(32775, 310);
    const result = runScrollStep([scrollbarWrapper, contentPane]);

    expect(result.found).toBe(true);
    expect(contentPane.scrollTop).toBe(32775 - 310);
    expect(contentPane.dispatchedEvents).toEqual(['scroll']);
    expect(scrollbarWrapper.scrollTop).toBe(0);
    expect(scrollbarWrapper.dispatchedEvents).toEqual([]);
  });

  it('reports the scrollHeight measured before the jump, not after', () => {
    // The caller compares this across consecutive jumps to detect that nothing new mounted; a
    // post-jump reading would compare against an already-grown value and never stabilize.
    const contentPane = makeFakeScrollable(32775, 310);
    const result = runScrollStep([contentPane]);

    expect(result.scrollHeightBeforeJump).toBe(32775);
  });

  it('reports the current mounted cell count alongside scrollHeight', () => {
    // A mount batch whose measured height happens to equal the placeholder it replaced would
    // leave scrollHeight unchanged even though real content mounted; cellCount is the second,
    // independent signal the caller uses so that case is not mistaken for having stabilized.
    const contentPane = makeFakeScrollable(32775, 310);
    const result = runScrollStep([contentPane], [{}, {}, {}]);

    expect(result.cellCount).toBe(3);
  });

  it('ignores elements too small to be the virtualized content pane', () => {
    const tinyOverflow = makeFakeScrollable(400, 380); // 20px gap, under the 50px floor
    const shortViewport = makeFakeScrollable(5000, 150); // viewport under the 200px floor
    const result = runScrollStep([tinyOverflow, shortViewport]);

    expect(result).toEqual({ found: false });
    expect(tinyOverflow.scrollTop).toBe(0);
    expect(shortViewport.scrollTop).toBe(0);
  });

  it('returns found false when nothing on the page is scrollable', () => {
    expect(runScrollStep([])).toEqual({ found: false });
  });
});

// --- editCanvasCell orchestration, against a fake CdpSession ---

interface FakeOptions {
  loadReady?: boolean;
  /** Load check reports ready only once at least this many Page.navigate calls have fired. */
  loadReadyAfterNavigateCount?: number;
  locatorResults: Array<
    | { found: true; x: number; y: number; currentText: string }
    | { found: false; reason: string; rowId?: string; rowCellCount?: number }
  >;
  /** Fire a matching request + response pair for the edit-document save right after the
   *  replacement text is typed, mirroring the real save-race fix: a save fired any earlier (on
   *  the click, mid-clear) is stale and must not satisfy the wait. */
  fireSaveRequestOnInsertText?: boolean;
  /** Fires a save request + response pair on the click, before any clearing or typing happens:
   *  reproduces the real live bug where a debounced autosave triggered mid-Backspace captures a
   *  stale, partially-cleared snapshot and its response lands well before the final text exists. */
  fireStaleSaveRequestOnClick?: boolean;
  /** HTTP status of the simulated save response. Defaults to 200 (success) when firing. */
  saveResponseStatus?: number;
  /** How many scroll jumps fire before the caller recognizes the bottom. Each jump reports a
   *  larger scrollHeight AND cellCount than the last (more content mounted) until the Nth, which
   *  repeats the previous reading on both: two consecutive identical readings on BOTH signals are
   *  the stabilization signal locateCellByScrolling actually stops on, so the smallest meaningful
   *  value is 2 (one jump alone can never establish that nothing changed). Defaults to 2. */
  scrollStepsBeforeBottom?: number;
  /** Overrides cellCount independently of scrollHeightBeforeJump, to simulate a mount whose
   *  measured height happens to equal the placeholder it replaced (scrollHeight stays put while
   *  content still mounts). Called with the 1-indexed jump number; return the cellCount for that
   *  jump. When unset, cellCount tracks scrollHeightBeforeJump's own growth pattern exactly. */
  cellCountForStep?: (stepNumber: number) => number;
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
        if (expression.includes('scrollHeightBeforeJump')) {
          scrollStepCount += 1;
          // Growing reading per jump until the Nth, which repeats the (N-1)th: the caller sees a
          // changing scrollHeight (more content revealed) and keeps going, then two identical
          // readings in a row and stops. Clamping is what produces that repeat.
          const lastFreshStep = (opts.scrollStepsBeforeBottom ?? 2) - 1;
          const scrollHeightBeforeJump = 30_000 + Math.min(scrollStepCount, lastFreshStep) * 500;
          const cellCount = opts.cellCountForStep
            ? opts.cellCountForStep(scrollStepCount)
            : 30 + Math.min(scrollStepCount, lastFreshStep) * 20;
          return { result: { value: { found: true, scrollHeightBeforeJump, cellCount } } } as T;
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

      if (method === 'Input.insertText' && opts.fireSaveRequestOnInsertText) {
        // A real macrotask delay, not a microtask: editCanvasCell reads finalInputAt = Date.now()
        // synchronously right after this call returns, so the fake save's own timestamp must land
        // on a genuinely later tick to be distinguishable, exactly the property the fix checks for.
        setTimeout(() => {
          const requestId = 'save-request-1';
          for (const handler of handlers.get('Network.requestWillBeSent') ?? []) {
            handler({ requestId, request: { url: 'https://team.slack.com/canvas/-/edit-document?_x_version_ts=1' } });
          }
          for (const handler of handlers.get('Network.responseReceived') ?? []) {
            handler({ requestId, response: { status: opts.saveResponseStatus ?? 200 } });
          }
        }, 1);
      }

      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed' && opts.fireStaleSaveRequestOnClick) {
        const requestId = 'stale-save-request';
        for (const handler of handlers.get('Network.requestWillBeSent') ?? []) {
          handler({ requestId, request: { url: 'https://team.slack.com/canvas/-/edit-document?_x_version_ts=1' } });
        }
        for (const handler of handlers.get('Network.responseReceived') ?? []) {
          handler({ requestId, response: { status: 200 } });
        }
      }

      return {} as T;
    },
    close() {},
  };

  return { session, calls };
}

// A macrotask tick, not a bare microtask: waitFor's poll loop calls this between checks, and a
// pure Promise.resolve() never yields to a pending setTimeout-based fake (the save-request timing
// fakes below need one), so a tight poll loop can spin through its whole real-clock deadline
// without that timer ever getting a turn. setTimeout(0) is still effectively instant for test
// purposes, it just actually reaches the macrotask queue instead of starving it.
const instantSleep = () => new Promise<void>((r) => setTimeout(r, 0));

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
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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
      scrollStepsBeforeBottom: 5, // plenty of room; the row is found before the container stabilizes
      fireSaveRequestOnInsertText: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 0,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: 'Working', after: 'Done' });
    // Two scroll jumps before the third locate call finds it.
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(2);
  });

  it('recovers from column_out_of_range once a scroll step mounts the target column', async () => {
    // Reproduces a real live bug: a row whose anchor cell is already mounted (found) but whose
    // trailing cells are all still empty can report column_out_of_range for a cell that genuinely
    // exists, simply because that cell's own .table-cell-content has not mounted yet. The old
    // behavior treated this as definitive and returned immediately, without ever attempting the
    // scroll step that (confirmed live) is exactly what makes the cell locatable.
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: false, reason: 'column_out_of_range' },
        { found: false, reason: 'column_out_of_range' },
        { found: true, x: 10, y: 20, currentText: '' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      scrollStepsBeforeBottom: 5, // plenty of room; the cell mounts before the container stabilizes
      fireSaveRequestOnInsertText: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 2,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: '', after: 'Done' });
    // Two scroll jumps before the third locate call finds the target column.
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(2);
  });

  it('fails on a confirmed too-narrow row by default instead of editing a later table', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 5 },
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 5 },
        { found: true, x: 10, y: 20, currentText: '' },
      ],
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 4,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('column_out_of_range');
    }
    expect(calls.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('rules out a narrower row past occurrence one instead of dead-ending the whole search', async () => {
    // Reproduces a real live bug: a two-column summary table's own name cell can be occurrence 1
    // for an anchor text also used, further down the canvas, by a much wider table's name column
    // (a real Sprint canvas's Workload Summary row versus its own stand-up table row, both named
    // by the same engineer). A column offset only valid on the wider row used to dead-end the
    // WHOLE search the moment it first hit the narrower row, because column_out_of_range carried
    // no rowId for the caller to exclude it by, so nothing ever advanced past occurrence 1
    // regardless of how many wider occurrences existed later in the document.
    const { session, calls } = makeFakeSession({
      locatorResults: [
        // Same rowId AND same rowCellCount twice in a row is what confirms this row is genuinely
        // too narrow, independent of the page-wide scroll stabilization signal.
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 2 },
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 2 },
        { found: true, x: 10, y: 20, currentText: '' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnInsertText: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 2,
      skipNarrowRows: true,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: '', after: 'Done' });
    // One scroll jump between the two identical readings of the narrow row is enough to confirm
    // it, well before the page-wide scroll signal would ever stabilize.
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(1);
  });

  it('does not exclude a row whose own cell count is still growing, even once the page-wide scroll signal has stabilized', async () => {
    // Reproduces the actual live bug this session found: the page-wide stabilization signal
    // (the whole canvas's aggregate scrollHeight/cellCount) can read as unchanged across a jump
    // at the same moment one specific row is still mid-mount, if some unrelated part of the page
    // happened to settle first. A version of this function gated the exclusion decision on that
    // page-wide signal alone and wrongly ruled row-growing out the moment the page-wide signal
    // first stabilized (after 2 jumps here), regardless of row-growing's own cell count still
    // visibly climbing (2, then 5, then 7). The fix keeps re-checking (and re-scrolling for) the
    // SAME row until its own reading repeats, not the page's.
    //
    // The two versions converge on the identical final result value here (a downstream `found:
    // true` entry the fake session serves next either way, since the fake has no real DOM to
    // make exclusion actually filter anything out), so the property this pins is observable only
    // in HOW MANY scroll jumps ran before that same entry was reached: the old, page-wide-gated
    // version stops scrolling and excludes as soon as it sees stabilized=true (2 jumps), while
    // the fix keeps scrolling until row-growing's own count repeats (3 jumps, since 7 is read
    // twice only on the third and fourth locate calls). A regression back to gating on the
    // page-wide signal alone would make this assert 2, not 3.
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: false, reason: 'column_out_of_range', rowId: 'row-growing', rowCellCount: 2 },
        { found: false, reason: 'column_out_of_range', rowId: 'row-growing', rowCellCount: 5 },
        { found: false, reason: 'column_out_of_range', rowId: 'row-growing', rowCellCount: 7 },
        { found: true, x: 10, y: 20, currentText: '' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      // The page-wide signal stabilizes after the second jump (it repeats the first jump's
      // reading), long before row-growing's own cell count (2, then 5, then 7) stops climbing.
      scrollStepsBeforeBottom: 2,
      fireSaveRequestOnInsertText: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 2,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, before: '', after: 'Done' });
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(3);
  });

  it('does not let an excluded too-narrow row shift the occurrence numbering of the rows after it', async () => {
    // Reproduces a real live bug found immediately after the exclusion fix above shipped: a
    // caller who requests occurrence 2 wants the SECOND row where columnOffset actually
    // resolves, not the second anchor-text match counting a too-narrow row that never resolved
    // at all. Ruling out row-narrow (see the test above) must not consume a slot in the count,
    // or every occurrence past it silently shifts by one, exactly what happened live: a request
    // for a specific week's row in a real Sprint stand-up canvas landed one row later than
    // intended, because an unrelated two-column summary table earlier in the document happened
    // to share the same anchor text and got excluded, but the exclusion itself was still being
    // counted toward the occurrence the caller asked for.
    const { session } = makeFakeSession({
      locatorResults: [
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 2 },
        { found: false, reason: 'column_out_of_range', rowId: 'row-narrow', rowCellCount: 2 },
        { found: true, x: 10, y: 20, currentText: 'first-valid-row' },
        { found: true, x: 10, y: 20, currentText: 'second-valid-row' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnInsertText: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      occurrence: 2,
      columnOffset: 2,
      skipNarrowRows: true,
      text: 'Done',
      sleep: instantSleep,
    });

    // If row-narrow's exclusion had counted toward the occurrence, this would have stopped at
    // first-valid-row (the second anchor match overall) instead of second-valid-row (the second
    // match where columnOffset actually resolves, which is what occurrence 2 is supposed to mean).
    expect(result).toEqual({ ok: true, before: 'second-valid-row', after: 'Done' });
  });

  it('reports the excluded row as too narrow instead of row_not_found when it was the only match', async () => {
    // Reproduces a second real live bug, found right after the occurrence-shifting fix above: once
    // the sole anchor-text match is confirmed too narrow and excluded (two identical
    // column_out_of_range readings for the same rowId), the next locate call has nothing left to
    // find and reports a bare row_not_found. Without the lastExcludedNarrowRowDiagnosis fallback,
    // that row_not_found becomes the caller-facing answer verbatim: "No cell in the canvas contains
    // the exact text ...", even though the row was just found and specifically confirmed to exist,
    // one column too narrow for the request. The honest answer is the column_out_of_range message.
    const { session } = makeFakeSession({
      locatorResults: [
        { found: false, reason: 'column_out_of_range', rowId: 'only-row', rowCellCount: 2 },
        { found: false, reason: 'column_out_of_range', rowId: 'only-row', rowCellCount: 2 },
        { found: false, reason: 'row_not_found' },
      ],
      scrollStepsBeforeBottom: 2,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'OnlyRow',
      columnOffset: 10,
      text: 'Done',
      sleep: instantSleep,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'column_out_of_range',
      message: 'Found the row for "OnlyRow", but column offset 10 is out of range for it.',
    });
  });

  it('gives up with row_not_found once two consecutive jumps reveal nothing new', async () => {
    const { session, calls } = makeFakeSession({
      locatorResults: [{ found: false, reason: 'row_not_found' }],
      scrollStepsBeforeBottom: 2, // second jump repeats the first jump's scrollHeight: stabilized
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
    // Exactly two: the reason for stopping must be the repeated scrollHeight, not the deadline.
    // Without the stabilization check this keeps jumping until loadTimeoutMs expires and still
    // reports row_not_found, so the reason assertion alone cannot tell the two apart.
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(2);
  });

  it('does not stabilize on a repeated scrollHeight alone while cellCount keeps changing', async () => {
    // Reproduces a real hazard: a mount batch whose measured height happens to equal the
    // placeholder it replaced leaves scrollHeight unchanged even though content genuinely mounted.
    // scrollHeight repeats from the very first jump here; cellCount is what actually keeps moving
    // and is what the loop must wait on before giving up.
    const { session, calls } = makeFakeSession({
      locatorResults: [{ found: false, reason: 'row_not_found' }],
      cellCountForStep: (step) => (step >= 4 ? 90 : 30 + step * 20), // stabilizes on cellCount at jump 4
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
    // Four jumps, not the two a scrollHeight-only check would have stopped at: scrollHeight alone
    // repeats from jump 1 onward here, so a check ignoring cellCount would give up after jump 2.
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(4);
  });

  it('labels a search that ran out of time as such, not as a completed scroll to the bottom', async () => {
    // A deadline cutoff and a genuinely confirmed absence must not read the same to the caller:
    // the row may still exist further down when the search simply ran out of time.
    const { session } = makeFakeSession({
      locatorResults: [{ found: false, reason: 'row_not_found' }],
      scrollStepsBeforeBottom: 1000, // never stabilizes within the microscopic deadline below
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Nobody',
      columnOffset: 0,
      text: 'x',
      loadTimeoutMs: 1,
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('row_not_found');
      expect(result.message).toContain('ran out of time');
      expect(result.message).not.toContain('scrolled to the bottom');
    }
  });

  it('fails with save_not_confirmed when the cell reads back unchanged', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Working' }, // readback: edit never applied
      ],
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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

  it('rejects a save response that arrived before the final text existed, even a 2xx one', async () => {
    // Reproduces a real live bug: Slack's autosave is debounced and fires WHILE clearing, not
    // only once the final text lands, so a long clear+replace reliably produces an early save
    // request mid-Backspace that captures a partially-cleared, stale snapshot with a perfectly
    // successful 2xx response, well before the real edit finishes. A check that accepts the first
    // save response it ever sees is satisfied by that stale one; the DOM readback below is
    // genuinely correct at that moment, so a naive check reports ok:true while what actually
    // persists server-side is the intermediate text. No second save is fired here at all, so a
    // correct fix must time out waiting for one, not succeed on the stale one.
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireStaleSaveRequestOnClick: true,
    });

    const result = await editCanvasCell(session, {
      canvasUrl: 'https://app.slack.com/client/T1/unified-files/doc/F1',
      rowAnchorText: 'Michael',
      columnOffset: 1,
      text: 'Done',
      saveTimeoutMs: 5,
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('save_not_confirmed');
      expect(result.message).toContain('no save response');
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
      fireSaveRequestOnInsertText: true,
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
      fireSaveRequestOnInsertText: true,
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
    const { session, calls } = makeFakeSession({
      locatorResults: [
        { found: true, x: 5, y: 5, currentText: 'Old work', rowId: 'row_1', targetIndex: 1 } as any,
        { found: true, x: 10, y: 20, currentText: 'New work', rowId: 'row_2', targetIndex: 1 } as any,
        { found: false, reason: 'row_not_found' },
      ],
      scrollStepsBeforeBottom: 2, // stabilizes on the second jump, with only two matches ever found
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
    expect(
      calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('scrollHeightBeforeJump'))
    ).toHaveLength(2);
  });

  it('fails with save_not_confirmed when no autosave request is observed', async () => {
    const { session } = makeFakeSession({
      locatorResults: [
        { found: true, x: 10, y: 20, currentText: 'Working' },
        { found: true, x: 10, y: 20, currentText: 'Done' },
      ],
      fireSaveRequestOnInsertText: false,
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
