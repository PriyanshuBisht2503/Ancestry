/**
 * Graph construction — specification §6.
 *
 * `AncestryGraphBuilder` is a pure function of its `GraphBuildInput`: the same
 * input always produces a byte-identical graph. There is no `Math.random`, no
 * ambient clock (the clock is injected through `input.now`) and no dependence
 * on `Map`/`Set` iteration order anywhere an emitted collection could observe
 * it — every emitted collection is sorted with a total order.
 *
 * Rules implemented here:
 *
 * - **Node identity** is `makeNodeId(blockId, commit)` (specification §2.3).
 *   Colliding candidates are deduplicated by a *total* comparison, not by
 *   arrival order, and a warning records the loss.
 * - **Predecessor preference**: a node prefers predecessors that are strictly
 *   earlier — `parent.authorTimestamp < child.authorTimestamp`, ties broken by
 *   `parent.commit < child.commit`. `MERGED_FROM` is the documented exception:
 *   a merge parent is admitted by git's own `parents` list regardless of the
 *   timestamp comparison, because that list is the definition of parentage.
 * - **Comparison window**: a node below `thresholds.ignore` cannot satisfy the
 *   §4 table for any similarity-based relationship, so it stays in the graph —
 *   the reported cost accounting is never quietly reduced — but it draws no
 *   edge. `MERGED_FROM` is exempt: a merge parent is found through git's own
 *   `parents` list, so it is never similarity-gated.
 * - **Fan-out cap**: a node gets at most {@link MAX_PREDECESSORS_PER_NODE}
 *   incoming edges. Candidates are considered best-first
 *   (`rankPredecessors` order) and the cap is hard; the number of nodes that had
 *   at least one further candidate predecessor is reported as a single aggregate
 *   warning. The exact number of *eligible* predecessors beyond the cap is
 *   deliberately not computed — that is the full pairwise comparison the cap
 *   exists to avoid.
 * - **Similarity aggregates** (`avgSimilarity`, `strongCount`,
 *   `possibleCount`) deliberately exclude the focus node, whose similarity is
 *   the constant 1 and would otherwise inflate every average.
 */

import { createHash } from 'node:crypto';

import { ENGINE_VERSION, SCHEMA_URI, makeEdgeId, makeNodeId, moduleForPath } from '../types';
import type {
  AncestryEdge,
  AncestryGraph,
  AncestryNode,
  GraphStats,
  MatchClassification,
  SimilarityThresholds,
} from '../types';
import type { EdgeDecision, GraphBuildInput, VersionCandidate } from './inputs';
import {
  MAX_PREDECESSORS_PER_NODE,
  couldBeRelated,
  comparePredecessorRank,
  decideRelationship,
  edgeSimilarity,
  isPrimaryPredecessor,
} from './edge-inference';
import { detectOrigin } from './origin';

/** Default thresholds used when the caller supplies a degenerate threshold set. */
const DEFAULT_THRESHOLDS: SimilarityThresholds = { strong: 0.9, possible: 0.75, ignore: 0.6 };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isMatchClassification(value: unknown): value is MatchClassification {
  return value === 'strong' || value === 'possible' || value === 'weak' || value === 'unrelated';
}

/** Derives a classification from a score and the thresholds in force (§3.3). */
function classify(similarity: number, thresholds: SimilarityThresholds): MatchClassification {
  if (similarity >= thresholds.strong) {
    return 'strong';
  }
  if (similarity >= thresholds.possible) {
    return 'possible';
  }
  if (similarity >= thresholds.ignore) {
    return 'weak';
  }
  return 'unrelated';
}

