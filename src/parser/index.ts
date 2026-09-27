/**
 * Public surface of the AST extraction module.
 *
 * Everything a caller outside `src/parser` needs is re-exported here so that the
 * rest of the extension never reaches into `src/parser/blocks` or
 * `src/parser/kinds` directly — those files are free to change shape without a
 * ripple, and there is exactly one place to look for "how do I turn a file into
 * blocks?".
 *
 * The two functions that matter most to the rest of the system are
 * {@link parseSource} (file → blocks) and {@link findBestBlockForRange}
 * (user selection → the block whose history they want to see).
 */

import { AncestryError, languageForPath } from '../types';
import type { CodeBlock, CodeBlockKind, ParseFileResult, SupportedLanguage } from '../types';
import { assertWithinSizeLimit, decodeSource, isProbablyBinary } from './guards';
import { createSourceFile } from './sourceFile';
import { extractBlocks } from './blocks';

/**
 * Default byte ceiling for a single file, matching the `maxFileSizeBytes`
 * setting. Parsing is linear in file size but similarity search is quadratic in
 * blocks, so an unbounded file is the cheapest way to make an analysis unusable.
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How closely a kind identifies a single intent. Higher wins.
 *
 * Used only to break ties between blocks that cover exactly the same lines, which
 * is a user-visible decision: a `method` is a more specific answer than the
 * `class` that contains it, and a named `function` is a more specific answer than
 * the anonymous `block` it is made of. Ordering rationale, top to bottom:
 * callables first (a user asking about ancestry almost always means a callable),
 * then declarations that publish a contract, then data shapes, then the
 * anonymous brace block, which is the weakest possible answer.
 */
const SPECIFICITY: Readonly<Record<CodeBlockKind, number>> = Object.freeze({
  method: 100,
  constructor: 95,
  'arrow-function': 90,
  function: 85,
  class: 70,
  interface: 65,
  enum: 60,
  'type-alias': 55,
  namespace: 50,
  'object-literal': 45,
  variable: 40,
  block: 20,
  unknown: 0,
});

/** Order kinds are listed in {@link summarizeBlocks}. */
const SUMMARY_ORDER: readonly CodeBlockKind[] = [
  'function',
  'arrow-function',
  'method',
  'constructor',
  'class',
  'interface',
  'type-alias',
  'enum',
  'namespace',
  'variable',
  'object-literal',
  'block',
  'unknown',
];

const KIND_LABELS: Readonly<Record<CodeBlockKind, [singular: string, plural: string]>> =
  Object.freeze({
    function: ['function', 'functions'],
    'arrow-function': ['arrow function', 'arrow functions'],
    method: ['method', 'methods'],
    constructor: ['constructor', 'constructors'],
    class: ['class', 'classes'],
    interface: ['interface', 'interfaces'],
    'type-alias': ['type alias', 'type aliases'],
    enum: ['enum', 'enums'],
    namespace: ['namespace', 'namespaces'],
    variable: ['variable', 'variables'],
    'object-literal': ['object literal', 'object literals'],
    block: ['block', 'blocks'],
    unknown: ['unclassified', 'unclassified'],
  });

/**
 * File extension → language, using the single table in `src/types.ts`.
 *
 * Backslashes are normalised first because callers reach this from the editor and
 * from Git, and a Windows path would otherwise be measured from the last `/` and
 * classify as `unknown`.
 */
export function languageFor(filePath: string): SupportedLanguage {
  const normalized = filePath.indexOf('\\') >= 0 ? filePath.split('\\').join('/') : filePath;
  return languageForPath(normalized);
}

/** Limits applied by {@link parseSource}. */
export interface ParseOptions {
  /** Maximum blocks to extract; the walk stops and warns when reached. */
  maxBlocks?: number;
  /** Maximum file size in bytes. */
  maxBytes?: number;
}

/**
 * Parses source text into blocks.
 *
 * Never throws for a syntax error: a broken revision is expected input, so the
 * error surfaces as an `error` diagnostic and everything that did parse is still
 * returned. The only throws are the explicit size policy.
 *
 * `language` is derived from the path and reported as-is, so a caller can still
 * filter out `unknown` files even though they were parsed permissively.
 */
