/**
 * Literal normalisation.
 *
 * The interesting assertions here are the *boundaries*: what survives, what is
 * rounded, and what is thrown away entirely. A test that only checked
 * `lit:num:31` for `0x1F` would not notice that `12345678901234567890` had been
 * silently rounded.
 */

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  classifyStringContent,
  normalizeBigIntLiteral,
  normalizeNumericLiteral,
  normalizeStringLiteral,
  normalizeTemplateLiteral,
} from '../../src/normalization/literals';
import { parse, tokensOf } from './support';

/** First literal of the requested kind inside `text`. */
function firstLiteral<T extends ts.Node>(text: string, predicate: (node: ts.Node) => node is T): T {
  const sf = parse(text);
  let found: T | null = null;
  const visit = (node: ts.Node): void => {
    if (found === null && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === null) {
    throw new Error(`no matching literal in ${text}`);
  }
  return found;
}

const numeric = (text: string): string =>
  normalizeNumericLiteral(firstLiteral(text, ts.isNumericLiteral));
const string = (text: string): string =>
  normalizeStringLiteral(firstLiteral(text, ts.isStringLiteral));
const template = (text: string): string =>
  normalizeTemplateLiteral(
    firstLiteral(text, ts.isTemplateExpression as (n: ts.Node) => n is ts.TemplateExpression),
  );
const bigint = (text: string): string =>
  normalizeBigIntLiteral(firstLiteral(text, ts.isBigIntLiteral));

describe('numeric literals', () => {
  it('converts hex, binary, octal and legacy octal to decimal', () => {
    expect(numeric('0x1F;')).toBe('lit:num:31');
    expect(numeric('0XFF;')).toBe('lit:num:255');
    expect(numeric('0b1010;')).toBe('lit:num:10');
    expect(numeric('0o17;')).toBe('lit:num:15');
    expect(numeric('0777;')).toBe('lit:num:511');
  });

  it('strips digit separators', () => {
    expect(numeric('1_000;')).toBe('lit:num:1000');
    expect(numeric('1_000_000;')).toBe('lit:num:1000000');
    expect(numeric('0xFF_FF;')).toBe('lit:num:65535');
  });

  it('keeps integers exact, even beyond Number.MAX_SAFE_INTEGER', () => {
    expect(numeric('12345678901234567890;')).toBe('lit:num:12345678901234567890');
    expect(numeric('9007199254740993;')).toBe('lit:num:9007199254740993');
  });

  it('rounds floats to six decimal places', () => {
    expect(numeric('1.23456789;')).toBe('lit:num:1.234568');
    expect(numeric('0.5;')).toBe('lit:num:0.5');
    expect(numeric('1e3;')).toBe('lit:num:1000');
    expect(numeric('0.5e3;')).toBe('lit:num:500');
    expect(numeric('1.5e-7;')).toBe('lit:num:0');
  });

  it('collapses negative zero', () => {
    const values = tokensOf('const a = 0; const b = -0;').map((token) => token.value);

    expect(values).toContain('lit:num:0');
    // `-0` keeps its unary minus as an operator, but the value is still zero.
    expect(values.filter((value) => value === 'lit:num:0')).toHaveLength(2);
    expect(values).toContain('s:MinusToken');
  });

  it('renders out-of-range values without host-specific formatting', () => {
    expect(numeric('1e400;')).toBe('lit:num:inf');
    expect(numeric('-1e400;')).toBe('lit:num:-inf');
  });

  it('agrees with itself for the same value written differently', () => {
    expect(numeric('0x3e8;')).toBe(numeric('1000;'));
    expect(numeric('1_0.50;')).toBe(numeric('10.5;'));
  });
});

describe('string literals', () => {
  it('never emits the contents', () => {
    const result = string('"super-secret-token";');

    expect(result).not.toContain('super');
    expect(result).not.toContain('secret');
    // `super-secret-token` is 18 characters and is kebab-case, so it is
    // shape-classified as `ident`. That is a description of its *shape*, not a
    // disclosure of its value — only the length and the class ever reach the
    // token stream.
    expect(result).toBe('lit:str:18:ident');
  });

  it('falls back to `other` for anything that is not name-shaped', () => {
    expect(string('"SELECT * FROM users";')).toBe('lit:str:19:other');
    expect(string('"hello there";')).toBe('lit:str:11:other');
  });

  it('reports the decoded length, not the source length', () => {
    expect(string('"";')).toBe('lit:str:0:empty');
    expect(string('"abc";')).toBe('lit:str:3:ident');
    expect(string('"a\\nb";')).toBe('lit:str:3:other');
    expect(string('"\\u00e9";')).toBe('lit:str:1:ident');
  });

  it('classifies identifier-like, url-like and path-like contents', () => {
    expect(classifyStringContent('')).toBe('empty');
    expect(classifyStringContent('json')).toBe('ident');
    expect(classifyStringContent('a.b.c')).toBe('ident');
    expect(classifyStringContent('utf-8')).toBe('ident');
    expect(classifyStringContent('https://example.com/a')).toBe('url');
    expect(classifyStringContent('file:///tmp/x')).toBe('url');
    expect(classifyStringContent('www.example.com')).toBe('url');
    expect(classifyStringContent('./a/b')).toBe('path');
    expect(classifyStringContent('C:\\tmp\\a')).toBe('path');
    expect(classifyStringContent('hello there')).toBe('other');
    expect(classifyStringContent('SELECT * FROM t')).toBe('other');
    expect(classifyStringContent('x'.repeat(1000))).toBe('other');
  });
});

describe('template literals', () => {
  it('keeps the hole count and drops the quasi text', () => {
    const result = template('`a${1 + x}b${y}c`;');

    expect(result).toBe('lit:tmpl:2');
    expect(result).not.toContain('a');
  });

  it('emits the interpolated expressions as normal tokens', () => {
    const values = tokensOf('const out = `total: ${first + second}!`;').map((token) => token.value);

    expect(values).toContain('lit:tmpl:1');
    expect(values).toContain('s:PlusToken');
    // `out` is the only name declared inside the block, so `first` and `second`
    // are *free* identifiers and are deliberately preserved rather than
    // canonicalised — rewriting which external function a block calls would
    // change its behaviour.
    expect(values).toContain('ext:first');
    expect(values).toContain('ext:second');
    // The quasi chunks never appear.
    expect(values.join(' ')).not.toContain('total');
  });

  it('treats a template with no holes as zero holes', () => {
    const values = tokensOf('const out = `plain text`;').map((token) => token.value);

    expect(values).toContain('lit:tmpl:0');
    expect(values).not.toContain('plain');
  });
});

describe('bigint literals', () => {
  it('collapses every BigInt to a single token', () => {
    expect(bigint('9007199254740993n;')).toBe('lit:bigint');
    expect(bigint('1n;')).toBe('lit:bigint');
  });
});

describe('regex literals', () => {
  it('keeps the kind and the flags but never the pattern', () => {
    const values = tokensOf('const re = /ab+c/gi;').map((token) => token.value);
    const joined = values.join(' ');

    expect(joined).toContain('lit:regex:gi');
    expect(joined).not.toContain('ab+c');
  });

  it('distinguishes flag sets', () => {
    const flags = (text: string): string | undefined =>
      tokensOf(text)
        .map((token) => token.value)
        .find((value) => value.startsWith('lit:regex'));

    expect(flags('const re = /x/;')).toBe('lit:regex');
    expect(flags('const re = /x/g;')).toBe('lit:regex:g');
    expect(flags('const re = /x/gi;')).toBe('lit:regex:gi');
    expect(flags('const re = /x/gi;')).not.toBe(flags('const re = /y/g;'));
  });
});
