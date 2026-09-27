/**
 * Tests for the pure half of the webview's derived state.
 *
 * WHY THESE ARE PLAIN FUNCTION CALLS AND NOT RENDERED COMPONENTS
 * --------------------------------------------------------------
 * `components/graphState.ts` is split in two on purpose: a reducer and a set of
 * helpers that are pure functions of their arguments, and `useMemo` wrappers
 * around them. This file exercises the pure half directly, in a bare Node
 * process, with no DOM, no jsdom, and no testing-library. That is not a
 * limitation — it is the reason the split exists: the message protocol and the
 * filter algebra are the parts most likely to be wrong and hardest to reproduce
 * by hand, and they can be exhaustively checked in milliseconds.
 *
 * The hooks themselves are one-line delegations to `core/`, which has its own
 * test files (`layout.test.ts`, `filter.test.ts`, `graphStats.test.ts`); wrapping
 * a `useMemo` in a test would only assert that React works.
 */

import { describe, expect, it } from 'vitest';
import type { WebviewGraphPayload } from '../../src/types';
import { EDGE_TYPES } from '../../src/webview/client/core/domain';
import { availableFilterOptions } from '../../src/webview/client/core/filter';
import { ancestryPath } from '../../src/webview/client/core/graph-stats';
import { computeLayout } from '../../src/webview/client/core/layout';
import { generateTimeTicks } from '../../src/webview/client/core/timeline';
import {
  ancestryReducer,
  CLASSIFICATIONS,
  createInitialUiState,
  dateInputValue,
  DAY_MS,
  defaultStatus,
  EDGE_LABELS,
  endOfDayUtc,
  filterForEdgeTypes,
  nodeHint,
  parseDateInput,
  patchFilter,
  resetFilter,
  safeRatio,
  shortCommitOf,
  similarityLabel,
  similarityPercent,
  timestampRange,
  toggleListValue,
  xTickPercentages,
  yRowPlacements,
  type AncestryAction,
  type AncestryUiState,
} from '../../src/webview/client/components/graphState';
import { DAY, makeChainGraph, makeGraph, makeNode, T0 } from './fixtures';

/** A payload wrapper, as the host sends it. */
function payloadOf(graph: ReturnType<typeof makeGraph>): WebviewGraphPayload {
  return {
    graph,
    focusSource: 'function service() {}',
    engineVersion: '0.1.0',
    stats: { durationMs: 1234, cacheHits: 12, cacheMisses: 3 },
  };
}

/** Folds a list of actions from the initial state. */
function reduce(actions: readonly AncestryAction[], from?: AncestryUiState): AncestryUiState {
  return actions.reduce(ancestryReducer, from ?? createInitialUiState());
}

// ---------------------------------------------------------------------------
// the reducer
// ---------------------------------------------------------------------------

describe('ancestryReducer — initial state', () => {
  const state = createInitialUiState();

  it('starts empty but usable', () => {
    expect(state.graph).toBeNull();
    expect(state.filter).toEqual({});
    expect(state.selectedId).toBeNull();
    expect(state.highlightIds).toEqual([]);
    expect(state.loading).toBeNull();
    expect(state.error).toBeNull();
    expect(state.focusRequest).toBeNull();
    expect(state.fitToken).toBe(0);
    expect(state.view).toEqual({ labels: true, edges: true });
  });

  it('is independent between calls (no shared mutable default)', () => {
    const a = createInitialUiState();
    const b = createInitialUiState();
    expect(a).not.toBe(b);
    expect(a.highlightIds).not.toBe(b.highlightIds);
  });
});