/** Defensive threshold normalisation: never throws, never trusts the caller. */
function normalizeThresholds(value: unknown): SimilarityThresholds {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof SimilarityThresholds, unknown>
  >;
  const strong = clamp01(num(raw.strong));
  const possible = clamp01(num(raw.possible));
  const ignore = clamp01(num(raw.ignore));
  return {
    strong: strong > 0 ? strong : DEFAULT_THRESHOLDS.strong,
    possible: possible > 0 ? possible : DEFAULT_THRESHOLDS.possible,
    ignore: ignore > 0 ? ignore : DEFAULT_THRESHOLDS.ignore,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural guard for orchestrator output. A candidate that does not carry a
 * block id, a commit hash and a similarity is unusable for graph identity and
 * is skipped with a warning rather than crashing the whole analysis
 * (specification §10).
 */
function isVersionCandidate(value: unknown): value is VersionCandidate {
  if (!isRecord(value) || !isRecord(value.block) || !isRecord(value.commit)) {
    return false;
  }
  return (
    typeof value.block.id === 'string' &&
    value.block.id.length > 0 &&
    typeof value.block.filePath === 'string' &&
    isRecord(value.block.range) &&
    typeof value.commit.hash === 'string' &&
    value.commit.hash.length > 0
  );
}

function asBranches(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      seen.add(entry);
    }
  }
  return [...seen].sort();
}

