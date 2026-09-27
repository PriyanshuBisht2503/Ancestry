/**
 * Hashing primitives for the Ancestry semantic-similarity engine.
 *
 * Ancestry compares code *after* normalisation, so the tokens that reach this
 * module are already identifier-canonicalised and literal-collapsed. That makes
 * set-based and sketch-based approximations viable: a rename does not move the
 * shingle set at all, and a reformat does not move it either.
 *
 * Three sketching families are provided:
 *  - **SHA-1** for exact, collision-resistant content identity (`sha1Hex`).
 *  - **FNV-1a 64** for a fast, non-cryptographic 64-bit hash used by SimHash,
 *    MinHash banding and the SimHash bucket keys of the candidate index.
 *  - **SimHash / MinHash** for order-insensitive near-duplicate detection.
 *
 * The FNV-1a hash is returned as a `bigint` on purpose. A 64-bit value cannot be
 * represented exactly by an IEEE-754 double (only 53 mantissa bits), and the
 * XOR/popcount operations SimHash and Hamming distance depend on would then be
 * wrong for roughly 99.9% of all hashes. `bigint` costs a little more but keeps
 * the arithmetic exact, which is the whole reason the Hamming distances in
 * `candidates.ts` are trustworthy.
 *
 * @module similarity/hashing
 */

import { createHash } from 'node:crypto';

/** Modulo-2^64 mask. FNV-1a 64 and every SimHash value are 64 bits wide. */
const MASK64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64 offset basis (14695981039346656037) — the published constant from
 * the FNV reference specification, and the defined hash of the empty string.
 */
export const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;

/** FNV-1a 64 prime (1099511628211), again from the FNV reference specification. */
export const FNV64_PRIME = 0x100000001b3n;

/** Bit masks used by the SWAR population count. */
const SWAR_LOW_BITS = 0x5555555555555555n;
const SWAR_TWO_BITS = 0x3333333333333333n;
const SWAR_FOUR_BITS = 0x0f0f0f0f0f0f0f0fn;
const SWAR_BYTE_SUM = 0x0101010101010101n;

/** Width of a SimHash value in hexadecimal characters. */
const SIMHASH_HEX_LENGTH = 16;

/**
 * SHA-1 of a UTF-8 string.
 *
 * Used for content identity rather than for similarity: `NormalizedBlock.tokenHash`
 * lets Ancestry short-circuit an exact match, and shingle values must be stable
 * across processes and machines (they are persisted in the cache), so a
 * cryptographic hash is the right choice here despite the extra constant factor.
 *
 * @param input - Arbitrary text. Never source code leaves the process via this
 *   function's return value: only the digest does.
 * @returns 40 lowercase hexadecimal characters.
 */
export function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * FNV-1a, 64-bit variant.
 *
 * Algorithm (reference spec): start from the 64-bit offset basis, then for each
 * byte of the input XOR the byte into the low octet, then multiply by the 64-bit
 * prime, all modulo 2^64. The multiply is the reason this returns a `bigint`:
 * the intermediate product is up to 128 bits wide and is *not* representable as
 * a double.
 *
 * @param input - Text to hash. The raw UTF-8 bytes are hashed, so this agrees
 *   with the published vectors for ASCII.
 * @returns The 64-bit hash as a non-negative `bigint` in `[0, 2^64)`.
 */
export function fnv1a64(input: string): bigint {
  let hash = FNV64_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash;
}

/**
 * Population count of a 64-bit word, using the SWAR (SIMD-within-a-register)
 * trick: three shift/mask/accumulate passes reduce 64 bits to 8 bytes, and one
 * final multiply-and-shift sums them. Six bigint operations instead of a
 * 64-iteration loop.
 *
 * @param v - Any bigint. The value is truncated to its low 64 bits, matching the
 *   64-bit width of a SimHash.
 * @returns Number of set bits in `[0, 64]`.
 */
export function popcount64(v: bigint): number {
  let x = BigInt.asUintN(64, v);
  // x -= (x >> 1) & 0x55.. : pair up adjacent bits into 2-bit counters.
  x -= (x >> 1n) & SWAR_LOW_BITS;
  // Combine 2-bit counters into 4-bit counters.
  x = (x & SWAR_TWO_BITS) + ((x >> 2n) & SWAR_TWO_BITS);
  // Combine 4-bit counters into byte counters.
  x = (x + (x >> 4n)) & SWAR_FOUR_BITS;
  // Sum the 8 byte counters with one multiply; the top byte holds the total.
  return Number(((x * SWAR_BYTE_SUM) >> 56n) & 0xffn);
}