describe('ancestryReducer — init and graph', () => {
  const graph = makeChainGraph();

  it('installs the graph, the focus source and the run stats', () => {
    const state = reduce([{ type: 'host', message: { type: 'init', payload: payloadOf(graph) } }]);
    expect(state.graph).toBe(graph);
    expect(state.focusSource).toBe('function service() {}');
    expect(state.runStats).toEqual({ durationMs: 1234, cacheHits: 12, cacheMisses: 3 });
  });

  it('widens the filter to the graph defaults, not to an empty filter', () => {
    const state = reduce([{ type: 'host', message: { type: 'graph', payload: payloadOf(graph) } }]);
    expect(state.filter.branches).toEqual(['main']);
    expect(state.filter.minSimilarity).toBe(0);
    expect(state.filter.edgeTypes).toEqual([...EDGE_TYPES]);
  });

  it('frames the focus node and does not fit the whole graph', () => {
    const state = reduce([{ type: 'host', message: { type: 'graph', payload: payloadOf(graph) } }]);
    expect(state.focusRequest).not.toBeNull();
    expect(state.focusRequest?.nodeId).toBe('n3');
    expect(state.fitToken).toBe(0);
    expect(state.focusToken).toBe(1);
  });

  it('fits instead when the graph has no focus node', () => {
    const headless = makeGraph([makeNode('a'), makeNode('b', { timestamp: T0 + DAY })], []);
    const state = reduce([
      { type: 'host', message: { type: 'graph', payload: payloadOf(headless) } },
    ]);
    expect(state.focusRequest).toBeNull();
    expect(state.fitToken).toBe(1);
    expect(state.focusToken).toBe(1);
  });

  it('reaches the same state for init and for graph', () => {
    const viaInit = reduce([
      { type: 'host', message: { type: 'init', payload: payloadOf(graph) } },
    ]);
    const viaGraph = reduce([
      { type: 'host', message: { type: 'graph', payload: payloadOf(graph) } },
    ]);
    expect(viaGraph).toEqual(viaInit);
  });

  it('clears a previous selection, highlight, error and loading state', () => {
    const state = reduce(
      [
        { type: 'host', message: { type: 'graph', payload: payloadOf(graph) } },
        { type: 'select', nodeId: 'n1' },
        { type: 'host', message: { type: 'highlight', payload: { nodeIds: ['n2'], reason: 'x' } } },
        { type: 'host', message: { type: 'error', payload: { message: 'boom' } } },
        { type: 'host', message: { type: 'graph', payload: payloadOf(graph) } },
      ],
      // A pre-existing loading state must not survive a new graph.
      ancestryReducer(createInitialUiState(), {
        type: 'host',
        message: { type: 'loading', payload: { message: 'working', ratio: 0.5 } },
      }),
    );
    expect(state.selectedId).toBeNull();
    expect(state.highlightIds).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.loading).toBeNull();
  });
});

describe('ancestryReducer — the rest of the protocol', () => {
  const graph = makeChainGraph();
  const loaded = reduce([{ type: 'host', message: { type: 'graph', payload: payloadOf(graph) } }]);

  it('applies a host filter', () => {
    const state = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'filter', payload: { minSimilarity: 0.9 } },
    });
    expect(state.filter).toEqual({ minSimilarity: 0.9 });
  });

  it('turns a focus message into a new flight request, even for the same id', () => {
    const first = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'focus', payload: { nodeId: 'n1' } },
    });
    const second = ancestryReducer(first, {
      type: 'host',
      message: { type: 'focus', payload: { nodeId: 'n1' } },
    });
    expect(first.focusRequest?.nodeId).toBe('n1');
    expect(second.focusRequest?.nodeId).toBe('n1');
    expect(second.focusRequest?.token).toBeGreaterThan(first.focusRequest?.token ?? 0);
  });

  it('records a highlight and says why', () => {
    const withReason = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'highlight', payload: { nodeIds: ['n1', 'n2'], reason: 'same author' } },
    });
    expect(withReason.highlightIds).toEqual(['n1', 'n2']);
    expect(withReason.statusMessage).toBe('Highlighted 2 node(s): same author');

    const withoutReason = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'highlight', payload: { nodeIds: ['n1'], reason: '' } },
    });
    expect(withoutReason.statusMessage).toBe('Highlighted 1 node(s)');
  });

  it('clears a highlight, and is a no-op when there was none', () => {
    const highlighted = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'highlight', payload: { nodeIds: ['n1'], reason: '' } },
    });
    const cleared = ancestryReducer(highlighted, {
      type: 'host',
      message: { type: 'clearHighlight' },
    });
    expect(cleared.highlightIds).toEqual([]);
    expect(ancestryReducer(cleared, { type: 'host', message: { type: 'clearHighlight' } })).toBe(
      cleared,
    );
  });

  it('records loading progress', () => {
    const state = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'loading', payload: { message: 'Reading history…', ratio: 0.25 } },
    });
    expect(state.loading).toEqual({ message: 'Reading history…', ratio: 0.25 });
  });

  it('turns an error into a toast and cancels any loading state', () => {
    const loading = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'loading', payload: { message: 'working', ratio: 0.5 } },
    });
    const failed = ancestryReducer(loading, {
      type: 'host',
      message: { type: 'error', payload: { message: 'git failed', detail: 'exit 128' } },
    });
    expect(failed.error).toEqual({ message: 'git failed', detail: 'exit 128' });
    expect(failed.loading).toBeNull();
  });

  it('normalises a missing error detail to null', () => {
    const state = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'error', payload: { message: 'oops' } },
    });
    expect(state.error?.detail).toBeNull();
  });

  it('treats a status message as "done" and clears loading', () => {
    const loading = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'loading', payload: { message: 'working', ratio: 0.5 } },
    });
    const done = ancestryReducer(loading, {
      type: 'host',
      message: { type: 'status', payload: { message: 'Rendering graph…' } },
    });
    expect(done.statusMessage).toBe('Rendering graph…');
    expect(done.loading).toBeNull();
  });

  it('ignores an unrecognised message rather than throwing', () => {
    const bogus = { type: 'nope' } as unknown as AncestryAction;
    expect(() => ancestryReducer(loaded, bogus)).not.toThrow();
    expect(ancestryReducer(loaded, bogus)).toBe(loaded);
  });
});