export function parseSource(
  filePath: string,
  text: string,
  options: ParseOptions = {},
): ParseFileResult {
  assertWithinSizeLimit(
    Buffer.byteLength(text, 'utf8'),
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    filePath,
  );
  const language = languageFor(filePath);
  const startedAt = Date.now();
  const sourceFile = createSourceFile(filePath, text, language);
  const { blocks, diagnostics } = extractBlocks(sourceFile, filePath, language, {
    maxBlocks: options.maxBlocks,
  });
  return {
    filePath,
    language,
    blocks,
    diagnostics,
    durationMs: Date.now() - startedAt,
    sourceLength: text.length,
  };
}

/**
 * Parses raw file bytes, refusing binary content.
 *
 * Order matters: the size guard runs first because it is O(1) and because a huge
 * blob does not deserve a UTF-8 round trip. Binary detection then throws
 * `BINARY_FILE` rather than returning an empty result, because "this file is not
 * analysable" is a fact the caller must not silently ignore.
 *
 * A UTF-8 BOM is stripped before parsing: leaving it in place would shift every
 * line and column by one relative to what the editor shows.
 */
export function parseSourceFromBuffer(
  filePath: string,
  bytes: Buffer,
  options: ParseOptions = {},
): ParseFileResult {
  assertWithinSizeLimit(bytes.length, options.maxBytes ?? DEFAULT_MAX_BYTES, filePath);
  if (isProbablyBinary(bytes)) {
    throw new AncestryError('BINARY_FILE', `${filePath} is a binary file and cannot be analysed.`, {
      detail:
        'Content did not pass the text sniffer (NUL bytes, non-printable ratio, or invalid UTF-8).',
    });
  }
  const { text } = decodeSource(bytes);
  return parseSource(filePath, text, options);
}

/**
 * Chooses the block a user's selection is about. **This is the selection→block
 * decision the whole product hangs off**, so the rules are spelled out and are
 * deliberately boring:
 *
 * 1. **Smallest enclosing block wins.** A selection that sits inside a method
 *    resolves to the method, not to the class that contains it, because "what
 *    happened to this method?" is the question the user is asking. Containment
 *    means `block.range.startLine <= startLine` **and**
 *    `block.range.endLine >= endLine`.
 * 2. **Ties on span break towards greater specificity** ({@link SPECIFICITY}): a
 *    `method` beats a `class`, a `function` beats a `block`. This only comes into
 *    play for blocks that occupy exactly the same lines, e.g. a one-line class.
 * 3. **No enclosing block → largest line overlap, then smallest span, then
 *    specificity.** A selection that starts in one function and ends in the next
 *    spans no single block; the most-overlapping one is the best available answer,
 *    and among equally-overlapping blocks the tightest is the more faithful one.
 * 4. **Still nothing → `null`**, so the caller can synthesise a block for a file
 *    with no recognisable constructs (an empty file, a JSON-ish file, or a
 *    selection that missed everything).
 * 5. **Exact ties keep the earlier block** in the caller's array. `extractBlocks`
 *    returns source order, so "earlier" means "declared first" — stable across
 *    runs, which is what makes ids and UI ordering reproducible.
 *
 * A reversed range (`startLine > endLine`, possible from a synthetic caller) is
 * normalised rather than treated as a miss.
 */
export function findBestBlockForRange(
  blocks: readonly CodeBlock[],
  startLine: number,
  endLine: number,
): CodeBlock | null {
  const from = Math.min(startLine, endLine);
  const to = Math.max(startLine, endLine);

  let best: CodeBlock | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestSpecificity = -1;
  for (const block of blocks) {
    if (block.range.startLine > from || block.range.endLine < to) {
      continue;
    }
    const span = lineSpan(block);
    const specificity = SPECIFICITY[block.kind];
    if (span < bestSpan || (span === bestSpan && specificity > bestSpecificity)) {
      best = block;
      bestSpan = span;
      bestSpecificity = specificity;
    }
  }
  if (best !== null) {
    return best;
  }

  let overlapBest: CodeBlock | null = null;
  let bestOverlap = 0;
  let overlapSpan = Number.POSITIVE_INFINITY;
  let overlapSpecificity = -1;
  for (const block of blocks) {
    const overlap = Math.min(to, block.range.endLine) - Math.max(from, block.range.startLine) + 1;
    if (overlap <= 0) {
      continue;
    }
    const span = lineSpan(block);
    const specificity = SPECIFICITY[block.kind];
    const better =
      overlap > bestOverlap ||
      (overlap === bestOverlap &&
        (span < overlapSpan || (span === overlapSpan && specificity > overlapSpecificity)));
    if (better) {
      overlapBest = block;
      bestOverlap = overlap;
      overlapSpan = span;
      overlapSpecificity = specificity;
    }
  }
  return overlapBest;
}

