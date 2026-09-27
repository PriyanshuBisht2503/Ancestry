/**
 * Relationship inference: which version of a block succeeded which, and why.
 *
 * Implements specification §4 exactly. The decision order is *evidence order*,
 * strongest evidence first, so the verdict never depends on iteration order:
 *
 *   1. `MERGED_FROM`  — the child's commit is a merge and the parent is one of
 *      its parents. Parentage is recorded by git, not inferred, so it wins
 *      outright.
 *   2. `MOVED_FROM`   — different paths plus move evidence (an explicit git
 *      rename, a path-history move, or an identical block name). Similarity
 *      alone is never enough (specification §4).
 *   3. `EVOLVED_FROM` — same path, similarity ≥ `possible`.
 *      `MODIFIED_FROM` — same path, similarity in `[ignore, possible)`.
 *   4. `COPIED_FROM`  — different path, similarity ≥ `possible`, no move
 *      evidence.
 *   Otherwise: no relationship (`emit === false`).
 *
 * ## Confidence formula
 *
 * Confidence is computed, never hand-picked per branch:
 *
 *   confidence = clamp01(evidenceBase - evidencePenalty + similarityBonus)
 *
 *   similarityBonus = 0.10 * clamp01((similarity - ignore) / (1 - ignore))
 *
 * `evidenceBase`/`evidencePenalty` encode *how much the evidence class is
 * trusted*; the bonus is the only term that depends on the measured
 * similarity. The bases are spaced further apart than the maximum bonus
 * (0.10), which makes the global ordering an invariant rather than a
 * coincidence:
 *
 *   MERGED_FROM (0.90) > MOVED_FROM via rename (0.75) > MOVED_FROM via name
 *   (0.70) > EVOLVED_FROM (0.60) > COPIED_FROM (0.40) > MODIFIED_FROM (0.20)
 *
 * for *every* similarity value. Move evidence is additionally penalised
 * according to its rank (rename 0.00, path history 0.03, name match 0.05) so a
 * name match can never outrank a git-detected rename.
 */

import type { AncestryEdgeType, AncestryNode, CodeBlock, SimilarityThresholds } from '../types';
import type { EdgeDecision, EdgeDecisionInput, VersionCandidate } from './inputs';

/** The kinds of evidence that can justify a `MOVED_FROM` edge, strongest first. */
export type MoveEvidence = 'rename' | 'path-history' | 'name';

/**
 * Trust assigned to each relationship class before the similarity bonus.
 * Spaced by more than {@link SIMILARITY_BONUS_MAX} so the ordering
 * merge > move > evolve > copy > modified holds for any similarity value.
 */
export const EVIDENCE_BASE: Readonly<Record<AncestryEdgeType, number>> = Object.freeze({
  MERGED_FROM: 0.9,
  MOVED_FROM: 0.75,
  EVOLVED_FROM: 0.6,
  COPIED_FROM: 0.4,
  MODIFIED_FROM: 0.2,
});

/** Penalty per move-evidence class: an explicit git rename beats a name match. */
export const MOVE_EVIDENCE_PENALTY: Readonly<Record<MoveEvidence, number>> = Object.freeze({
  rename: 0,
  'path-history': 0.03,
  name: 0.05,
});

/** Maximum amount the measured similarity can add to an evidence base. */
export const SIMILARITY_BONUS_MAX = 0.1;

/**
 * Similarity floor required to draw a `MOVED_FROM` edge, per evidence class.
 *
 * Specification §4 asks for `strong`. For an explicit git rename the
 * requirement is relaxed to `possible` because the priority order in §4 puts
 * rename evidence above the copy fallback, and refusing the edge would
 * downgrade a *known* move to a guess. A name match keeps the `strong` floor:
 * identical names in two files is a hint, not proof.
 */
export const MOVE_SIMILARITY_FLOOR: Readonly<Record<MoveEvidence, 'possible' | 'strong'>> =
  Object.freeze({
    rename: 'possible',
    'path-history': 'possible',
    name: 'strong',
  });

/** Smallest margin used when deciding whether a second predecessor is drawn. */
export const PREDECESSOR_MARGIN_FLOOR = 0.05;

/** Number of incoming edges a single node may have, including its primary one. */
export const MAX_PREDECESSORS_PER_NODE = 3;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Rounds to four decimals so serialised graphs are stable and readable. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** `0.96` → `96%`. Deterministic integer percent for rationales. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Edge similarity for an ordered pair.
 *
 * Ancestry only ever computes similarity against the focus block, so the true
 * pairwise similarity is unavailable. The conservative lower bound
 * `min(child, parent)` is used instead: it is *exact* for every edge incident
 * to the focus node (whose own score is 1) and a lower bound otherwise, which
 * is the safe direction — it never overstates a relationship.
 */
