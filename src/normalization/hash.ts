/**
 * Hashing primitives for AST normalisation.
 *
 * Ancestry deliberately owns its own copies of these primitives instead of
 * importing them from `src/similarity`. Two reasons:
 *
 *  1. Layering. `src/similarity` is the *scoring* layer (Jaccard, LCS, cosine,
 *     classification). Normalisation must be able to produce hashes without
 *     depending on a module that, in turn, depends on normalisation. Keeping
 *     the primitives here means the dependency arrow only ever points one way.
 *  2. Determinism. The exact hash functions define the identity of a block
 *     across runs, releases and cache entries. They are versioned by
 *     `NORMALIZATION_VERSION` (see `src/types.ts`); a change here is a breaking
 *     change and must bump it.
 *
 * Everything below is implemented locally with no runtime dependency beyond
 * JavaScript number/bigint arithmetic, so a normalisation can run in a worker,
 * in the extension host, or in a test process without a crypto polyfill.
 *
 * What is preserved vs discarded:
 *  - `sha1Hex` preserves the *exact* byte content of its input. It is used for
 *    `tokenHash` and for shingle digests, both of which must agree with
 *    `node:crypto` SHA-1.
 *  - `fnv1a64` preserves bit-identity of the input string, nothing is truncated.
 *  - `simhashOf` *discards* magnitude: it keeps only the sign of a 64-way
 *    projection per token, so it is order-sensitive and lossy by design.
 *  - `minhashOf` discards everything except, per band, the minimum 16-bit
 *    projection of the shingle set; it estimates set Jaccard, not sequence
 *    similarity.
 *  - `shingleHashes` *discards* the token values themselves — only a truncated
 *    64-bit digest of each k-gram survives, so the stream cannot be recovered
 *    from the shingle list by brute force in practice.
 *
 * Parameters (all defaults are the ones wired into `normalizeBlock`):
 *  - shingle size k = 4 tokens (`DEFAULT_SHINGLE_SIZE`).
 *  - shingle digest width = 16 lowercase hex characters (64 bits).
 *  - MinHash bands = 128, each band value in `[0, 65535]`, rendered as decimal
 *    strings to match `NormalizedBlock.minhash` in the frozen contract.
 *  - SimHash width = 64 bits, rendered as 16 lowercase hex characters.
 */

/** Default number of normalised tokens per shingle. Matches the shingle size setting. */
export const DEFAULT_SHINGLE_SIZE = 4;

/** Number of MinHash bands in the signature. The frozen contract requires 128. */
export const MINHASH_BANDS = 128;

/** SimHash width in bits. The frozen contract requires 64. */
export const SIMHASH_BITS = 64;

/** Hex characters retained from a shingle digest. */
const SHINGLE_HEX_LENGTH = 16;

const HEX_DIGITS = '0123456789abcdef';

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * Encode a string to UTF-8 bytes without allocating a Buffer.
 *
 * Why: `sha1Hex` is called for every shingle of every block, so the encoder sits
 * on a hot path. Lone surrogates are encoded as the three-byte sequence their
 * code unit denotes (CESU-8 style) rather than as U+FFFD, because determinism
 * matters more than conformance with the WHATWG replacement policy here: the
 * same input must always produce the same digest.
 */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function pushUint32(bytes: number[], value: number): void {
  bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function toHex8(value: number): string {
  let out = '';
  for (let shift = 28; shift >= 0; shift -= 4) {
    out += HEX_DIGITS[(value >>> shift) & 0xf];
  }
  return out;
}

/**
 * SHA-1 of a string's UTF-8 bytes, as 40 lowercase hex characters.
 *
 * SHA-1 is used because it is a *fingerprint of an already-normalised string*,
 * not a security primitive: the input contains no secrets (identifiers are
 * canonicalised, string literals are reduced to a length and a class), and the
 * value only has to be stable and fast. It is deliberately implemented here so
 * the extension has no crypto dependency; the result is byte-for-byte identical
 * to `node:crypto`'s `createHash('sha1')`.
 */
export function sha1Hex(input: string): string {
  const message = utf8Bytes(input);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) {
    message.push(0);
  }
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  pushUint32(message, high);
  pushUint32(message, low);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        ((message[at]! << 24) |
          (message[at + 1]! << 16) |
          (message[at + 2]! << 8) |
          message[at + 3]!) >>>
        0;
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl32(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return toHex8(h0) + toHex8(h1) + toHex8(h2) + toHex8(h3) + toHex8(h4);
}

/**
 * 64-bit FNV-1a over UTF-8 bytes.
 *
 * Cheap, dependency-free, and stable across runs and platforms — the property
 * MinHash and SimHash actually need. It is *not* cryptographic and must never be
 * used for anything that needs collision resistance.
 */
export function fnv1a64(input: string): bigint {
  const bytes = utf8Bytes(input);
  let hash = FNV64_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i += 1) {
    hash = (hash ^ BigInt(bytes[i]!)) & U64_MASK;
    hash = (hash * FNV64_PRIME) & U64_MASK;
  }
  return hash;
}

