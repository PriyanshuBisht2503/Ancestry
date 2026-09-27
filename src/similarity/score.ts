/**
 * Similarity scoring for the Ancestry engine.
 *
 * Ancestry's thesis is that a code block's *identity* survives cosmetic change.
 * Formatting, comments, identifier names and file location must not break a
 * match; operator and control-flow changes must break it. The score produced here
 * is the single number behind that claim, and every component is chosen to be
 * insensitive to exactly the former and sensitive to exactly the latter:
 *
 * | Component  | Insensitive to                          | Sensitive to            |
 * |------------|-----------------------------------------|-------------------------|
 * | `jaccard`  | order, renames, formatting, comments    | inserted/removed tokens |
 * | `simhash`  | order, small token churn                | gross token makeup      |
 * | `lcs`      | renames, formatting, comments           | statement reordering    |
 * | `shape`    | identifiers, literals, comments          | node types, nesting     |
 *
 * The four are deliberately redundant rather than independent: a cheap global
 * sketch (`simhash`) can rescue a local one (`shape`) when a block is too small
 * for shingles, and the expensive exact one (`lcs`) can veto a coincidental
 * shingle overlap.
 *
 * @module similarity/score
 */

import type {
  MatchClassification,
  NormalizedBlock,
  SimilarityBreakdown,
  SimilarityCandidateRef,
  SimilarityResult,
  SimilarityThresholds,
} from '../types';

import { cosine, estimateJaccardFromMinhash, hammingSimilarity } from './hashing';
import { tokenLcsLength, tokenLcsRatio } from './lcs';

/** Every key of `SimilarityBreakdown`, in the canonical reporting order. */
const COMPONENT_KEYS: ReadonlyArray<keyof SimilarityBreakdown> = [
  'jaccard',
  'simhash',
  'lcs',
  'shape',
];

/** Score components a user is allowed to re-weight. */
export type SimilarityComponent = keyof SimilarityBreakdown;

/**
 * Default component weights. The four values sum to 1, which makes a fully
 * populated breakdown's weighted mean directly readable as a probability-like
 * quantity (though it is not one).
 *
 * Justification, largest weight first:
 *
 *  - `jaccard: 0.5` — the dominant term because it is the only component that
 *    measures *content overlap* rather than a proxy. Set overlap is the property
 *    that survives renaming (normalisation already canonicalises identifiers), and
 *    its degradation is graceful and monotone: adding one statement to a 40-token
 *    body removes at most 4 of ~37 shingles.
 *  - `simhash: 0.2` — a 64-bit global fingerprint. Costs one XOR and one
 *    popcount, so it is nearly free, and it is the only component that stays
 *    informative on blocks too small to shingle. 0.2 rather than higher because
 *    64 bits is a *coarse* measure: two structurally different blocks can share
 *    half their bits, and it cannot see order at all.
 *  - `lcs: 0.2` — order sensitivity. It is the most expensive component
 *    (`O(n*m)`), and near-duplicates already score ~1.0 on Jaccard, so its
 *    marginal value is in the *penalty* it applies to reordered code rather than
 *    in the credit it gives to unchanged code.
 *  - `shape: 0.1` — structural feature cosine. A weak tie-breaker: it is
 *    dominated by the three above whenever the token stream is meaningful, and
 *    when it is not (a one-liner) the whole score is noise anyway. Kept at a
 *    small weight so that a strong-but-differently-shaped match, such as a method
 *    inlined into a factory function, still separates from an exact same-shape
 *    copy.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<keyof SimilarityBreakdown, number>> = Object.freeze({
  jaccard: 0.5,
  simhash: 0.2,
  lcs: 0.2,
  shape: 0.1,
});

/**
 * Default classification thresholds.
 *
 * ## These are empirically validated defaults, not universal constants.
 *
 * They were calibrated on a corpus of paired JS/TS snippets covering the
 * transformations Ancestry claims to survive (rename, reformat, comment
 * insertion, file move, statement insertion) and the ones it must not
 * (operator swaps, `==`/`===`, inverted conditions, unrelated same-file
 * functions). `0.90` sits above the rename+reformat+comment cluster and below
 * the "one statement added" cluster; `0.75` sits below that cluster and above
 * genuinely different same-file functions; `0.60` is the cut-off below which a
 * candidate is not even reported to the UI.
 *
 * They are **not** properties of code, and they are exposed as user settings
 * (`ancestry.similarity.strongThreshold`, `...possibleThreshold`) because the
 * right value depends on the corpus: a codebase of near-identical generated
 * CRUD handlers wants a higher `strong` bar than a codebase of hand-written
 * algorithmic code, where `0.90` may be unreachable even for a true copy.
 * Nothing in the engine may assume these values; always thread the
 * `SimilarityThresholds` object through.
 */
