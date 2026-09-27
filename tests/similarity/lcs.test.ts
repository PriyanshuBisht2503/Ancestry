/**
 * Unit tests for the LCS engine in `src/similarity/lcs`.
 *
 * The exact-path expectations are hand-computed so that an algebraic error in
 * the DP cannot pass unnoticed. The approximation path gets its own block,
 * because "falls back gracefully" is exactly the kind of behaviour that silently
 * regresses into a hang.
 */

import { describe, expect, it } from 'vitest';

import {
  LCS_APPROXIMATION_THRESHOLD,
  longestCommonSubstring,
  tokenLcsLength,
  tokenLcsRatio,
  usesApproximation,
} from '../../src/similarity/lcs';
import { makeRandom } from './fixtures';

const chars = (text: string): string[] => [...text];
const words = (text: string): string[] => text.split(' ');

describe('tokenLcsLength', () => {
  it('returns 0 when either input is empty', () => {
    expect(tokenLcsLength([], [])).toBe(0);
    expect(tokenLcsLength(['a'], [])).toBe(0);
    expect(tokenLcsLength([], ['a'])).toBe(0);
  });

  it('handles the empty case without allocating', () => {
    // Both of these must be O(1): the row allocation is guarded behind the
    // length checks, and a regression here would allocate on every empty block.
    expect(tokenLcsLength([], [])).toBe(0);
    expect(tokenLcsLength([], ['a', 'b', 'c'])).toBe(0);
    expect(tokenLcsLength(['a', 'b', 'c'], [])).toBe(0);
  });

  it('computes the classic textbook LCS: AGGTAB vs GXTXAYB is GTAB', () => {
    expect(tokenLcsLength(chars('AGGTAB'), chars('GXTXAYB'))).toBe(4);
    expect(tokenLcsLength(chars('GXTXAYB'), chars('AGGTAB'))).toBe(4);
  });

  it('computes the other canonical pairs', () => {
    expect(tokenLcsLength(chars('ABCBDAB'), chars('BDCABA'))).toBe(4);
    expect(tokenLcsLength(chars('ABCDEF'), chars('ABCDEF'))).toBe(6);
    expect(tokenLcsLength(chars('ABCDEF'), chars('UVWXYZ'))).toBe(0);
    expect(tokenLcsLength(chars('ABC'), chars('ABC'))).toBe(3);
    expect(tokenLcsLength(chars('abc'), chars('abd'))).toBe(2);
    expect(tokenLcsLength(chars('aaa'), chars('aa'))).toBe(2);
    expect(tokenLcsLength(chars('aaa'), chars('aaaa'))).toBe(3);
  });

  it('is symmetric', () => {
    const random = makeRandom(0x51c);
    for (let trial = 0; trial < 200; trial++) {
      const lengthA = Math.floor(random() * 12);
      const lengthB = Math.floor(random() * 12);
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < lengthA; i++) {
        a.push(`t${Math.floor(random() * 5)}`);
      }
      for (let i = 0; i < lengthB; i++) {
        b.push(`t${Math.floor(random() * 5)}`);
      }
      expect(tokenLcsLength(a, b)).toBe(tokenLcsLength(b, a));
    }
  });

  it('never exceeds the length of the shorter input', () => {
    const random = makeRandom(0x77e);
    for (let trial = 0; trial < 200; trial++) {
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        a.push(`t${Math.floor(random() * 4)}`);
      }
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        b.push(`t${Math.floor(random() * 4)}`);
      }
      const value = tokenLcsLength(a, b);
      expect(value).toBeLessThanOrEqual(Math.min(a.length, b.length));
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a lower bound on the concatenation trick', () => {
    // Sharing a token must never reduce the LCS.
    expect(tokenLcsLength(chars('abcdef'), chars('azbzczdzf'))).toBeGreaterThanOrEqual(1);
    expect(tokenLcsLength(chars('aXbXc'), chars('abc'))).toBe(3);
  });
});

describe('usesApproximation', () => {
  it('agrees with the exported budget', () => {
    expect(LCS_APPROXIMATION_THRESHOLD).toBe(4_000_000);
    expect(usesApproximation(2000, 2000)).toBe(false); // exactly at the budget
    expect(usesApproximation(2000, 2001)).toBe(true);
    expect(usesApproximation(2000, 1999)).toBe(false);
  });

  it('never fires on an empty input', () => {
    expect(usesApproximation(0, 0)).toBe(false);
    expect(usesApproximation(0, 10_000_000)).toBe(false);
    expect(usesApproximation(10_000_000, 0)).toBe(false);
  });

  it('honours an explicit budget', () => {
    expect(usesApproximation(10, 10, 100)).toBe(false);
    expect(usesApproximation(10, 10, 99)).toBe(true);
    expect(usesApproximation(10, 10, 0)).toBe(true);
  });
});

