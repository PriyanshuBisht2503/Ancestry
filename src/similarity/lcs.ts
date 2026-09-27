/**
 * Longest-common-subsequence over *token* sequences for the Ancestry
 * similarity engine.
 *
 * The LCS component is the only order-sensitive part of a `SimilarityBreakdown`:
 * Jaccard, SimHash and shape cosine are all order-insensitive, so without LCS
 * Ancestry could not tell "swapped two statements" from "left the block alone".
 * That detection power costs `O(|a| * |b|)`, which is unaffordable for a
 * pathological 4 000-token generated file compared against thousands of
 * candidates, hence the budgeted approximation below.
 *
 * @module similarity/lcs
 */

/**
 * Maximum number of DP cells the exact algorithm may fill.
 *
 * Justification: the row-by-row `Uint32Array` DP runs at roughly 30-80M cells
 * per second in V8. Four million cells therefore costs 50-130 ms for a *single*
 * pair — already the worst-case cost of an entire history scan if the budget is
 * spent per comparison. 4M cells corresponds to pairs such as 2 000 x 2 000
 * tokens, which is well beyond the size of a hand-written function; a pair that
 * large is almost always generated or minified code, where token-level LCS is
 * not what a human means by "similar" anyway.
 *
 * The threshold is exported so the fallback is observable: `usesApproximation`
 * reports it, tests exercise it, and a future settings UI can surface it.
 */
export const LCS_APPROXIMATION_THRESHOLD = 4_000_000;

/** Width, in tokens, of the anchor used by the anchored approximation. */
const ANCHOR_K = 4;

/**
 * Cap on the number of recorded positions per distinct k-gram.
 *
 * Justification: a repetitive input (`if ( a ) { a = a + a; }` repeated) maps one
 * k-gram to O(n) positions, which would turn the linear anchor pass quadratic and
 * defeat the point of the fallback. Truncating keeps the anchor pass linear at
 * the price of a slightly worse — but still valid — lower bound.
 */
const MAX_ANCHORS_PER_HEAD = 32;

/** Number of common contiguous runs the anchored approximation will sum. */
const MAX_ANCHORED_RUNS = 8;

/** A half-open run of tokens common to both sequences. */
interface CommonRun {
  /** Start index into `a`. */
  readonly startA: number;
  /** Start index into `b`. */
  readonly startB: number;
  /** Number of tokens in the run. */
  readonly length: number;
}

/** Result of {@link longestCommonSubstring}. */
export interface LongestCommonSubstring {
  /** The common tokens themselves, in source order. */
  readonly text: string[];
  /** Start index into the first sequence. */
  readonly startA: number;
  /** Start index into the second sequence. */
  readonly startB: number;
  /** Length in tokens; `0` when there is no common run. */
  readonly length: number;
}

/**
 * Would the exact DP for these sequence lengths exceed the cell budget?
 *
 * Exposed so callers (and tests) can reason about the fallback without
 * provoking it. Sequences of length 0 have a product of 0, which never exceeds
 * the budget — and the exact path is also trivially correct there, so no
 * allocation happens at all.
 *
 * @param aLen - Length of the first sequence.
 * @param bLen - Length of the second sequence.
 * @param maxCells - Cell budget. Defaults to {@link LCS_APPROXIMATION_THRESHOLD}.
 * @returns `true` when the anchored approximation should be used instead.
 */
export function usesApproximation(
  aLen: number,
  bLen: number,
  maxCells: number = LCS_APPROXIMATION_THRESHOLD,
): boolean {
  if (aLen <= 0 || bLen <= 0) {
    return false;
  }
  return aLen * bLen > maxCells;
}

