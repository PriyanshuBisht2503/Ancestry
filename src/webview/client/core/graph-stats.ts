/**
 * Derived graph facts: ancestry paths, descendants, counts and summaries.
 *
 * WHY PURE AND SEPARATE: these are the answers the detail panel and the
 * "highlight ancestry" command display, and every one of them has to be right
 * about *pathological* graphs — cycles from a botched merge, a graph whose
 * origin was never found, a node id that does not exist. None of those cases
 * can be reproduced on demand in the real UI, so they are all exercised here
 * instead, in milliseconds, on every test run.
 *
 * The module also keeps a `WeakMap` index of nodes by id. The renderer and the
 * panel call `nodeById` in tight loops (once per node per hover frame); a
 * linear scan there is the difference between a 60fps scene and a slideshow on
 * a 5 000-node graph. `WeakMap` means the cache cannot keep a graph alive.
 */

import type { AncestryEdgeType, AncestryGraph, AncestryNode } from '../../../types';
import { EDGE_TYPES, sanitizeLabel } from './domain';
import { humanizeDuration } from './timeline';

/**
 * Preference order when following a node's ancestry backwards.
 *
 * A merge is the strongest statement about where a line of code came from
 * ("these two histories converged here"), so it is followed first. A move is
 * followed last: relocation is a weaker claim about identity than a rewrite,
 * and preferring it would route a moved function's ancestry into an unrelated
 * file's line.
 */
const ANCESTRY_PREFERENCE: ReadonlySet<string> = new Set<string>([
  'MERGED_FROM',
  'EVOLVED_FROM',
  'MODIFIED_FROM',
  'MOVED_FROM',
  'COPIED_FROM',
]);

/** An adjacency index over one graph. Rebuilt whenever the graph object changes. */
interface GraphIndex {
  readonly byId: ReadonlyMap<string, AncestryNode>;
  /** child id → parent id, in graph order. */
  readonly parents: ReadonlyMap<string, string[]>;
  /** parent id → child ids, in graph order. */
  readonly children: ReadonlyMap<string, string[]>;
  /** child id → (parent id → edge type), so ancestry can prefer a type. */
  readonly parentTypes: ReadonlyMap<string, ReadonlyMap<string, AncestryEdgeType>>;
  /** Node ids sharing an edge with each node, in either direction. */
  readonly neighbours: ReadonlyMap<string, string[]>;
}

const INDEX_CACHE = new WeakMap<AncestryGraph, GraphIndex>();

/** An empty result, used when a graph has no usable nodes at all. */
function emptyIndex(): GraphIndex {
  return {
    byId: new Map(),
    parents: new Map(),
    children: new Map(),
    parentTypes: new Map(),
    neighbours: new Map(),
  };
}

/**
 * Walks a node's ancestry **backwards** to the origin.
 *
 * Returns node ids ordered from `nodeId` towards the oldest known ancestor.
 * Robustness rules, all of which are covered by tests:
 *  - a missing node yields `[]` rather than throwing;
 *  - a cycle terminates (a `visited` set) instead of recursing forever;
 *  - a graph with no detectable origin simply ends the path at the last node
 *    with no parent, and the caller can tell "no origin" from "no path" by
 *    checking whether the final node has `isOrigin`;
 *  - a node reachable through several parents follows the preferred type.
 */
export function ancestryPath(graph: AncestryGraph, nodeId: string): string[] {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return [];
  }
  const index = getIndex(graph);
  if (!index.byId.has(nodeId)) {
    return [];
  }
  const path: string[] = [nodeId];
  const visited = new Set<string>([nodeId]);
  let current = nodeId;
  for (;;) {
    const next = preferredParent(index, current);
    if (next === null || visited.has(next)) {
      return path;
    }
    path.push(next);
    visited.add(next);
    current = next;
  }
}

/**
 * The forward closure of a node: itself plus everything descended from it.
 *
 * Breadth-first, and the result is ordered by discovery, so the highlighted set
 * is stable for a given graph. A cycle yields a finite, duplicate-free set.
 */
export function descendants(graph: AncestryGraph, nodeId: string): string[] {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return [];
  }
  const index = getIndex(graph);
  if (!index.byId.has(nodeId)) {
    return [];
  }
  const out: string[] = [nodeId];
  const visited = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of index.children.get(current) ?? []) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * A one-line description of a graph's size and span, e.g.
 * `12 versions · 4 files · 3 authors over 2 years`.
 *
 * Uses `·` as the separator rather than a comma so the line stays readable when
 * two of the numbers are long paths/author names, and singularises correctly
 * (`1 version · 1 file`).
 */