describe('ancestryReducer — local actions', () => {
  const graph = makeChainGraph();
  const loaded = reduce([{ type: 'host', message: { type: 'graph', payload: payloadOf(graph) } }]);

  it('selects and clears a node', () => {
    const selected = ancestryReducer(loaded, { type: 'select', nodeId: 'n1' });
    expect(selected.selectedId).toBe('n1');
    expect(ancestryReducer(selected, { type: 'select', nodeId: 'n1' })).toBe(selected);
    expect(ancestryReducer(selected, { type: 'select', nodeId: null }).selectedId).toBeNull();
  });

  it('copies the filter so the caller cannot mutate state afterwards', () => {
    const source = { minSimilarity: 0.5 };
    const state = ancestryReducer(loaded, { type: 'filter', filter: source });
    source.minSimilarity = 0.9;
    expect(state.filter.minSimilarity).toBe(0.5);
  });

  it('dismisses the error, and is a no-op when there is none', () => {
    const failed = ancestryReducer(loaded, {
      type: 'host',
      message: { type: 'error', payload: { message: 'boom' } },
    });
    expect(ancestryReducer(failed, { type: 'dismissError' }).error).toBeNull();
    expect(ancestryReducer(loaded, { type: 'dismissError' })).toBe(loaded);
  });

  it('bumps the fit token and says so', () => {
    const state = ancestryReducer(loaded, { type: 'fit' });
    expect(state.fitToken).toBe(loaded.fitToken + 1);
    expect(state.statusMessage).toBe('Fitted the view');
  });

  it('toggles labels and edges and reports each in the status line', () => {
    const labelsOff = ancestryReducer(loaded, { type: 'toggleLabels' });
    expect(labelsOff.view).toEqual({ labels: false, edges: true });
    expect(labelsOff.statusMessage).toBe('Node labels off');
    expect(ancestryReducer(labelsOff, { type: 'toggleLabels' }).statusMessage).toBe(
      'Node labels on',
    );

    const edgesOff = ancestryReducer(loaded, { type: 'toggleEdges' });
    expect(edgesOff.view).toEqual({ labels: true, edges: false });
    expect(edgesOff.statusMessage).toBe('Edges off');
  });
});