/** Exact LCS length by row-by-row dynamic programming over `Uint32Array` rows. */
function exactLcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  // The shorter sequence becomes the row so the working set is as small as
  // possible; both orientations give the same answer by symmetry.
  const narrow = a.length <= b.length ? b : a;
  const tall = a.length <= b.length ? a : b;
  const width = narrow.length;
  let previous = new Uint32Array(width + 1);
  let current = new Uint32Array(width + 1);
  for (let i = 1; i <= tall.length; i++) {
    const token = tall[i - 1];
    current[0] = 0;
    for (let j = 1; j <= width; j++) {
      if (token === narrow[j - 1]) {
        current[j] = previous[j - 1] + 1;
      } else {
        const up = previous[j];
        const left = current[j - 1];
        current[j] = up >= left ? up : left;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[width];
}

/**
 * Collect maximal common runs of at least `k` tokens, using a Map of k-gram
 * heads.
 *
 * Method: index every k-gram of `a` by value, then stream `b`. A k-gram match at
 * `(j, i)` fixes a *diagonal* `d = i - j`; consecutive k-gram matches on the
 * same diagonal are consecutive tokens, so the longest run of consecutive
 * positions on a diagonal is exactly a maximal common substring. This is
 * `O((|a| + |b|) * k)` after hash insertion, versus `O(|a| * |b|)` for the DP.
 */
function collectCommonRuns(a: readonly string[], b: readonly string[], k: number): CommonRun[] {
  const heads = new Map<string, number[]>();
  for (let i = 0; i + k <= a.length; i++) {
    const key = a.slice(i, i + k).join(' ');
    const positions = heads.get(key);
    if (positions === undefined) {
      heads.set(key, [i]);
    } else if (positions.length < MAX_ANCHORS_PER_HEAD) {
      positions.push(i);
    }
  }
  const diagonals = new Map<number, number[]>();
  for (let i = 0; i + k <= b.length; i++) {
    const positions = heads.get(b.slice(i, i + k).join(' '));
    if (positions === undefined) {
      continue;
    }
    for (const j of positions) {
      const diagonal = i - j;
      const bucket = diagonals.get(diagonal);
      if (bucket === undefined) {
        diagonals.set(diagonal, [i]);
      } else {
        bucket.push(i);
      }
    }
  }
  const runs: CommonRun[] = [];
  for (const [diagonal, positions] of diagonals) {
    positions.sort((left, right) => left - right);
    let runStart = positions[0];
    let previousPosition = runStart;
    for (let index = 1; index < positions.length; index++) {
      const position = positions[index];
      if (position !== previousPosition + 1) {
        runs.push({
          startA: runStart - diagonal,
          startB: runStart,
          length: previousPosition - runStart + k,
        });
        runStart = position;
      }
      previousPosition = position;
    }
    runs.push({
      startA: runStart - diagonal,
      startB: runStart,
      length: previousPosition - runStart + k,
    });
  }
  return runs;
}

/**
 * Can `run` join `chain` without breaking the monotonicity that makes a set of
 * runs a valid common *subsequence*?
 *
 * A naive "sum the longest matches" is **not** a lower bound on the LCS: two
 * matches on different diagonals can cross, so the token order induced on `a` and
 * on `b` can disagree. Requiring the merged set — sorted by position in `b` — to
 * be strictly increasing and non-overlapping in *both* sequences makes the
 * concatenation a genuine common subsequence, which is exactly the property that
 * guarantees the approximation never overestimates.
 *
 * `chain` holds at most {@link MAX_ANCHORED_RUNS} runs, so the re-sort per
 * candidate is negligible.
 */
function chainAccepts(chain: readonly CommonRun[], run: CommonRun): boolean {
  const merged = chain.concat([run]).sort((left, right) => left.startB - right.startB);
  let lastA = -1;
  let lastB = -1;
  for (const candidate of merged) {
    if (candidate.startA <= lastA || candidate.startB <= lastB) {
      return false;
    }
    lastA = candidate.startA + candidate.length - 1;
    lastB = candidate.startB + candidate.length - 1;
  }
  return true;
}

/**
 * Anchored lower-bound approximation of the LCS length.
 *
 * Strategy: find every common contiguous run of at least `min(4, |a|, |b|)`
 * tokens, then greedily accept the longest runs that can be chained into a
 * monotone, non-overlapping common subsequence, summing up to
 * {@link MAX_ANCHORED_RUNS} of them.
 *
 * Properties, in order of importance:
 *  - It never overestimates: every accepted chain is a real common subsequence.
 *  - It is `O((|a| + |b|) * k)` plus `O(r log r)` for the run sort, and allocates
 *    nothing proportional to `|a| * |b|`.
 *  - It underestimates interleaved re-orderings, which the DP would find. That is
 *    the accepted cost: the approximation only runs on blocks large enough that
 *    the exact DP is off the table, and the result still grows monotonically with
 *    real shared structure, so it ranks candidates far better than a constant.
 *
 * 8 runs is chosen because for realistic code the LCS of two versions of the same
 * function is dominated by a handful of contiguous stretches (signature, prologue,
 * body, epilogue); the tail of run lengths decays quickly.
 */
function anchoredLcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const k = Math.max(1, Math.min(ANCHOR_K, a.length, b.length));
  const runs = collectCommonRuns(a, b, k);
  if (runs.length === 0) {
    return 0;
  }
  runs.sort((left, right) => right.length - left.length);
  let chain: CommonRun[] = [];
  let total = 0;
  for (const run of runs) {
    if (chain.length >= MAX_ANCHORED_RUNS) {
      break;
    }
    if (chainAccepts(chain, run)) {
      chain = chain.concat([run]);
      total += run.length;
    }
  }
  return total;
}

/** Element-wise equality, avoiding an array allocation. */
function isElementWiseEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Length of the longest common subsequence of two token sequences.
 *
 * Above the cell budget this degrades to an anchored approximation, which is a
 * lower bound rather than the exact value; callers that need the exact number
 * should raise `maxCells` and accept the cost.
 *
 * Two cheap exactness shortcuts run first: an empty input has LCS 0, and two
 * element-wise identical inputs have LCS equal to their length. The second one
 * matters because `compareBlocks` normally short-circuits an unmodified block via
 * `tokenHash`, but the LCS is still requested directly by tests and by the
 * diff-hint view.
 *
 * @param a - First token sequence.
 * @param b - Second token sequence.
 * @param maxCells - DP cell budget. Defaults to
 *   {@link LCS_APPROXIMATION_THRESHOLD}. Pass `0` to force the approximation.
 * @returns The LCS length, in `[0, min(|a|, |b|)]`, or a lower bound on it when
 *   the approximation path was taken.
 */
export function tokenLcsLength(
  a: readonly string[],
  b: readonly string[],
  maxCells?: number,
): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a === b || isElementWiseEqual(a, b)) {
    return a.length;
  }
  if (usesApproximation(a.length, b.length, maxCells)) {
    return anchoredLcsLength(a, b);
  }
  return exactLcsLength(a, b);
}

