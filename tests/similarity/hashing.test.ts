/**
 * Unit tests for the hashing primitives in `src/similarity/hashing`.
 *
 * The vector tests use the published FNV-1a 64 reference values rather than
 * values captured from this implementation: a test that asserts the code agrees
 * with itself proves nothing.
 */

import { describe, expect, it } from 'vitest';

import {
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
} from '../../src/similarity/hashing';
import { makeRandom } from './fixtures';

const MASK64 = 0xffffffffffffffffn;

/**
 * Independent reference FNV-1a 64: iterates code points rather than bytes and
 * writes the loop in a different shape, so a transcription error in the
 * production loop cannot make the test agree with it.
 */
function referenceFnv1a64(input: string): bigint {
  let hash = FNV64_OFFSET_BASIS;
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash;
}

function naivePopcount(value: bigint): number {
  let v = BigInt.asUintN(64, value);
  let count = 0;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
}

function naiveHamming(a: bigint, b: bigint): number {
  return naivePopcount(BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b));
}

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64 reference vectors', () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ['', 'cbf29ce484222325'],
      ['a', 'af63dc4c8601ec8c'],
      ['b', 'af63df4c8601f1a5'],
      ['c', 'af63de4c8601eff2'],
      ['fo', '08985907b541d342'],
      ['foo', 'dcb27518fed9d577'],
      ['foob', 'dd120e790c2512af'],
      ['fooba', 'cac165afa2fef40a'],
      ['foobar', '85944171f73967e8'],
      ['hello world', '779a65e7023cd2e7'],
    ];
    for (const [input, expected] of vectors) {
      expect(fnv1a64(input).toString(16).padStart(16, '0')).toBe(expected);
    }
  });

  it('hashes the empty string to the offset basis', () => {
    expect(fnv1a64('')).toBe(FNV64_OFFSET_BASIS);
    expect(FNV64_OFFSET_BASIS).toBe(14695981039346656037n);
    expect(FNV64_PRIME).toBe(1099511628211n);
  });

  it('stays exact past 2^53, where a double-based hash would lose precision', () => {
    // A 64-bit value above 2^53 cannot round-trip through a JS `number`; the
    // whole reason this returns a bigint.
    const long = 'a'.repeat(200);
    const hash = fnv1a64(long);
    expect(hash > 2n ** 53n).toBe(true);
    expect(hash).toBe(referenceFnv1a64(long));
    // The nearest double is a different number, which is the point.
    expect(BigInt(Number(hash))).not.toBe(hash);
  });

  it('agrees with the reference over a deterministic random corpus', () => {
    const random = makeRandom(0x5eed);
    for (let i = 0; i < 200; i++) {
      let text = '';
      const length = 1 + Math.floor(random() * 40);
      for (let c = 0; c < length; c++) {
        text += String.fromCharCode(32 + Math.floor(random() * 95));
      }
      expect(fnv1a64(text)).toBe(referenceFnv1a64(text));
    }
  });

  it('always stays inside the 64-bit range', () => {
    for (const input of ['', 'x', 'x'.repeat(1000), 'é'.repeat(50)]) {
      const hash = fnv1a64(input);
      expect(hash >= 0n).toBe(true);
      expect(hash <= MASK64).toBe(true);
    }
  });
});

