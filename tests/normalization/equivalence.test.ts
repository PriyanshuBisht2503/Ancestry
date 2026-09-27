/**
 * Phase 4 checkpoint: what normalisation must *forget* and what it must keep.
 *
 * This file is the contract test for the whole module. Everything else in
 * `tests/normalization` checks how a piece works; this checks which equivalences
 * hold, which is the property the product is sold on ("renamed variables produce
 * the same or highly similar normalized representation").
 *
 * Read the two lists at the top of each describe block as a single statement:
 * a rename or a reformat is invisible, and a behaviour change is not.
 */

import { describe, expect, it } from 'vitest';
import { normalize, lcsRatio, overlapRatio, jaccard, valuesOf } from './support';

describe('invariance: what must hash the same', () => {
  it('treats a renamed function with renamed parameters as the same block', () => {
    const before = normalize('function add(a, b) { return a + b; }');
    const after = normalize('function sum(x, y) { return x + y; }');

    expect(after.normalizedText).toBe(before.normalizedText);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.tokenCount).toBe(before.tokenCount);
  });

  it('ignores indentation, line breaks and brace placement', () => {
    const compact = normalize('function f(a){if(a){return 1}return 2}');
    const spread = normalize(
      ['function f(a) {', '    if (a) {', '        return 1;', '    }', '    return 2;', '}'].join(
        '\n',
      ),
    );

    expect(spread.tokenHash).toBe(compact.tokenHash);
  });

  it('ignores trailing commas and semicolons', () => {
    const plain = normalize('function f(a, b) { const c = [1, 2]; return { a, b, c }; }');
    const decorated = normalize('function f(a, b,) { const c = [1, 2,]; return { a, b, c, }; }');

    expect(decorated.tokenHash).toBe(plain.tokenHash);
  });

  it('ignores added, removed and reordered comments', () => {
    const bare = normalize('function f(a) { return a + 1; }');
    const noisy = normalize(
      [
        '/* leading block comment */',
        'function f(a) {',
        '  // a line comment',
        '  return a + 1; /* trailing */',
        '}',
        '/**',
        ' * and a JSDoc block',
        ' * @param a thing',
        ' */',
      ].join('\n'),
    );

    expect(noisy.tokenHash).toBe(bare.tokenHash);
  });

  it('treats a function moved to another file, under another name, as the same block', () => {
    const original = normalize('function authenticate(token) { return token; }', {
      // default: preserveDeclarationName is false
    });
    const moved = normalize('function verifyCredential(credential) { return credential; }');

    expect(moved.tokenHash).toBe(original.tokenHash);
  });

  it('collapses const, let and var to one declaration keyword', () => {
    const asConst = normalize('function f() { const total = 1 + 2; return total; }');
    const asLet = normalize('function f() { let total = 1 + 2; return total; }');
    const asVar = normalize('function f() { var total = 1 + 2; return total; }');

    expect(asLet.tokenHash).toBe(asConst.tokenHash);
    expect(asVar.tokenHash).toBe(asConst.tokenHash);
  });

  it('ignores the radix and digit separators of a numeric literal', () => {
    const plain = normalize('function f() { return 1000; }');
    const separated = normalize('function f() { return 1_000; }');
    const hex = normalize('function f() { return 0x3e8; }');
    const octal = normalize('function f() { return 0o1750; }');
    const binary = normalize('function f() { return 0b1111101000; }');

    expect(separated.tokenHash).toBe(plain.tokenHash);
    expect(hex.tokenHash).toBe(plain.tokenHash);
    expect(octal.tokenHash).toBe(plain.tokenHash);
    expect(binary.tokenHash).toBe(plain.tokenHash);
  });

  it('ignores parenthesisation, assertions and non-null wrappers', () => {
    const plain = normalize('function f(a) { return a + 1; }');
    const wrapped = normalize('function f(a) { return (((a as unknown as number)!) + 1); }');

    expect(wrapped.tokenHash).toBe(plain.tokenHash);
  });
});

