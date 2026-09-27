/**
 * Origin detection — specification §5.
 *
 * Origin is the *earliest detected semantic match*: the earliest node in the
 * ancestry chain of the focus block whose similarity is at least `possible`.
 * It is never a claim of authorship, and the wording of that disclaimer is
 * fixed by the specification and rendered verbatim.
 *
 * The traversal walks *backwards* over the ancestry edge types
 * (`MERGED_FROM`, `EVOLVED_FROM`, `MODIFIED_FROM`, `MOVED_FROM`,
 * `COPIED_FROM` — i.e. every relationship the graph can contain) from the focus
 * node, so a single ancestor is reachable through any number of hops and any
 * mix of relationships. It is cycle-safe: a visited set bounds the walk, and
 * every function here returns for a cyclic graph.
 */

import type {
  AncestryEdge,
  AncestryEdgeType,
  AncestryGraph,
  AncestryNode,
  OriginInfo,
  SimilarityThresholds,
} from '../types';
import { comparePredecessorRank } from './edge-inference';

/** The phrase every artifact must use for origin (specification §5). */
export const ORIGIN_TERM = 'earliest detected semantic match';

/**
 * The exact disclaimer of specification §5, carried on
 * `OriginInfo.disclaimer` and rendered verbatim. Fixed wording: Git history
 * records commits, not intentions, and the result is bounded by how much
 * history was scanned.
 */
export const ORIGIN_DISCLAIMER =
  'Git history records commits, not intentions. This is the earliest version ' +
  'Ancestry detected that is sufficiently similar to your selection — not proof ' +
  'of original authorship. The search covered the history available in this ' +
  'repository, which may be truncated by a shallow clone or by the configured ' +
  'depth limit.';

/** Every relationship type the ancestry walk follows. */
const ANCESTRY_EDGE_TYPES: ReadonlySet<AncestryEdgeType> = new Set<AncestryEdgeType>([
  'MERGED_FROM',
  'EVOLVED_FROM',
  'MODIFIED_FROM',
  'MOVED_FROM',
  'COPIED_FROM',
]);

/** True when `value` names an ancestry relationship. */
export function isAncestryEdgeType(value: string): value is AncestryEdgeType {
  return ANCESTRY_EDGE_TYPES.has(value as AncestryEdgeType);
}

function indexNodes(nodes: readonly AncestryNode[]): Map<string, AncestryNode> {
  const index = new Map<string, AncestryNode>();
  for (const node of nodes) {
    if (node && typeof node.id === 'string') {
      index.set(node.id, node);
    }
  }
  return index;
}

/** child id → parent ids, restricted to ancestry edge types. */
function incomingParents(edges: readonly AncestryEdge[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge || !isAncestryEdgeType(edge.type)) {
      continue;
    }
    const list = parents.get(edge.from);
    if (list) {
      if (!list.includes(edge.to)) {
        list.push(edge.to);
      }
    } else {
      parents.set(edge.from, [edge.to]);
    }
  }
  return parents;
}

/**
 * All nodes reachable from `focusNodeId` by following incoming ancestry edges,
 * excluding the focus node itself.
 *
 * When `edges` is omitted the graph structure is unknown, so the whole node set
 * ordered by `(timestamp, commit)` is treated as one ancestry chain — the
 * degraded mode a caller gets when it has nodes but no edges. The walk is
 * depth-first with a visited set, so a cyclic graph terminates.
 */
export function collectAncestors(
  nodes: readonly AncestryNode[],
  focusNodeId: string,
  edges: readonly AncestryEdge[] = [],
): AncestryNode[] {
  const index = indexNodes(nodes);
  if (!index.has(focusNodeId)) {
    return [];
  }
  if (edges.length === 0) {
    return nodes
      .filter((node) => node.id !== focusNodeId)
      .filter((node) => compareByTime(node, index.get(focusNodeId)!) < 0)
      .sort(compareByTime);
  }
  const parents = incomingParents(edges);
  const visited = new Set<string>([focusNodeId]);
  const found: AncestryNode[] = [];
  const stack: string[] = [focusNodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const parentId of parents.get(current) ?? []) {
      if (visited.has(parentId)) {
        continue;
      }
      visited.add(parentId);
      const node = index.get(parentId);
      if (node) {
        found.push(node);
        stack.push(parentId);
      }
    }
  }
  return found;
}

