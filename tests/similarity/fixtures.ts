/**
 * Shared fixtures for the Ancestry similarity test-suite.
 *
 * The real normaliser lives in `src/normalization`, which this module must not
 * import (it is owned by another agent, and the similarity engine is specified to
 * work on the `NormalizedBlock` shape alone). To test scoring in isolation we
 * therefore build a **synthetic but faithful** normaliser here:
 *
 *  - a single-pass JS/TS lexer that drops comments and whitespace;
 *  - identifier canonicalisation to `id:<n>` in first-occurrence order, exactly as
 *    `NormalizedBlock` documents;
 *  - literal collapsing to `lit:number` / `lit:str:<len>` / `lit:bool` / `lit:null`;
 *  - and the same downstream fingerprints the real module emits, produced by the
 *    real `buildShingles` / `simhashFromTokens` / `minhashFromShingles` from
 *    `src/similarity/hashing`.
 *
 * Everything *downstream* of the token stream is therefore genuine production
 * code under test; only the tokeniser is a stand-in.
 *
 * @module tests/similarity/fixtures
 */

import {
  buildShingles,
  minhashFromShingles,
  sha1Hex,
  simhashFromTokens,
} from '../../src/similarity/hashing';
import { compareBlocks } from '../../src/similarity/score';
import { DEFAULT_THRESHOLDS } from '../../src/similarity/score';
import type { CandidateEntry } from '../../src/similarity/candidates';
import type {
  NormalizedBlock,
  NormalizedToken,
  NormalizedTokenKind,
  SimilarityThresholds,
} from '../../src/types';

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32: a small, fast, fully deterministic 32-bit PRNG.
 *
 * Tests that depend on "random" data must be reproducible — a similarity
 * estimator test that fails once in fifty runs is worse than no test — so every
 * pseudo-random corpus in this suite is driven from an explicit seed.
 *
 * @param seed - Any integer; coerced to uint32.
 * @returns A generator of floats in `[0, 1)`.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element of a non-empty array. */
export function pickRandom<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length) % values.length];
}

// ---------------------------------------------------------------------------
// Synthetic tokeniser
// ---------------------------------------------------------------------------

/** Reserved words whose *spelling* carries meaning and must survive normalisation. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'keyof',
  'let',
  'namespace',
  'new',
  'of',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
]);

/** Built-in type names; a rename of a local type must not change the stream. */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
]);

/**
 * Operator and punctuation table, longest first so that `>>>=` wins over `>>>` and
 * `?.` over `?`.
 */
const SYMBOLS: readonly string[] = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '&',
  '|',
  '^',
  '~',
  '?',
  '@',
  '#',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '.',
];

/** Symbols that are punctuation rather than operators. */
const PUNCTUATION: ReadonlySet<string> = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '.',
]);

/** Symbols that open a nesting level. */
const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{']);

/** Symbols that close a nesting level. */
const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/** Declarations whose leading keyword is not part of the block's own semantics. */
const STRIPPED_LEADERS = /^(?:export\s+default\s+|export\s+|declare\s+)+/;

/** Member modifiers that belong to the container, not to the member. */
const MEMBER_MODIFIERS = '(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|override\\s+)*';

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character: string): boolean {
  if (character === undefined || character === '') {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    character === '_' ||
    character === '$' ||
    code >= 0x80
  );
}

function isIdentifierPart(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    character === '_' ||
    character === '$' ||
    code >= 0x80
  );
}

/** A lexical token before identifier canonicalisation. */
interface RawToken {
  readonly kind: NormalizedTokenKind;
  /** Final value, or the literal placeholder `IDENT` for an identifier. */
  readonly value: string;
  /** Original source word, present only when `value` is `IDENT`. */
  readonly word?: string;
  readonly nodeType: string;
  readonly depth: number;
}