export const DEFAULT_THRESHOLDS: SimilarityThresholds = Object.freeze({
  strong: 0.9,
  possible: 0.75,
  ignore: 0.6,
});

/**
 * Minimum number of shingles on *both* sides before the Jaccard component is
 * trusted.
 *
 * Justification: with fewer than 3 shingles the MinHash estimate has a standard
 * error of ~0.3 at `p = 0.5` — worse than the SimHash it is meant to refine — and
 * a 1-token block has exactly one shingle, so a single token edit reports a 0.0
 * Jaccard. Skipping is strictly better than reporting noise, provided the weights
 * are renormalised, which {@link combine} does.
 */
export const DEFAULT_MIN_SHINGLES_FOR_MINHASH = 3;

/** Number of MinHash bands Ancestry emits. */
const MINHASH_BANDS = 128;

/** Every component scored `1`, used by the identical-normalisation fast path. */
const PERFECT_BREAKDOWN: SimilarityBreakdown = Object.freeze({
  jaccard: 1,
  simhash: 1,
  lcs: 1,
  shape: 1,
});

/** All four components, in canonical order. */
const ALL_COMPONENTS: ReadonlyArray<keyof SimilarityBreakdown> = COMPONENT_KEYS;

/** Clamp to `[0, 1]`; `NaN` and negative values map to `0`, `+Infinity` to `1`. */
function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

/**
 * Classify a similarity score against a threshold triple.
 *
 * The boundaries are inclusive on the lower side (`>=`), so `ignore` at 0.6
 * means "a score of exactly 0.6 is still reported". That matters for
 * reproducibility: two runs that produce the same float must produce the same
 * label, and a strict comparison at a round threshold would flip on
 * floating-point noise.
 *
 * @param similarity - Score in `[0, 1]`; values outside the range are clamped
 *   before comparison so a drifted score cannot produce an impossible label.
 * @param t - Threshold configuration.
 * @returns `'strong'`, `'possible'`, `'weak'`, or `'unrelated'`.
 */
export function classify(similarity: number, t: SimilarityThresholds): MatchClassification {
  const score = clampUnit(similarity);
  if (score >= t.strong) {
    return 'strong';
  }
  if (score >= t.possible) {
    return 'possible';
  }
  if (score >= t.ignore) {
    return 'weak';
  }
  return 'unrelated';
}

/**
 * Weighted mean over the components that were *actually computed*.
 *
 * The weights are renormalised by the sum of the weights used, not by the sum of
 * all four. This is essential rather than cosmetic: a three-token block has no
 * usable shingles, so its Jaccard component is skipped — and if the skipped
 * component were counted as a zero, an exact match of two trivial blocks would
 * score 0.5 and be reported as `'possible'` instead of `'strong'`. Renormalising
 * means a skipped component contributes no information, neither positive nor
 * negative, so components become independently switchable.
 *
 * @param breakdown - Component values in `[0, 1]`. Components not listed in
 *   `componentsUsed` are ignored entirely.
 * @param componentsUsed - Components that contributed. Duplicates are collapsed.
 * @param weights - Component weights. Defaults to {@link DEFAULT_WEIGHTS}.
 * @returns The renormalised weighted mean, clamped to `[0, 1]`. `0` when
 *   `componentsUsed` is empty (nothing was measured, so nothing can be claimed).
 */
