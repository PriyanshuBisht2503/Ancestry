/**
 * The webview's derived state: one reducer, a handful of `useMemo` hooks, and
 * the small pure helpers the components share.
 *
 * WHY THIS FILE EXISTS INSTEAD OF SCATTERING `useMemo` THROUGH THE COMPONENTS
 * ---------------------------------------------------------------------------
 * The old hand-rolled UI kept one mutable `AppState` object and re-derived
 * everything in a `refresh()` call. In React that shape is wrong: the refresh
 * has to be a *pure function of state*, or a component will read a value that
 * is one render stale. So the derivation is pulled out here, split into
 *   - pure functions (`ancestryReducer`, `patchFilter`, `resetFilter`, …) which
 *     are unit tested directly, with no React and no DOM involved, and
 *   - hooks (`useLayout`, `useGraphFilter`, …) which are thin `useMemo`
 *     wrappers over the very same `core/` functions the non-React version used.
 *
 * NOTHING HERE TOUCHES THE DOM AND NOTHING HERE IMPORTS `three`. The Three.js
 * scene is driven from `App.tsx` through plain data, so this module stays
 * runnable in a bare Node process — which is exactly how `graphState.test.ts`
 * exercises it.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: any knowledge of how a value is displayed.
 * Colours, labels and dates come from `core/`; this module only ever decides
 * *which* value is current.
 */

import { useMemo } from 'react';
import type {
  AncestryEdgeType,
  AncestryGraph,
  AncestryNode,
  HostToWebviewMessage,
  MatchClassification,
  WebviewFilter,
  WebviewGraphPayload,
} from '../../../types';
import { EDGE_TYPES } from '../core/domain';
import {
  applyFilter,
  availableFilterOptions,
  filterDefaults,
  type FilterOptions,
  type FilterResult,
} from '../core/filter';
import { ancestryPath, summarizeGraph } from '../core/graph-stats';
import { computeLayout, type AxisSpec, type LayoutResult } from '../core/layout';
import { formatAxisLabel } from '../core/timeline';

// ---------------------------------------------------------------------------
// shared display vocabulary
// ---------------------------------------------------------------------------

/** One day in milliseconds; the date inputs are day-granular. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Human labels for the five edge types, keyed by the canonical type.
 *
 * Shared by the legend and the filter-bar toggle row so the two can never call
 * the same relationship different things. Typed as `Record<string, string>`
 * because `EDGE_TYPES` is an `as const` tuple and indexing it with a runtime
 * string has to stay legal for the map lookup to compile.
 */
export const EDGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  EVOLVED_FROM: 'evolved',
  MODIFIED_FROM: 'modified',
  MOVED_FROM: 'moved',
  COPIED_FROM: 'copied',
  MERGED_FROM: 'merged',
});

/** The classification badges, in descending order of confidence. */
export const CLASSIFICATIONS: readonly MatchClassification[] = Object.freeze([
  'strong',
  'possible',
  'weak',
  'unrelated',
]);

// ---------------------------------------------------------------------------
// state shape
// ---------------------------------------------------------------------------

/** The run statistics the host attaches to every graph payload. */
export type RunStats = WebviewGraphPayload['stats'];

/** Determinate progress reported by the host while an analysis runs. */
export interface LoadingState {
  readonly message: string;
  /** 0..1, monotonic within a run. */
  readonly ratio: number;
}

/** A non-fatal error the host reported. */
export interface ErrorState {
  readonly message: string;
  readonly detail: string | null;
}

/** A one-shot "fly the camera to this node" request. */
export interface FocusRequest {
  readonly nodeId: string;
  /**
   * Monotonic counter, not just the id: the host can legitimately ask to focus
   * the node that is already focused, and a value-only dependency would not
   * re-run the effect.
   */
  readonly token: number;
}

/** The two toggles the `1` / `2` keyboard shortcuts drive. */
export interface ViewFlags {
  readonly labels: boolean;
  readonly edges: boolean;
}

/**
 * The whole UI state, as one immutable object.
 *
 * Every field is `readonly` so the reducer can be reasoned about as a pure
 * function: two states are equal exactly when their fields are.
 */