/**
 * Parse a hexadecimal string into a 64-bit unsigned value.
 *
 * Accepts 1..16 characters in either case; leading zeroes are implied, so
 * `'ff'` and `'00000000000000ff'` denote the same number even though they
 * differ in length. Anything else (empty, non-hex, longer than 16 characters)
 * is rejected.
 *
 * @param value - Candidate hexadecimal text.
 * @returns The parsed value, or `null` when `value` is not valid hex64.
 */
export function parseHex64(value: string): bigint | null {
  if (value.length === 0 || value.length > SIMHASH_HEX_LENGTH) {
    return null;
  }
  let acc = 0n;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let digit: number;
    if (code >= 0x30 && code <= 0x39) {
      digit = code - 0x30;
    } else if (code >= 0x61 && code <= 0x66) {
      digit = code - 0x61 + 10;
    } else if (code >= 0x41 && code <= 0x46) {
      digit = code - 0x41 + 10;
    } else {
      return null;
    }
    acc = (acc << 4n) | BigInt(digit);
  }
  return acc;
}

/** Number of bits at which two SimHash values differ, saturating at 64. */
const MAX_HAMMING_DISTANCE = 64;

/**
 * Hamming distance between two SimHash values.
 *
 * Ancestry treats malformed input as maximally distant rather than throwing:
 * a corrupt cache entry must degrade one comparison, not abort a 200 000-block
 * analysis. A length mismatch therefore yields the maximum distance, which is
 * also the semantically honest answer — two values of different widths cannot
 * be shown to be equal.
 *
 * @param a - First SimHash: 16 lowercase hex characters (upper case accepted).
 * @param b - Second SimHash.
 * @returns `popcount(a ^ b)` in `[0, 64]`, or `64` when either value is not a
 *   valid hex64 of the same length as the other.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return MAX_HAMMING_DISTANCE;
  }
  const left = parseHex64(a);
  const right = parseHex64(b);
  if (left === null || right === null) {
    return MAX_HAMMING_DISTANCE;
  }
  return popcount64(left ^ right);
}

/**
 * Hamming similarity of two SimHash values, i.e. the `shape`-independent
 * fingerprint component of a `SimilarityBreakdown`.
 *
 * @param a - First SimHash.
 * @param b - Second SimHash.
 * @returns `1 - distance/64`, in `[0, 1]`. Malformed input yields `0`.
 */
export function hammingSimilarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / MAX_HAMMING_DISTANCE;
}

/**
 * Exact Jaccard similarity of two shingle sets: `|A n B| / |A u B|`.
 *
 * This is the ground truth that `estimateJaccardFromMinhash` approximates. It is
 * `O(|A| + |B|)` in memory, so it is only used for small inputs (tests, tiny
 * blocks, debugging) and never in the bulk comparison loop.
 *
 * @param a - First shingle collection; duplicates are collapsed.
 * @param b - Second shingle collection.
 * @returns A value in `[0, 1]`. `1` when both collections are empty (two empty
 *   sets are identical) and `0` when exactly one is empty.
 */
export function exactJaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  // Iterate the smaller set so the membership tests are the cheaper side.
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const value of small) {
    if (large.has(value)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * MinHash estimate of the Jaccard similarity of two shingle sets.
 *
 * Each band of a 128-band MinHash signature is an independent unbiased estimator
 * of the Jaccard index; their mean has standard error `sqrt(p(1-p)/128)`, i.e.
 * about ±0.04 near `p = 0.5`. That is the accuracy/cost trade Ancestry accepts:
 * comparing 128 integers instead of building two sets and intersecting them.
 *
 * Signatures of different lengths are compared over their common prefix; the
 * estimate is reported relative to that prefix, because penalising a candidate
 * for carrying a shorter (older-format) signature would be a silent false
 * negative rather than an honest "less similar".
 *
 * @param a - First MinHash signature, band values as decimal strings.
 * @param b - Second MinHash signature.
 * @param bands - Number of bands to compare. Defaults to the 128 bands the
 *   normaliser emits.
 * @returns A value in `[0, 1]`; `0` when either signature is empty.
 */
export function estimateJaccardFromMinhash(
  a: readonly string[],
  b: readonly string[],
  bands = 128,
): number {
  const comparable = Math.min(bands, a.length, b.length);
  if (comparable <= 0) {
    return 0;
  }
  let matches = 0;
  for (let i = 0; i < comparable; i++) {
    if (a[i] === b[i]) {
      matches++;
    }
  }
  return matches / comparable;
}

/**
 * Clamp a value into `[0, 1]`. `NaN` and negative values map to `0`;
 * `+Infinity` maps to `1`.
 */
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
 * Cosine similarity of two sparse feature vectors, computed over the union of
 * their keys so no allocation proportional to the feature vocabulary is needed.
 *
 * The result is clamped to `[0, 1]`. Feature vectors only ever hold non-negative
 * counts, so the true cosine is already in that range and the clamp exists only
 * to absorb floating-point drift (`1.0000000000000002` must not escape into a
 * similarity result that the UI renders as a percentage).
 *
 * @param a - First feature map, e.g. `NormalizedBlock.features`.
 * @param b - Second feature map.
 * @returns A value in `[0, 1]`; `0` when either vector has zero magnitude.
 */
export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of Object.keys(a)) {
    const x = a[key];
    const y = b[key];
    normA += x * x;
    if (y !== undefined) {
      dot += x * y;
    }
  }
  for (const key of Object.keys(b)) {
    const y = b[key];
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return clampUnit(dot / Math.sqrt(normA * normB));
}

/** Decimal value of a lowercase/uppercase hex character, or -1 when not hex. */
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  return -1;
}

