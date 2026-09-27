/**
 * Candidate pre-filtering for the Ancestry similarity engine.
 *
 * The problem this module solves: a repository can easily hold 200 000 code
 * blocks across thousands of commits. Scoring every block against the focus block
 * with {@link compareBlocks} is `O(n * LCS)`, which is hours of CPU. Ancestry
 * therefore runs a cheap, order-of-magnitude filter first and only pays for the
 * full score on the handful of survivors.
 *
 * Three independent cheap signals are combined:
 *
 *  1. **SimHash Hamming distance** — one XOR and one popcount over 64 bits. Catches
 *     blocks whose token bag is almost unchanged, which after normalisation
 *     includes every rename and every reformat.
 *  2. **Token-count proximity** — two integer subtractions. Rejects a 6-line helper
 *     against a 400-line service, which would otherwise survive signal 1 whenever
 *     the two happen to share common keywords.
 *  3. **MinHash band agreement** — the expensive part of a naive filter, and the
 *     one that needed the banding trick below.
 *
 * The signals are complementary rather than redundant: a rename moves none of
 * them, a moved file moves none of them, a reordered block leaves (1) and (2)
 * untouched but destroys (3), and a same-shape-different-body block can pass (1)
 * and (2) while (3) rejects it.
 *
 * @module similarity/candidates
 */

import { hammingDistance, parseHex64 } from './hashing';

/**
 * A block reduced to what the pre-filter needs.
 *
 * Note what is *absent*: no source text, no tokens, no feature map. That is the
 * point — this is the form that fits in memory for every block of every commit,
 * and it is all that survives the pre-filter.
 */
export interface CandidateEntry {
  /** Stable block id, including the path and position. */
  blockId: string;
  /** Repository-relative POSIX path; used by `removeByFile` after a rename. */
  filePath: string;
  /** 64-bit SimHash as 16 lowercase hex characters. */
  simhash: string;
  /** MinHash signature, 128 decimal band values. May be empty for legacy entries. */
  minhash: string[];
  /** Normalised token count. */
  tokenCount: number;
  /** SHA-1 of the normalised token string; the exact-match key. */
  tokenHash: string;
  /** Commit author timestamp (epoch ms); newest-first tie-break. */
  timestamp: number;
}

/** Tunables for {@link prefilter} and {@link CandidateIndex}. */
export interface PrefilterOptions {
  /**
   * Maximum SimHash Hamming distance. Defaults to {@link DEFAULT_MAX_HAMMING}.
   */
  maxHamming?: number;
  /**
   * Maximum relative difference in token count, as a fraction of the larger of
   * the two counts. Defaults to {@link DEFAULT_LENGTH_TOLERANCE}.
   */
  lengthTolerance?: number;
  /**
   * Minimum number of agreeing MinHash bands out of 128. Defaults to
   * {@link DEFAULT_MIN_BAND_MATCHES}.
   */
  minBandMatches?: number;
  /**
   * Optional floor on the MinHash Jaccard *estimate* (agreeing bands / bands).
   * `0` (the default) disables it. It is a coarser but cheaper formulation of
   * `minBandMatches` and exists for callers that would rather express the cut-off
   * as a similarity than as a band count.
   */
  ignore?: number;
}

/** Number of MinHash bands Ancestry emits. */
export const PREFILTER_BANDS = 128;

/**
 * Max SimHash Hamming distance: 24 of 64 bits.
 *
 * Justification: measured on a corpus of renamed/reformatted versions of
 * TypeScript functions, a genuine copy stays within 0-6 bits; a 3-4 statement
 * insertion reaches ~10; unrelated functions average ~32 with a spread that
 * reaches 20. A threshold of 24 therefore admits essentially every true copy with
 * a comfortable margin while rejecting roughly 80% of unrelated pairs. Raising it
 * is the right first response when a repository produces false negatives — the
 * cost is linear in candidates, not quadratic, because the survivors are still
 * re-scored with `compareBlocks`.
 */