describe('sha1Hex', () => {
  it('produces 40 lowercase hex characters', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    for (const input of ['x', 'id:1 id:2', 'a'.repeat(5000)]) {
      expect(sha1Hex(input)).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('parseHex64', () => {
  it('accepts 1..16 hex characters in either case', () => {
    expect(parseHex64('ff')).toBe(255n);
    expect(parseHex64('00000000000000ff')).toBe(255n);
    expect(parseHex64('FF')).toBe(255n);
    expect(parseHex64('ffffffffffffffff')).toBe(MASK64);
  });

  it('rejects empty, over-long and non-hex input', () => {
    expect(parseHex64('')).toBeNull();
    expect(parseHex64('0'.repeat(17))).toBeNull();
    expect(parseHex64('g')).toBeNull();
    expect(parseHex64('12 34')).toBeNull();
    expect(parseHex64('-1')).toBeNull();
  });
});

describe('popcount64', () => {
  it('agrees with a naive loop, including the boundary values', () => {
    const values: bigint[] = [
      0n,
      1n,
      2n,
      3n,
      255n,
      256n,
      0x5555555555555555n,
      0xaaaaaaaaaaaaaaaan,
      0x0f0f0f0f0f0f0f0fn,
      1n << 63n,
      MASK64,
      MASK64 - 1n,
      0x8000000000000000n | 0x1n,
      fnv1a64('foobar'),
    ];
    for (const value of values) {
      expect(popcount64(value)).toBe(naivePopcount(value));
    }
  });

  it('handles the specific values called out by the spec', () => {
    expect(popcount64(0n)).toBe(0);
    expect(popcount64(1n)).toBe(1);
    expect(popcount64(2n)).toBe(1);
    expect(popcount64(1n << 63n)).toBe(1);
    expect(popcount64(MASK64)).toBe(64);
  });

  it('truncates to the low 64 bits instead of throwing', () => {
    expect(popcount64(1n << 64n)).toBe(0);
    expect(popcount64((1n << 64n) | 0xffn)).toBe(8);
    expect(popcount64(-1n)).toBe(64);
  });

  it('agrees with the naive loop over a random corpus', () => {
    const random = makeRandom(0xc0ffee);
    for (let i = 0; i < 500; i++) {
      let value = 0n;
      for (let bit = 0; bit < 8; bit++) {
        value = (value << 8n) | BigInt(Math.floor(random() * 256));
      }
      expect(popcount64(value)).toBe(naivePopcount(value));
    }
  });
});

describe('hammingDistance / hammingSimilarity', () => {
  it('computes the distance of known pairs', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingDistance('0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0')).toBe(64);
    expect(hammingDistance('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa')).toBe(0);
    expect(hammingDistance('0f0f0f0f0f0f0f0f', '00ff00ff00ff00ff')).toBe(32);
  });

  it('agrees with the naive popcount over random values', () => {
    const random = makeRandom(0xabcdef);
    const toHex = (value: bigint): string =>
      BigInt.asUintN(64, value).toString(16).padStart(16, '0');
    for (let i = 0; i < 300; i++) {
      const a =
        BigInt(Math.floor(random() * 2 ** 32)) * 2n ** 32n + BigInt(Math.floor(random() * 2 ** 32));
      let b =
        BigInt(Math.floor(random() * 2 ** 32)) * 2n ** 32n + BigInt(Math.floor(random() * 2 ** 32));
      // Force a small distance half the time, so the test exercises the
      // near-duplicate regime as well as the random one.
      if (i % 2 === 0) {
        b = a ^ (1n << BigInt(Math.floor(random() * 64)));
      }
      expect(hammingDistance(toHex(a), toHex(b))).toBe(naiveHamming(a, b));
    }
  });

  it('returns the maximum distance for mismatched lengths', () => {
    expect(hammingDistance('ffff', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('ffffffffffffffff', 'ffff')).toBe(64);
    expect(hammingDistance('', '')).toBe(64);
  });

  it('returns the maximum distance for invalid hex instead of throwing', () => {
    expect(hammingDistance('zzzzzzzzzzzzzzzz', '0000000000000000')).toBe(64);
    expect(hammingDistance('0000000000000000', 'not-hex-at-all')).toBe(64);
    expect(hammingDistance('00000000000000000', '0000000000000000')).toBe(64);
  });

  it('derives similarity from the distance', () => {
    expect(hammingSimilarity('0000000000000000', '0000000000000000')).toBe(1);
    expect(hammingSimilarity('0000000000000000', '0000000000000003')).toBeCloseTo(1 - 2 / 64, 12);
    expect(hammingSimilarity('0000000000000000', 'ffffffffffffffff')).toBe(0);
    // 'zzz' is not hex, so the value is unusable and the pair is maximally distant.
    expect(hammingSimilarity('zzz', 'zzz')).toBe(0);
  });
});

describe('exactJaccard', () => {
  it('returns 1 when both collections are empty', () => {
    expect(exactJaccard([], [])).toBe(1);
    expect(exactJaccard(new Set<string>(), [])).toBe(1);
  });

  it('returns 0 when exactly one collection is empty', () => {
    expect(exactJaccard([], ['a'])).toBe(0);
    expect(exactJaccard(['a'], [])).toBe(0);
  });

  it('computes the ratio for ordinary sets', () => {
    expect(exactJaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(exactJaccard(['a', 'b', 'c'], ['a', 'b', 'd'])).toBeCloseTo(2 / 4, 12);
    expect(exactJaccard(['a'], ['b'])).toBe(0);
    expect(exactJaccard(['a', 'b'], ['a'])).toBeCloseTo(0.5, 12);
  });

  it('collapses duplicates', () => {
    expect(exactJaccard(['a', 'a', 'a'], ['a'])).toBe(1);
    expect(exactJaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
  });
});

describe('estimateJaccardFromMinhash', () => {
  it('is exact for identical and empty signatures', () => {
    const signature = minhashFromShingles(['a', 'b', 'c', 'd', 'e'], 16);
    expect(estimateJaccardFromMinhash(signature, signature, 16)).toBe(1);
    expect(estimateJaccardFromMinhash([], [], 16)).toBe(0);
    expect(estimateJaccardFromMinhash(signature, [], 16)).toBe(0);
    expect(estimateJaccardFromMinhash([], signature, 16)).toBe(0);
  });

  it('is within 0.05 of exact Jaccard across a random set corpus, in aggregate', () => {
    // MinHash noise is `sqrt(p(1-p)/128)`: about 0.04 at p = 0.5 and 0.027 at
    // p = 0.9. A *per-pair* 0.05 guarantee is therefore not statistically
    // available at 128 bands (it is a 1.5-1.9 sigma bound), and the estimator is
    // unbiased, so the defensible assertions are on the aggregate error plus a
    // 2-3 sigma per-pair bound. The estimator is fully deterministic, so every
    // number below is reproducible.
    const random = makeRandom(0x1234abcd);
    const errors: number[] = [];
    let worst = 0;
    for (let trial = 0; trial < 200; trial++) {
      const universe = 400;
      const sizeA = 20 + Math.floor(random() * 120);
      const sizeB = 20 + Math.floor(random() * 120);
      const setA = new Set<string>();
      const setB = new Set<string>();
      for (let i = 0; i < sizeA; i++) {
        setA.add(`s${Math.floor(random() * universe)}`);
      }
      for (let i = 0; i < sizeB; i++) {
        setB.add(`s${Math.floor(random() * universe)}`);
      }
      const truth = exactJaccard(setA, setB);
      const estimate = estimateJaccardFromMinhash(
        minhashFromShingles([...setA], 128),
        minhashFromShingles([...setB], 128),
        128,
      );
      const error = Math.abs(estimate - truth);
      errors.push(error);
      worst = Math.max(worst, error);
    }
    const mean = errors.reduce((total, error) => total + error, 0) / errors.length;
    const meanSquare = errors.reduce((total, error) => total + error * error, 0) / errors.length;
    expect(mean).toBeLessThan(0.04);
    expect(Math.sqrt(meanSquare)).toBeLessThan(0.05);
    // 3-sigma worst case at p = 0.5.
    expect(worst).toBeLessThan(0.15);
  });

  it('is accurate in the high-overlap regime that Ancestry actually acts on', () => {
    // Ancestry only reports pairs above ~0.6, where the standard error is at most
    // 0.033. Here the aggregate error must be well under 0.05, at least 95% of
    // pairs must be individually within 0.05, and none may exceed 0.1.
    const random = makeRandom(0x77aa33);
    const errors: number[] = [];
    let signed = 0;
    for (let trial = 0; trial < 250; trial++) {
      const setA = new Set<string>();
      for (let i = 0; i < 60; i++) {
        setA.add(`s${i}`);
      }
      const setB = new Set<string>(setA);
      // Delete 0-20% of the elements, then add the same number back as new ones.
      const drop = Math.floor(random() * 12);
      for (let i = 0; i < drop; i++) {
        setB.delete(`s${Math.floor(random() * 60)}`);
      }
      for (let i = 0; i < drop; i++) {
        setB.add(`n${i}`);
      }
      const truth = exactJaccard(setA, setB);
      expect(truth).toBeGreaterThan(0.6);
      const estimate = estimateJaccardFromMinhash(
        minhashFromShingles([...setA], 128),
        minhashFromShingles([...setB], 128),
        128,
      );
      errors.push(Math.abs(estimate - truth));
      signed += estimate - truth;
    }
    const mean = errors.reduce((total, error) => total + error, 0) / errors.length;
    const within = errors.filter((error) => error < 0.05).length;
    expect(mean).toBeLessThan(0.025);
    expect(within / errors.length).toBeGreaterThanOrEqual(0.95);
    expect(Math.max(...errors)).toBeLessThan(0.1);
    // The estimator must be *unbiased*: a systematic overestimate would push
    // unrelated blocks over the `strong` threshold. Without the avalanche
    // finaliser this figure is +0.062.
    expect(Math.abs(signed / errors.length)).toBeLessThan(0.01);
  });

  it('compares over the common prefix when the signatures differ in length', () => {
    const long = minhashFromShingles(['a', 'b', 'c', 'd'], 128);
    const short = long.slice(0, 64);
    expect(estimateJaccardFromMinhash(long, short, 128)).toBe(1);
    expect(estimateJaccardFromMinhash(long, short, 64)).toBe(1);
  });
});

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeCloseTo(1, 12);
  });

  it('returns 0 for disjoint vectors', () => {
    expect(cosine({ a: 1, b: 2 }, { c: 3, d: 4 })).toBe(0);
  });

  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosine({}, { a: 1 })).toBe(0);
    expect(cosine({ a: 1 }, {})).toBe(0);
    expect(cosine({}, {})).toBe(0);
  });

  it('computes the sparse dot product over the union of keys', () => {
    // Classic 3-4-5 triangle in the first two dimensions.
    expect(cosine({ a: 3, b: 4 }, { a: 4, b: 3 })).toBeCloseTo(24 / 25, 12);
    expect(cosine({ a: 1, b: 1 }, { a: 1, b: 0 })).toBeCloseTo(1 / Math.SQRT2, 12);
  });

  it('is symmetric', () => {
    const a = { x: 1, y: 5, z: 2 };
    const b = { x: 3, y: 1, w: 9 };
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 12);
  });

  it('clamps float drift into [0, 1]', () => {
    // A long, nearly-parallel pair of vectors can round past 1.
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      a[`k${i}`] = 1 / (i + 1);
      b[`k${i}`] = 1 / (i + 1);
    }
    b['extra'] = 1e-9;
    const value = cosine(a, b);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('maps non-finite input to 0 rather than propagating NaN', () => {
    expect(cosine({ a: Number.NaN }, { a: 1 })).toBe(0);
    expect(cosine({ a: 1 }, { a: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe('buildShingles', () => {
  it('emits n - k + 1 shingles for text at least k tokens long', () => {
    const text = 'a b c d e f';
    expect(buildShingles(text, 4)).toHaveLength(3);
    expect(buildShingles(text, 2)).toHaveLength(5);
    expect(buildShingles(text, 6)).toHaveLength(1);
  });

  it('emits a single shingle for the whole token list when the text is shorter than k', () => {
    expect(buildShingles('a b c', 4)).toHaveLength(1);
    expect(buildShingles('a', 4)).toHaveLength(1);
    expect(buildShingles('a b', 4)).toHaveLength(1);
  });

  it('returns nothing for empty input', () => {
    expect(buildShingles('')).toEqual([]);
    expect(buildShingles('   ')).toEqual([]);
  });

  it('de-duplicates repeated k-grams', () => {
    // 'a b a b a b a b' yields five 4-grams but only two distinct ones: the
    // Jaccard index must be a *set* index, or repetition would dominate it.
    const repeated = buildShingles('a b a b a b a b', 4);
    expect(repeated).toHaveLength(2);
    expect(buildShingles('a b a b a b a b', 4)).toEqual(repeated);
  });

  it('ignores runs of whitespace, so formatting cannot change the shingle set', () => {
    expect(buildShingles('a b c d e', 4)).toEqual(buildShingles('  a  b\n c\td  e ', 4));
  });

  it('returns 16-character lowercase hex values', () => {
    for (const shingle of buildShingles('function id:0 ( id:1 ) { return id:1 ; }', 4)) {
      expect(shingle).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('simhashFromTokens', () => {
  it('is deterministic and returns 16 lowercase hex characters', () => {
    const tokens = [{ value: 'function' }, { value: 'id:0' }, { value: '(' }, { value: 'id:1' }];
    const first = simhashFromTokens(tokens);
    const second = simhashFromTokens(tokens);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is all zeroes for an empty bag', () => {
    expect(simhashFromTokens([])).toBe('0000000000000000');
  });

  it('ignores zero-weighted tokens', () => {
    expect(simhashFromTokens([{ value: 'a', weight: 0 }])).toBe('0000000000000000');
  });

  it('places near-identical token bags within 3 bits of each other', () => {
    const random = makeRandom(0x2468);
    for (let trial = 0; trial < 20; trial++) {
      const base: Array<{ value: string }> = [];
      for (let i = 0; i < 200; i++) {
        base.push({ value: `t${Math.floor(random() * 400)}` });
      }
      const variant = base.map((token, index) =>
        index === 137 ? { value: `other${Math.floor(random() * 400)}` } : token,
      );
      const distance = hammingDistance(simhashFromTokens(base), simhashFromTokens(variant));
      expect(distance).toBeLessThanOrEqual(3);
    }
  });

  it('is order-insensitive, which is what makes it a global shape sketch', () => {
    const a = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value }));
    const b = ['e', 'c', 'a', 'd', 'b'].map((value) => ({ value }));
    expect(simhashFromTokens(a)).toBe(simhashFromTokens(b));
  });

  it('separates unrelated bags', () => {
    const a = ['function', 'id:0', '(', 'id:1', ')', '{', 'return', 'id:1', ';', '}'].map(
      (value) => ({ value }),
    );
    const b = ['class', 'id:9', 'extends', 'id:8', '{', '}', 'while', '(', 'true', ')'].map(
      (value) => ({ value }),
    );
    expect(hammingDistance(simhashFromTokens(a), simhashFromTokens(b))).toBeGreaterThanOrEqual(8);
  });
});

describe('minhashFromShingles', () => {
  it('emits the requested number of bands, each in [0, 65535]', () => {
    const signature = minhashFromShingles(['a', 'b', 'c', 'd', 'e'], 128);
    expect(signature).toHaveLength(128);
    for (const band of signature) {
      expect(band).toMatch(/^[0-9]+$/);
      expect(Number(band)).toBeGreaterThanOrEqual(0);
      expect(Number(band)).toBeLessThanOrEqual(65535);
    }
  });

  it('is all zeros for an empty shingle set', () => {
    expect(minhashFromShingles([], 8)).toEqual(['0', '0', '0', '0', '0', '0', '0', '0']);
  });

  it('is deterministic', () => {
    const shingles = ['alpha', 'beta', 'gamma', 'delta'];
    expect(minhashFromShingles(shingles, 32)).toEqual(minhashFromShingles(shingles, 32));
  });

  it('produces identical signatures for identical inputs', () => {
    const shingles = ['one', 'two', 'three', 'four', 'five', 'six'];
    expect(minhashFromShingles(shingles, 64)).toEqual(minhashFromShingles([...shingles], 64));
  });

  it('decorrelates the bands: they are not all equal', () => {
    const signature = minhashFromShingles(['x', 'y', 'z'], 16);
    expect(new Set(signature).size).toBeGreaterThan(1);
  });

  it('returns nothing for a non-positive band count', () => {
    expect(minhashFromShingles(['a'], 0)).toEqual([]);
    expect(minhashFromShingles(['a'], -3)).toEqual([]);
  });
});