/**
 * splitmix64's finalising avalanche step: a bijection on 64 bits that pushes
 * entropy from the high bits down into the low ones.
 *
 * This exists because FNV-1a avalanches *upward*, not downward: two strings that
 * differ only in their last character produce low-bit hashes that differ in a
 * predictable small amount, so the low 16 bits of a set of near-identical
 * shingles are strongly rank-correlated rather than interchangeable. MinHash
 * needs them interchangeable. Measured on a corpus of near-duplicate shingle
 * sets (Jaccard 0.84, 128 bands), the unbiased mean absolute error is:
 *
 * ```text
 *   fnv1a64(s) ^ (i * PRIME), low 16 bits     bias +0.0623   meanAbs 0.0657
 *   avalanche64(fnv1a64(s) ^ (i * PRIME))     bias -0.0001   meanAbs 0.0156
 * ```
 *
 * i.e. leaving FNV's low bits unmixed inflates every MinHash estimate by six
 * points of Jaccard, which is enough to push unrelated blocks over the `strong`
 * threshold. The finaliser costs three multiplies per shingle per band and buys
 * both the bias removal and a 4x reduction in error.
 *
 * @param value - Any 64-bit word.
 * @returns A fully mixed 64-bit permutation of `value`.
 */
function avalanche64(value: bigint): bigint {
  let z = BigInt.asUintN(64, value);
  z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n;
  z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn;
  return (z ^ (z >> 31n)) & MASK64;
}

/**
 * SimHash of a weighted token bag, as 16 lowercase hexadecimal characters.
 *
 * Algorithm (Charikar similarity hashing): hash every distinct token with FNV-1a
 * 64; for each of the 64 bit positions, add the token's weight when the bit is
 * set and subtract it when clear; emit a `1` wherever the accumulated sum is
 * positive. Two bags that share most of their tokens produce hashes that differ
 * in only a few bits, which is what makes a single XOR + popcount a usable
 * similarity measure.
 *
 * The token bag is order-insensitive by construction, so a pure reordering of
 * statements cannot change the fingerprint. That is intentional: Ancestry needs
 * a *cheap* global shape signal, and ordering sensitivity is supplied separately
 * by the LCS component.
 *
 * The computation is fully deterministic — no randomness, no locale, no
 * dependence on iteration order of a hash map — so a cached SimHash can be
 * re-derived and compared across runs and machines.
 *
 * @param tokens - Token occurrences. `weight` defaults to `1`; callers that
 *   deduplicate should pass the occurrence count as the weight, which is what
 *   makes long identifier runs and repeated operators matter more than singletons.
 * @returns 16 lowercase hexadecimal characters. An empty bag yields 16 zeroes.
 */
