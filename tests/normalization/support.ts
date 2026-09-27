/**
 * Shared fixtures and helpers for the normalisation tests.
 *
 * The tests deliberately drive the *public* API (`normalizeBlock`, `tokenize`,
 * the literal helpers) rather than private internals, so a refactor that keeps
 * the contract cannot silently break them. Anything in here is test-only
 * scaffolding: it is not part of the module's exported surface.
 */

import * as ts from 'typescript';
import type {
  CodeBlock,
  NormalizedBlock,
  NormalizedToken,
  SupportedLanguage,
} from '../../src/types';
import { NORMALIZATION_VERSION } from '../../src/types';
import { createSourceFile } from '../../src/parser/sourceFile';
import { createCanonicalizer, collectDeclaredNames } from '../../src/normalization/identifiers';
import { tokenize } from '../../src/normalization/tokens';
import { extractFeatures, summarizeAst } from '../../src/normalization/features';
import { minhashOf, sha1Hex, shingleHashes, simhashOf } from '../../src/normalization/hash';
import { normalizeBlock, type NormalizeOptions } from '../../src/normalization';

/** Build a `CodeBlock` around a piece of source text. */
export function makeBlock(text: string, overrides: Partial<CodeBlock> = {}): CodeBlock {
  const filePath = overrides.filePath ?? 'src/service.ts';
  const language: SupportedLanguage = overrides.language ?? 'typescript';
  return {
    id: overrides.id ?? 'src/service.ts::function::demo::1',
    kind: overrides.kind ?? 'function',
    name: overrides.name ?? 'demo',
    qualifiedName: overrides.qualifiedName ?? 'demo',
    signature: null,
    filePath,
    language,
    range: {
      startOffset: 0,
      endOffset: text.length,
      startLine: 1,
      startColumn: 0,
      endLine: text.split('\n').length,
      endColumn: 0,
    },
    parentId: null,
    container: null,
    text,
    textHash: sha1Hex(text),
    tokenCount: 0,
    ...overrides,
  };
}

/** Normalise a fragment and return only the persisted block. */
export function normalize(text: string, options: NormalizeOptions = {}): NormalizedBlock {
  return normalizeBlock(makeBlock(text), options).normalized;
}

/** Normalise a fragment and return the block plus any warnings. */
export function normalizeWithWarnings(
  text: string,
  options: NormalizeOptions = {},
): { normalized: NormalizedBlock; warnings: string[] } {
  return normalizeBlock(makeBlock(text), options);
}

/** Token values of a normalised block. */
export function valuesOf(normalized: NormalizedBlock): string[] {
  return normalized.normalizedText.split(' ').filter((value) => value.length > 0);
}

/** Tokenize a fragment without building the persisted form. */
export function tokensOf(
  text: string,
  options: NormalizeOptions & { language?: SupportedLanguage; filePath?: string } = {},
): NormalizedToken[] {
  const sf = createSourceFile(
    options.filePath ?? 'fixture.ts',
    text,
    options.language ?? 'typescript',
  );
  return tokenize(
    sf,
    sf,
    {
      canonicalizer: createCanonicalizer({
        preserveDeclarationName: options.preserveDeclarationName,
      }),
      declared: collectDeclaredNames(sf),
      includeNodeTypes: true,
    },
    { maxTokens: options.maxTokens, maxDepth: options.maxDepth },
  );
}

/** Identifier map produced alongside {@link tokensOf}. */
export function identifierMapOf(
  text: string,
  preserveDeclarationName = false,
): Record<string, string> {
  const sf = createSourceFile('fixture.ts', text, 'typescript');
  const canonicalizer = createCanonicalizer({ preserveDeclarationName });
  tokenize(
    sf,
    sf,
    { canonicalizer, declared: collectDeclaredNames(sf), includeNodeTypes: true },
    {},
  );
  return canonicalizer.readonlyMap();
}

/** Node kinds of a token stream, in order — handy for readable assertions. */
export function nodeTypesOf(tokens: readonly NormalizedToken[]): string[] {
  return tokens.map((token) => token.nodeType);
}

/** All `SourceFile` tokens for a fragment (used by structural feature assertions). */
export function featuresOf(text: string): Record<string, number> {
  return extractFeatures(tokensOf(text));
}

/** Human-readable structural summary for a fragment. */
export function summaryOf(text: string): string {
  const sf = createSourceFile('fixture.ts', text, 'typescript');
  return summarizeAst(sf, tokensOf(text));
}

/** Reproduce the persisted hashes from a token list, to assert the wiring. */
export function hashesOf(tokens: readonly NormalizedToken[]): {
  tokenHash: string;
  simhash: string;
  minhash: string[];
  shingles: string[];
  version: string;
} {
  const values = tokens.map((token) => token.value);
  const normalizedText = values.join(' ');
  const shingles = shingleHashes(values, 4);
  return {
    tokenHash: sha1Hex(normalizedText),
    simhash: simhashOf(values),
    minhash: minhashOf(shingles, 128),
    shingles,
    version: NORMALIZATION_VERSION,
  };
}

/**
 * Length of the longest common subsequence of two token streams.
 *
 * A test-local LCS: `src/similarity` owns the production implementation and may
 * not exist yet, and an O(n·m) dynamic program over a few hundred tokens is
 * instantaneous anyway.
 */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? (previous[j - 1] as number) + 1
          : Math.max(previous[j] as number, current[j - 1] as number);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length] as number;
}

/** LCS ratio over the longer of the two streams, so "how much is shared". */
export function lcsRatio(a: readonly string[], b: readonly string[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 1;
  }
  return lcsLength(a, b) / longest;
}

/** Multiset intersection over the longer stream, i.e. containment. */
export function overlapRatio(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const value of a) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let shared = 0;
  for (const value of b) {
    const remaining = counts.get(value) ?? 0;
    if (remaining > 0) {
      counts.set(value, remaining - 1);
      shared += 1;
    }
  }
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : shared / longest;
}

/** Jaccard similarity of two token multisets. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const value of left) {
    if (right.has(value)) {
      shared += 1;
    }
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 1 : shared / union;
}

/** Source file with parent nodes, for tests that need the AST directly. */
export function parse(text: string, filePath = 'fixture.ts'): ts.SourceFile {
  return createSourceFile(filePath, text, 'typescript');
}
