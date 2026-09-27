/**
 * Public surface of the Ancestry semantic-similarity engine.
 *
 * Everything the rest of the extension may use is re-exported here so that no
 * other module has to know the internal file layout, and so that the scoring
 * primitives (hashing sketches, LCS, weighted combination) can be unit-tested
 * and reused — for example by the cache layer, which needs `tokenHash` identity
 * checks, and by the graph layer, which needs `classify`.
 *
 * Layering, cheapest first:
 *
 * ```text
 * prefilter / CandidateIndex   O(1)-ish fingerprint tests, sublinear lookup
 *         |
 * compareFingerprint           SimHash + MinHash only, no token stream touched
 *         |
 * compareBlocks                full score, including the O(n*m) LCS
 * ```
 *
 * Ancestry is expected to walk that ladder top-down: a repository with 200 000
 * blocks should only reach the bottom rung for a few dozen candidates.
 *
 * @module similarity
 */

export {
  buildShingles,
  cosine,
  estimateJaccardFromMinhash,
  exactJaccard,
  fnv1a64,
  FNV64_OFFSET_BASIS,
  FNV64_PRIME,
  hammingDistance,
  hammingSimilarity,
  minhashFromShingles,
  parseHex64,
  popcount64,
  sha1Hex,
  simhashFromTokens,
} from './hashing';

export {
  LCS_APPROXIMATION_THRESHOLD,
  longestCommonSubstring,
  tokenLcsLength,
  tokenLcsRatio,
  usesApproximation,
} from './lcs';
export type { LongestCommonSubstring } from './lcs';

export {
  classify,
  combine,
  compareBlocks,
  compareFingerprint,
  DEFAULT_MIN_SHINGLES_FOR_MINHASH,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  requireStrongMatch,
} from './score';
export type { CompareOptions, SimilarityComponent } from './score';

export {
  BANDS_PER_BUCKET,
  BAND_BUCKETS,
  bandBucketHits,
  bandMatchCount,
  buildCandidateIndex,
  CandidateIndex,
  DEFAULT_LENGTH_TOLERANCE,
  DEFAULT_MAX_HAMMING,
  DEFAULT_MIN_BAND_MATCHES,
  DEFAULT_PREFILTER_OPTIONS,
  MIN_BUCKET_HITS,
  PREFILTER_BANDS,
  prefilter,
} from './candidates';
export type { CandidateEntry, PrefilterOptions, ResolvedPrefilterOptions } from './candidates';