export function simhashFromTokens(tokens: Array<{ value: string; weight?: number }>): string {
  const accumulator = new Float64Array(64);
  for (const token of tokens) {
    const weight = token.weight === undefined ? 1 : token.weight;
    if (weight === 0) {
      continue;
    }
    const hex = fnv1a64(token.value).toString(16).padStart(SIMHASH_HEX_LENGTH, '0');
    for (let bit = 0; bit < 64; bit++) {
      const nibble = hexDigit(hex.charCodeAt(SIMHASH_HEX_LENGTH - 1 - (bit >> 2)));
      const isSet = (nibble >> (bit & 3)) & 1;
      accumulator[bit] += isSet === 1 ? weight : -weight;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (accumulator[bit] > 0) {
      hash |= 1n << BigInt(bit);
    }
  }
  return hash.toString(16).padStart(SIMHASH_HEX_LENGTH, '0');
}

/**
 * MinHash signature over a shingle set.
 *
 * Band `i` is the minimum, over all shingles `s`, of
 * `(fnv1a64(s) XOR (i * PRIME)) & 0xFFFF`. XOR-ing a per-band multiple of the FNV
 * prime decorrelates the bands: without it every band would hold the same value,
 * because `fnv1a64` is the same function for every `i`, and a signature whose
 * bands are all identical estimates nothing. The result is a family of `bands`
 * estimators of the Jaccard index whose mean is that index.
 *
 * The XOR result additionally passes through an avalanche finaliser before the
 * 16-bit mask. This is a deliberate, measured refinement: FNV-1a avalanches
 * upward, so the raw low 16 bits of hashes of *near-identical* strings are
 * rank-correlated, which is precisely the shingle distribution MinHash is fed.
 * See {@link avalanche64} for the measured bias (0.062) and error (0.066) of the
 * un-finalised form against (-0.0001, 0.016) for this one.
 *
 * An empty shingle set has no minimum, so every band is `0` by convention. Note
 * that a *non-empty* set can also produce a `0` band (a 16-bit masked value of
 * exactly zero occurs with probability ~1/65536 per band), so callers must gate on
 * shingle count, not on band values — which is exactly what `compareBlocks` does.
 *
 * @param shingles - Shingle values (their hexadecimal form is irrelevant; only
 *   the string itself is hashed, so `sha1Hex` prefixes and raw shingles both work).
 * @param bands - Signature length. Defaults to 128, matching
 *   `NormalizedBlock.minhash`.
 * @returns `bands` decimal strings, each in `[0, 65535]`.
 */
export function minhashFromShingles(shingles: readonly string[], bands = 128): string[] {
  if (bands <= 0) {
    return [];
  }
  const signature: string[] = new Array<string>(bands);
  if (shingles.length === 0) {
    for (let i = 0; i < bands; i++) {
      signature[i] = '0';
    }
    return signature;
  }
  const hashes = shingles.map((shingle) => fnv1a64(shingle));
  for (let i = 0; i < bands; i++) {
    // Multiples of the FNV prime spread consecutive band indices across the
    // word; the value is masked per band rather than after the minimum.
    const salt = BigInt(i) * FNV64_PRIME;
    let best = 0xffffn;
    for (const hash of hashes) {
      const value = avalanche64(hash ^ salt) & 0xffffn;
      if (value < best) {
        best = value;
      }
    }
    signature[i] = best.toString();
  }
  return signature;
}

/**
 * Build the k-gram shingle set over a space-separated normalised token stream.
 *
 * Shingles are hashed to 16 hex characters (64 bits) and de-duplicated, which
 * makes the MinHash input a genuine *set* — repeated structure (a long chain of
 * identical `} else {` blocks) must not be allowed to dominate the Jaccard index
 * through sheer multiplicity.
 *
 * Text shorter than `k` tokens has no k-gram at all, so the whole token list is
 * emitted as a single shingle. Without that fallback a three-token block would
 * produce an empty shingle set, the Jaccard component would be skipped, and two
 * tiny blocks would be compared on fingerprints alone.
 *
 * Splitting is on arbitrary whitespace runs rather than on a single space. For
 * contract-conformant input (`normalizedText` is documented as space-joined) the
 * two are identical, but a caller that hands over raw text should not silently
 * get a shingle set that changes when a line break becomes a space.
 *
 * @param normalizedText - `NormalizedBlock.normalizedText`; tokens are separated
 *   by whitespace and empty fields are ignored.
 * @param k - Shingle width in tokens. Defaults to 4, which balances
 *   specificity (4-grams rarely coincide by accident) against sensitivity (a
 *   single inserted token invalidates at most 4 shingles).
 * @returns De-duplicated shingle values, `sha1Hex(...)` truncated to 16 characters.
 */
export function buildShingles(normalizedText: string, k = 4): string[] {
  const tokens = normalizedText.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return [];
  }
  const width = Math.max(1, Math.min(k, tokens.length));
  const seen = new Set<string>();
  const shingles: string[] = [];
  for (let i = 0; i + width <= tokens.length; i++) {
    //   cannot occur in a normalised token, so it is a safe join character.
    const shingle = sha1Hex(tokens.slice(i, i + width).join(' ')).slice(0, 16);
    if (!seen.has(shingle)) {
      seen.add(shingle);
      shingles.push(shingle);
    }
  }
  return shingles;
}
