/**
 * Ancestry — AST normalisation.
 *
 * Public entry point of the module: turn the text of a {@link CodeBlock} into a
 * {@link NormalizedBlock} — a canonical token stream plus the hashes, shingles
 * and structural features that `src/similarity` scores.
 *
 * The promise the module keeps, and the reason it exists at all:
 *
 * ```text
 *   function add(a, b) { return a + b; }        ┐
 *                                               ├─ identical normalizedText and tokenHash
 *   function sum(x, y) { return x + y; }        ┘
 * ```
 *
 * How it is kept, in one paragraph: every node of the block's AST is walked once
 * in source order; names bound inside the block become `id:n` in first-occurrence
 * order, so renames are free; comments, whitespace, semicolons and trailing
 * commas are erased by construction; and everything whose *meaning* depends on a
 * name the block does not own — property names, type names, globals, module
 * specifiers — is preserved, because collapsing those would make two genuinely
 * different programs look identical. The plan is explicit about that trade-off:
 * "do not remove information that changes program behavior".
 *
 * The full identifier-role table, the privacy posture and the hash parameters are
 * documented in `identifiers.ts`, `literals.ts` and `hash.ts` respectively. Two
 * things are worth repeating here because they are visible in the output:
 *
 *  - **No source text, with one documented exception.** String literals become
 *    `lit:str:<length>:<class>`, template chunks are discarded, comments and JSX
 *    text never enter the stream. Module specifiers *are* kept as `mod:<path>`,
 *    because which module a block depends on is behavioural information; that is
 *    the only raw source-derived string in `normalizedText`.
 *  - **`nodeType` is not hashed.** The construct lives in the token *value*
 *    (`s:IfStatement`), which keeps `normalizedText` self-describing while leaving
 *    `nodeType` free to be a debugging aid that can change without invalidating
 *    the cache.
 *
 * What the caller must provide: a `SourceFile` produced by
 * `src/parser/sourceFile`'s `createSourceFile` with **parent nodes set**, because
 * role classification resolves through `node.parent`.
 */

import * as ts from 'typescript';
import type {
  CodeBlock,
  NormalizedBlock,
  NormalizeResult,
  NormalizedToken,
  SupportedLanguage,
} from '../types';
import { NORMALIZATION_VERSION, languageForPath } from '../types';
import { createSourceFile } from '../parser/sourceFile';
import { collectDeclaredNames, createCanonicalizer } from './identifiers';
import { tokenize } from './tokens';
import { extractFeatures, summarizeAst } from './features';
import {
  DEFAULT_SHINGLE_SIZE,
  MINHASH_BANDS,
  minhashOf,
  sha1Hex,
  shingleHashes,
  simhashOf,
} from './hash';

/** Tunables for one normalisation run. */
export interface NormalizeOptions {
  /** Hard cap on emitted tokens. Default 20000. */
  maxTokens?: number;
  /** Hard cap on block nesting depth. Default 200. */
  maxDepth?: number;
  /**
   * Keep the root declaration's own name verbatim. Default `false`, so that a
   * renamed function still matches its ancestors. See `CanonicalizerOptions`.
   */
  preserveDeclarationName?: boolean;
}

/** Tokens per shingle. Matches `ancestry.similarity.shingleSize`'s default. */
const SHINGLE_SIZE = DEFAULT_SHINGLE_SIZE;

function maxTokenDepth(tokens: readonly NormalizedToken[]): number {
  let max = 0;
  for (const token of tokens) {
    if (token.depth > max) {
      max = token.depth;
    }
  }
  return max;
}

/** Assemble the persisted form from an already-tokenised subtree. */
function assemble(
  blockId: string,
  language: SupportedLanguage,
  root: ts.Node,
  tokens: NormalizedToken[],
  identifierMap: Record<string, string>,
): NormalizedBlock {
  const values: string[] = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i += 1) {
    values[i] = tokens[i]!.value;
  }
  const normalizedText = values.join(' ');
  const shingles = shingleHashes(values, SHINGLE_SIZE);
  return {
    blockId,
    language,
    tokens,
    normalizedText,
    tokenHash: sha1Hex(normalizedText),
    simhash: simhashOf(values),
    minhash: minhashOf(shingles, MINHASH_BANDS),
    shingles,
    features: extractFeatures(tokens),
    astSummary: summarizeAst(root, tokens),
    identifierMap,
    tokenCount: tokens.length,
    maxDepth: maxTokenDepth(tokens),
    normalizationVersion: NORMALIZATION_VERSION,
  };
}