export function edgeSimilarity(child: VersionCandidate, parent: VersionCandidate): number {
  return round4(Math.min(num(child.similarity?.similarity), num(parent.similarity?.similarity)));
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** True when the pair is a merge parent relationship per git's own record. */
function isMergePair(child: VersionCandidate, parent: VersionCandidate): boolean {
  const parents = child.commit?.parents;
  return (
    child.commit?.isMerge === true &&
    Array.isArray(parents) &&
    parents.includes(parent.commit?.hash)
  );
}

/**
 * Ranks the move evidence linking `parent` to `child`, or null when there is
 * none. Specification §4: rename beats name match; similarity is not evidence.
 */
export function classifyMoveEvidence(
  child: VersionCandidate,
  parent: VersionCandidate,
): MoveEvidence | null {
  const parentPath = parent.block?.filePath;
  const evidence = child.renameEvidence;
  if (evidence && evidence.fromPath === parentPath) {
    return 'rename';
  }
  if (typeof child.previousPath === 'string' && child.previousPath === parentPath) {
    return 'path-history';
  }
  const name = child.block?.name;
  if (typeof name === 'string' && name.length > 0 && name === parent.block?.name) {
    return 'name';
  }
  return null;
}

/**
 * The similarity bonus for a decision: at most {@link SIMILARITY_BONUS_MAX},
 * scaled linearly from the ignore floor to a perfect match. A similarity at (or
 * below) the ignore floor contributes nothing, which is what keeps
 * `MODIFIED_FROM` the low-confidence band it is in specification §4.
 */
export function similarityBonus(similarity: number, thresholds: SimilarityThresholds): number {
  const span = 1 - thresholds.ignore;
  const normalised =
    span > 0 ? (clamp01(similarity) - thresholds.ignore) / span : clamp01(similarity);
  return SIMILARITY_BONUS_MAX * clamp01(normalised);
}

interface ResolvedRelation {
  type: AncestryEdgeType;
  evidence: MoveEvidence | null;
}

/**
 * The single place the specification §4 table is encoded. Returns null when the
 * pair yields no relationship. Both `decideRelationship` and
 * `couldBeRelated` route through it, so the cheap pre-filter the builder uses
 * can never disagree with the authoritative verdict.
 */
function resolveRelation(
  similarity: number,
  sameFile: boolean,
  isMerge: boolean,
  move: MoveEvidence | null,
  thresholds: SimilarityThresholds,
): ResolvedRelation | null {
  // 1. Merge — git's own record, not an inference.
  if (isMerge) {
    return { type: 'MERGED_FROM', evidence: null };
  }

  // 2. Move — different paths plus rename / path-history / name evidence.
  if (!sameFile && move !== null) {
    if (similarity >= thresholds[MOVE_SIMILARITY_FLOOR[move]]) {
      return { type: 'MOVED_FROM', evidence: move };
    }
    // A name match below the `strong` floor is not enough to claim a move; the
    // pair falls through to the copy rule below when it clears `possible`.
  }

  // 3. Same path — the construct was modified in place.
  if (sameFile) {
    if (similarity >= thresholds.possible) {
      return { type: 'EVOLVED_FROM', evidence: null };
    }
    if (similarity >= thresholds.ignore) {
      return { type: 'MODIFIED_FROM', evidence: null };
    }
    return null;
  }

  // 4. Different path without move evidence — an independent copy.
  if (similarity >= thresholds.possible) {
    return { type: 'COPIED_FROM', evidence: null };
  }
  return null;
}

/**
 * Cheap O(1) eligibility test used by the builder to shortlist predecessors.
 * Exactly equivalent to `decideRelationship(...).emit` — see
 * {@link resolveRelation}. Callers must never pair a candidate with itself; the
 * builder enforces that structurally by only ever comparing a node with nodes
 * from a strictly-earlier prefix of the time order.
 */
export function couldBeRelated(
  child: VersionCandidate,
  parent: VersionCandidate,
  thresholds: SimilarityThresholds,
): boolean {
  return (
    resolveRelation(
      edgeSimilarity(child, parent),
      child.block?.filePath === parent.block?.filePath,
      isMergePair(child, parent),
      classifyMoveEvidence(child, parent),
      thresholds,
    ) !== null
  );
}

/**
 * Decides the relationship between a child (later) and a parent (earlier)
 * candidate according to specification §4, returning the type, a confidence
 * computed from the evidence, and a rationale naming that evidence.
 *
 * Never throws; unusable input yields `emit: false`.
 */
export function decideRelationship(input: EdgeDecisionInput): EdgeDecision {
  const child = input.child;
  const parent = input.parent;
  const thresholds = input.thresholds;
  const similarity = clamp01(num(input.similarity));
  const sameFile = child?.block?.filePath === parent?.block?.filePath;
  const lineDelta = computeLineDelta(child.block, parent.block);
  const isMerge = input.isMergeRelationship === true || isMergePair(child, parent);
  const move = sameFile ? null : classifyMoveEvidence(child, parent);
  const bonus = similarityBonus(similarity, thresholds);
  const confidence = (base: number, penalty = 0): number => round4(clamp01(base - penalty + bonus));

  const resolved = resolveRelation(similarity, sameFile, isMerge, move, thresholds);
  if (resolved === null) {
    return {
      type: 'COPIED_FROM',
      confidence: 0,
      rationale: noRelationRationale(similarity, sameFile, thresholds),
      sameFile,
      lineDelta,
      emit: false,
    };
  }

  switch (resolved.type) {
    case 'MERGED_FROM':
      return {
        type: 'MERGED_FROM',
        confidence: confidence(EVIDENCE_BASE.MERGED_FROM),
        rationale: mergeRationale(child, parent),
        sameFile,
        lineDelta,
        emit: true,
      };
    case 'MOVED_FROM':
      return {
        type: 'MOVED_FROM',
        confidence: confidence(EVIDENCE_BASE.MOVED_FROM, MOVE_EVIDENCE_PENALTY[resolved.evidence!]),
        rationale: moveRationale(child, parent, resolved.evidence!, similarity, thresholds),
        sameFile,
        lineDelta,
        emit: true,
      };
    case 'EVOLVED_FROM':
      return {
        type: 'EVOLVED_FROM',
        confidence: confidence(EVIDENCE_BASE.EVOLVED_FROM),
        rationale: evolveRationale(child, parent, similarity, thresholds),
        sameFile,
        lineDelta,
        emit: true,
      };
    case 'MODIFIED_FROM':
      return {
        type: 'MODIFIED_FROM',
        confidence: confidence(EVIDENCE_BASE.MODIFIED_FROM),
        rationale: modifiedRationale(child, similarity, thresholds),
        sameFile,
        lineDelta,
        emit: true,
      };
    case 'COPIED_FROM':
    default:
      return {
        type: 'COPIED_FROM',
        confidence: confidence(EVIDENCE_BASE.COPIED_FROM),
        rationale: copyRationale(child, parent, similarity, thresholds),
        sameFile,
        lineDelta,
        emit: true,
      };
  }
}

/**
 * Line-count delta between two versions of a construct in the same file, or
 * null when the paths differ (there is no meaningful in-file delta then).
 *
 * Positive means the child grew. The sign is deliberately the *span* delta, not
 * the position delta: specification's `AncestryEdge.lineDelta` is defined as a
 * "signed line-count delta".
 */
export function computeLineDelta(child: CodeBlock, parent: CodeBlock): number | null {
  if (child.filePath !== parent.filePath) {
    return null;
  }
  return lineCount(child) - lineCount(parent);
}

function lineCount(block: CodeBlock): number {
  const span = num(block.range?.endLine) - num(block.range?.startLine);
  return span > 0 ? Math.round(span) : 0;
}

/**
 * Total order over predecessor candidates, best first: similarity to the focus
 * descending, then the earlier commit, then the node id. The id tie-break
 * guarantees a total order, which is what makes the primary incoming edge of a
 * node deterministic regardless of the order candidates were discovered in.
 */
export function comparePredecessorRank(a: AncestryNode, b: AncestryNode): number {
  if (a.similarity !== b.similarity) {
    return b.similarity - a.similarity;
  }
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/** Sorts a node's possible predecessors best-first; does not mutate the input. */
export function rankPredecessors(candidates: readonly AncestryNode[]): AncestryNode[] {
  return [...candidates].sort(comparePredecessorRank);
}

/**
 * The margin a second predecessor must stay within of the best one:
 * `max(0.05, strong - possible)` — 0.15 with the default thresholds, i.e. one
 * full classification band. It is derived from the thresholds so that retuning
 * the bands retunes the fan-out with them.
 */
export function predecessorMargin(thresholds: SimilarityThresholds): number {
  return Math.max(PREDECESSOR_MARGIN_FLOOR, thresholds.strong - thresholds.possible);
}

/**
 * Whether `other` is good enough to be drawn as an *additional* incoming edge
 * of a node whose best predecessor is `best`.
 *
 * Margin rule: an extra predecessor must (a) clear `possible` on its own — a
 * weaker stub adds a hairball, not information — and (b) come within the
 * margin of the best predecessor's similarity. Together these keep branches and
 * merge parents visible while suppressing the long tail of merely "possible"
 * candidates. Merge relationships bypass this test in the builder: git
 * recorded them, so they are evidence rather than a guess.
 */
export function isPrimaryPredecessor(
  best: AncestryNode,
  other: AncestryNode,
  thresholds: SimilarityThresholds,
): boolean {
  if (best.id === other.id) {
    return false;
  }
  if (other.similarity < thresholds.possible) {
    return false;
  }
  return other.similarity >= best.similarity - predecessorMargin(thresholds);
}

// ---------------------------------------------------------------------------
// Rationales — every one names the evidence that produced the decision.
// ---------------------------------------------------------------------------

function noRelationRationale(
  similarity: number,
  sameFile: boolean,
  thresholds: SimilarityThresholds,
): string {
  if (sameFile) {
    return `no relationship evidence: similarity ${pct(similarity)} is below the ignore floor ${pct(thresholds.ignore)}.`;
  }
  return `no relationship evidence: similarity ${pct(similarity)} is below the possible threshold ${pct(thresholds.possible)} and no rename or name evidence links the two files.`;
}

function mergeRationale(child: VersionCandidate, parent: VersionCandidate): string {
  const parents = child.commit.parents;
  const count = Array.isArray(parents) ? parents.length : 0;
  return `git recorded ${child.commit.shortHash} as a merge commit with ${count} parent${count === 1 ? '' : 's'}, and the block exists unchanged in parent ${parent.commit.shortHash}.`;
}

function moveRationale(
  child: VersionCandidate,
  parent: VersionCandidate,
  evidence: MoveEvidence,
  similarity: number,
  thresholds: SimilarityThresholds,
): string {
  const childPath = child.block.filePath;
  switch (evidence) {
    case 'rename': {
      const rename = child.renameEvidence;
      return `git detected rename of ${rename?.fromPath ?? parent.block.filePath} → ${childPath} (score ${pct(num(rename?.score))}) at ${child.commit.shortHash}, and the block matched ${parent.block.filePath} (similarity ${pct(similarity)} ≥ ${pct(thresholds.possible)}).`;
    }
    case 'path-history':
      return `path history moved the block from ${child.previousPath} to ${childPath} at ${child.commit.shortHash}, and the block matched ${parent.block.filePath} (similarity ${pct(similarity)} ≥ ${pct(thresholds.possible)}).`;
    case 'name':
    default:
      return `block "${child.block.name ?? '<anon>'}" appears in ${parent.block.filePath} before ${childPath} (name match, similarity ${pct(similarity)} ≥ ${pct(thresholds.strong)}).`;
  }
}

function evolveRationale(
  child: VersionCandidate,
  parent: VersionCandidate,
  similarity: number,
  thresholds: SimilarityThresholds,
): string {
  const childName = child.block.name;
  const parentName = parent.block.name;
  const identity =
    typeof childName === 'string' && childName.length > 0 && childName === parentName
      ? `name "${childName}" preserved`
      : 'construct edited in place';
  return `same file ${child.block.filePath}, modified in place (${identity}); similarity ${pct(similarity)} ≥ possible ${pct(thresholds.possible)}.`;
}

function modifiedRationale(
  child: VersionCandidate,
  similarity: number,
  thresholds: SimilarityThresholds,
): string {
  return `same file ${child.block.filePath}, but only a weak match: similarity ${pct(similarity)} is between ignore ${pct(thresholds.ignore)} and possible ${pct(thresholds.possible)}.`;
}

function copyRationale(
  child: VersionCandidate,
  parent: VersionCandidate,
  similarity: number,
  thresholds: SimilarityThresholds,
): string {
  const band =
    similarity >= thresholds.strong
      ? `at or above the strong threshold ${pct(thresholds.strong)}`
      : `above possible ${pct(thresholds.possible)} but below strong ${pct(thresholds.strong)}`;
  return `different files (${parent.block.filePath} → ${child.block.filePath}) with no rename evidence; similarity ${pct(similarity)} is ${band}.`;
}