function sha1Hex(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

/** Total, order-independent tie-break for deduplication of colliding candidates. */
function dedupeWinner(a: VersionCandidate, b: VersionCandidate): VersionCandidate {
  const simA = num(a.similarity?.similarity);
  const simB = num(b.similarity?.similarity);
  if (simA !== simB) {
    return simB > simA ? b : a;
  }
  const keyA = dedupeKey(a);
  const keyB = dedupeKey(b);
  return keyA <= keyB ? a : b;
}

/** Canonical, fully specified description of a candidate for tie-breaking. */
function dedupeKey(candidate: VersionCandidate): string {
  const rename = candidate.renameEvidence;
  return [
    candidate.block.filePath,
    str(candidate.block.name),
    str(candidate.block.qualifiedName),
    num(candidate.block.range?.startLine),
    num(candidate.block.range?.endLine),
    candidate.isDeleted ? '1' : '0',
    asBranches(candidate.branches).join(','),
    str(rename?.fromPath),
    str(rename?.commit),
    str(candidate.previousPath),
  ].join('\u0000');
}

/** Total order of emitted nodes: timestamp, then path, then id. */
function compareNodes(a: AncestryNode, b: AncestryNode): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.filePath !== b.filePath) {
    return a.filePath < b.filePath ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/** Total order of emitted edges: from, to, type. */
function compareEdges(a: AncestryEdge, b: AncestryEdge): number {
  if (a.from !== b.from) {
    return a.from < b.from ? -1 : 1;
  }
  if (a.to !== b.to) {
    return a.to < b.to ? -1 : 1;
  }
  if (a.type === b.type) {
    return 0;
  }
  return a.type < b.type ? -1 : 1;
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The node id of a candidate, or the empty string when the record is unusable.
 * The focus node id is the anchor of the whole graph, so it is computed
 * defensively rather than assumed.
 */
function focusNodeIdOf(candidate: VersionCandidate | undefined): string {
  if (!isVersionCandidate(candidate)) {
    return '';
  }
  return makeNodeId(candidate.block.id, candidate.commit.hash);
}

/** Builds an `AncestryGraph` from a set of scored candidates.
 *
 * The builder is synchronous, allocation-light on the hot path and never
 * throws; every problem it meets is either repaired or recorded in
 * `AncestryGraph.warnings` (specification §6: "A file Ancestry skipped is
 * always visible in the report").
 */
export class AncestryGraphBuilder {
  private readonly input: GraphBuildInput;

  constructor(input: GraphBuildInput) {
    this.input = input;
  }

  /**
   * Constructs the graph. Safe to call repeatedly: the builder holds no mutable
   * state, so two calls with the same input return deeply equal graphs.
   */
  build(): AncestryGraph {
    const warnings: string[] = [];
    const thresholds = normalizeThresholds(this.input.thresholds);
    const focus = this.input.focus;
    const focusBlockId = str(focus?.block?.id);
    const generatedAt = this.generatedAt();

    const { candidates, byNodeId, dropped } = this.collectCandidates(warnings);
    for (const id of [...dropped.keys()].sort(compareStrings)) {
      warnings.push(
        `deduplicated ${dropped.get(id)} candidate(s) collapsing onto node ${id} (same block at the same commit); kept the strongest similarity`,
      );
    }
    this.checkFileHistory(candidates, focus, warnings);

    const nodes = this.buildNodes(candidates, focusNodeIdOf(focus), thresholds);
    const edges = this.buildEdges(nodes, byNodeId, thresholds, warnings);

    const origin = detectOrigin(nodes, focusNodeIdOf(focus), thresholds, edges);
    for (const node of nodes) {
      node.isOrigin = origin !== null && node.id === origin.nodeId;
    }

    const stats = this.buildStats(nodes, edges, warnings);
    return {
      id: this.graphId(focusBlockId, generatedAt),
      schema: SCHEMA_URI,
      engineVersion: ENGINE_VERSION,
      focusBlockId,
      repositoryRoot: str(this.input.repositoryRoot),
      generatedAt,
      nodes,
      edges,
      origin,
      stats,
      warnings: dedupeInOrder([...(this.input.warnings ?? []), ...warnings]),
      unparsed: normalizeUnparsed(this.input.unparsed),
    };
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  private generatedAt(): number {
    const now = typeof this.input.now === 'function' ? this.input.now() : Date.now();
    return Number.isFinite(now) ? now : 0;
  }

  private graphId(focusBlockId: string, generatedAt: number): string {
    const provided = this.input.graphId;
    if (typeof provided === 'string' && provided.length > 0) {
      return provided;
    }
    // Specification §6: a stable hash of (repositoryRoot, focusBlockId,
    // generatedAt). NUL-joined so the three fields cannot be confused.
    return sha1Hex(`${str(this.input.repositoryRoot)}\u0000${focusBlockId}\u0000${generatedAt}`);
  }

  /**
   * Validates, deduplicates and guarantees the presence of the focus candidate.
   * Returns the surviving candidates plus the id → candidate index used by the
   * edge phase, and a per-node count of dropped collisions.
   */
  private collectCandidates(warnings: string[]): {
    candidates: VersionCandidate[];
    byNodeId: Map<string, VersionCandidate>;
    dropped: Map<string, number>;
  } {
    const raw = Array.isArray(this.input.candidates) ? this.input.candidates : [];
    const focus = this.input.focus;
    const focusNodeId = focusNodeIdOf(focus);

    const byNodeId = new Map<string, VersionCandidate>();
    const dropped = new Map<string, number>();
    let malformed = 0;
    let sawFocus = false;

    for (const entry of raw) {
      if (!isVersionCandidate(entry)) {
        malformed++;
        continue;
      }
      const id = makeNodeId(entry.block.id, entry.commit.hash);
      if (id === focusNodeId) {
        sawFocus = true;
      }
      const existing = byNodeId.get(id);
      if (existing === undefined) {
        byNodeId.set(id, entry);
        continue;
      }
      dropped.set(id, (dropped.get(id) ?? 0) + 1);
      byNodeId.set(id, dedupeWinner(existing, entry));
    }
    if (malformed > 0) {
      warnings.push(
        `skipped ${malformed} malformed candidate record(s) missing a block or commit identity`,
      );
    }

    if (!sawFocus && focus !== undefined && isVersionCandidate(focus)) {
      byNodeId.set(focusNodeId, focus);
      warnings.push(
        `the selected block ${focusNodeId} was missing from the candidate list; it was added from the focus record`,
      );
    }

    const candidates = [...byNodeId.values()].sort((a, b) =>
      compareStrings(makeNodeId(a.block.id, a.commit.hash), makeNodeId(b.block.id, b.commit.hash)),
    );
    return { candidates, byNodeId, dropped };
  }

  /**
   * Coverage accounting against the focus file's commit list: a version of the
   * focus path that never appears in `fileHistory` is a version the scan did
   * not see, and that is reported rather than hidden (specification §6).
   */
  private checkFileHistory(
    candidates: readonly VersionCandidate[],
    focus: VersionCandidate,
    warnings: string[],
  ): void {
    const history = Array.isArray(this.input.fileHistory) ? this.input.fileHistory : [];
    if (history.length === 0 || !isVersionCandidate(focus)) {
      return;
    }
    const known = new Set<string>();
    for (const commit of history) {
      if (isRecord(commit) && typeof commit.hash === 'string') {
        known.add(commit.hash);
      }
    }
    const focusPath = focus.block.filePath;
    const missing = candidates.filter(
      (candidate) => candidate.block.filePath === focusPath && !known.has(candidate.commit.hash),
    );
    if (missing.length > 0) {
      warnings.push(
        `file history is missing ${missing.length} commit(s) that contain the focus file's path; those versions are not represented in the graph`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  private buildNodes(
    candidates: readonly VersionCandidate[],
    focusNodeId: string,
    thresholds: SimilarityThresholds,
  ): AncestryNode[] {
    const nodes: AncestryNode[] = [];
    for (const candidate of candidates) {
      const id = makeNodeId(candidate.block.id, candidate.commit.hash);
      const isFocus = id === focusNodeId;
      const similarity = isFocus ? 1 : round4(clamp01(num(candidate.similarity?.similarity)));
      const classification: MatchClassification = isFocus
        ? 'strong'
        : isMatchClassification(candidate.similarity?.classification)
          ? candidate.similarity.classification
          : classify(similarity, thresholds);
      const range = candidate.block.range;
      nodes.push({
        id,
        blockId: candidate.block.id,
        blockName: typeof candidate.block.name === 'string' ? candidate.block.name : null,
        blockKind: candidate.block.kind,
        qualifiedName:
          typeof candidate.block.qualifiedName === 'string' ? candidate.block.qualifiedName : null,
        signature: typeof candidate.block.signature === 'string' ? candidate.block.signature : null,
        filePath: candidate.block.filePath,
        commit: candidate.commit.hash,
        shortCommit: str(candidate.commit.shortHash),
        author: {
          name: str(candidate.commit.author?.name),
          email: str(candidate.commit.author?.email),
        },
        timestamp: num(candidate.commit.authorTimestamp),
        hash: str(candidate.block.textHash),
        lineStart: num(range?.startLine),
        lineEnd: num(range?.endLine),
        language: candidate.block.language,
        similarity,
        classification,
        isFocus,
        isOrigin: false,
        branches: asBranches(candidate.branches),
        isDeleted: candidate.isDeleted === true,
        module: moduleForPath(candidate.block.filePath),
      });
    }
    nodes.sort(compareNodes);
    return nodes;
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  private buildEdges(
    nodes: readonly AncestryNode[],
    byNodeId: ReadonlyMap<string, VersionCandidate>,
    thresholds: SimilarityThresholds,
    warnings: string[],
  ): AncestryEdge[] {
    // Every node takes part in the pairwise pass. A node below the ignore floor
    // cannot satisfy `couldBeRelated` for a similarity-based relationship, so it
    // still ends up isolated, while a merge parent — which git itself recorded
    // as a parent — is admitted regardless of score. One rule, no second path.
    const byTime = [...nodes].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      if (a.commit !== b.commit) {
        return a.commit < b.commit ? -1 : 1;
      }
      return compareStrings(a.id, b.id);
    });
    const size = byTime.length;

    // The predecessor ranking is derived once. `rankOf[i]` is the position of
    // `byTime[i]` in best-first order, so the pairwise loop below compares
    // integers instead of re-deriving a three-key ordering for every pair.
    const ranked = byTime
      .map((_, index) => index)
      .sort((a, b) => comparePredecessorRank(byTime[a]!, byTime[b]!));
    const rankOf: number[] = new Array(size);
    ranked.forEach((index, rank) => {
      rankOf[index] = rank;
    });

    // Two nodes of the same commit can never be in a parent/child relation, and
    // a merge parent may sit anywhere in the order, so both checks are one
    // integer comparison against a per-node commit rank.
    const commitRankByHash = new Map<string, number>();
    const commitRankOf: number[] = new Array(size);
    for (let index = 0; index < size; index++) {
      const commit = byTime[index]!.commit;
      let rank = commitRankByHash.get(commit);
      if (rank === undefined) {
        rank = commitRankByHash.size;
        commitRankByHash.set(commit, rank);
      }
      commitRankOf[index] = rank;
    }
    const indexById = new Map<string, number>();
    byTime.forEach((node, index) => indexById.set(node.id, index));

    const byCommit = new Map<string, AncestryNode[]>();
    for (const node of byTime) {
      const bucket = byCommit.get(node.commit);
      if (bucket) {
        bucket.push(node);
      } else {
        byCommit.set(node.commit, [node]);
      }
    }

    const edges: AncestryEdge[] = [];
    const seen = new Set<string>();
    let capped = 0;

    for (let index = 0; index < size; index++) {
      const child = byTime[index]!;
      const childCandidate = byNodeId.get(child.id);
      if (!childCandidate) {
        continue;
      }
      // 1. Strictly-earlier candidates: the whole prefix of the time order. The
      // rank gate runs *before* the eligibility test, so once the shortlist is
      // full a candidate that cannot enter it costs two integer comparisons
      // instead of a full §4 evaluation. It is a pure short-circuit —
      // `couldBeRelated` remains the single source of truth.
      const shortlist: number[] = [];
      const childCommitRank = commitRankOf[index]!;
      const cap = MAX_PREDECESSORS_PER_NODE;
      let worstRank = Number.POSITIVE_INFINITY;
      let omitted = 0;
      for (let other = 0; other < index; other++) {
        if (commitRankOf[other] === childCommitRank) {
          continue;
        }
        if (rankOf[other]! >= worstRank) {
          omitted++;
          continue;
        }
        const parent = byTime[other]!;
        const parentCandidate = byNodeId.get(parent.id);
        if (!parentCandidate || !couldBeRelated(childCandidate, parentCandidate, thresholds)) {
          continue;
        }
        insertRanked(shortlist, other, rankOf);
        if (shortlist.length >= cap) {
          worstRank = rankOf[shortlist[cap - 1]!]!;
        }
      }
      // 2. Merge parents, admitted by git's own parents list (specification §4).
      // This is the documented exception to the time ordering: looking the
      // parent up by commit hash is proof of parentage, so the parent is
      // considered even when it does not precede the child by timestamp.
      const parents = childCandidate.commit.parents;
      if (childCandidate.commit.isMerge && Array.isArray(parents)) {
        for (const parentHash of [...parents].sort(compareStrings)) {
          for (const parent of byCommit.get(parentHash) ?? []) {
            const position = indexById.get(parent.id);
            if (position !== undefined && position < index) {
              continue; // already considered in the earlier prefix
            }
            insertRanked(shortlist, position as number, rankOf);
          }
        }
      }
      if (shortlist.length === 0) {
        continue;
      }

      const best = byTime[shortlist[0]!]!;
      for (const position of shortlist) {
        const parent = byTime[position]!;
        const parentCandidate = byNodeId.get(parent.id);
        if (!parentCandidate) {
          continue;
        }
        const isMergeRelationship =
          childCandidate.commit.isMerge === true &&
          Array.isArray(childCandidate.commit.parents) &&
          childCandidate.commit.parents.includes(parent.commit);
        const similarity = edgeSimilarity(childCandidate, parentCandidate);
        const decision = decideRelationship({
          child: childCandidate,
          parent: parentCandidate,
          childNodeId: child.id,
          parentNodeId: parent.id,
          similarity,
          thresholds,
          isMergeRelationship,
        });
        if (!decision.emit) {
          continue;
        }
        if (
          parent.id !== best.id &&
          decision.type !== 'MERGED_FROM' &&
          !isPrimaryPredecessor(best, parent, thresholds)
        ) {
          continue;
        }
        const edge = makeEdge(child, parent, similarity, decision);
        if (seen.has(edge.id)) {
          continue;
        }
        seen.add(edge.id);
        edges.push(edge);
      }
      if (omitted > 0) {
        capped++;
      }
    }

    if (capped > 0) {
      warnings.push(
        `predecessor fan-out capped at ${MAX_PREDECESSORS_PER_NODE} for ${capped} node(s); further candidate predecessors were omitted`,
      );
    }
    edges.sort(compareEdges);
    return edges;
  }

  /**
   * Honest cost accounting (specification §6). The focus node is excluded from
   * every similarity aggregate — `avgSimilarity`, `strongCount` and
   * `possibleCount` — because its score is the constant 1 and would otherwise
   * inflate the numbers. `truncated` is propagated verbatim: a truncated scan
   * must be visible to the UI, and the builder is also the layer that adds the
   * accompanying warning.
   */
  private buildStats(
    nodes: readonly AncestryNode[],
    edges: readonly AncestryEdge[],
    warnings: string[],
  ): GraphStats {
    const files = new Set<string>();
    const authors = new Set<string>();
    const commits = new Set<string>();
    const branches = new Set<string>();
    let earliest: number | null = null;
    let latest: number | null = null;
    let similaritySum = 0;
    let compared = 0;
    let strongCount = 0;
    let possibleCount = 0;

    for (const node of nodes) {
      files.add(node.filePath);
      commits.add(node.commit);
      authors.add(`${node.author.name}\\u0000${node.author.email}`);
      for (const branch of node.branches) {
        branches.add(branch);
      }
      if (earliest === null || node.timestamp < earliest) {
        earliest = node.timestamp;
      }
      if (latest === null || node.timestamp > latest) {
        latest = node.timestamp;
      }
      if (node.isFocus) {
        continue;
      }
      similaritySum += node.similarity;
      compared++;
      if (node.classification === 'strong') {
        strongCount++;
      } else if (node.classification === 'possible') {
        possibleCount++;
      }
    }

    const truncated = this.input.stats?.truncated === true;
    if (truncated) {
      warnings.push(
        'history is truncated: the earliest detected match is only the earliest within the scanned window',
      );
    }

    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount: files.size,
      authorCount: authors.size,
      commitCount: commits.size,
      branchCount: branches.size,
      earliestTimestamp: earliest,
      latestTimestamp: latest,
      avgSimilarity: compared === 0 ? 0 : round4(similaritySum / compared),
      strongCount,
      possibleCount,
      truncated,
      filesInspected: Math.max(0, Math.round(num(this.input.stats?.filesInspected))),
      blocksCompared: Math.max(0, Math.round(num(this.input.stats?.blocksCompared))),
    };
  }
}

/**
 * Materialises an `AncestryEdge` from a decision. The id is derived with
 * `makeEdgeId`, which is what makes duplicate edges detectable and the edge
 * order-independent.
 */
function makeEdge(
  child: AncestryNode,
  parent: AncestryNode,
  similarity: number,
  decision: EdgeDecision,
): AncestryEdge {
  return {
    id: makeEdgeId(child.id, parent.id, decision.type),
    from: child.id,
    to: parent.id,
    type: decision.type,
    similarity: round4(clamp01(similarity)),
    confidence: decision.confidence,
    sameFile: decision.sameFile,
    lineDelta: decision.lineDelta,
    rationale: decision.rationale,
  };
}

/**
 * Keeps the best `MAX_PREDECESSORS_PER_NODE` candidates of a shortlist, best
 * first. Works on indices into the time-ordered node array so the hot loop
 * compares precomputed ranks instead of node objects; `rankOf` is the total
 * order defined by `comparePredecessorRank`.
 */
function insertRanked(shortlist: number[], index: number, rankOf: readonly number[]): void {
  const rank = rankOf[index]!;
  if (shortlist.length >= MAX_PREDECESSORS_PER_NODE) {
    if (rank >= rankOf[shortlist[MAX_PREDECESSORS_PER_NODE - 1]!]!) {
      return;
    }
    shortlist.pop();
  } else if (shortlist.includes(index)) {
    return;
  }
  let position = 0;
  while (position < shortlist.length && rankOf[shortlist[position]!]! <= rank) {
    position++;
  }
  shortlist.splice(position, 0, index);
}

function dedupeInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = str(value);
    if (text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeUnparsed(
  value: GraphBuildInput['unparsed'],
): Array<{ filePath: string; reason: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: Array<{ filePath: string; reason: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const filePath = str(entry.filePath);
    const reason = str(entry.reason);
    const key = `${filePath}\u0000${reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ filePath, reason });
  }
  out.sort((a, b) => compareStrings(a.filePath, b.filePath) || compareStrings(a.reason, b.reason));
  return out;
}