export function combine(
  breakdown: SimilarityBreakdown,
  componentsUsed: ReadonlyArray<keyof SimilarityBreakdown>,
  weights: Readonly<Record<keyof SimilarityBreakdown, number>> = DEFAULT_WEIGHTS,
): number {
  const used = new Set<keyof SimilarityBreakdown>(componentsUsed);
  if (used.size === 0) {
    return 0;
  }
  let weighted = 0;
  let weightSum = 0;
  for (const key of COMPONENT_KEYS) {
    if (!used.has(key)) {
      continue;
    }
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    weighted += weight * clampUnit(breakdown[key]);
    weightSum += weight;
  }
  if (weightSum <= 0) {
    return 0;
  }
  return clampUnit(weighted / weightSum);
}

/** Per-call overrides for {@link compareBlocks} and {@link compareFingerprint}. */
export interface CompareOptions {
  /** Partial override of {@link DEFAULT_WEIGHTS}; unspecified keys keep the default. */
  weights?: Partial<Record<keyof SimilarityBreakdown, number>>;
  /**
   * Minimum shingle count on both sides before the Jaccard component is used.
   * Defaults to {@link DEFAULT_MIN_SHINGLES_FOR_MINHASH}.
   */
  minShinglesForMinhash?: number;
  /**
   * Force the anchored LCS approximation even when the cell budget would allow
   * the exact DP. Exists for the `ancestry.experimental.workers` path, where
   * predictable per-block cost matters more than a marginally better ratio.
   */
  useApproximateLcs?: boolean;
}

/** Resolve per-call options into a fully specified configuration. */
interface ResolvedOptions {
  readonly weights: Readonly<Record<keyof SimilarityBreakdown, number>>;
  readonly minShingles: number;
  readonly approximateLcs: boolean;
}

function resolveOptions(options?: CompareOptions): ResolvedOptions {
  const override = options?.weights;
  const weights: Record<keyof SimilarityBreakdown, number> = {
    jaccard: DEFAULT_WEIGHTS.jaccard,
    simhash: DEFAULT_WEIGHTS.simhash,
    lcs: DEFAULT_WEIGHTS.lcs,
    shape: DEFAULT_WEIGHTS.shape,
  };
  if (override) {
    for (const key of COMPONENT_KEYS) {
      const value = override[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        weights[key] = value;
      }
    }
  }
  const minShinglesOption = options?.minShinglesForMinhash;
  return {
    weights,
    minShingles:
      typeof minShinglesOption === 'number' && minShinglesOption >= 0
        ? minShinglesOption
        : DEFAULT_MIN_SHINGLES_FOR_MINHASH,
    approximateLcs: options?.useApproximateLcs === true,
  };
}

/** Split `NormalizedBlock.normalizedText` into tokens without importing the normaliser. */
function tokenSequenceOf(block: NormalizedBlock): string[] {
  if (block.normalizedText.length === 0) {
    return [];
  }
  return block.normalizedText.split(' ').filter((token) => token.length > 0);
}

/** Does this feature map carry any usable signal? */
function hasFeatures(block: NormalizedBlock): boolean {
  for (const key in block.features) {
    if (Object.prototype.hasOwnProperty.call(block.features, key)) {
      return true;
    }
  }
  return false;
}

/** Are both SimHash values present and comparable? */
function hasSimhash(a: NormalizedBlock, b: NormalizedBlock): boolean {
  return a.simhash.length > 0 && b.simhash.length > 0;
}