export function summarizeGraph(graph: AncestryGraph): string {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (nodes.length === 0) {
    return 'No matching versions found';
  }
  const files = new Set<string>();
  const authors = new Set<string>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (node.filePath.length > 0) {
      files.add(node.filePath);
    }
    // An anonymous commit is still one author as far as the summary is
    // concerned; reporting "0 authors" for a graph full of commits would be
    // plainly wrong. Bucketed the same way `groupByAuthor` buckets it.
    authors.add(sanitizeLabel(node.author.name) || '(unknown)');
    const timestamp = Number.isFinite(node.timestamp) ? node.timestamp : 0;
    if (timestamp < min) {
      min = timestamp;
    }
    if (timestamp > max) {
      max = timestamp;
    }
  }
  const span =
    Number.isFinite(min) && Number.isFinite(max) && max > min
      ? humanizeDuration(max - min)
      : 'an instant';
  const fileCount = files.size;
  const authorCount = authors.size;
  return (
    [
      `${nodes.length} ${pluralize(nodes.length, 'version')}`,
      `${fileCount} ${pluralize(fileCount, 'file')}`,
      `${authorCount} ${pluralize(authorCount, 'author')}`,
    ].join(' · ') + ` over ${span}`
  );
}

/** Author → node count, descending by count then ascending by name. */
export function groupByAuthor(graph: AncestryGraph): Array<{ author: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const author = sanitizeLabel(node.author.name) || '(unknown)';
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count || compareText(a.author, b.author));
}

/** File path → node count, descending by count then ascending by path. */
export function clusterByFile(graph: AncestryGraph): Array<{ filePath: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const filePath = node.filePath.length > 0 ? node.filePath : '(unknown)';
    counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([filePath, count]) => ({ filePath, count }))
    .sort((a, b) => b.count - a.count || compareText(a.filePath, b.filePath));
}

/** Looks a node up by id; `null` on a miss rather than `undefined`. */
export function nodeById(graph: AncestryGraph, id: string): AncestryNode | null {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return getIndex(graph).byId.get(id) ?? null;
}

/**
 * The node plus every node sharing an edge with it, in either direction.
 *
 * Ordered by `(timestamp, id)` so the "related versions" list in the detail
 * panel reads chronologically, which is what makes it useful for tracing a
 * line of code. The node itself is first.
 */
export function relatedNodes(graph: AncestryGraph, nodeId: string): string[] {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return [];
  }
  const index = getIndex(graph);
  const node = index.byId.get(nodeId);
  if (node === undefined) {
    return [];
  }
  const ids = new Set<string>([nodeId]);
  for (const related of index.neighbours.get(nodeId) ?? []) {
    if (related !== nodeId) {
      ids.add(related);
    }
  }
  return [...ids].sort((a, b) => {
    const left = index.byId.get(a);
    const right = index.byId.get(b);
    const leftTime = left !== undefined && Number.isFinite(left.timestamp) ? left.timestamp : 0;
    const rightTime = right !== undefined && Number.isFinite(right.timestamp) ? right.timestamp : 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return compareText(a, b);
  });
}

/** The number of distinct edge types actually present, for the status line. */
export function countEdgeTypes(graph: AncestryGraph): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of EDGE_TYPES) {
    counts[type] = 0;
  }
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (counts[edge.type] !== undefined) {
      counts[edge.type] = (counts[edge.type] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Builds (and caches) the adjacency index for a graph object. */
function getIndex(graph: AncestryGraph | null | undefined): GraphIndex {
  if (graph === null || graph === undefined || typeof graph !== 'object') {
    return emptyIndex();
  }
  const cached = INDEX_CACHE.get(graph);
  if (cached !== undefined) {
    return cached;
  }
  const byId = new Map<string, AncestryNode>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (
      node !== null &&
      typeof node === 'object' &&
      typeof node.id === 'string' &&
      !byId.has(node.id)
    ) {
      byId.set(node.id, node);
    }
  }
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const parentTypes = new Map<string, Map<string, AncestryEdgeType>>();
  const neighbours = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list === undefined) {
      map.set(key, [value]);
    } else if (!list.includes(value)) {
      list.push(value);
    }
  };
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (edge === null || typeof edge !== 'object') {
      continue;
    }
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      continue;
    }
    push(parents, edge.from, edge.to);
    push(children, edge.to, edge.from);
    push(neighbours, edge.from, edge.to);
    push(neighbours, edge.to, edge.from);
    let types = parentTypes.get(edge.from);
    if (types === undefined) {
      types = new Map<string, AncestryEdgeType>();
      parentTypes.set(edge.from, types);
    }
    if (!types.has(edge.to)) {
      types.set(edge.to, edge.type);
    }
  }
  const index: GraphIndex = { byId, parents, children, parentTypes, neighbours };
  INDEX_CACHE.set(graph, index);
  return index;
}

/**
 * Picks the parent to follow, honouring {@link ANCESTRY_PREFERENCE}.
 *
 * When two parents tie on rank (e.g. both are `COPIED_FROM`) the earlier one in
 * graph order wins, so the result is deterministic for a given graph.
 */
function preferredParent(index: GraphIndex, nodeId: string): string | null {
  const candidates = index.parents.get(nodeId);
  if (candidates === undefined || candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  const types = index.parentTypes.get(nodeId);
  const ranks = [...ANCESTRY_PREFERENCE];
  let best = candidates[0]!;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const type = types?.get(candidate);
    const rank =
      type !== undefined && ANCESTRY_PREFERENCE.has(type) ? ranks.indexOf(type) : ranks.length;
    if (rank < bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  return best;
}

function pluralize(count: number, noun: string): string {
  return `${noun}${count === 1 ? '' : 's'}`;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