/**
 * The outermost block that fully contains the range, or `null`.
 *
 * Deliberately the inverse tie-break of {@link findBestBlockForRange}: here the
 * *largest* container wins, because the question being asked is "what is this
 * part of?". A selection inside a method returns the class (or namespace) the
 * method lives in.
 */
export function findEnclosingBlock(
  blocks: readonly CodeBlock[],
  startLine: number,
  endLine: number,
): CodeBlock | null {
  const from = Math.min(startLine, endLine);
  const to = Math.max(startLine, endLine);

  let best: CodeBlock | null = null;
  let bestSpan = -1;
  let bestSpecificity = -1;
  for (const block of blocks) {
    if (block.range.startLine > from || block.range.endLine < to) {
      continue;
    }
    const span = lineSpan(block);
    const specificity = SPECIFICITY[block.kind];
    if (span > bestSpan || (span === bestSpan && specificity > bestSpecificity)) {
      best = block;
      bestSpan = span;
      bestSpecificity = specificity;
    }
  }
  return best;
}

/**
 * Top-level, non-overlapping blocks entirely inside `[minLine, maxLine]`.
 *
 * Powers the "analyse every block in this file" command, which must analyse units
 * and not fragments: a method nested in a class is covered by the class's own
 * analysis, and running both would double every match. Ordering is by start line
 * so the resulting list is stable and reads top-to-bottom.
 */
export function blocksWithinFile(
  blocks: readonly CodeBlock[],
  minLine: number,
  maxLine: number,
): CodeBlock[] {
  const inside = blocks.filter(
    (block) => block.range.startLine >= minLine && block.range.endLine <= maxLine,
  );
  // Sort outermost-first for equal starts so a container is always seen before
  // anything it contains; then a single forward pass keeps only blocks that do not
  // overlap the previously kept one. O(n log n) instead of the O(n^2) pairwise
  // containment test, which matters when this runs over a whole repository.
  inside.sort((a, b) => a.range.startLine - b.range.startLine || b.range.endLine - a.range.endLine);
  const kept: CodeBlock[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const block of inside) {
    if (block.range.startLine <= previousEnd) {
      continue;
    }
    kept.push(block);
    previousEnd = block.range.endLine;
  }
  return kept;
}

/**
 * One-line count summary for a status bar or a notification, e.g.
 * `3 functions, 1 class (5 blocks)`.
 *
 * Ordered by importance rather than alphabetically so the most interesting kind is
 * read first, and pluralised correctly because it is rendered in chrome the user
 * reads at a glance.
 */
export function summarizeBlocks(blocks: readonly CodeBlock[]): string {
  if (blocks.length === 0) {
    return 'no blocks';
  }
  const counts = new Map<CodeBlockKind, number>();
  for (const block of blocks) {
    counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const kind of SUMMARY_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) {
      const [singular, plural] = KIND_LABELS[kind];
      parts.push(`${count} ${count === 1 ? singular : plural}`);
    }
  }
  const noun = blocks.length === 1 ? 'block' : 'blocks';
  return `${parts.join(', ')} (${blocks.length} ${noun})`;
}

function lineSpan(block: CodeBlock): number {
  return block.range.endLine - block.range.startLine + 1;
}

export { assertWithinSizeLimit, decodeSource, isProbablyBinary, looksLikeText } from './guards';
export { createSourceFile, getScriptKind, toSourceRange } from './sourceFile';
export { blockLabel, classifyNode, isFunctionLike } from './kinds';
export { buildQualifiedName, buildSignature } from './signature';
export { collectDiagnostics, extractBlocks } from './blocks';
export type { ExtractBlocksOptions } from './blocks';