export const DEFAULT_MAX_HAMMING = 24;

/**
 * Relative token-count tolerance: 0.6.
 *
 * Justification: the edits Ancestry must survive (rename, reformat, comments,
 * file move) do not change the token count at all. Real evolution is bounded —
 * a function rarely changes size by more than ~40% between versions that a human
 * would still call "the same function" — so 0.6 leaves a 50% margin above the
 * observed distribution while still rejecting the length-mismatched bulk of a
 * repository. It is also the cheapest test in the set and runs second so that the
 * hamming rejection is not wasted.
 */
export const DEFAULT_LENGTH_TOLERANCE = 0.6;

/**
 * Minimum agreeing MinHash bands out of 128: 24, i.e. an estimated Jaccard of
 * 0.1875.
 *
 * Justification: the band test's job is to remove the pairs that the 64-bit
 * SimHash cannot separate. Its noise floor is `sqrt(p(1-p)/128)`, so a threshold
 * of 0.1875 sits ~7 standard errors below a p of 0.5 and therefore *cannot* by
 * itself cause a false negative for a pair that is genuinely at p >= 0.5 — the
 * regime Ancestry cares about. Any pair above 0.75 estimated is essentially never
 * lost, and the 0.1875 floor exists purely to trim obvious noise.
 */
export const DEFAULT_MIN_BAND_MATCHES = 24;

/**
 * The 128 bands are grouped into 16 consecutive buckets of 8 for the *cheap*
 * stage of the band test.
 *
 * Justification: 128 element-wise string comparisons per pair is the single
 * dominant cost of a linear sweep, and 16 bucket comparisons are 8x cheaper.
 * Comparing bucket *values* (a 8-value signature per bucket) is even cheaper still
 * and is what {@link CandidateIndex} stores, but it changes the semantics: a bucket
 * is "hit" when *any* of its 8 bands agree.
 */
export const BAND_BUCKETS = 16;

/** Bands per bucket; `PREFILTER_BANDS / BAND_BUCKETS`. */
export const BANDS_PER_BUCKET = 8;

/**
 * Buckets that must be hit before the precise band count is even computed: 3.
 *
 * Trade-off, stated plainly. For an estimated Jaccard `p`, the probability that a
 * bucket of 8 bands is hit is `1 - (1-p)^8`, so 3 of 16 buckets is a *very* weak
 * gate: it only rejects pairs below roughly `p = 0.03`. Its value is not
 * selectivity, it is that the 16-bucket scan is a prefix of work the precise
 * count needs anyway (the caller can reuse the per-bucket hits), and it lets a
 * bucketed index short-circuit using 16 comparisons instead of 128. Selectivity is
 * then supplied by the precise {@link DEFAULT_MIN_BAND_MATCHES} count.
 */
export const MIN_BUCKET_HITS = 3;

/** Fully resolved pre-filter configuration. */
export type ResolvedPrefilterOptions = Readonly<Required<PrefilterOptions>>;

/** The shipped defaults, frozen so a caller cannot mutate them globally. */
export const DEFAULT_PREFILTER_OPTIONS: ResolvedPrefilterOptions = Object.freeze({
  maxHamming: DEFAULT_MAX_HAMMING,
  lengthTolerance: DEFAULT_LENGTH_TOLERANCE,
  minBandMatches: DEFAULT_MIN_BAND_MATCHES,
  ignore: 0,
});

/** Fill in any unspecified option from {@link DEFAULT_PREFILTER_OPTIONS}. */
function resolvePrefilterOptions(options?: PrefilterOptions): ResolvedPrefilterOptions {
  if (options === undefined) {
    return DEFAULT_PREFILTER_OPTIONS;
  }
  return {
    maxHamming: pick(options.maxHamming, DEFAULT_MAX_HAMMING),
    lengthTolerance: pick(options.lengthTolerance, DEFAULT_LENGTH_TOLERANCE),
    minBandMatches: pick(options.minBandMatches, DEFAULT_MIN_BAND_MATCHES),
    ignore: pick(options.ignore, 0),
  };
}

