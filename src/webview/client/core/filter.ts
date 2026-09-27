/**
 * Filter application: graph → the visible node/edge sets the renderer draws.
 *
 * WHY PURE AND SEPARATE: filtering is the single most re-run piece of logic in
 * the webview (every keystroke in the search box and every slider drag goes
 * through here) and it is also the piece whose *correctness* is hardest to eyeball
 * in a 3D scene — a subtly wrong edge set looks like a rendering bug. Keeping it
 * a pure function of `(graph, filter)` makes it exhaustively testable, which is
 * the only practical way to trust it.
 *
 * The connective rule: **an edge is visible only when both of its endpoints are
 * visible and its own type passes the edge-type filter.** Filtering by branch
 * while leaving a cross-branch `MERGED_FROM` edge on screen would draw a line
 * whose ends are not there, so endpoint visibility is mandatory.
 */

import type {
  AncestryEdge,
  AncestryEdgeType,
  AncestryGraph,
  AncestryNode,
  WebviewFilter,
} from '../../../types';
import { EDGE_TYPES, DETACHED_BRANCH, sanitizeLabel } from './domain';

/** The outcome of {@link applyFilter}. */
export interface FilterResult {
  visibleNodeIds: Set<string>;
  visibleEdgeIds: Set<string>;
  visibleEdges: AncestryEdge[];
  /** How many nodes were excluded. */
  hiddenCount: number;
  /**
   * How many times each *reason* rejected something, so the UI can say
   * "4 hidden by similarity" rather than "some nodes are hidden". A node that
   * fails three dimensions is counted under all three — the numbers answer
   * "how much would relaxing this control reveal?", not "how many nodes were
   * rejected exactly once".
   */
  reasonCounts: Record<string, number>;
}

/** The reason keys {@link applyFilter} can report. */
export const FILTER_REASONS = Object.freeze({
  branch: 'branch',
  file: 'file',
  author: 'author',
  minSimilarity: 'minSimilarity',
  timeRange: 'timeRange',
  search: 'search',
  edgeType: 'edgeType',
  endpoint: 'endpoint',
});

/** Every distinct value a filter dimension can take, for populating the UI. */
export interface FilterOptions {
  branches: string[];
  files: string[];
  authors: string[];
  edgeTypes: AncestryEdgeType[];
  minSimilarity: number;
  maxSimilarity: number;
  minTimestamp: number;
  maxTimestamp: number;
}

/**
 * Applies a filter to a graph.
 *
 * An *empty* filter object (every field absent) returns everything: that is
 * the contract the host relies on when it sends `{ type: 'filter' }` with no
 * payload to mean "reset". Empty arrays are treated as "no restriction on this
 * dimension" for the same reason — the filter bar starts with every checkbox
 * ticked, and un-ticking all of them means "no filter", not "show nothing".
 */