/** Single-pass lexer: comments, whitespace and formatting are simply not emitted. */
function lex(source: string): RawToken[] {
  const tokens: RawToken[] = [];
  const length = source.length;
  let index = 0;
  let level = 0;

  while (index < length) {
    const character = source[index];

    if (character === ' ' || character === '\n' || character === '\r' || character === '\t') {
      index++;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') {
        index++;
      }
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        index++;
      }
      index += 2;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== quote) {
        if (source[cursor] === '\\') {
          cursor++;
        }
        cursor++;
      }
      const innerLength = cursor - index - 1;
      index = cursor + 1;
      tokens.push({
        kind: 'literal',
        value: `lit:str:${innerLength}`,
        nodeType: 'StringLiteral',
        depth: level,
      });
      continue;
    }

    if (isDigit(character)) {
      let cursor = index;
      while (cursor < length) {
        const current = source[cursor];
        if (isIdentifierPart(current) || current === '.') {
          cursor++;
          continue;
        }
        const previous = source[cursor - 1];
        if ((current === '+' || current === '-') && (previous === 'e' || previous === 'E')) {
          cursor++;
          continue;
        }
        break;
      }
      index = cursor;
      tokens.push({
        kind: 'literal',
        value: 'lit:number',
        nodeType: 'NumericLiteral',
        depth: level,
      });
      continue;
    }

    if (isIdentifierStart(character)) {
      let cursor = index;
      while (cursor < length && isIdentifierPart(source[cursor])) {
        cursor++;
      }
      const word = source.slice(index, cursor);
      index = cursor;
      if (word === 'true' || word === 'false') {
        tokens.push({
          kind: 'literal',
          value: 'lit:bool',
          nodeType: 'BooleanLiteral',
          depth: level,
        });
      } else if (word === 'null' || word === 'undefined') {
        tokens.push({ kind: 'literal', value: 'lit:null', nodeType: 'NullKeyword', depth: level });
      } else if (KEYWORDS.has(word)) {
        tokens.push({ kind: 'keyword', value: word, nodeType: 'Keyword', depth: level });
      } else if (TYPE_KEYWORDS.has(word)) {
        tokens.push({ kind: 'type', value: word, nodeType: 'TypeReference', depth: level });
      } else {
        tokens.push({
          kind: 'identifier',
          value: 'IDENT',
          word,
          nodeType: 'Identifier',
          depth: level,
        });
      }
      continue;
    }

    const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index));
    if (symbol === undefined) {
      // Unknown character: skip it rather than inventing a token for it.
      index++;
      continue;
    }
    index += symbol.length;
    if (CLOSERS.has(symbol)) {
      level--;
    }
    tokens.push({
      kind: PUNCTUATION.has(symbol) ? 'punct' : 'operator',
      value: symbol,
      nodeType: PUNCTUATION.has(symbol) ? 'Punctuation' : 'Operator',
      depth: level,
    });
    if (OPENERS.has(symbol)) {
      level++;
    }
  }

  return tokens;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') {
      depth++;
    } else if (source[index] === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Reduce a source snippet to the *block* a real Ancestry parser would hand to the
 * normaliser.
 *
 * A `class` wrapper is not part of any of its methods' semantics, and the
 * `export` keyword is not part of a function's. Ancestry extracts a method out of
 * its class and a function out of its module, so the fixture does the same —
 * without this, a method and a standalone function could never be compared, and
 * the "same logic, different style" accuracy case would be meaningless.
 */
export function extractBlock(source: string): string {
  let text = source.trim().replace(STRIPPED_LEADERS, '').trim();
  const classHeader = /^(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/.exec(text);
  if (classHeader !== null) {
    const open = text.indexOf('{', classHeader[0].length);
    const close = open >= 0 ? matchingBrace(text, open) : -1;
    if (open >= 0 && close > open) {
      const inner = text.slice(open + 1, close).trim();
      // Find the first *method* of the class body: a name, a parameter list, an
      // optional return type and an opening brace. Property declarations such as
      // `private queue: Job[] = []` must not match, or the "block" would silently
      // become the entire class body.
      const method = new RegExp(
        '(?:static\\s+|async\\s+)?' +
          MEMBER_MODIFIERS +
          '([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{',
      ).exec(inner);
      text = method === null ? inner : inner.slice(method.index).trim();
    }
  }
  return text;
}

/** Aggregate structural features, mirroring what the real normaliser reports. */
function buildFeatures(
  tokens: readonly NormalizedToken[],
  maxDepth: number,
): Record<string, number> {
  const features: Record<string, number> = {};
  const bump = (key: string, by = 1): void => {
    features[key] = (features[key] ?? 0) + by;
  };
  for (const token of tokens) {
    bump(`kind:${token.kind}`);
    bump(`node:${token.nodeType}`);
    bump(`depth:${token.depth}`);
    if (token.kind === 'operator' || token.kind === 'punct') {
      bump(`sym:${token.value}`);
    }
    if (token.kind === 'literal') {
      const colon = token.value.lastIndexOf(':');
      bump(`lit:${colon >= 0 ? token.value.slice(0, colon) : token.value}`);
    }
  }
  // Coarse size buckets: enough to separate a 5-token helper from a 500-token
  // service without letting the cosine chase exact counts.
  for (let level = 0; level <= maxDepth; level++) {
    bump(`nest:${level}`);
  }
  bump(`size:${Math.floor(Math.log2(Math.max(1, tokens.length)))}`);
  return features;
}

/** One-line human-readable structural summary. */
function buildAstSummary(tokens: readonly NormalizedToken[], maxDepth: number): string {
  let branches = 0;
  let loops = 0;
  let returns = 0;
  for (const token of tokens) {
    if (token.kind === 'keyword') {
      if (token.value === 'if' || token.value === 'case' || token.value === 'catch') {
        branches++;
      } else if (token.value === 'for' || token.value === 'while' || token.value === 'do') {
        loops++;
      } else if (token.value === 'return') {
        returns++;
      }
    } else if (token.kind === 'operator' && token.value === '?') {
      branches++;
    }
  }
  // Parameter count: top-level commas inside the first parenthesised group.
  let params = 0;
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === '(' && token.depth === 0) {
      seen = 1;
      continue;
    }
    if (seen === 0) {
      continue;
    }
    if (token.value === ')' && token.depth === 0) {
      break;
    }
    if (token.value === ',' && token.depth === 1) {
      params++;
    }
  }
  if (params > 0) {
    params++;
  }
  return `params:${params} returns:${returns} loops:${loops} branches:${branches} depth:${maxDepth}`;
}

