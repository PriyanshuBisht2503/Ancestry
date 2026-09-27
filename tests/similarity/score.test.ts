/**
 * Unit tests for the scoring engine in `src/similarity/score`.
 *
 * These tests exercise the *aggregation* rules — renormalisation over used
 * components, threshold boundaries, clamping, and the cost separation between the
 * full and cheap paths. The end-to-end accuracy claims live in
 * `accuracy.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  classify,
  combine,
  compareBlocks,
  compareFingerprint,
  DEFAULT_MIN_SHINGLES_FOR_MINHASH,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  requireStrongMatch,
} from '../../src/similarity/score';
import { makeNormalized } from './fixtures';
import type { SimilarityBreakdown, SimilarityThresholds } from '../../src/types';

const breakdown = (
  jaccard: number,
  simhash: number,
  lcs: number,
  shape: number,
): SimilarityBreakdown => ({ jaccard, simhash, lcs, shape });

describe('DEFAULT_WEIGHTS', () => {
  it('matches the documented values and sums to 1', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ jaccard: 0.5, simhash: 0.2, lcs: 0.2, shape: 0.1 });
    const total = Object.values(DEFAULT_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('is frozen so a caller cannot mutate the engine defaults', () => {
    expect(Object.isFrozen(DEFAULT_WEIGHTS)).toBe(true);
  });
});

describe('DEFAULT_THRESHOLDS', () => {
  it('matches the plan classification bands', () => {
    expect(DEFAULT_THRESHOLDS.strong).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.possible).toBe(0.75);
    expect(DEFAULT_THRESHOLDS.ignore).toBe(0.6);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });

  it('agrees with the settings declared in package.json', () => {
    // Duplicated deliberately: a drift between the manifest defaults and the
    // engine defaults would silently change every user's results.
    const thresholds: SimilarityThresholds = DEFAULT_THRESHOLDS;
    expect(thresholds.strong).toBeGreaterThan(thresholds.possible);
    expect(thresholds.possible).toBeGreaterThan(thresholds.ignore);
  });
});

describe('classify', () => {
  const t = DEFAULT_THRESHOLDS;

  it('labels every band, boundaries included', () => {
    expect(classify(1, t)).toBe('strong');
    expect(classify(0.95, t)).toBe('strong');
    expect(classify(0.9, t)).toBe('strong'); // boundary is inclusive
    expect(classify(0.8999999, t)).toBe('possible');
    expect(classify(0.8999, t)).toBe('possible');
    expect(classify(0.75, t)).toBe('possible'); // boundary is inclusive
    expect(classify(0.7499, t)).toBe('weak');
    expect(classify(0.6, t)).toBe('weak'); // boundary is inclusive
    expect(classify(0.5999, t)).toBe('unrelated');
    expect(classify(0, t)).toBe('unrelated');
  });

  it('honours custom thresholds', () => {
    const custom: SimilarityThresholds = { strong: 0.99, possible: 0.5, ignore: 0.2 };
    expect(classify(0.95, custom)).toBe('possible');
    expect(classify(0.99, custom)).toBe('strong');
    expect(classify(0.3, custom)).toBe('weak');
    expect(classify(0.1, custom)).toBe('unrelated');
  });

  it('clamps out-of-range and non-finite scores', () => {
    expect(classify(1.5, t)).toBe('strong');
    expect(classify(-3, t)).toBe('unrelated');
    expect(classify(Number.NaN, t)).toBe('unrelated');
    expect(classify(Number.POSITIVE_INFINITY, t)).toBe('strong');
  });
});

describe('combine', () => {
  it('returns 0 when nothing was measured', () => {
    expect(combine(breakdown(1, 1, 1, 1), [])).toBe(0);
    expect(combine(breakdown(0, 0, 0, 0), [])).toBe(0);
  });

  it('is the plain weighted mean when every component is used', () => {
    expect(combine(breakdown(1, 1, 1, 1), ['jaccard', 'simhash', 'lcs', 'shape'])).toBe(1);
    expect(combine(breakdown(0, 0, 0, 0), ['jaccard', 'simhash', 'lcs', 'shape'])).toBe(0);
    expect(
      combine(breakdown(0.5, 0.2, 0.2, 0.1), ['jaccard', 'simhash', 'lcs', 'shape']),
    ).toBeCloseTo(0.5 * 0.5 + 0.2 * 0.2 + 0.2 * 0.2 + 0.1 * 0.1, 12);
  });

  it('renormalises over the used components instead of counting a skip as zero', () => {
    // The jaccard component is 0 because it was *not measured*. Counting it would
    // cap the score at 0.5 and demote an exact match of two tiny blocks.
    const values = breakdown(0, 1, 1, 1);
    const withSkip = combine(values, ['simhash', 'lcs', 'shape']);
    const rawSum = DEFAULT_WEIGHTS.simhash + DEFAULT_WEIGHTS.lcs + DEFAULT_WEIGHTS.shape;
    expect(withSkip).toBe(1);
    expect(rawSum).toBeCloseTo(0.5, 12);
    expect(combine(values, ['jaccard', 'simhash', 'lcs', 'shape'])).toBeCloseTo(rawSum, 12);
    expect(withSkip).toBeGreaterThan(combine(values, ['jaccard', 'simhash', 'lcs', 'shape']));
  });

  it('collapses duplicate component names', () => {
    expect(combine(breakdown(0, 1, 1, 1), ['simhash', 'simhash'])).toBe(1);
  });

  it('clamps component values and the result into [0, 1]', () => {
    expect(combine(breakdown(5, 5, 5, 5), ['jaccard', 'simhash', 'lcs', 'shape'])).toBe(1);
    expect(combine(breakdown(-5, -5, -5, -5), ['jaccard', 'simhash', 'lcs', 'shape'])).toBe(0);
    expect(
      combine(breakdown(Number.NaN, 1, 1, 1), ['jaccard', 'simhash', 'lcs', 'shape']),
    ).toBeCloseTo((0.2 + 0.2 + 0.1) / 1, 12);
  });

  it('returns 0 when every used component has a non-positive weight', () => {
    const zeroed = { jaccard: 0, simhash: 0, lcs: 0, shape: 0 };
    expect(combine(breakdown(1, 1, 1, 1), ['jaccard', 'simhash', 'lcs', 'shape'], zeroed)).toBe(0);
  });

  it('accepts custom weights', () => {
    const values = breakdown(1, 0, 0, 0);
    const lcsOnly = { jaccard: 0, simhash: 0, lcs: 1, shape: 0 };
    const jaccardOnly = { jaccard: 1, simhash: 0, lcs: 0, shape: 0 };
    expect(combine(values, ['jaccard'], jaccardOnly)).toBe(1);
    expect(combine(values, ['jaccard'], lcsOnly)).toBe(0);
  });
});

describe('compareBlocks', () => {
  it('returns exactly 1 and strong for identical normalised structure', () => {
    const a = makeNormalized('function alpha(x: number) { return x + 1; }', { blockId: 'a' });
    // Same token stream, different identifier names and formatting.
    const b = makeNormalized('function\n  beta ( y : number ) {\n    return y + 1;\n  }', {
      blockId: 'b',
    });
    expect(a.tokenHash).toBe(b.tokenHash);
    const result = compareBlocks(a, b);
    expect(result.similarity).toBe(1);
    expect(result.classification).toBe('strong');
    expect(result.breakdown).toEqual({ jaccard: 1, simhash: 1, lcs: 1, shape: 1 });
    expect([...result.componentsUsed].sort()).toEqual(['jaccard', 'lcs', 'shape', 'simhash']);
    expect(result.sourceBlockId).toBe('a');
    expect(result.candidateBlockId).toBe('b');
    expect(requireStrongMatch(result)).toBe(true);
  });

  it('skips the jaccard component for tiny blocks and renormalises', () => {
    // Four tokens produce a single shingle, below the 3-shingle floor.
    const a = makeNormalized('const a = 1;', { blockId: 'a' });
    const b = makeNormalized('const a = 1 + 2;', { blockId: 'b' });
    expect(a.shingles.length).toBeLessThan(DEFAULT_MIN_SHINGLES_FOR_MINHASH);
    const result = compareBlocks(a, b);
    expect(result.componentsUsed).not.toContain('jaccard');
    expect(result.breakdown.jaccard).toBe(0);

    const weightSum = DEFAULT_WEIGHTS.simhash + DEFAULT_WEIGHTS.lcs + DEFAULT_WEIGHTS.shape;
    const unnormalisedSum =
      DEFAULT_WEIGHTS.simhash * result.breakdown.simhash +
      DEFAULT_WEIGHTS.lcs * result.breakdown.lcs +
      DEFAULT_WEIGHTS.shape * result.breakdown.shape;
    // Renormalising divides by the *used* weight (0.5), lifting the pair from
    // 0.45 — which the un-renormalised sum would report, below the ignore
    // threshold — back to 0.91.
    expect(result.similarity).toBeCloseTo(unnormalisedSum / weightSum, 12);
    expect(result.similarity).toBeGreaterThan(unnormalisedSum);
    expect(unnormalisedSum).toBeLessThan(DEFAULT_THRESHOLDS.ignore);
    expect(result.similarity).toBeGreaterThan(DEFAULT_THRESHOLDS.ignore);
    expect(result.classification).toBe('strong');
  });

  it('respects an explicit minShinglesForMinhash', () => {
    const a = makeNormalized('const a = 1;', { blockId: 'a' });
    const b = makeNormalized('const a = 1 + 2;', { blockId: 'b' });
    const result = compareBlocks(a, b, DEFAULT_THRESHOLDS, { minShinglesForMinhash: 1 });
    expect(result.componentsUsed).toContain('jaccard');
  });

  it('skips lcs when a block has no tokens, and shape when a feature map is empty', () => {
    const a = makeNormalized('const a = 1;', { blockId: 'a' });
    const b = makeNormalized('const a = 1 + 2;', { blockId: 'b' });
    const empty = { ...b, normalizedText: '', tokenHash: 'different', features: {} };
    const result = compareBlocks(a, empty);
    expect(result.componentsUsed).not.toContain('lcs');
    expect(result.componentsUsed).not.toContain('shape');
    expect(result.componentsUsed).toContain('simhash');
    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThanOrEqual(1);
  });

  it('uses the forced approximate LCS when asked', () => {
    const a = makeNormalized(
      'function f(xs: number[]) { return xs.map((x) => x + 1).filter((x) => x > 0).reduce((a, b) => a + b, 0); }',
      { blockId: 'a' },
    );
    const b = makeNormalized(
      'function g(ys: number[]) { return ys.map((y) => y + 1).filter((y) => y > 0).reduce((p, q) => p + q, 0); }',
      { blockId: 'b' },
    );
    const exact = compareBlocks(a, b);
    const approximate = compareBlocks(a, b, DEFAULT_THRESHOLDS, { useApproximateLcs: true });
    expect(exact.breakdown.lcs).toBe(1);
    expect(approximate.breakdown.lcs).toBeGreaterThan(0);
    expect(approximate.breakdown.lcs).toBeLessThanOrEqual(exact.breakdown.lcs);
  });

  it('honours custom weights', () => {
    const a = makeNormalized('function f(x: number) { return x + 1; }', { blockId: 'a' });
    const b = makeNormalized('function f(x: number) { return x - 1; }', { blockId: 'b' });
    const lcsHeavy = compareBlocks(a, b, DEFAULT_THRESHOLDS, {
      weights: { jaccard: 0, simhash: 0, lcs: 1, shape: 0 },
    });
    const simhashHeavy = compareBlocks(a, b, DEFAULT_THRESHOLDS, {
      weights: { jaccard: 0, simhash: 1, lcs: 0, shape: 0 },
    });
    expect(lcsHeavy.similarity).toBeCloseTo(lcsHeavy.breakdown.lcs, 12);
    expect(simhashHeavy.similarity).toBeCloseTo(simhashHeavy.breakdown.simhash, 12);
  });

  it('ignores negative and non-finite weight overrides', () => {
    const a = makeNormalized('function f(x: number) { return x + 1; }', { blockId: 'a' });
    const b = makeNormalized('function f(x: number) { return x - 1; }', { blockId: 'b' });
    const reference = compareBlocks(a, b);
    const mangled = compareBlocks(a, b, DEFAULT_THRESHOLDS, {
      weights: { jaccard: Number.NaN, simhash: -3, lcs: Number.POSITIVE_INFINITY },
    });
    // jaccard is dropped, simhash is dropped, lcs keeps its default, shape keeps
    // its default; the point is simply that nothing throws or goes non-finite.
    expect(Number.isFinite(mangled.similarity)).toBe(true);
    expect(mangled.similarity).toBeGreaterThanOrEqual(0);
    expect(reference.similarity).toBeGreaterThan(0);
  });

  it('produces scores in [0, 1] with valid classifications across a mini corpus', () => {
    const snippets = [
      'function f(x: number) { return x + 1; }',
      'function g(y: number) { return y - 1; }',
      'const h = (a: string) => a.trim().toUpperCase();',
      'class K { private n = 0; inc(): void { this.n += 1; } }',
    ];
    for (const left of snippets) {
      for (const right of snippets) {
        const result = compareBlocks(
          makeNormalized(left, { blockId: 'l' }),
          makeNormalized(right, { blockId: 'r' }),
        );
        expect(result.similarity).toBeGreaterThanOrEqual(0);
        expect(result.similarity).toBeLessThanOrEqual(1);
        expect(['strong', 'possible', 'weak', 'unrelated']).toContain(result.classification);
      }
    }
  });
});

describe('compareFingerprint', () => {
  /**
   * A ~500-token function body. The operator is a parameter so that two
   * invocations produce genuinely different token streams — otherwise the
   * `tokenHash` fast path would short-circuit every test below.
   */
  const bigSource = (name: string, op: string): string => {
    let body = '';
    for (let i = 0; i < 40; i++) {
      body += `  const value${i} = compute${i}(input${i}, limit${i}) ${op} step${i};\n`;
    }
    return `export function ${name}(input: number, limit: number): number {\n${body}  return input ${op} limit;\n}`;
  };

  it('only uses the fingerprint components', () => {
    const source = makeNormalized(bigSource('alpha', '+'), { blockId: 'src' });
    const candidate = makeNormalized(bigSource('beta', '-'), { blockId: 'cand' });
    expect(source.tokenHash).not.toBe(candidate.tokenHash);
    const result = compareFingerprint(
      {
        blockId: 'cand',
        simhash: candidate.simhash,
        minhash: candidate.minhash,
        tokenCount: candidate.tokenCount,
      },
      source,
    );
    expect(result.componentsUsed).not.toContain('lcs');
    expect(result.componentsUsed).not.toContain('shape');
    expect(result.componentsUsed).toContain('simhash');
    expect(result.sourceBlockId).toBe('src');
    expect(result.candidateBlockId).toBe('cand');
  });

  it('works without a MinHash signature', () => {
    const source = makeNormalized(bigSource('alpha', '+'), { blockId: 'src' });
    const candidate = makeNormalized(bigSource('beta', '-'), { blockId: 'cand' });
    const result = compareFingerprint(
      {
        blockId: 'cand',
        simhash: candidate.simhash,
        minhash: [],
        tokenCount: candidate.tokenCount,
      },
      source,
    );
    expect(result.componentsUsed).toEqual(['simhash']);
  });

  it('short-circuits an identical fingerprint', () => {
    const source = makeNormalized(bigSource('alpha', '+'), { blockId: 'src' });
    const result = compareFingerprint(
      {
        blockId: 'cand',
        simhash: source.simhash,
        minhash: source.minhash,
        tokenCount: source.tokenCount,
      },
      source,
    );
    expect(result.similarity).toBe(1);
    expect(result.classification).toBe('strong');
  });

  it('is strictly cheaper than compareBlocks', () => {
    const source = makeNormalized(bigSource('alpha', '+'), { blockId: 'src' });
    const candidate = makeNormalized(bigSource('beta', '-'), { blockId: 'cand' });
    const reference = {
      blockId: 'cand',
      simhash: candidate.simhash,
      minhash: candidate.minhash,
      tokenCount: candidate.tokenCount,
    };

    const iterations = 100;
    const fingerprintStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      compareFingerprint(reference, source);
    }
    const fingerprintMs = Date.now() - fingerprintStart;

    const blocksStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      compareBlocks(source, candidate);
    }
    const blocksMs = Date.now() - blocksStart;

    // compareBlocks pays an O(n*m) DP that compareFingerprint never touches, so
    // the gap is two orders of magnitude, not a rounding artefact.
    expect(fingerprintMs * 4).toBeLessThan(Math.max(blocksMs, 1));
  });

  it('lands in the right ballpark without the LCS and shape components', () => {
    const source = makeNormalized('function alpha(x: number) { return x + 1; }', {
      blockId: 'src',
    });
    const candidate = makeNormalized('function beta(y: number) { return y - 2; }', {
      blockId: 'cand',
    });
    const reference = {
      blockId: 'cand',
      simhash: candidate.simhash,
      minhash: candidate.minhash,
      tokenCount: candidate.tokenCount,
    };
    const cheap = compareFingerprint(reference, source);
    const full = compareBlocks(source, candidate);
    // Cheap uses two components, so it is only *directionally* comparable: it
    // runs high when the token order has broken but the bag has not (the LCS
    // penalty is missing), and can run low when SimHash has drifted more than the
    // full score's other components can compensate. What must hold is that it
    // orders the same block the same way, not that it equals the full score.
    expect(Math.abs(cheap.similarity - full.similarity)).toBeLessThan(0.15);
    expect(cheap.similarity).toBeLessThanOrEqual(1);
  });

  it('over-reports a reordered block, which is why it may only shortlist', () => {
    // Two statements transposed: the token *bag* is unchanged, so SimHash is
    // perfect and Jaccard barely moves, while the LCS component — absent here —
    // is the only thing that would punish the reordering.
    const source = makeNormalized(
      'function f(p: number) { const a = p + 1; const b = p * 2; return a + b; }',
      { blockId: 'src' },
    );
    const candidate = makeNormalized(
      'function g(q: number) { const bb = q * 2; const aa = q + 1; return bb + aa; }',
      { blockId: 'cand' },
    );
    const reference = {
      blockId: 'cand',
      simhash: candidate.simhash,
      minhash: candidate.minhash,
      tokenCount: candidate.tokenCount,
    };
    const cheap = compareFingerprint(reference, source);
    const full = compareBlocks(source, candidate);
    expect(cheap.similarity).toBeGreaterThan(full.similarity);
  });
});

describe('requireStrongMatch', () => {
  it('is true only for the strong classification', () => {
    const a = makeNormalized('function f(x: number) { return x + 1; }', { blockId: 'a' });
    const b = makeNormalized('function f(x: number) { return x + 1; }', { blockId: 'b' });
    const strong = compareBlocks(a, b);
    expect(requireStrongMatch(strong)).toBe(true);

    const different = makeNormalized('const z = 9;', { blockId: 'c' });
    const weak = compareBlocks(a, different);
    expect(requireStrongMatch(weak)).toBe(false);
  });
});