export function applyFilter(graph: AncestryGraph, filter: WebviewFilter): FilterResult {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const safeFilter: WebviewFilter = filter !== null && typeof filter === 'object' ? filter : {};

  const branchSet = toSet(safeFilter.branches);
  const fileSet = toSet(safeFilter.files);
  const authorSet = toSet(safeFilter.authors);
  const edgeTypeSet = toSet(safeFilter.edgeTypes);
  const minSimilarity = normalizeScore(safeFilter.minSimilarity);
  const fromTimestamp = normalizeTime(safeFilter.fromTimestamp);
  const toTimestamp = normalizeTime(safeFilter.toTimestamp);
  const search =
    typeof safeFilter.search === 'string' ? safeFilter.search.trim().toLowerCase() : '';

  const reasonCounts: Record<string, number> = {};
  const visibleNodeIds = new Set<string>();
  let hiddenCount = 0;

  for (const node of nodes) {
    let visible = true;

    if (branchSet !== null && !matchesBranch(node, branchSet)) {
      bump(reasonCounts, FILTER_REASONS.branch);
      visible = false;
    }
    if (visible && fileSet !== null && !matchesFile(node, fileSet)) {
      bump(reasonCounts, FILTER_REASONS.file);
      visible = false;
    }
    if (visible && authorSet !== null && !matchesAuthor(node, authorSet)) {
      bump(reasonCounts, FILTER_REASONS.author);
      visible = false;
    }
    if (visible && minSimilarity !== null && !matchesSimilarity(node, minSimilarity)) {
      bump(reasonCounts, FILTER_REASONS.minSimilarity);
      visible = false;
    }
    if (
      visible &&
      (fromTimestamp !== null || toTimestamp !== null) &&
      !matchesTime(node, fromTimestamp, toTimestamp)
    ) {
      bump(reasonCounts, FILTER_REASONS.timeRange);
      visible = false;
    }
    if (visible && search.length > 0 && !matchesSearch(node, search)) {
      bump(reasonCounts, FILTER_REASONS.search);
      visible = false;
    }

    if (visible) {
      visibleNodeIds.add(node.id);
    } else {
      hiddenCount += 1;
    }
  }

  const visibleEdges: AncestryEdge[] = [];
  const visibleEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeTypeSet !== null && !edgeTypeSet.has(edge.type)) {
      bump(reasonCounts, FILTER_REASONS.edgeType);
      continue;
    }
    if (!visibleNodeIds.has(edge.from) || !visibleNodeIds.has(edge.to)) {
      bump(reasonCounts, FILTER_REASONS.endpoint);
      continue;
    }
    visibleEdges.push(edge);
    visibleEdgeIds.add(edge.id);
  }

  return { visibleNodeIds, visibleEdgeIds, visibleEdges, hiddenCount, reasonCounts };
}

/**
 * The filter the webview starts with: every dimension switched *on* at its
 * widest, so the first render shows the whole graph and the user narrows from
 * there (rather than starting from an empty scene and being confused by it).
 *
 * `edgeTypes` deliberately lists all five canonical types rather than only the
 * ones present in this graph, because the filter bar draws a toggle for each
 * and an un-ticked toggle reads as "this relationship is hidden", which would be
 * a lie for a relationship that does not exist.
 */
export function filterDefaults(graph: AncestryGraph): WebviewFilter {
  const options = availableFilterOptions(graph);
  return {
    branches: options.branches,
    files: options.files,
    authors: options.authors,
    minSimilarity: 0,
    fromTimestamp: options.minTimestamp,
    toTimestamp: options.maxTimestamp,
    edgeTypes: [...EDGE_TYPES],
    search: '',
  };
}

/**
 * Enumerates the distinct values available in each filter dimension.
 *
 * Every list is unique and sorted, which matters twice: the filter bar's
 * multi-selects are order-sensitive for the user, and a stable order means the
 * DOM is not rebuilt from scratch every time a new graph arrives.
 *
 * `files` lists the *file paths*, not the module lanes, because the file
 * multi-select is prefix-aware (see {@link applyFilter}) and therefore needs the
 * full path to build its options. `branches` includes the `(detached)` sentinel
 * when at least one node is unreachable from any ref, so those nodes can be
 * selected explicitly rather than being unfilterable.
 */
export function availableFilterOptions(graph: AncestryGraph): FilterOptions {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  const branches = new Set<string>();
  const files = new Set<string>();
  const authors = new Set<string>();
  const edgeTypes = new Set<AncestryEdgeType>();
  let minSimilarity = 1;
  let maxSimilarity = 0;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const keys = nodeBranchKeys(node);
    if (keys.length === 0) {
      branches.add(DETACHED_BRANCH);
    } else {
      for (const key of keys) {
        branches.add(key);
      }
    }
    if (node.filePath.length > 0) {
      files.add(node.filePath);
    }
    const author = sanitizeLabel(node.author.name);
    if (author.length > 0) {
      authors.add(author);
    }
    const similarity = clamp01(node.similarity);
    if (similarity < minSimilarity) {
      minSimilarity = similarity;
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
    const timestamp = Number.isFinite(node.timestamp) ? node.timestamp : 0;
    if (timestamp < minTimestamp) {
      minTimestamp = timestamp;
    }
    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
    }
  }

  for (const edge of edges) {
    edgeTypes.add(edge.type);
  }

  return {
    branches: [...branches].sort(compareLabels),
    files: [...files].sort(compareLabels),
    authors: [...authors].sort(compareLabels),
    // Canonical display order, not the order the edges happen to appear in.
    edgeTypes: EDGE_TYPES.filter((type) => edgeTypes.has(type)),
    minSimilarity: nodes.length === 0 ? 0 : clamp01(minSimilarity),
    maxSimilarity: nodes.length === 0 ? 1 : clamp01(maxSimilarity),
    minTimestamp: nodes.length === 0 ? 0 : minTimestamp,
    maxTimestamp: nodes.length === 0 ? 0 : maxTimestamp,
  };
}