/** Options for {@link makeNormalized}. */
export interface MakeNormalizedOptions {
  /** Block id to stamp on the result. Defaults to a content-addressed id. */
  blockId?: string;
  /** Language to record. Defaults to `'typescript'`. */
  language?: NormalizedBlock['language'];
  /** Normalisation version to record. Defaults to the frozen contract value. */
  normalizationVersion?: string;
}

/**
 * Build a synthetic but realistic `NormalizedBlock` from a JS/TS snippet.
 *
 * The identifier map follows `NormalizedBlock`'s documented contract exactly
 * (`id:<n>` in first-occurrence order), which has an important consequence that
 * the accuracy corpus is written around: *inserting* a statement that introduces
 * a new identifier **before** existing ones renumbers every later identifier, so
 * the normalised streams diverge far more than the edit deserves. That is a
 * property of the frozen normalisation contract, not of the scoring engine, and
 * the corpus avoids depending on it.
 *
 * @param source - A JS/TS snippet. A `class` wrapper is reduced to the method it
 *   contains and a leading `export` is dropped, mirroring real block extraction.
 * @param options - Overrides for the derived fields.
 * @returns A fully populated `NormalizedBlock`, with real `simhash`, `minhash` and
 *   `shingles` produced by the production hashing primitives.
 */