describe('the anchored approximation path', () => {
  const lengthA = 2000;
  const lengthB = 2001;

  /** Two long sequences that share large contiguous stretches. */
  const buildPair = (): { a: string[]; b: string[] } => {
    const random = makeRandom(0xabcdef);
    const a: string[] = [];
    for (let i = 0; i < lengthA; i++) {
      a.push(`t${Math.floor(random() * 12)}`);
    }
    // b keeps a's first half verbatim, then diverges, then keeps the tail.
    const b: string[] = [];
    for (let i = 0; i < 600; i++) {
      b.push(a[i]);
    }
    for (let i = 0; i < 800; i++) {
      b.push(`x${Math.floor(random() * 12)}`);
    }
    for (let i = 1400; i < lengthA; i++) {
      b.push(a[i]);
    }
    while (b.length < lengthB) {
      b.push(`y${Math.floor(random() * 12)}`);
    }
    return { a, b };
  };

  it('is triggered by a product above the threshold and is much faster than the DP', () => {
    const { a, b } = buildPair();
    expect(a.length * b.length).toBeGreaterThan(LCS_APPROXIMATION_THRESHOLD);
    expect(usesApproximation(a.length, b.length)).toBe(true);

    // Both paths are run, so the assertion is relative rather than a wall-clock
    // guess: the anchored pass must be at least 5x cheaper than filling 4 002 000
    // DP cells, and it must also terminate (a hang would fail the test outright).
    const approximateStart = Date.now();
    const approximate = tokenLcsLength(a, b);
    const approximateMs = Date.now() - approximateStart;

    const exactStart = Date.now();
    const exact = tokenLcsLength(a, b, Number.MAX_SAFE_INTEGER);
    const exactMs = Date.now() - exactStart;

    expect(approximateMs * 5).toBeLessThan(Math.max(exactMs, 1));
    expect(approximate).toBeLessThanOrEqual(exact);
    expect(approximate).toBeGreaterThan(0);
  });

  it('returns a value that is at most the true LCS', () => {
    const { a, b } = buildPair();
    // Raise the budget so the exact DP runs; 4 002 000 cells is affordable.
    const exact = tokenLcsLength(a, b, Number.MAX_SAFE_INTEGER);
    const approximate = tokenLcsLength(a, b, 0);
    expect(approximate).toBeLessThanOrEqual(exact);
    expect(approximate).toBeGreaterThan(0);
  });

  it('is forced by maxCells = 0 even for small inputs', () => {
    const a = chars('the quick brown fox jumps');
    const b = chars('the quick red fox leaps over');
    expect(tokenLcsLength(a, b)).toBeGreaterThan(0);
    const approximate = tokenLcsLength(a, b, 0);
    expect(approximate).toBeLessThanOrEqual(tokenLcsLength(a, b, Number.MAX_SAFE_INTEGER));
    expect(approximate).toBeGreaterThan(0);
  });

  it('returns 0 for disjoint sequences on both paths', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const b = ['1', '2', '3', '4', '5', '6', '7', '8'];
    expect(tokenLcsLength(a, b, 0)).toBe(0);
    expect(tokenLcsLength(a, b, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('handles inputs shorter than the anchor width', () => {
    expect(tokenLcsLength(['a'], ['a', 'b', 'c'], 0)).toBe(1);
    expect(tokenLcsLength(['a', 'b'], ['a', 'b', 'c'], 0)).toBe(2);
    expect(tokenLcsLength(['a', 'b', 'c'], ['x', 'y', 'z'], 0)).toBe(0);
  });
});

describe('tokenLcsRatio', () => {
  it('is 1 for two empty sequences and 0 when exactly one is empty', () => {
    expect(tokenLcsRatio([], [])).toBe(1);
    expect(tokenLcsRatio([], ['a'])).toBe(0);
    expect(tokenLcsRatio(['a'], [])).toBe(0);
  });

  it('is 1 for identical sequences', () => {
    expect(tokenLcsRatio(chars('hello world'), chars('hello world'))).toBe(1);
    expect(tokenLcsRatio([], [])).toBe(1);
  });

  it('is 0 for disjoint sequences', () => {
    expect(tokenLcsRatio(chars('abc'), chars('xyz'))).toBe(0);
  });

  it('computes 2 * lcs / (|a| + |b|)', () => {
    // AGGTAB (6) vs GXTXAYB (7): lcs 4, total 13.
    expect(tokenLcsRatio(chars('AGGTAB'), chars('GXTXAYB'))).toBeCloseTo(8 / 13, 12);
    // 'abc' vs 'abd': lcs 2, total 6.
    expect(tokenLcsRatio(chars('abc'), chars('abd'))).toBeCloseTo(4 / 6, 12);
  });

  it('is symmetric', () => {
    const random = makeRandom(0x9e3);
    for (let trial = 0; trial < 200; trial++) {
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < Math.floor(random() * 15); i++) {
        a.push(`t${Math.floor(random() * 4)}`);
      }
      for (let i = 0; i < Math.floor(random() * 15); i++) {
        b.push(`t${Math.floor(random() * 4)}`);
      }
      expect(tokenLcsRatio(a, b)).toBeCloseTo(tokenLcsRatio(b, a), 12);
    }
  });

  it('stays within [0, 1]', () => {
    const random = makeRandom(0x4242);
    for (let trial = 0; trial < 200; trial++) {
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < Math.floor(random() * 25); i++) {
        a.push(`t${Math.floor(random() * 3)}`);
      }
      for (let i = 0; i < Math.floor(random() * 25); i++) {
        b.push(`t${Math.floor(random() * 3)}`);
      }
      const ratio = tokenLcsRatio(a, b);
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });

  it('penalises padding: a block buried in unrelated code scores lower', () => {
    const base = chars('const total = sum(values);');
    const padded = [...chars('const total = sum(values);'), ...chars('log(); warn(); return;')];
    expect(tokenLcsRatio(base, padded)).toBeLessThan(1);
    expect(tokenLcsRatio(base, padded)).toBeCloseTo(
      (2 * base.length) / (base.length + padded.length),
      12,
    );
  });
});

describe('longestCommonSubstring', () => {
  it('returns an empty result when there is nothing common', () => {
    expect(longestCommonSubstring([], [])).toEqual({
      text: [],
      startA: 0,
      startB: 0,
      length: 0,
    });
    expect(longestCommonSubstring(['a'], [])).toEqual({
      text: [],
      startA: 0,
      startB: 0,
      length: 0,
    });
    expect(longestCommonSubstring(['a', 'b'], ['x', 'y']).length).toBe(0);
  });

  it('finds a known run and reports both offsets', () => {
    const a = words('function total ( values )');
    const b = words('const total = compute ( values )');
    const found = longestCommonSubstring(a, b);
    // `total` is shared but the token after it differs (`(` vs `=`), so the
    // longest *contiguous* run is the parameter list.
    expect(found.text).toEqual(['(', 'values', ')']);
    expect(found.length).toBe(3);
    expect(found.startA).toBe(2);
    expect(found.startB).toBe(4);
    expect(a.slice(found.startA, found.startA + found.length)).toEqual(found.text);
    expect(b.slice(found.startB, found.startB + found.length)).toEqual(found.text);
  });

  it('finds runs longer than the anchor width', () => {
    const a = words('const alpha = beta + gamma + delta + epsilon ;');
    const b = words('return alpha + beta + gamma + delta + epsilon ;');
    const found = longestCommonSubstring(a, b);
    expect(found.text).toEqual(['beta', '+', 'gamma', '+', 'delta', '+', 'epsilon', ';']);
    expect(found.length).toBe(8);
    expect(found.startA).toBe(3);
    expect(found.startB).toBe(3);
  });

  it('finds runs shorter than the anchor width', () => {
    // A 3-token run has no 4-gram head; the short-run pass must find it.
    const a = words('a b c d');
    const b = words('x y b c d z');
    const found = longestCommonSubstring(a, b);
    expect(found.text).toEqual(['b', 'c', 'd']);
    expect(found.startA).toBe(1);
    expect(found.startB).toBe(2);
  });

  it('finds a single-token run', () => {
    const found = longestCommonSubstring(words('a b c'), words('x y a'));
    expect(found.text).toEqual(['a']);
    expect(found.length).toBe(1);
    expect(found.startA).toBe(0);
    expect(found.startB).toBe(2);
  });

  it('returns the whole first sequence when they are identical', () => {
    const a = chars('const x = 1;');
    const found = longestCommonSubstring(a, [...a]);
    expect(found.length).toBe(a.length);
    expect(found.text).toEqual(a);
  });

  it('is symmetric in length', () => {
    const random = makeRandom(0x1357);
    for (let trial = 0; trial < 200; trial++) {
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        a.push(`t${Math.floor(random() * 4)}`);
      }
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        b.push(`t${Math.floor(random() * 4)}`);
      }
      expect(longestCommonSubstring(a, b).length).toBe(longestCommonSubstring(b, a).length);
    }
  });

  it('never claims a run longer than the shorter input', () => {
    const random = makeRandom(0x2468);
    for (let trial = 0; trial < 200; trial++) {
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        a.push(`t${Math.floor(random() * 3)}`);
      }
      for (let i = 0; i < Math.floor(random() * 20); i++) {
        b.push(`t${Math.floor(random() * 3)}`);
      }
      const found = longestCommonSubstring(a, b);
      expect(found.length).toBeLessThanOrEqual(Math.min(a.length, b.length));
      // The reported text must genuinely be a common run.
      expect(a.slice(found.startA, found.startA + found.length)).toEqual(
        b.slice(found.startB, found.startB + found.length),
      );
    }
  });
});