/**
 * k-gram shingle digests over a normalised token stream.
 *
 * A shingle is the SHA-1 digest of `k` consecutive token values joined by a
 * single space, truncated to {@link SHINGLE_HEX_LENGTH} hex characters. The
 * result is de-duplicated and sorted: MinHash estimates the Jaccard similarity
 * of *sets*, and sorting makes the persisted output byte-stable for the
 * determinism guarantee in `NormalizedBlock`.
 *
 * Streams shorter than `k` tokens still produce exactly one shingle (over the
 * whole stream) so that tiny blocks — a getter, a one-line arrow — have a
 * signature instead of an empty set, which would otherwise make every pair of
 * trivial blocks look identical.
 *
 * @param tokens Normalised token values, in source order.
 * @param k Tokens per shingle; values below 1 are clamped to 1.
 */
export function shingleHashes(
  tokens: readonly string[],
  k: number = DEFAULT_SHINGLE_SIZE,
): string[] {
  if (tokens.length === 0) {
    return [];
  }
  const size = Math.max(1, Math.floor(k));
  const unique = new Set<string>();
  if (tokens.length < size) {
    unique.add(sha1Hex(tokens.join(' ')).slice(0, SHINGLE_HEX_LENGTH));
    return [...unique].sort();
  }
  for (let i = 0; i + size <= tokens.length; i += 1) {
    unique.add(sha1Hex(tokens.slice(i, i + size).join(' ')).slice(0, SHINGLE_HEX_LENGTH));
  }
  return [...unique].sort();
}

/**
 * SimHash of a token stream: 64 bits as 16 lowercase hex characters.
 *
 * Every token contributes a +1/-1 vote to each of the 64 bit counters according
 * to its FNV-1a hash, and a bit is set when its counter is positive. Tokens are
 * therefore *order-insensitive*: the fingerprint captures "which constructs
 * dominate", not "in which order", which complements the order-sensitive
 * `tokenHash` and MinHash. An empty stream hashes to all zeroes.
 */
export function simhashOf(tokens: readonly string[]): string {
  const votes = new Int32Array(SIMHASH_BITS);
  for (const token of tokens) {
    const hash = fnv1a64(token);
    const high = Number((hash >> 32n) & 0xffffffffn) >>> 0;
    const low = Number(hash & 0xffffffffn) >>> 0;
    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit] += (low >>> bit) & 1 ? 1 : -1;
      votes[bit + 32] += (high >>> bit) & 1 ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < SIMHASH_BITS; bit += 1) {
    if ((votes[bit] as number) > 0) {
      fingerprint |= 1n << BigInt(bit);
    }
  }
  return fingerprint.toString(16).padStart(16, '0');
}

/**
 * MinHash signature: one minimum 16-bit projection per band.
 *
 * Bands are independent multiply-shift mixes of the shingle's 64-bit FNV hash
 * (`imul`-based so the cost stays in 32-bit number space), and each band keeps
 * the smallest value seen. The expected number of agreements between two
 * signatures equals the Jaccard similarity of their shingle sets, which is what
 * `SimilarityBreakdown.jaccard` reports. Values are decimal strings because the
 * frozen `NormalizedBlock` contract types `minhash` as `string[]`.
 *
 * An empty shingle set yields all-zero bands, which scores 1.0 against another
 * empty set and 0.0 against anything else — the desired behaviour for
 * degenerate blocks.
 */
export function minhashOf(shingles: readonly string[], bands: number = MINHASH_BANDS): string[] {
  const bandCount = Math.max(1, Math.floor(bands));
  const minimums = new Uint16Array(bandCount).fill(0xffff);
  for (const shingle of shingles) {
    const hash = fnv1a64(shingle);
    const high = Number((hash >> 32n) & 0xffffffffn) >>> 0;
    const low = Number(hash & 0xffffffffn) >>> 0;
    for (let band = 0; band < bandCount; band += 1) {
      const mixed =
        (Math.imul(low ^ Math.imul(band + 1, 0x9e3779b1), 0x85ebca6b) +
          Math.imul(high, 0xc2b2ae35)) >>>
        0;
      const value = mixed & 0xffff;
      if (value < (minimums[band] as number)) {
        minimums[band] = value;
      }
    }
  }
  return Array.from(minimums, (value) => String(value));
}