/** The branch keys a node is filtered by; empty means "reachable from no ref". */
export function nodeBranchKeys(node: AncestryNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const branch of node.branches) {
    const label = sanitizeLabel(branch);
    if (label.length === 0 || seen.has(label)) {
      continue;
    }
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Human-readable one-liner explaining what a filter is hiding. */
export function describeHiddenReasons(result: FilterResult): string {
  const entries = Object.entries(result.reasonCounts).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return 'No nodes hidden';
  }
  entries.sort((a, b) => b[1] - a[1] || compareLabels(a[0], b[0]));
  return entries.map(([reason, count]) => `${reason} (${count})`).join(', ');
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** `null` means "this dimension is unrestricted". */
function toSet(values: readonly string[] | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return new Set(values);
}

function matchesBranch(node: AncestryNode, allowed: ReadonlySet<string>): boolean {
  const keys = nodeBranchKeys(node);
  if (keys.length === 0) {
    return allowed.has(DETACHED_BRANCH);
  }
  for (const key of keys) {
    if (allowed.has(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Prefix-aware file matching: a node is kept when its path starts with any of
 * the selected entries. Selecting `src/webview` therefore keeps
 * `src/webview/client/main.ts`, which is what a user means by "filter by folder".
 */
function matchesFile(node: AncestryNode, allowed: ReadonlySet<string>): boolean {
  const path = node.filePath;
  for (const prefix of allowed) {
    if (prefix.length === 0 || path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function matchesAuthor(node: AncestryNode, allowed: ReadonlySet<string>): boolean {
  const name = sanitizeLabel(node.author.name);
  if (allowed.has(name)) {
    return true;
  }
  // Fall back to the email local part so a user who thinks in `alice@corp`
  // still finds their commits.
  const email = sanitizeLabel(node.author.email);
  const local = email.split('@')[0] ?? '';
  return local.length > 0 && allowed.has(local);
}

function matchesSimilarity(node: AncestryNode, minSimilarity: number): boolean {
  return clamp01(node.similarity) >= minSimilarity;
}

/** Inclusive on both bounds; an inverted range matches nothing. */
function matchesTime(node: AncestryNode, from: number | null, to: number | null): boolean {
  const timestamp = Number.isFinite(node.timestamp) ? node.timestamp : 0;
  if (from !== null && timestamp < from) {
    return false;
  }
  if (to !== null && timestamp > to) {
    return false;
  }
  return true;
}

/**
 * Case-insensitive substring search across the identifying fields.
 *
 * `commit` is matched as a substring rather than a prefix so that both
 * `abc1234` and the full SHA find the same commit; a prefix-only match would
 * make the search box feel broken for anyone who pasted a full SHA.
 */
function matchesSearch(node: AncestryNode, needle: string): boolean {
  const haystacks: Array<string | null> = [
    node.blockName,
    node.qualifiedName,
    node.signature,
    node.filePath,
    node.author.name,
    node.author.email,
    node.commit,
    node.shortCommit,
    node.module,
  ];
  for (const haystack of haystacks) {
    if (typeof haystack === 'string' && haystack.toLowerCase().includes(needle)) {
      return true;
    }
  }
  return false;
}

function normalizeScore(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return clamp01(value);
}

function normalizeTime(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function compareLabels(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