/** Strictly-earlier ordering: timestamp, then commit, then id. */
function compareByTime(a: AncestryNode, b: AncestryNode): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.commit !== b.commit) {
    return a.commit < b.commit ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function earliest(nodes: readonly AncestryNode[]): AncestryNode | null {
  let best: AncestryNode | null = null;
  for (const node of nodes) {
    if (best === null || compareByTime(node, best) < 0) {
      best = node;
    }
  }
  return best;
}

function toOriginInfo(node: AncestryNode, basis: OriginInfo['basis']): OriginInfo {
  return {
    nodeId: node.id,
    filePath: node.filePath,
    commit: node.commit,
    shortCommit: node.shortCommit,
    author: node.author,
    timestamp: node.timestamp,
    similarity: node.similarity,
    basis,
    disclaimer: ORIGIN_DISCLAIMER,
  };
}

/**
 * Detects the origin of `focusNodeId`'s ancestry.
 *
 * The origin is the earliest ancestor (by author timestamp, ties broken by
 * commit then id) whose similarity to the focus block is at least
 * `thresholds.possible`. Its basis is `earliest-strong-match` when that node
 * also clears `thresholds.strong`, otherwise `earliest-match`.
 *
 * Returns **null** when the answer would be an overstatement:
 * - the focus node is not in `nodes`;
 * - fewer than two ancestors qualify (specification §5: "fewer than two
 *   nodes"), which includes the empty and single-version cases.
 *
 * In the inconclusive case callers should surface `explainInconclusive` rather
 * than showing nothing.
 */
export function detectOrigin(
  nodes: AncestryNode[],
  focusNodeId: string,
  thresholds: SimilarityThresholds,
  edges: readonly AncestryEdge[] = [],
): OriginInfo | null {
  if (!indexNodes(nodes).has(focusNodeId)) {
    return null;
  }
  const qualifying = collectAncestors(nodes, focusNodeId, edges).filter(
    (node) => node.similarity >= thresholds.possible,
  );
  if (qualifying.length < 2) {
    return null;
  }
  const origin = earliest(qualifying);
  if (origin === null) {
    return null;
  }
  return toOriginInfo(
    origin,
    origin.similarity >= thresholds.strong ? 'earliest-strong-match' : 'earliest-match',
  );
}

/**
 * The record to display when `detectOrigin` returns null.
 *
 * Returns an `inconclusive` `OriginInfo` describing the best available
 * candidate — the earliest qualifying ancestor, or the focus node itself when
 * no ancestor clears `possible` — and null when the origin *is* conclusive
 * (callers should use `detectOrigin`) or the focus id is unknown. The record is
 * still bound by the §5 disclaimer, so the UI cannot accidentally present an
 * inconclusive answer as a finding.
 */
export function explainInconclusive(
  nodes: AncestryNode[],
  focusNodeId: string,
  thresholds: SimilarityThresholds,
  edges: readonly AncestryEdge[] = [],
): OriginInfo | null {
  const index = indexNodes(nodes);
  const focus = index.get(focusNodeId);
  if (!focus) {
    return null;
  }
  const qualifying = collectAncestors(nodes, focusNodeId, edges).filter(
    (node) => node.similarity >= thresholds.possible,
  );
  if (qualifying.length >= 2) {
    return null;
  }
  const subject = earliest(qualifying) ?? focus;
  return toOriginInfo(subject, 'inconclusive');
}

/**
 * The primary inheritance chain from `nodeId` back towards the origin, as node
 * ids, starting at `nodeId`.
 *
 * At each hop the best-ranked incoming edge is followed (the same ordering that
 * chooses a node's primary predecessor), so the result is the line of descent a
 * user would click through. It terminates on cyclic graphs via a visited set,
 * and returns an empty array for an unknown node id.
 */
export function originPath(graph: AncestryGraph, nodeId: string): string[] {
  const index = indexNodes(graph.nodes);
  if (!index.has(nodeId)) {
    return [];
  }
  const parents = incomingParents(graph.edges);
  const path: string[] = [nodeId];
  const visited = new Set<string>([nodeId]);
  let current = nodeId;
  for (;;) {
    const best = bestUnvisitedParent(index, parents, current, visited);
    if (best === null) {
      return path;
    }
    path.push(best.id);
    visited.add(best.id);
    current = best.id;
  }
}

function bestUnvisitedParent(
  index: ReadonlyMap<string, AncestryNode>,
  parents: ReadonlyMap<string, string[]>,
  nodeId: string,
  visited: ReadonlySet<string>,
): AncestryNode | null {
  let best: AncestryNode | null = null;
  for (const parentId of parents.get(nodeId) ?? []) {
    if (visited.has(parentId)) {
      continue;
    }
    const node = index.get(parentId);
    if (!node) {
      continue;
    }
    if (best === null || comparePredecessorRank(node, best) < 0) {
      best = node;
    }
  }
  return best;
}