/** An empty, always-valid AST used when a block could not be parsed at all. */
function emptySourceFile(): ts.SourceFile {
  return ts.createSourceFile('empty.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

/**
 * Normalise one code block.
 *
 * Re-parses `block.text` on its own: a block must be comparable across files and
 * across history, so it cannot depend on the surrounding module (an identifier
 * that is a local here may be an import there). Parsing is the compiler's
 * error-tolerant parser, so a block that does not parse still yields a stream —
 * possibly a partial one — and a warning instead of an exception.
 */
export function normalizeBlock(block: CodeBlock, options: NormalizeOptions = {}): NormalizeResult {
  const warnings: string[] = [];
  const canonicalizer = createCanonicalizer({
    preserveDeclarationName: options.preserveDeclarationName,
  });
  let tokens: NormalizedToken[] = [];
  let root: ts.Node = emptySourceFile();
  let identifierMap: Record<string, string> = {};

  try {
    const sf = createSourceFile(block.filePath, block.text, block.language);
    root = sf;
    const declared = collectDeclaredNames(sf);
    tokens = tokenize(
      sf,
      sf,
      { canonicalizer, declared, includeNodeTypes: true },
      { maxTokens: options.maxTokens, maxDepth: options.maxDepth },
      { warnings },
    );
    identifierMap = canonicalizer.readonlyMap();
  } catch (error) {
    // Normalisation must never take down an analysis run. A block we cannot even
    // parse becomes an empty stream: it will not match anything, which is the
    // correct outcome for an unreadable block.
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`normalization failed for block ${block.id}: ${reason}`);
    root = emptySourceFile();
    tokens = [];
  }

  return {
    normalized: assemble(block.id, block.language, root, tokens, identifierMap),
    warnings,
  };
}

/**
 * Normalise every block of one already-parsed file.
 *
 * The file text is parsed once and each block is located inside the resulting
 * tree by its recorded offsets, so the whole file costs a single parse instead of
 * one per block. Blocks whose offsets cannot be located (stale ranges, a file
 * that changed under the caller) fall back to normalising their own recorded
 * `text`, which is always self-consistent.
 *
 * Note that the frozen signature has no channel for warnings, so truncation
 * warnings raised while normalising an in-place subtree are dropped here. Call
 * `normalizeBlock` directly when those matter.
 */
export function normalizeSource(
  filePath: string,
  text: string,
  blocks: CodeBlock[],
  options: NormalizeOptions = {},
): NormalizedBlock[] {
  const language = languageForPath(filePath);
  let sf: ts.SourceFile | null = null;
  try {
    sf = createSourceFile(filePath, text, language);
  } catch {
    sf = null;
  }
  const results: NormalizedBlock[] = [];
  for (const block of blocks) {
    if (sf !== null) {
      const node = findNodeAtRange(sf, block.range.startOffset, block.range.endOffset);
      if (node !== null) {
        results.push(normalizeNode(block, node, sf, options));
        continue;
      }
    }
    results.push(normalizeBlock(block, options).normalized);
  }
  return results;
}

/** Normalise a block whose subtree was already located in `sf`. */
function normalizeNode(
  block: CodeBlock,
  node: ts.Node,
  sf: ts.SourceFile,
  options: NormalizeOptions,
): NormalizedBlock {
  const canonicalizer = createCanonicalizer({
    preserveDeclarationName: options.preserveDeclarationName,
  });
  const declared = collectDeclaredNames(sf);
  const tokens = tokenize(
    node,
    sf,
    { canonicalizer, declared, includeNodeTypes: true },
    { maxTokens: options.maxTokens, maxDepth: options.maxDepth },
  );
  return assemble(block.id, block.language, node, tokens, canonicalizer.readonlyMap());
}

/**
 * Smallest node whose source range covers `[start, end)`.
 *
 * Prefers the deepest match so a method inside a class normalises as the method,
 * not as the class. A block recorded with 1-based lines and 0-based columns in
 * `CodeBlock.range` maps directly onto these offsets.
 */
function findNodeAtRange(sf: ts.SourceFile, start: number, end: number): ts.Node | null {
  if (end < start) {
    return null;
  }
  let best: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    const nodeStart = node.pos;
    const nodeEnd = node.end;
    if (nodeStart <= start && end <= nodeEnd) {
      best = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return best;
}

/**
 * Token values of a normalised block, ready for LCS.
 *
 * Splitting `normalizedText` on a single space is safe because no token value
 * can contain a space: identifiers come from the AST and literals from
 * `literals.ts`, neither of which emits whitespace. Empty entries are filtered
 * anyway so an empty block yields `[]` rather than `['']`.
 */
export function tokenSequence(normalized: NormalizedBlock): string[] {
  if (normalized.normalizedText.length === 0) {
    return [];
  }
  return normalized.normalizedText.split(' ').filter((value) => value.length > 0);
}

export { createCanonicalizer, collectDeclaredNames, classifyIdentifier } from './identifiers';
export type { Canonicalizer, CanonicalizerOptions, IdentifierRole } from './identifiers';
export { tokenize } from './tokens';
export type { TokenizeContext, TokenizeLimits, TokenizeOutput } from './tokens';
export { extractFeatures, featureVectorFor, summarizeAst } from './features';
export {
  classifyStringContent,
  normalizeBigIntLiteral,
  normalizeNumericLiteral,
  normalizeStringLiteral,
  normalizeTemplateLiteral,
} from './literals';
export {
  DEFAULT_SHINGLE_SIZE,
  MINHASH_BANDS,
  SIMHASH_BITS,
  fnv1a64,
  minhashOf,
  sha1Hex,
  shingleHashes,
  simhashOf,
} from './hash';