/**
 * Normalised LCS ratio, `2 * lcs / (|a| + |b|)`: the Dice coefficient over token
 * orderings.
 *
 * Dice is used rather than `lcs / min(|a|, |b|)` because it is symmetric and
 * penalises a block that has been padded with unrelated tokens, which is exactly
 * the copy-paste-with-extra-code failure mode Ancestry must not report as a copy.
 *
 * @param a - First token sequence.
 * @param b - Second token sequence.
 * @returns A value in `[0, 1]`. `1` when both sequences are empty (identical) and
 *   `0` when exactly one is.
 */
export function tokenLcsRatio(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const ratio = (2 * tokenLcsLength(a, b)) / total;
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

/** Index in `b` of the `length`-gram that starts at `startA`, or -1. */
function findGramInB(
  a: readonly string[],
  b: readonly string[],
  startA: number,
  length: number,
): number {
  const gram = a.slice(startA, startA + length).join(' ');
  for (let j = 0; j + length <= b.length; j++) {
    if (b.slice(j, j + length).join(' ') === gram) {
      return j;
    }
  }
  return -1;
}

/**
 * Longest common contiguous run of tokens, plus where it occurs in each input.
 *
 * Exact, in `O((|a| + |b|) * k)` using the same k-gram-head technique as the
 * approximation, with a separate pass for runs shorter than `k` (a run of 1-3
 * tokens has no 4-gram head, so it would otherwise be missed).
 *
 * Ancestry uses this for the human-readable diff hint attached to a
 * `MODIFIED_FROM` edge — "these 23 tokens are literally unchanged" is far more
 * informative to a reader than a similarity number.
 *
 * @param a - First token sequence.
 * @param b - Second token sequence.
 * @returns The longest common run. `length` is `0` and `text` is empty when the
 *   sequences share nothing.
 */
export function longestCommonSubstring(
  a: readonly string[],
  b: readonly string[],
): LongestCommonSubstring {
  if (a.length === 0 || b.length === 0) {
    return { text: [], startA: 0, startB: 0, length: 0 };
  }
  const k = Math.max(1, Math.min(ANCHOR_K, a.length, b.length));
  let best: CommonRun = { startA: 0, startB: 0, length: 0 };
  for (const run of collectCommonRuns(a, b, k)) {
    if (run.length > best.length) {
      best = run;
    }
  }
  if (best.length < k) {
    // No run of length >= k, so look for the longest run of length k-1 .. 1.
    for (let length = k - 1; length >= 1; length--) {
      const limit = Math.min(length, a.length, b.length);
      for (let startA = 0; startA + limit <= a.length; startA++) {
        const startB = findGramInB(a, b, startA, limit);
        if (startB >= 0) {
          best = { startA, startB, length: limit };
          break;
        }
      }
      if (best.length > 0) {
        break;
      }
    }
  }
  return {
    text: a.slice(best.startA, best.startA + best.length),
    startA: best.startA,
    startB: best.startB,
    length: best.length,
  };
}