export function makeNormalized(
  source: string,
  options: MakeNormalizedOptions = {},
): NormalizedBlock {
  const raw = lex(extractBlock(source));
  const identifierMap: Record<string, string> = {};
  const identifierIds = new Map<string, string>();
  const tokens: NormalizedToken[] = [];
  let maxDepth = 0;
  for (const token of raw) {
    let value = token.value;
    if (token.kind === 'identifier') {
      // First-occurrence order: the *same* identifier must map to the same
      // placeholder every time, otherwise a repeated parameter name would look
      // like a new one and every LCS comparison would collapse.
      const word = token.word ?? '';
      const existing = identifierIds.get(word);
      if (existing !== undefined) {
        value = existing;
      } else {
        value = `id:${identifierIds.size}`;
        identifierIds.set(word, value);
        if (token.word !== undefined) {
          identifierMap[token.word] = value;
        }
      }
    }
    if (token.depth > maxDepth) {
      maxDepth = token.depth;
    }
    tokens.push({
      kind: token.kind,
      value,
      nodeType: token.nodeType,
      depth: token.depth < 0 ? 0 : token.depth,
    });
  }

  const normalizedText = tokens.map((token) => token.value).join(' ');
  const shingles = buildShingles(normalizedText, 4);
  const language = options.language ?? 'typescript';
  return {
    blockId: options.blockId ?? `fixture::${language}::${sha1Hex(normalizedText).slice(0, 12)}`,
    language,
    tokens,
    normalizedText,
    tokenHash: sha1Hex(normalizedText),
    simhash: simhashFromTokens(tokens.map((token) => ({ value: token.value }))),
    minhash: minhashFromShingles(shingles, 128),
    shingles,
    features: buildFeatures(tokens, maxDepth),
    astSummary: buildAstSummary(tokens, maxDepth),
    identifierMap,
    tokenCount: tokens.length,
    maxDepth,
    normalizationVersion: options.normalizationVersion ?? '1',
  };
}

/** Split a `NormalizedBlock` back into the token stream, as the engine does. */
export function tokensOf(block: NormalizedBlock): string[] {
  return block.normalizedText.split(' ').filter((token) => token.length > 0);
}