describe('ancestryReducer — purity', () => {
  it('never mutates the state it is given', () => {
    const before = createInitialUiState();
    const snapshot = JSON.stringify({
      filter: before.filter,
      highlightIds: before.highlightIds,
      view: before.view,
    });
    reduce(
      [
        { type: 'host', message: { type: 'graph', payload: payloadOf(makeChainGraph()) } },
        { type: 'select', nodeId: 'n1' },
        { type: 'host', message: { type: 'highlight', payload: { nodeIds: ['n1'], reason: 'r' } } },
        { type: 'fit' },
        { type: 'toggleEdges' },
      ],
      before,
    );
    expect(
      JSON.stringify({
        filter: before.filter,
        highlightIds: before.highlightIds,
        view: before.view,
      }),
    ).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// filter helpers
// ---------------------------------------------------------------------------

describe('patchFilter', () => {
  it('merges without mutating the original', () => {
    const original = { minSimilarity: 0.5, search: 'x' };
    const next = patchFilter(original, { minSimilarity: 0.9 });
    expect(next).toEqual({ minSimilarity: 0.9, search: 'x' });
    expect(original.minSimilarity).toBe(0.5);
  });

  it('removes a key when the patch value is undefined', () => {
    const next = patchFilter({ search: 'x', fromTimestamp: 5 }, { fromTimestamp: undefined });
    expect(next).toEqual({ search: 'x' });
    expect('fromTimestamp' in next).toBe(false);
  });

  it('adds a key that was absent', () => {
    expect(patchFilter({}, { toTimestamp: 7 })).toEqual({ toTimestamp: 7 });
  });
});

describe('toggleListValue', () => {
  it('adds a missing value and removes a present one', () => {
    expect(toggleListValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleListValue(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('resetFilter', () => {
  const options = availableFilterOptions(makeChainGraph());

  it('produces the widest possible filter', () => {
    const filter = resetFilter(options);
    expect(filter).toEqual({
      branches: options.branches,
      files: options.files,
      authors: options.authors,
      minSimilarity: options.minSimilarity,
      fromTimestamp: options.minTimestamp,
      toTimestamp: options.maxTimestamp,
      edgeTypes: [...EDGE_TYPES],
      search: '',
    });
  });

  it('shows everything', () => {
    const result = availableFilterOptions(makeChainGraph());
    expect(result.branches.length).toBeGreaterThan(0);
  });
});

describe('filterForEdgeTypes', () => {
  it('returns the enabled types in canonical order', () => {
    expect(filterForEdgeTypes(new Set(['COPIED_FROM', 'EVOLVED_FROM']))).toEqual([
      'EVOLVED_FROM',
      'COPIED_FROM',
    ]);
  });

  it('drops unknown names rather than forwarding them to the host', () => {
    expect(filterForEdgeTypes(new Set(['NOPE', 'MOVED_FROM']))).toEqual(['MOVED_FROM']);
  });
});

describe('date input round trip', () => {
  it('formats a timestamp as the input value', () => {
    expect(dateInputValue(Date.UTC(2023, 3, 5))).toBe('2023-04-05');
  });

  it('renders an unset or unusable bound as an empty field', () => {
    expect(dateInputValue(undefined)).toBe('');
    expect(dateInputValue(Number.NaN)).toBe('');
  });

  it('parses a value back to the start of its UTC day', () => {
    expect(parseDateInput('2023-04-05')).toBe(Date.UTC(2023, 3, 5));
  });

  it('treats a blank or unparseable value as unset', () => {
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('not a date')).toBeNull();
  });

  it('makes the "to" bound inclusive of the whole day', () => {
    const to = endOfDayUtc(parseDateInput('2023-04-05') ?? 0);
    expect(to).toBe(Date.UTC(2023, 3, 5) + DAY_MS - 1);
    expect(to).toBeGreaterThan(Date.UTC(2023, 3, 5));
  });
});

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

describe('similarity formatting', () => {
  it('renders whole percents for the slider', () => {
    expect(similarityPercent(0)).toBe(0);
    expect(similarityPercent(0.856)).toBe(86);
    expect(similarityPercent(1)).toBe(100);
  });

  it('clamps an out-of-range slider value', () => {
    expect(similarityPercent(5)).toBe(100);
    expect(similarityPercent(-1)).toBe(0);
    expect(similarityPercent(Number.NaN)).toBe(0);
  });

  it('renders one decimal for the detail panel', () => {
    expect(similarityLabel(0.8567)).toBe('85.7%');
    expect(similarityLabel(1)).toBe('100.0%');
  });
});

describe('safeRatio', () => {
  it('passes a valid ratio through', () => {
    expect(safeRatio(0.42)).toBe(0.42);
  });

  it('clamps out-of-range and maps junk to zero', () => {
    expect(safeRatio(7)).toBe(1);
    expect(safeRatio(-3)).toBe(0);
    expect(safeRatio(Number.NaN)).toBe(0);
    expect(safeRatio(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('node summaries', () => {
  it('summarises a node as sha, path and similarity', () => {
    const node = makeNode('n', { shortCommit: 'abc1234', similarity: 0.9 });
    expect(nodeHint(node)).toBe('abc1234 · src/app/service.ts · 90.0%');
  });

  it('falls back to a slice of the full commit when shortCommit is empty', () => {
    const node = makeNode('n', { shortCommit: '', commit: 'f'.repeat(40) });
    expect(shortCommitOf(node)).toBe('fffffff');
  });

  it('uses the caller-supplied fallback when there is no node', () => {
    expect(nodeHint(null, 'Waiting for a graph')).toBe('Waiting for a graph');
  });
});

describe('defaultStatus', () => {
  it('says it is waiting before a graph arrives', () => {
    expect(defaultStatus(null)).toBe('Waiting for a graph');
  });

  it('summarises the graph once one has', () => {
    expect(defaultStatus(makeChainGraph())).toMatch(/3 versions/);
  });
});

// ---------------------------------------------------------------------------
// axis placement
// ---------------------------------------------------------------------------

describe('timestampRange', () => {
  it('spans the graph', () => {
    expect(timestampRange(makeChainGraph())).toEqual({ min: T0, max: T0 + 90 * DAY });
  });

  it('returns a usable range for a graph with no nodes', () => {
    const range = timestampRange(makeGraph([]));
    expect(range.max - range.min).toBeGreaterThan(0);
  });

  it('returns a usable range for no graph at all', () => {
    expect(timestampRange(null)).toEqual({ min: 0, max: 1 });
  });
});

describe('xTickPercentages', () => {
  const graph = makeChainGraph();
  const axis = computeLayout(graph).axis;
  const range = timestampRange(graph);

  it('produces one placement per tick, in order', () => {
    const placements = xTickPercentages(axis, range);
    expect(placements).toHaveLength(axis.xTicks.length);
    for (const placement of placements) {
      expect(placement.left).toBeGreaterThanOrEqual(0);
      expect(placement.left).toBeLessThanOrEqual(1);
    }
  });

  it('puts the earliest tick at 0 and the latest at 1', () => {
    const placements = xTickPercentages(axis, range);
    expect(placements[0]?.left).toBe(0);
    expect(placements[placements.length - 1]?.left).toBe(1);
  });

  it('is monotonically non-decreasing', () => {
    const lefts = xTickPercentages(axis, range).map((placement) => placement.left);
    for (let index = 1; index < lefts.length; index += 1) {
      expect(lefts[index]!).toBeGreaterThanOrEqual(lefts[index - 1]!);
    }
  });

  it('agrees with the tick labels core/timeline produced', () => {
    const placements = xTickPercentages(axis, range);
    expect(placements.map((placement) => placement.label)).toEqual(
      axis.xTicks.map((tick) => tick.label),
    );
    expect(placements.filter((placement) => placement.major).length).toBeGreaterThan(0);
  });

  it('pins every tick to 0 when the range is a single instant', () => {
    const flat = computeLayout(makeGraph([makeNode('a'), makeNode('b')])).axis;
    for (const placement of xTickPercentages(flat, { min: 5, max: 5 })) {
      expect(placement.left).toBe(0);
    }
  });

  it('is empty when the axis has no ticks', () => {
    expect(xTickPercentages({ ...axis, xTicks: [] }, range)).toEqual([]);
  });

  it('stays consistent with the ticks the X axis really uses', () => {
    // The DOM axis and the 3D axis must not disagree: the first generated tick
    // is the graph's minimum timestamp and the last its maximum, by contract.
    const ticks = generateTimeTicks(range.min, range.max);
    expect(ticks[0]?.timestamp).toBe(range.min);
    expect(ticks[ticks.length - 1]?.timestamp).toBe(range.max);
  });
});

describe('yRowPlacements', () => {
  it('gives one row per branch, evenly spread, carrying the palette colour', () => {
    const graph = makeGraph([
      makeNode('a', { branches: ['main'] }),
      makeNode('b', { branches: ['feature'], timestamp: T0 + DAY }),
      makeNode('c', { branches: [], timestamp: T0 + 2 * DAY }),
    ]);
    const axis = computeLayout(graph).axis;
    const rows = yRowPlacements(axis);
    expect(rows).toHaveLength(axis.yRows.length);
    expect(rows.map((row) => row.label)).toEqual(axis.yRows.map((row) => row.label));
    expect(rows.every((row) => /^#[0-9a-f]{6}$/.test(row.color))).toBe(true);
    for (const row of rows) {
      expect(row.top).toBeGreaterThan(0);
      expect(row.top).toBeLessThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// shared vocabulary
// ---------------------------------------------------------------------------

describe('display vocabulary', () => {
  it('labels all five edge types', () => {
    for (const type of EDGE_TYPES) {
      expect(EDGE_LABELS[type]).toBeTruthy();
    }
    expect(Object.keys(EDGE_LABELS).sort()).toEqual([...EDGE_TYPES].sort());
  });

  it('lists the four classifications, strongest first', () => {
    expect(CLASSIFICATIONS).toEqual(['strong', 'possible', 'weak', 'unrelated']);
  });
});

describe('DAY_MS', () => {
  it('is a real day', () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe('ancestryPath agreement', () => {
  it('the reducer and core/graph-stats agree on the focus node chain', () => {
    const graph = makeChainGraph();
    const state = reduce([{ type: 'host', message: { type: 'graph', payload: payloadOf(graph) } }]);
    expect(ancestryPath(graph, state.focusRequest?.nodeId ?? '')).toEqual(['n3', 'n2', 'n1']);
  });
});