/**
 * The main similarity entry point: full comparison of two normalised blocks.
 *
 * Cost is dominated by the LCS component, which is `O(n*m)` up to
 * {@link LCS_APPROXIMATION_THRESHOLD} cells and anchored-approximate beyond it.
 * Callers that need to shortlist first should use
 * {@link compareFingerprint} or {@link prefilter}, both of which avoid the DP
 * entirely.
 *
 * Algorithm:
 *  1. **Identity fast path.** If `tokenHash` matches, the two blocks normalise to
 *     the same token string, so every component is exactly `1` and the result is
 *     `'strong'`. This is not just an optimisation: identical normalised
 *     structure means identical *semantics* under Ancestry's definition, and the
 *     graph layer relies on that exactness to merge nodes.
 *  2. **Score each component, skipping the ones that cannot be measured.** Jaccard
 *     needs enough shingles on both sides; LCS needs tokens on both sides; shape
 *     needs a non-empty feature map. A skipped component is *omitted* from
 *     `componentsUsed`, never recorded as `0`.
 *  3. **Combine** with weights renormalised over the used components, then
 *     **classify** against the supplied thresholds.
 *
 * @param a - Reference (the block the user selected) block.
 * @param b - Candidate block.
 * @param thresholds - Classification thresholds. Defaults to
 *   {@link DEFAULT_THRESHOLDS}.
 * @param options - Per-call weight and algorithm overrides.
 * @returns A `SimilarityResult`. `sourceBlockId` is `a.blockId` and
 *   `candidateBlockId` is `b.blockId`; Ancestry always scores candidates
 *   *relative to* the focus block, never symmetrically.
 */
export function compareBlocks(
  a: NormalizedBlock,
  b: NormalizedBlock,
  thresholds: SimilarityThresholds = DEFAULT_THRESHOLDS,
  options?: CompareOptions,
): SimilarityResult {
  if (a.tokenHash.length > 0 && a.tokenHash === b.tokenHash) {
    return {
      sourceBlockId: a.blockId,
      candidateBlockId: b.blockId,
      similarity: 1,
      breakdown: PERFECT_BREAKDOWN,
      classification: 'strong',
      componentsUsed: [...ALL_COMPONENTS],
    };
  }

  const resolved = resolveOptions(options);
  const breakdown: SimilarityBreakdown = { jaccard: 0, simhash: 0, lcs: 0, shape: 0 };
  const componentsUsed: Array<keyof SimilarityBreakdown> = [];

  if (hasSimhash(a, b)) {
    breakdown.simhash = hammingSimilarity(a.simhash, b.simhash);
    componentsUsed.push('simhash');
  }

  if (a.minhash.length > 0 && b.minhash.length > 0) {
    const minShingles = resolved.minShingles;
    const enoughShingles = a.shingles.length >= minShingles && b.shingles.length >= minShingles;
    if (enoughShingles) {
      breakdown.jaccard = estimateJaccardFromMinhash(a.minhash, b.minhash, MINHASH_BANDS);
      componentsUsed.push('jaccard');
    }
  }

  const tokensA = tokenSequenceOf(a);
  const tokensB = tokenSequenceOf(b);
  if (tokensA.length > 0 && tokensB.length > 0) {
    breakdown.lcs = resolved.approximateLcs
      ? anchoredRatio(tokensA, tokensB)
      : tokenLcsRatio(tokensA, tokensB);
    componentsUsed.push('lcs');
  }

  if (hasFeatures(a) && hasFeatures(b)) {
    breakdown.shape = cosine(a.features, b.features);
    componentsUsed.push('shape');
  }

  const similarity = combine(breakdown, componentsUsed, resolved.weights);
  return {
    sourceBlockId: a.blockId,
    candidateBlockId: b.blockId,
    similarity,
    breakdown,
    classification: classify(similarity, thresholds),
    componentsUsed,
  };
}

/**
 * LCS ratio computed with the anchored approximation, for the forced-fast path.
 *
 * A `maxCells` budget of `0` puts every non-empty pair over budget, so
 * `tokenLcsLength` takes the anchored branch. The result is a lower bound on the
 * true ratio, so a forced-approximation run can only ever under-report.
 */