export interface AncestryUiState {
  /** The validated graph, or `null` before the first payload arrives. */
  readonly graph: AncestryGraph | null;
  /** Source text of the focus block only; never historical source. */
  readonly focusSource: string;
  /** Duration and cache accounting for the run that produced `graph`. */
  readonly runStats: RunStats | null;
  /** The active filter. `{}` means "no restriction on any dimension". */
  readonly filter: WebviewFilter;
  readonly selectedId: string | null;
  readonly highlightIds: readonly string[];
  /** Transient message for the status line; `''` means "derive it". */
  readonly statusMessage: string;
  readonly loading: LoadingState | null;
  readonly error: ErrorState | null;
  readonly focusRequest: FocusRequest | null;
  /** Bumped to ask the renderer to reframe the whole graph. */
  readonly fitToken: number;
  /**
   * Monotonic counter behind {@link focusRequest}, kept separate from
   * `fitToken` because the two are different events: sharing one counter would
   * let a `focus` request that happens to carry the same number as an earlier
   * `fit` be swallowed by React's dependency check.
   */
  readonly focusToken: number;
  readonly view: ViewFlags;
}

/** Everything that can change {@link AncestryUiState}. */
export type AncestryAction =
  /** A validated message that arrived from the extension host. */
  | { readonly type: 'host'; readonly message: HostToWebviewMessage }
  /** A selection, from the 3D view, the list, or the `Esc` shortcut. */
  | { readonly type: 'select'; readonly nodeId: string | null }
  /** A filter change, from the filter bar or from a host `filter` message. */
  | { readonly type: 'filter'; readonly filter: WebviewFilter }
  | { readonly type: 'dismissError' }
  | { readonly type: 'status'; readonly message: string }
  /** The `f` shortcut. */
  | { readonly type: 'fit' }
  /** The `1` shortcut. */
  | { readonly type: 'toggleLabels' }
  /** The `2` shortcut. */
  | { readonly type: 'toggleEdges' };

/** The state the webview boots with, before any message has arrived. */
export function createInitialUiState(): AncestryUiState {
  return {
    graph: null,
    focusSource: '',
    runStats: null,
    filter: {},
    selectedId: null,
    highlightIds: [],
    statusMessage: '',
    loading: null,
    error: null,
    focusRequest: null,
    fitToken: 0,
    focusToken: 0,
    view: { labels: true, edges: true },
  };
}

// ---------------------------------------------------------------------------
// the reducer
// ---------------------------------------------------------------------------

/**
 * The single state transition function.
 *
 * PURE, and that is the whole point: it takes a state and an action and returns
 * the next state, touching nothing else. It is what makes the message protocol
 * testable without a browser — `graphState.test.ts` drives a whole host
 * conversation through it.
 *
 * It deliberately does **not** post to the host. Outbound traffic is the
 * caller's job (`App.tsx`), which keeps this function synchronous and free of
 * the `postMessage` channel.
 */
export function ancestryReducer(state: AncestryUiState, action: AncestryAction): AncestryUiState {
  switch (action.type) {
    case 'host':
      return applyHostMessage(state, action.message);
    case 'select':
      return state.selectedId === action.nodeId ? state : { ...state, selectedId: action.nodeId };
    case 'filter':
      return { ...state, filter: { ...action.filter } };
    case 'dismissError':
      return state.error === null ? state : { ...state, error: null };
    case 'status':
      return { ...state, statusMessage: action.message };
    case 'fit':
      return { ...state, fitToken: state.fitToken + 1, statusMessage: 'Fitted the view' };
    case 'toggleLabels': {
      const labels = !state.view.labels;
      return {
        ...state,
        view: { ...state.view, labels },
        statusMessage: `Node labels ${labels ? 'on' : 'off'}`,
      };
    }
    case 'toggleEdges': {
      const edges = !state.view.edges;
      return {
        ...state,
        view: { ...state.view, edges },
        statusMessage: `Edges ${edges ? 'on' : 'off'}`,
      };
    }
    default:
      return state;
  }
}

/**
 * Folds one validated host message into the state.
 *
 * The `init` and `graph` cases are the same transition on purpose: the host
 * sends `graph` for every re-analysis of an already-open panel, and the webview
 * must reach exactly the same state either way — that is the invariant the
 * "replay last analysis" command depends on.
 */