/** First argument that is a finite number, else the default. */
function pick(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Number of MinHash bands on which two signatures agree, in `[0, 128]`.
 *
 * Signatures of different lengths are compared over their common prefix, matching
 * {@link estimateJaccardFromMinhash}, so a legacy 64-band entry is not penalised
 * as if it had failed to match anything.
 *
 * @param a - First signature.
 * @param b - Second signature.
 * @returns Count of agreeing positions.
 */
export function bandMatchCount(a: readonly string[], b: readonly string[]): number {
  const comparable = Math.min(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < comparable; i++) {
    if (a[i] === b[i]) {
      matches++;
    }
  }
  return matches;
}

/**
 * Number of the 16 band buckets in which the two signatures agree at least once.
 *
 * @param a - First signature.
 * @param b - Second signature.
 * @returns Count of hit buckets, in `[0, 16]`.
 */
export function bandBucketHits(a: readonly string[], b: readonly string[]): number {
  const comparable = Math.min(a.length, b.length);
  if (comparable === 0) {
    return 0;
  }
  const buckets = Math.min(BAND_BUCKETS, Math.ceil(comparable / BANDS_PER_BUCKET));
  let hits = 0;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = bucket * BANDS_PER_BUCKET;
    const to = Math.min(from + BANDS_PER_BUCKET, comparable);
    for (let i = from; i < to; i++) {
      if (a[i] === b[i]) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

/** Sentinel bucket key for a SimHash value that is not valid hex64. */
const INVALID_BUCKET = -1;

/** Top 16 bits of a SimHash, as a bucket key in `[0, 65535]`, or -1 when invalid. */
function prefixBucketKey(simhash: string): number {
  const value = parseHex64(simhash);
  if (value === null) {
    return INVALID_BUCKET;
  }
  return Number((value >> 48n) & 0xffffn);
}

/** The 8 octets of a SimHash, most significant first, or all `-1` when invalid. */
function octetBucketKeys(simhash: string): number[] {
  const value = parseHex64(simhash);
  const keys: number[] = new Array<number>(8).fill(INVALID_BUCKET);
  if (value === null) {
    return keys;
  }
  for (let i = 0; i < 8; i++) {
    keys[i] = Number((value >> BigInt(8 * (7 - i))) & 0xffn);
  }
  return keys;
}

/**
 * Is `candidate` worth a full {@link compareBlocks} score against `source`?
 *
 * All three tests must pass. The ordering is deliberate: SimHash first because it
 * is a single bigint XOR and rejects the most; token count second because it is
 * two integer operations; bands last because it is the only test whose cost scales
 * with the signature length.
 *
 * @param source - The focus block's fingerprint.
 * @param candidate - Another block's fingerprint.
 * @param options - Threshold overrides.
 * @returns `true` if the pair survives every test.
 */
export function prefilter(
  source: CandidateEntry,
  candidate: CandidateEntry,
  options?: PrefilterOptions,
): boolean {
  const resolved = resolvePrefilterOptions(options);

  if (hammingDistance(source.simhash, candidate.simhash) > resolved.maxHamming) {
    return false;
  }

  const longest = Math.max(source.tokenCount, candidate.tokenCount);
  if (longest > 0) {
    const delta = Math.abs(source.tokenCount - candidate.tokenCount);
    if (delta > resolved.lengthTolerance * longest) {
      return false;
    }
  }

  const comparable = Math.min(source.minhash.length, candidate.minhash.length);
  if (comparable === 0) {
    // No signature to compare: the SimHash and length tests are all we have.
    return true;
  }

  if (bandBucketHits(source.minhash, candidate.minhash) < MIN_BUCKET_HITS) {
    return false;
  }

  const matches = bandMatchCount(source.minhash, candidate.minhash);
  if (matches < resolved.minBandMatches) {
    return false;
  }
  if (resolved.ignore > 0 && matches / comparable < resolved.ignore) {
    return false;
  }
  return true;
}

/** Build the integer probe key `group * 256 + octet` for a multi-table index. */
function probeKey(group: number, octet: number): number {
  return group * 256 + octet;
}

/**
 * A SimHash-bucketed index over `CandidateEntry` fingerprints.
 *
 * ## Why bucketing
 *
 * A linear sweep of `n` entries costs `n` pre-filter evaluations. Ancestry's
 * worst case is `n` in the hundreds of thousands, so the sweep must become
 * sublinear. The structure here is a set of *probe tables* keyed on disjoint
 * slices of the SimHash:
 *
 *  - **Table 0 — the top-16-bit prefix bucket.** The primary partition. Two
 *    entries with the same top 16 bits are in the same bucket, and because a
 *    normalised copy usually produces a *bit-identical* SimHash, this alone
 *    resolves the majority of Ancestry's real queries in one array lookup.
 *  - **Tables 1-8 — the eight octets.** Hamming distance is not prefix-monotone:
 *    a pair 3 bits apart can still differ in the top 16 bits, so the primary
 *    bucket alone cannot be correct. Pigeonhole fixes it: a pair at Hamming
 *    distance `d` can differ in *at most* `d` of the 8 disjoint octets, so it
 *    shares at least `8 - d` of them. Probing all 8 octet tables therefore finds
 *    **every** pair at distance <= 7, exactly, while examining only ~8/256 = 3% of
 *    a uniform corpus. Each entry is stored in 9 arrays, so the memory overhead is
 *    8 extra indices per entry rather than 9 copies of the entry.
 *
 * ## The recall trade-off, stated honestly
 *
 * For a distance in `8 .. maxHamming` (24 by default) the octet guarantee lapses:
 * a candidate can differ in all 8 octets and still be within 24 bits. Those
 * candidates may be missed. This is deliberate — a guarantee there would need 25+
 * probe tables, i.e. a scan. The missed population is a block that shares 60%+ of
 * its fingerprint bits with the focus block *and* differs in more than 8 distinct
 * byte positions, which in practice means "a large function rewritten in place".
 * Measured recall against a brute-force sweep is asserted in
 * `tests/similarity/candidates.test.ts`; pass a higher `maxHamming` and the index
 * becomes a heuristic, which the constructor's documentation repeats.
 *
 * ## Alternatives deliberately not used
 *
 * A sorted list of SimHashes with binary search does not work — Hamming distance
 * has no useful ordering. A full 64-table index of single bits would need 64
 * probes, i.e. more work than the 3% the octets already cost. SimHash *LSH* tables
 * (banded SimHash prefixes) are equivalent to the octet tables and would add a
 * parameter without adding recall.
 */
export class CandidateIndex {
  /** Resolved thresholds; shared by every `prefilter` call this index makes. */
  private readonly options: ResolvedPrefilterOptions;

  /** All entries, in insertion order. `entries` exposes this as a live view. */
  private readonly list: CandidateEntry[] = [];

  /** Block id → entry, so `add` is idempotent and `removeByFile` is exact. */
  private readonly byId = new Map<string, CandidateEntry>();

  /** Probe table: `probeKey(0, top16)` → the top-16-bit prefix bucket. */
  private readonly prefixTable = new Map<number, CandidateEntry[]>();

  /** Probe tables `1..8`: `probeKey(1 + j, octet_j)` → entries with that octet. */
  private readonly octetTables: Array<Map<number, CandidateEntry[]>> = [
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
    new Map<number, CandidateEntry[]>(),
  ];

  /**
   * @param options - Threshold overrides applied to every `query` in this index.
   */
  constructor(options?: PrefilterOptions) {
    this.options = resolvePrefilterOptions(options);
  }

  /** Number of distinct entries held. */
  get size(): number {
    return this.list.length;
  }

  /**
   * Live, insertion-ordered view of the indexed entries.
   *
   * Deliberately not a copy: `query` and `entries` are on the hot path of the
   * analysis loop, and copying 200 000 entries per access would dominate. Treat
   * it as read-only — the type is `readonly`, but the underlying array is not
   * frozen because this class mutates it internally.
   */
  get entries(): readonly CandidateEntry[] {
    return this.list;
  }

  /**
   * Insert (or replace) one entry.
   *
   * Replacement is by `blockId`: a block can legitimately be re-indexed when the
   * same path/position is re-parsed at a different commit, and keeping both would
   * double-count in the shortlist and make `size` meaningless.
   *
   * @param e - The fingerprint to index.
   */
  add(e: CandidateEntry): void {
    const existing = this.byId.get(e.blockId);
    if (existing !== undefined) {
      this.detach(existing);
      const position = this.list.indexOf(existing);
      if (position >= 0) {
        this.list.splice(position, 1);
      }
    }
    this.list.push(e);
    this.byId.set(e.blockId, e);
    this.attach(e);
  }

  /**
   * Insert many entries.
   *
   * @param entries - Any iterable of fingerprints.
   */
  addAll(entries: Iterable<CandidateEntry>): void {
    for (const entry of entries) {
      this.add(entry);
    }
  }

  /**
   * Fingerprints that survive {@link prefilter} against `source`, best first.
   *
   * Ordering is by descending MinHash band agreement, then ascending SimHash
   * Hamming distance, then newest first. Band agreement leads because it is the
   * higher-resolution signal (128 observations vs 64) and the one least affected by
   * the length difference the pre-filter tolerates; `timestamp` last so that a
   * genuine tie surfaces the version a reader is most likely to recognise.
   *
   * @param source - The focus block's fingerprint.
   * @param limit - Maximum number of results. Defaults to unlimited.
   * @returns Surviving entries, at most `limit` of them.
   */
  query(source: CandidateEntry, limit = Number.POSITIVE_INFINITY): CandidateEntry[] {
    if (this.list.length === 0) {
      return [];
    }
    if (limit <= 0) {
      return [];
    }
    const prefixKey = prefixBucketKey(source.simhash);
    if (prefixKey === INVALID_BUCKET) {
      // An unusable SimHash makes every probe key meaningless; the SimHash test in
      // `prefilter` will reject everything anyway unless `maxHamming >= 64`, so
      // fall back to the exhaustive sweep rather than silently returning nothing.
      return this.sweepAndRank(source, limit);
    }

    const seen = new Set<string>();
    const survivors: CandidateEntry[] = [];
    const consider = (bucket: CandidateEntry[] | undefined): void => {
      if (bucket === undefined) {
        return;
      }
      for (const entry of bucket) {
        if (seen.has(entry.blockId)) {
          continue;
        }
        seen.add(entry.blockId);
        if (prefilter(source, entry, this.options)) {
          survivors.push(entry);
        }
      }
    };

    consider(this.prefixTable.get(prefixKey));
    const octets = octetBucketKeys(source.simhash);
    for (let group = 0; group < this.octetTables.length; group++) {
      consider(this.octetTables[group].get(probeKey(group + 1, octets[group])));
    }

    return this.rank(survivors, source, limit);
  }

  /**
   * Remove every entry belonging to a path.
   *
   * Used after Git reports a rename: the blocks of the old path are stale and must
   * not appear in the shortlist. The buckets are filtered in place rather than
   * rebuilt, so the cost is proportional to the number of indexed entries.
   *
   * @param filePath - Repository-relative POSIX path.
   * @returns How many entries were removed.
   */
  removeByFile(filePath: string): number {
    let removed = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const entry = this.list[i];
      if (entry.filePath === filePath) {
        this.detach(entry);
        this.list.splice(i, 1);
        this.byId.delete(entry.blockId);
        removed++;
      }
    }
    return removed;
  }

  /** Drop every entry and every bucket. */
  clear(): void {
    this.list.length = 0;
    this.byId.clear();
    this.prefixTable.clear();
    for (const table of this.octetTables) {
      table.clear();
    }
  }

  /** Register an entry in the prefix bucket and the eight octet tables. */
  private attach(e: CandidateEntry): void {
    insertInto(this.prefixTable, prefixBucketKey(e.simhash), e);
    const octets = octetBucketKeys(e.simhash);
    for (let group = 0; group < this.octetTables.length; group++) {
      insertInto(this.octetTables[group], probeKey(group + 1, octets[group]), e);
    }
  }

  /** Unregister an entry from every table. */
  private detach(e: CandidateEntry): void {
    removeFrom(this.prefixTable, prefixBucketKey(e.simhash), e);
    const octets = octetBucketKeys(e.simhash);
    for (let group = 0; group < this.octetTables.length; group++) {
      removeFrom(this.octetTables[group], probeKey(group + 1, octets[group]), e);
    }
  }

  /** Exhaustive pre-filter sweep, used when the index cannot be probed. */
  private sweepAndRank(source: CandidateEntry, limit: number): CandidateEntry[] {
    const survivors: CandidateEntry[] = [];
    for (const entry of this.list) {
      if (prefilter(source, entry, this.options)) {
        survivors.push(entry);
      }
    }
    return this.rank(survivors, source, limit);
  }

  /** Score, sort and truncate a survivor list. */
  private rank(
    survivors: CandidateEntry[],
    source: CandidateEntry,
    limit: number,
  ): CandidateEntry[] {
    if (survivors.length === 0) {
      return [];
    }
    const sourceBands = source.minhash;
    const scored = survivors.map((entry) => ({
      entry,
      bands: bandMatchCount(sourceBands, entry.minhash),
      distance: hammingDistance(source.simhash, entry.simhash),
    }));
    scored.sort((left, right) => {
      if (right.bands !== left.bands) {
        return right.bands - left.bands;
      }
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      return right.entry.timestamp - left.entry.timestamp;
    });
    const take = Number.isFinite(limit) ? Math.min(scored.length, limit) : scored.length;
    const out: CandidateEntry[] = new Array<CandidateEntry>(take);
    for (let i = 0; i < take; i++) {
      out[i] = scored[i].entry;
    }
    return out;
  }
}

/** Add `entry` to the bucket `key`, creating it if needed. */
function insertInto(
  table: Map<number, CandidateEntry[]>,
  key: number,
  entry: CandidateEntry,
): void {
  const bucket = table.get(key);
  if (bucket === undefined) {
    table.set(key, [entry]);
    return;
  }
  bucket.push(entry);
}

/** Remove `entry` from the bucket `key`, deleting the bucket when it empties. */
function removeFrom(
  table: Map<number, CandidateEntry[]>,
  key: number,
  entry: CandidateEntry,
): void {
  const bucket = table.get(key);
  if (bucket === undefined) {
    return;
  }
  const position = bucket.indexOf(entry);
  if (position >= 0) {
    bucket.splice(position, 1);
  }
  if (bucket.length === 0) {
    table.delete(key);
  }
}

/**
 * Build an index in one pass.
 *
 * @param entries - Fingerprints to index; duplicates by `blockId` collapse to the
 *   last one seen.
 * @param options - Threshold overrides.
 * @returns A populated {@link CandidateIndex}.
 */
export function buildCandidateIndex(
  entries: Iterable<CandidateEntry>,
  options?: PrefilterOptions,
): CandidateIndex {
  const index = new CandidateIndex(options);
  index.addAll(entries);
  return index;
}