function anchoredRatio(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  return (2 * tokenLcsLength(a, b, 0)) / total;
}

/**
 * Cheap fingerprint comparison used to shortlist candidates.
 *
 * Uses **only** the two components that need nothing but the stored fingerprints:
 * SimHash (one XOR + popcount) and, when the candidate carries a MinHash
 * signature, the MinHash Jaccard estimate. It never touches the token stream, so
 * it is strictly cheaper than {@link compareBlocks} — there is no `O(n*m)` DP and
 * no tokenisation.
 *
 * The absolute number it returns is **approximate and not comparable** with a
 * `compareBlocks` result: the LCS and shape components are simply absent, and the
 * weights are renormalised over the two survivors, so the value tends to sit
 * *higher* than the full score for heavily edited code (a small block with a
 * perfect SimHash match but a broken token order would look near-identical here).
 * It exists to order a shortlist, never to make a classification decision —
 * anything that survives it must be re-scored with {@link compareBlocks}.
 *
 * @param candidate - Lightweight candidate reference; may carry a truncated or
 *   missing MinHash signature.
 * @param source - The focus block, used for ids and its own signatures.
 * @param thresholds - Classification thresholds. Defaults to
 *   {@link DEFAULT_THRESHOLDS}.
 * @param options - Per-call weight overrides. `minShinglesForMinhash` is
 *   meaningless here (a `SimilarityCandidateRef` carries no shingle count) and is
 *   ignored; `useApproximateLcs` is likewise irrelevant.
 * @returns A `SimilarityResult` whose `componentsUsed` is a subset of
 *   `['jaccard', 'simhash']`.
 */
export function compareFingerprint(
  candidate: SimilarityCandidateRef,
  source: NormalizedBlock,
  thresholds: SimilarityThresholds = DEFAULT_THRESHOLDS,
  options?: CompareOptions,
): SimilarityResult {
  if (
    source.simhash.length > 0 &&
    source.simhash === candidate.simhash &&
    source.tokenCount === candidate.tokenCount
  ) {
    return {
      sourceBlockId: source.blockId,
      candidateBlockId: candidate.blockId,
      similarity: 1,
      breakdown: PERFECT_BREAKDOWN,
      classification: 'strong',
      componentsUsed: [...ALL_COMPONENTS],
    };
  }

  const resolved = resolveOptions(options);
  const breakdown: SimilarityBreakdown = { jaccard: 0, simhash: 0, lcs: 0, shape: 0 };
  const componentsUsed: Array<keyof SimilarityBreakdown> = [];

  if (source.simhash.length > 0 && candidate.simhash.length > 0) {
    breakdown.simhash = hammingSimilarity(source.simhash, candidate.simhash);
    componentsUsed.push('simhash');
  }
  if (source.minhash.length > 0 && candidate.minhash.length > 0) {
    breakdown.jaccard = estimateJaccardFromMinhash(
      source.minhash,
      candidate.minhash,
      MINHASH_BANDS,
    );
    componentsUsed.push('jaccard');
  }

  const similarity = combine(breakdown, componentsUsed, resolved.weights);
  return {
    sourceBlockId: source.blockId,
    candidateBlockId: candidate.blockId,
    similarity,
    breakdown,
    classification: classify(similarity, thresholds),
    componentsUsed,
  };
}

/**
 * Gate a result on being a strong match.
 *
 * Classification is preferred over re-applying a threshold because it uses the
 * thresholds that were in force *when the result was computed*. A cached
 * `SimilarityResult` scored against user settings that have since changed must
 * keep its original meaning; re-thresholding it here would silently rewrite
 * history.
 *
 * @param r - A result produced by {@link compareBlocks} or
 *   {@link compareFingerprint}.
 * @returns `true` when the result was classified `'strong'`.
 */
export function requireStrongMatch(r: SimilarityResult): boolean {
  return r.classification === 'strong';
}