function applyHostMessage(state: AncestryUiState, message: HostToWebviewMessage): AncestryUiState {
  switch (message.type) {
    case 'init':
    case 'graph': {
      const graph = message.payload.graph;
      // The focus node is framed automatically; a graph without one (which the
      // builders can produce for a synthetic block) is framed as a whole.
      const focus = graph.nodes.find((node) => node.isFocus);
      return {
        ...state,
        graph,
        focusSource: message.payload.focusSource,
        runStats: message.payload.stats,
        filter: filterDefaults(graph),
        selectedId: null,
        highlightIds: [],
        statusMessage: '',
        loading: null,
        error: null,
        focusRequest:
          focus === undefined ? null : { nodeId: focus.id, token: state.focusToken + 1 },
        focusToken: state.focusToken + 1,
        fitToken: focus === undefined ? state.fitToken + 1 : state.fitToken,
      };
    }
    case 'filter':
      return { ...state, filter: { ...message.payload } };
    case 'focus':
      return {
        ...state,
        focusRequest: { nodeId: message.payload.nodeId, token: state.focusToken + 1 },
        focusToken: state.focusToken + 1,
      };
    case 'highlight': {
      const count = message.payload.nodeIds.length;
      const reason = message.payload.reason;
      return {
        ...state,
        highlightIds: [...message.payload.nodeIds],
        statusMessage:
          reason.length > 0
            ? `Highlighted ${count} node(s): ${reason}`
            : `Highlighted ${count} node(s)`,
      };
    }
    case 'clearHighlight':
      return state.highlightIds.length === 0 ? state : { ...state, highlightIds: [] };
    case 'loading':
      return {
        ...state,
        loading: { message: message.payload.message, ratio: message.payload.ratio },
      };
    case 'error':
      return {
        ...state,
        loading: null,
        error: { message: message.payload.message, detail: message.payload.detail ?? null },
      };
    case 'status':
      return { ...state, loading: null, statusMessage: message.payload.message };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// hooks — thin `useMemo` wrappers over `core/`
// ---------------------------------------------------------------------------

/** A shared "nothing is visible" result, so its identity is stable across renders. */
export const EMPTY_FILTER_RESULT: FilterResult = {
  visibleNodeIds: new Set<string>(),
  visibleEdgeIds: new Set<string>(),
  visibleEdges: [],
  hiddenCount: 0,
  reasonCounts: {},
};

/**
 * The 3D layout of `graph`, or `null` before a graph arrives.
 *
 * Memoised on the graph *object*, not on its contents: `core/layout.ts` is
 * already a pure function of the graph, and the host always hands over a freshly
 * validated object, so a new identity genuinely means new data.
 */
export function useLayout(graph: AncestryGraph | null): LayoutResult | null {
  return useMemo(() => (graph === null ? null : computeLayout(graph)), [graph]);
}

/** The visible node/edge sets for `(graph, filter)`, or `null` without a graph. */
export function useGraphFilter(
  graph: AncestryGraph | null,
  filter: WebviewFilter,
): FilterResult | null {
  return useMemo(() => (graph === null ? null : applyFilter(graph, filter)), [graph, filter]);
}

/** Every value each filter dimension can take, or `null` without a graph. */
export function useAvailableFilterOptions(graph: AncestryGraph | null): FilterOptions | null {
  return useMemo(() => (graph === null ? null : availableFilterOptions(graph)), [graph]);
}

/**
 * The visible nodes, oldest first.
 *
 * Chronological order is the only order that makes the list usable as an
 * accessible fallback for the 3D view: reading a lineage top to bottom in time
 * order is how the graph is meant to be read, and ties break on the id so the
 * order is stable between renders.
 */
export function useVisibleNodes(
  graph: AncestryGraph | null,
  visibleNodeIds: ReadonlySet<string> | null,
): AncestryNode[] {
  return useMemo(() => {
    if (graph === null || visibleNodeIds === null) {
      return [];
    }
    return graph.nodes
      .filter((node) => visibleNodeIds.has(node.id))
      .sort((a, b) => a.timestamp - b.timestamp || compareText(a.id, b.id));
  }, [graph, visibleNodeIds]);
}

/** The selected node's backwards ancestry chain, or `[]`. */
export function useAncestryPath(graph: AncestryGraph | null, nodeId: string | null): string[] {
  return useMemo(
    () => (graph === null || nodeId === null ? [] : ancestryPath(graph, nodeId)),
    [graph, nodeId],
  );
}

// ---------------------------------------------------------------------------
// pure helpers shared by the components
// ---------------------------------------------------------------------------

/** An inclusive epoch-millisecond range. */
export interface TimeRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The timestamp extent of a graph, ignoring non-finite timestamps.
 *
 * A graph with no nodes (or none with a usable timestamp) yields `{0, 1}` so
 * downstream percentage maths never divides by zero.
 */
export function timestampRange(graph: AncestryGraph | null): TimeRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const node of graph?.nodes ?? []) {
    const timestamp = Number.isFinite(node.timestamp) ? node.timestamp : 0;
    if (timestamp < min) {
      min = timestamp;
    }
    if (timestamp > max) {
      max = timestamp;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

/** One DOM tick on the schematic X axis. */
export interface AxisTickPlacement {
  /** 0..1 across the axis, ready for a `left: N%` style. */
  readonly left: number;
  readonly label: string;
  readonly major: boolean;
}

/**
 * Places the X-axis tick labels along the bottom of the stage.
 *
 * A *schematic* axis on purpose: the renderer owns the real projection, and a
 * pixel-accurate DOM axis would need the camera matrix on every frame. The
 * fraction is computed from the timestamps because `core/layout.ts` maps a
 * timestamp onto X linearly — `(xSpan * (ts - tMin)) / (tMax - tMin)` — so the
 * tick and the node it labels always agree, whatever the camera is doing.
 */
export function xTickPercentages(axis: AxisSpec, range: TimeRange): AxisTickPlacement[] {
  const span = range.max - range.min;
  return axis.xTicks.map((tick) => ({
    left: span > 0 ? clamp01((tick.timestamp - range.min) / span) : 0,
    label: tick.label,
    major: tick.major,
  }));
}

/** The Y-axis row placements, top to bottom, as 0..1 fractions. */
export function yRowPlacements(
  axis: AxisSpec,
): Array<{ readonly top: number; readonly label: string; readonly color: string }> {
  const count = axis.yRows.length;
  return axis.yRows.map((row, index) => ({
    top: ((index + 0.5) / Math.max(1, count)) * 100,
    label: row.label,
    color: row.color,
  }));
}

/**
 * Returns a copy of `current` with `patch` merged over it.
 *
 * A patch field set to `undefined` *removes* the key rather than storing
 * `undefined`: `WebviewFilter` uses optional properties and the object is
 * `postMessage`-serialised, so an explicit `undefined` would put a key in the
 * payload where the host expects it to be absent.
 */
export function patchFilter(current: WebviewFilter, patch: Partial<WebviewFilter>): WebviewFilter {
  const next: WebviewFilter = { ...current };
  for (const key of Object.keys(patch) as Array<keyof WebviewFilter>) {
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/** Adds `value` to `values`, or removes it when it is already present. */
export function toggleListValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/** The all-inclusive filter for a set of options — what the Reset button applies. */
export function resetFilter(options: FilterOptions): WebviewFilter {
  return {
    branches: [...options.branches],
    files: [...options.files],
    authors: [...options.authors],
    minSimilarity: options.minSimilarity,
    fromTimestamp: options.minTimestamp,
    toTimestamp: options.maxTimestamp,
    edgeTypes: [...EDGE_TYPES],
    search: '',
  };
}

/** The filter's `edgeTypes` for a set of enabled type names. */
export function filterForEdgeTypes(enabled: ReadonlySet<string>): AncestryEdgeType[] {
  return EDGE_TYPES.filter((type) => enabled.has(type));
}

/** `''` when the bound is unset, otherwise the UTC `YYYY-MM-DD` input value. */
export function dateInputValue(timestamp: number | undefined): string {
  return timestamp === undefined || !Number.isFinite(timestamp) ? '' : formatAxisLabel(timestamp);
}

/** Parses a `<input type="date">` value, or `null` when it is blank or junk. */
export function parseDateInput(value: string): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The inclusive end of the day containing `timestamp`.
 *
 * A `type="date"` input yields midnight, so "To: 2023-04-05" has to become the
 * last millisecond of that day or the whole day would be filtered out.
 */
export function endOfDayUtc(timestamp: number): number {
  return timestamp + DAY_MS - 1;
}

/** A similarity in 0..1 as a whole-number percentage, clamped. */
export function similarityPercent(value: number): number {
  return Math.round(clamp01(value) * 100);
}

/** A similarity in 0..1 as a one-decimal percentage string, for the detail panel. */
export function similarityLabel(value: number): string {
  return `${(clamp01(value) * 100).toFixed(1)}%`;
}

/** Clamps a host-supplied progress ratio into `[0, 1]`, mapping junk to `0`. */
export function safeRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** A one-line summary of a node, for the status line and hover hints. */
export function nodeHint(node: AncestryNode | null, fallback = 'No node'): string {
  if (node === null) {
    return fallback;
  }
  return `${shortCommitOf(node)} · ${node.filePath} · ${similarityLabel(node.similarity)}`;
}

/** The short commit for a node, tolerating a payload with no `shortCommit`. */
export function shortCommitOf(node: AncestryNode): string {
  return node.shortCommit.length > 0 ? node.shortCommit : node.commit.slice(0, 7);
}

/** The default status line: the graph summary, or a "nothing yet" message. */
export function defaultStatus(graph: AncestryGraph | null): string {
  return graph === null ? 'Waiting for a graph' : summarizeGraph(graph);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