describe('sensitivity: what must hash differently', () => {
  it('distinguishes == from ===', () => {
    const loose = normalize('function f(a, b) { return a == b; }');
    const strict = normalize('function f(a, b) { return a === b; }');

    expect(strict.tokenHash).not.toBe(loose.tokenHash);
  });

  it('distinguishes an if/else chain from a ternary', () => {
    const branch = normalize('function f(a) { if (a) { return 1; } else { return 2; } }');
    const ternary = normalize('function f(a) { return a ? 1 : 2; }');

    expect(ternary.tokenHash).not.toBe(branch.tokenHash);
  });

  it('distinguishes + from -', () => {
    const plus = normalize('function f(a, b) { return a + b; }');
    const minus = normalize('function f(a, b) { return a - b; }');

    expect(minus.tokenHash).not.toBe(plus.tokenHash);
  });

  it('distinguishes for from while', () => {
    const forLoop = normalize('function f(xs) { for (const x of xs) { g(x); } }');
    const whileLoop = normalize('function f(xs) { while (xs.length) { g(xs); } }');

    expect(whileLoop.tokenHash).not.toBe(forLoop.tokenHash);
  });

  it('preserves property names: obj.foo and obj.bar differ', () => {
    const foo = normalize('function f(obj) { return obj.foo; }');
    const bar = normalize('function f(obj) { return obj.bar; }');

    expect(bar.tokenHash).not.toBe(foo.tokenHash);
  });

  it('preserves type names: User and Account differ', () => {
    const user = normalize('function f(x: User) { return x.id; }');
    const account = normalize('function f(x: Account) { return x.id; }');

    expect(account.tokenHash).not.toBe(user.tokenHash);
  });

  it('preserves globals: console.log and window.console.log differ', () => {
    const direct = normalize('function f(a) { console.log(a); }');
    const viaWindow = normalize('function f(a) { window.console.log(a); }');

    expect(viaWindow.tokenHash).not.toBe(direct.tokenHash);
  });

  it('preserves literal values', () => {
    expect(normalize('function f() { return 1; }').tokenHash).not.toBe(
      normalize('function f() { return 2; }').tokenHash,
    );
    expect(normalize('function f() { return 1000; }').tokenHash).not.toBe(
      normalize('function f() { return 1001; }').tokenHash,
    );
    expect(normalize('function f() { return 0.5; }').tokenHash).not.toBe(
      normalize('function f() { return 0.6; }').tokenHash,
    );
  });
});

describe('gradual change stays similar', () => {
  /** Big enough that one added statement is a small relative change. */
  const base = [
    'function calculate(input, factor) {',
    '  const scaled = input * factor;',
    '  const offset = scaled + 10;',
    '  const result = offset - 2;',
    '  return result;',
    '}',
  ].join('\n');

  it('is not identical but overwhelmingly overlapping after one added statement', () => {
    const original = valuesOf(normalize(base));
    const extended = valuesOf(normalize(`${base.slice(0, -1)}  scaled;\n}`));

    expect(extended).not.toEqual(original);
    const overlap = overlapRatio(original, extended);
    expect(overlap).toBeGreaterThanOrEqual(0.9);
    expect(jaccard(original, extended)).toBeGreaterThan(0.85);
  });

  it('scores two genuinely different functions as barely related', () => {
    const arithmetic = valuesOf(normalize('function add(a, b) { const c = a + b; return c * 2; }'));
    const stringWork = valuesOf(
      normalize(
        'function join(parts, sep) { let out = ""; for (const p of parts) { out = out + sep + p; } return out; }',
      ),
    );

    expect(overlapRatio(arithmetic, stringWork)).toBeLessThan(0.7);
    expect(lcsRatio(arithmetic, stringWork)).toBeLessThan(0.7);
  });

  it('scores an arrow function and a function declaration as close but not equal', () => {
    const declaration = valuesOf(normalize('function total(a, b) { return a + b; }'));
    const arrow = valuesOf(normalize('const total = (a, b) => { return a + b; };'));

    expect(arrow).not.toEqual(declaration);
    // The bodies are identical; only the declaration wrapper differs.
    expect(Math.abs(arrow.length - declaration.length)).toBeLessThan(10);
    expect(lcsRatio(declaration, arrow)).toBeGreaterThan(0.7);
  });
});