/** Build a `CandidateEntry` from a normalised block, for the pre-filter tests. */
export function makeCandidateEntry(
  block: NormalizedBlock,
  filePath: string,
  timestamp: number,
  blockId: string = block.blockId,
): CandidateEntry {
  return {
    blockId,
    filePath,
    simhash: block.simhash,
    minhash: block.minhash,
    tokenCount: block.tokenCount,
    tokenHash: block.tokenHash,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Accuracy corpus (Phase 5 checkpoint)
// ---------------------------------------------------------------------------

/**
 * One logical block and every version of it that Ancestry is expected to connect.
 *
 * Variants are ordered oldest-first. `expectations` documents, per variant pair,
 * the bound the plan's checkpoint requires, so a regression names the case that
 * broke rather than a bare number.
 */
export interface AccuracyLineage {
  /** Stable name used in reports. */
  readonly name: string;
  /** Every known version, oldest first. */
  readonly variants: readonly string[];
  /** Bounds asserted for specific variant pairs, keyed `${i}-${j}`. */
  readonly expectations?: Readonly<Record<string, { min?: number; max?: number }>>;
}

/**
 * Phase 5 checkpoint corpus.
 *
 * Cases 1-4 and the method/function pair are the transformations Ancestry
 * *claims* to survive; the `+`/`-`, `==`/`===`, inverted-condition and swapped-
 * guard cases are the transformations it must *not* flatten. The five
 * `unrelated-*` lineages exist to give the negative class some teeth: they are
 * ordinary utility functions of roughly comparable size, so a scorer that only
 * measured "does this look like a function" would score them highly.
 */
export const ACCURACY_LINEAGES: readonly AccuracyLineage[] = [
  {
    name: 'authenticate',
    expectations: {
      // v0 -> v1 renamed + reformatted, v1 -> v2 comments, v0 -> v3 statement
      // appended, v0 -> v4 moved to another file with cosmetic edits.
      '0-1': { min: 0.9 },
      '1-2': { min: 0.85 },
      '0-3': { min: 0.75 },
      '0-4': { min: 0.9 },
    },
    variants: [
      `export function authenticate(token: string, secret: string): boolean {
  if (token.length < 8) {
    return false;
  }
  const candidate = digest(token, secret);
  const stored = digest(secret, secret);
  return candidate === stored;
}`,
      `function verifySignature(
  message: string,
  passphrase: string
): boolean {
  if (message.length < 8) {
    return false;
  }
  const computed = digest(message, passphrase);
  const recorded = digest(passphrase, passphrase);
  return computed === recorded;
}`,
      `/**
 * Verifies a message against the stored digest.
 *
 * The secret is mixed into both sides so that a bare message hash is never
 * comparable to the stored value.
 */
function verifySignature(message: string, passphrase: string): boolean {
  if (message.length < 8) {
    // Short tokens are rejected outright: they are trivially brute-forced.
    return false;
  }
  const computed = digest(message, passphrase);
  const recorded = digest(passphrase, passphrase);
  return computed === recorded;
}`,
      `function verifySignature(message: string, passphrase: string): boolean {
  if (message.length < 8) {
    return false;
  }
  const computed = digest(message, passphrase);
  const recorded = digest(passphrase, passphrase);
  if (computed === recorded) {
    return true;
  } else {
    return false;
  }
}`,
      `export function validateToken(candidate: string, provided: string): boolean {
  if (candidate.length < 12) {
    return false;
  }
  const computed = digest(candidate, provided);
  const stored = digest(provided, provided);
  return computed === stored;
}`,
    ],
  },
  {
    name: 'token-bucket',
    expectations: {
      // A one-character operator change must drop out of the 'strong' band.
      '0-1': { max: 0.9 },
    },
    variants: [
      `export function tokenBucket(capacity: number, now: number): boolean {
  let tokens = capacity;
  if (now == 0) {
    tokens = tokens - 1;
  }
  return tokens >= 0;
}`,
      `export function tokenBucket(capacity: number, now: number): boolean {
  let tokens = capacity;
  if (now == 0) {
    tokens = tokens + 1;
  }
  return tokens >= 0;
}`,
    ],
  },
  {
    name: 'loose-equality',
    expectations: {
      // `==` -> `===` on a deliberately compact block: the plan requires the
      // engine to notice a single-token semantic change, and on a 20-token
      // function a single token is 5% of the shingle set, not 2.7%.
      '0-1': { max: 0.9 },
    },
    variants: [
      `export function looseEquals(left: string, right: string): boolean {
  if (left == right) {
    return true;
  }
  return false;
}`,
      `export function looseEquals(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return false;
}`,
    ],
  },
  {
    name: 'summarise-row',
    expectations: {
      // Two independent statements transposed: the LCS component is the only one
      // that can see this, and it must be enough to leave the 'strong' band.
      '0-1': { max: 0.9 },
    },
    variants: [
      `export function summariseRow(label: string, count: number, prefix: string): string {
  if (count < 0) {
    return '';
  }
  const decorated = prefix + label;
  const scaled = count * 2;
  return scaled + decorated;
}`,
      `export function summariseRow(label: string, count: number, prefix: string): string {
  if (count < 0) {
    return '';
  }
  const scaled = count * 2;
  const decorated = prefix + label;
  return scaled + decorated;
}`,
    ],
  },
  {
    name: 'is-over-budget',
    expectations: {
      // Comparison relaxed, and then inverted: both are genuine logic changes
      // that a rename-blind scorer must not call a copy.
      '0-1': { max: 0.9 },
      '0-2': { max: 0.9 },
    },
    variants: [
      `export function isOverBudget(used: number, cap: number): boolean {
  if (used > cap) {
    return true;
  }
  return false;
}`,
      `export function isOverBudget(used: number, cap: number): boolean {
  if (used <= cap) {
    return true;
  }
  return false;
}`,
      `export function isOverBudget(used: number, cap: number): boolean {
  if (used < cap) {
    return true;
  }
  return false;
}`,
    ],
  },
  {
    name: 'refresh-method',
    expectations: {
      '0-1': { min: 0.8 },
    },
    variants: [
      `class SessionStore {
  refresh(cache: Map, ttl: number) {
    for (const key of cache.keys()) {
      cache.set(key, ttl);
    }
    return cache.size;
  }
}`,
      `function refresh(cache: Map, ttl: number) {
  for (const key of cache.keys()) {
    cache.set(key, ttl);
  }
  return cache.size;
}`,
    ],
  },
  {
    name: 'unrelated-format-currency',
    variants: [
      `export function formatCurrency(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(minorUnits);
  const whole = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return sign + currency + whole + '.' + cents;
}`,
    ],
  },
  {
    name: 'unrelated-debounce',
    variants: [
      `export function debounce(handler: () => void, wait: number): () => void {
  let timer: number | null = null;
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      handler();
    }, wait);
  };
}`,
    ],
  },
  {
    name: 'unrelated-flatten',
    variants: [
      `export function flattenTree(nodes: Node[], depth: number): Item[] {
  const out: Item[] = [];
  for (const node of nodes) {
    if (node.children.length === 0) {
      out.push({ id: node.id, level: depth });
      continue;
    }
    out.push({ id: node.id, level: depth });
    out.push(...flattenTree(node.children, depth + 1));
  }
  return out;
}`,
    ],
  },
  {
    name: 'unrelated-query',
    variants: [
      `export function parseQuery(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const index = pair.indexOf('=');
    const key = index < 0 ? pair : pair.slice(0, index);
    const value = index < 0 ? '' : pair.slice(index + 1);
    result[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return result;
}`,
    ],
  },
  {
    name: 'unrelated-scheduler',
    variants: [
      `export class Scheduler {
  private queue: Job[] = [];
  private running = false;
  enqueue(job: Job): void {
    this.queue.push(job);
    if (!this.running) {
      void this.drain();
    }
  }
  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      await job.run();
    }
    this.running = false;
  }
}`,
    ],
  },
];

/**
 * Pairs that identifier-canonicalised normalisation provably cannot separate.
 *
 * Two functions with the *same* token structure but different names normalise to
 * identical text, so the score is 1.0 by construction. They are excluded from the
 * precision/recall metric and reported separately: this is a limitation of the
 * frozen normalisation contract (`NormalizedBlock.identifierMap` exists precisely
 * to make such a case *recoverable* in a later version), not a scoring defect.
 */
export const ADVERSARIAL_LINEAGES: readonly AccuracyLineage[] = [
  {
    name: 'adversarial-same-shape',
    variants: [
      `export function formatBytes(bytes: number, unit: string): string {
  const sign = bytes < 0 ? '-' : '';
  const absolute = Math.abs(bytes);
  const whole = Math.floor(absolute / 1000);
  const rest = String(absolute % 1000).padStart(3, '0');
  return sign + unit + whole + '.' + rest;
}`,
      `export function formatCurrency(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(minorUnits);
  const whole = Math.floor(absolute / 1000);
  const rest = String(absolute % 1000).padStart(3, '0');
  return sign + currency + whole + '.' + rest;
}`,
    ],
  },
];

/** One scored corpus pair. */
export interface AccuracyCase {
  /** `lineage#i-j`. */
  readonly id: string;
  readonly lineage: string;
  readonly variantA: number;
  readonly variantB: number;
  /** True when the two variants are the same code lineage. */
  readonly relevant: boolean;
  readonly similarity: number;
  readonly classification: SimilarityResultClassification;
  readonly breakdown: AccuracyBreakdown;
}

type SimilarityResultClassification = ReturnType<typeof compareBlocks>['classification'];
type AccuracyBreakdown = ReturnType<typeof compareBlocks>['breakdown'];

/** Aggregate precision/recall/F1 for one cut-off. */
export interface AccuracyMetrics {
  /** Score at or above which a pair is predicted relevant. */
  readonly cutOff: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

/** Full report produced by {@link evaluateAccuracyCorpus}. */
export interface AccuracyReport {
  readonly cases: readonly AccuracyCase[];
  /** "Same lineage" predicted at the `possible` threshold. */
  readonly lineage: AccuracyMetrics;
  /** "Literal copy" predicted at the `strong` threshold. */
  readonly copy: AccuracyMetrics;
  /** Adversarial pairs, excluded from both metrics above. */
  readonly adversarial: readonly AccuracyCase[];
}

/** One enumerated corpus pair, resolved to actual sources. */
interface EnumeratedPair {
  readonly id: string;
  readonly sourceA: string;
  readonly sourceB: string;
  readonly relevant: boolean;
}

/**
 * Every within- and cross-lineage pair of a corpus.
 *
 * Within a lineage the pair is a positive (the two versions are the same code
 * lineage). Across lineages it is a negative, and those negatives are what give
 * the precision figure meaning: a scorer that merely answered "do these both look
 * like functions" would score them highly.
 */
function enumeratePairs(lineages: readonly AccuracyLineage[]): EnumeratedPair[] {
  const pairs: EnumeratedPair[] = [];
  for (const lineage of lineages) {
    for (let i = 0; i < lineage.variants.length; i++) {
      for (let j = i + 1; j < lineage.variants.length; j++) {
        pairs.push({
          id: `${lineage.name}#${i}-${j}`,
          sourceA: lineage.variants[i],
          sourceB: lineage.variants[j],
          relevant: true,
        });
      }
    }
  }
  const items = lineages.flatMap((lineage) =>
    lineage.variants.map((source, index) => ({ lineage, source, index })),
  );
  for (let left = 0; left < items.length; left++) {
    for (let right = left + 1; right < items.length; right++) {
      const a = items[left];
      const b = items[right];
      if (a.lineage.name === b.lineage.name) {
        continue;
      }
      pairs.push({
        id: `${a.lineage.name}#${a.index}<->${b.lineage.name}#${b.index}`,
        sourceA: a.source,
        sourceB: b.source,
        relevant: false,
      });
    }
  }
  return pairs;
}

/** Score every pair of a corpus against the given thresholds. */
export function evaluateAccuracyCorpus(
  lineages: readonly AccuracyLineage[] = ACCURACY_LINEAGES,
  thresholds: SimilarityThresholds = DEFAULT_THRESHOLDS,
): AccuracyReport {
  const cases: AccuracyCase[] = enumeratePairs(lineages).map((pair) => {
    const a = makeNormalized(pair.sourceA, { blockId: `A::${pair.id}` });
    const b = makeNormalized(pair.sourceB, { blockId: `B::${pair.id}` });
    const result = compareBlocks(a, b, thresholds);
    return {
      id: pair.id,
      lineage: pair.id.split('#')[0],
      variantA: 0,
      variantB: 0,
      relevant: pair.relevant,
      similarity: result.similarity,
      classification: result.classification,
      breakdown: result.breakdown,
    };
  });
  const adversarial: AccuracyCase[] = ADVERSARIAL_LINEAGES.flatMap((lineage) => {
    const scored: AccuracyCase[] = [];
    for (let i = 0; i < lineage.variants.length; i++) {
      for (let j = i + 1; j < lineage.variants.length; j++) {
        const a = makeNormalized(lineage.variants[i], { blockId: `${lineage.name}#${i}` });
        const b = makeNormalized(lineage.variants[j], { blockId: `${lineage.name}#${j}` });
        const result = compareBlocks(a, b, thresholds);
        scored.push({
          id: `${lineage.name}#${i}-${j}`,
          lineage: lineage.name,
          variantA: i,
          variantB: j,
          relevant: true,
          similarity: result.similarity,
          classification: result.classification,
          breakdown: result.breakdown,
        });
      }
    }
    return scored;
  });
  return {
    cases,
    lineage: metricsFor(cases, thresholds.possible),
    copy: metricsFor(cases, thresholds.strong),
    adversarial,
  };
}

/** Binary confusion matrix and derived precision/recall/F1 at a score cut-off. */
export function metricsFor(cases: readonly AccuracyCase[], cutOff: number): AccuracyMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (const entry of cases) {
    const predicted = entry.similarity >= cutOff;
    if (entry.relevant && predicted) {
      truePositives++;
    } else if (!entry.relevant && predicted) {
      falsePositives++;
    } else if (entry.relevant) {
      falseNegatives++;
    } else {
      trueNegatives++;
    }
  }
  const precision =
    truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    cutOff,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision,
    recall,
    f1,
  };
}
