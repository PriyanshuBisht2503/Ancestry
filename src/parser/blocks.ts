/**
 * The block extractor: turns a `ts.SourceFile` into the flat, id-keyed
 * {@link CodeBlock} list the rest of Ancestry consumes.
 *
 * Three invariants drive the implementation:
 *
 *  1. **Walk with `forEachChild`, never `getChildren`.** `getChildren` yields
 *     comment and whitespace trivia, which would turn every doc comment into a
 *     node to classify and would make ranges depend on formatting. `forEachChild`
 *     yields only real syntax, so indentation and line breaks cannot change which
 *     blocks exist — only their line numbers.
 *  2. **Recurse explicitly.** The interesting decisions (do not emit a function's
 *     own body as a `block`; do not emit an arrow twice because its `const` was
 *     already emitted; skip `.d.ts`) are all decisions about *where the recursion
 *     goes*, so the recursion is written out rather than delegated to the parser.
 *  3. **Never fail on a broken file.** A mid-history revision with a syntax error
 *     is normal, not exceptional; the error becomes a diagnostic and whatever
 *     parsed is still returned.
 */

import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { makeBlockId } from '../types';
import type { CodeBlock, CodeBlockKind, ParseDiagnostic, SupportedLanguage } from '../types';
import { blockLabel, callableBodyOf, classifyNode } from './kinds';
import { buildQualifiedName, buildSignature } from './signature';
import { toSourceRange } from './sourceFile';

/**
 * Default cap on blocks per file, matching the `maxBlocksPerFile` setting.
 *
 * The cap is a memory bound, not a quality filter: a 10 000-line file must not be
 * able to exhaust the analysis budget, and beyond a few hundred blocks the
 * marginal candidate is never ranked highly anyway.
 */
const DEFAULT_MAX_BLOCKS = 500;

/** Depth bound for flattening a compiler diagnostic chain. */
const MAX_DIAGNOSTIC_DEPTH = 8;

/**
 * Knobs for {@link extractBlocks}.
 *
 * The defaults are the ones a normal analysis run wants; the options exist for
 * the "analyse whole file" command and for tests that need to see the constructs
 * a caller has opted out of.
 */
export interface ExtractBlocksOptions {
  /** Hard cap on returned blocks; the walk stops and warns when reached. */
  maxBlocks?: number;
  /**
   * Emit anonymous statement blocks (`if (…) { … }` bodies). Default `true`:
   * selecting one of those is a real user action, and its evolution is chartable.
   * Function, accessor, constructor and class-static bodies are never emitted
   * regardless — they belong to their owner.
   */
  includeBlocks?: boolean;
  /**
   * Extract from `.d.ts` files and `declare` declarations. Default `false`,
   * because ambient declarations describe code that lives in *other* commits and
   * files; charting them produces the "this evolved into a duplicate of itself"
   * loops that make an ancestry graph useless.
   */
  includeAmbientDeclarations?: boolean;
}

/** One level of the containment chain currently being walked. */
interface StackEntry {
  id: string;
  kind: CodeBlockKind;
  name: string | null;
  qualifiedName: string | null;
}

interface WalkContext {
  sf: ts.SourceFile;
  filePath: string;
  language: SupportedLanguage;
  includeBlocks: boolean;
  includeAmbient: boolean;
  maxBlocks: number;
  blocks: CodeBlock[];
  /** Nodes already represented by an emitted block, so they are never emitted twice. */
  covered: Set<ts.Node>;
  /**
   * Nodes whose entire subtree must stay unanalysable, because the node itself was
   * rejected as an ambient declaration. Without this, the members of a
   * `declare class` would be emitted as orphans with no container to belong to.
   */
  suppressed: Set<ts.Node>;
  /** Ids in use, to keep `makeBlockId` collisions from producing two blocks with one id. */
  ids: Set<string>;
  stack: StackEntry[];
  truncated: boolean;
}

/**
 * Extracts every recognised construct in `sf` as a {@link CodeBlock}.
 *
 * Nested constructs are emitted *and* linked: an outer block's `text` includes its
 * inner ones, and `parentId` expresses the containment tree, so a caller can either
 * analyse a whole unit or drill into a part of it.
 *
 * Returned blocks are sorted by `range.startOffset` (outermost first when two
 * blocks start at the same offset) so that ids, UI ordering and test expectations
 * are all deterministic.
 */
export function extractBlocks(
  sf: ts.SourceFile,
  filePath: string,
  language: SupportedLanguage,
  options: ExtractBlocksOptions = {},
): { blocks: CodeBlock[]; diagnostics: ParseDiagnostic[] } {
  const diagnostics = collectDiagnostics(sf);
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;

  // `.d.ts` files are ambient by definition: every declaration in them is a
  // reference to an implementation that Ancestry will meet elsewhere. Skipping
  // the whole file is therefore the honest answer, and no diagnostic is raised
  // because "this file is a declaration file" is not a problem worth reporting.
  if (isDeclarationFile(filePath) && options.includeAmbientDeclarations !== true) {
    return { blocks: [], diagnostics };
  }

  const ctx: WalkContext = {
    sf,
    filePath,
    language,
    includeBlocks: options.includeBlocks ?? true,
    includeAmbient: options.includeAmbientDeclarations === true,
    maxBlocks,
    blocks: [],
    covered: new Set<ts.Node>(),
    suppressed: new Set<ts.Node>(),
    ids: new Set<string>(),
    stack: [],
    truncated: false,
  };

  // Starting at the SourceFile's children keeps the file itself out of the walk:
  // a file is not a block, but it is the container of top-level declarations.
  sf.forEachChild((child) => visit(ctx, child));

  if (ctx.truncated) {
    diagnostics.push({
      message: `Block limit of ${maxBlocks} reached; the remaining constructs in this file were not analysed.`,
      line: 1,
      column: 1,
      severity: 'warning',
    });
  }

  ctx.blocks.sort(compareBlocks);
  return { blocks: ctx.blocks, diagnostics };
}

/**
 * Syntactic diagnostics from the parser, mapped to 1-based line/column.
 *
 * `parseDiagnostics` is populated by the recovering parser but is not part of the
 * public `SourceFile` type, so it is reached through a narrow structural cast to
 * `unknown` — never `any` — and every field is re-checked before use. Recovering
 * from a syntax error is the whole point: the file still yields whatever parsed
 * before the error, and those blocks are often exactly the interesting ones.
 */
export function collectDiagnostics(sf: ts.SourceFile): ParseDiagnostic[] {
  const holder = sf as unknown as {
    parseDiagnostics?: readonly { messageText?: unknown; start?: number }[];
  };
  const raw = holder.parseDiagnostics;
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  const out: ParseDiagnostic[] = [];
  for (const entry of raw) {
    const start = typeof entry.start === 'number' ? entry.start : 0;
    const clamped = start < 0 ? 0 : start > sf.text.length ? sf.text.length : start;
    const position = sf.getLineAndCharacterOfPosition(clamped);
    out.push({
      message: flattenDiagnosticMessage(entry.messageText),
      line: position.line + 1,
      column: position.character,
      severity: 'error',
    });
  }
  return out;
}

function visit(ctx: WalkContext, node: ts.Node): void {
  if (ctx.truncated || ctx.suppressed.has(node)) {
    return;
  }
  const kind = emittableKind(ctx, node);
  const emitted = kind === 'unknown' ? false : emit(ctx, node, kind);
  visitChildren(ctx, node);
  if (emitted) {
    ctx.stack.pop();
  }
}

/**
 * Which children to descend into, and which node to skip.
 *
 * The special cases exist so that a construct is never represented twice or split
 * in half by its own syntax.
 */
function visitChildren(ctx: WalkContext, node: ts.Node): void {
  if (ts.isVariableStatement(node)) {
    visitVariableStatement(ctx, node);
    return;
  }
  if (ts.isFunctionLike(node)) {
    visitCallable(ctx, node);
    return;
  }
  node.forEachChild((child) => visit(ctx, child));
}

/**
 * A `VariableStatement` is a carrier, not a unit: `const a = 1, b = 2` is two
 * blocks, each keyed by its own name and line, so the walk descends straight into
 * the declaration list instead of emitting the statement.
 */
function visitVariableStatement(ctx: WalkContext, node: ts.VariableStatement): void {
  for (const declaration of node.declarationList.declarations) {
    visitVariableDeclaration(ctx, declaration);
  }
}

function visitVariableDeclaration(ctx: WalkContext, declaration: ts.VariableDeclaration): void {
  const kind = emittableKind(ctx, declaration);
  const emitted = kind === 'unknown' ? false : emit(ctx, declaration, kind);
  const initializer = declaration.initializer;
  if (initializer !== undefined && isCoveredByDeclaration(initializer)) {
    // `const load = async () => {}` and `export const config = { … }` are each one
    // block, named after the binding. Without this the value would also be visited
    // on its own and emitted a second time, occupying the same lines as its own
    // declaration and winning or losing the selection tie-break arbitrarily.
    ctx.covered.add(initializer);
  }
  declaration.forEachChild((child) => visit(ctx, child));
  if (emitted) {
    ctx.stack.pop();
  }
}

/**
 * A value that must not be emitted separately from the declaration holding it.
 *
 * Deliberately narrow: a plain object literal bound to a non-config name is not a
 * block at all, so there is nothing to suppress.
 */
function isCoveredByDeclaration(value: ts.Expression): boolean {
  if (isInlineFunction(value)) {
    return true;
  }
  return ts.isObjectLiteralExpression(value) && classifyNode(value) === 'object-literal';
}

/**
 * Descends through a callable without treating its body as a block of its own.
 *
 * A function body *is* a `Block` node; emitting it would split one function into
 * two overlapping blocks and would make "select a line inside a function" resolve
 * to an anonymous brace block instead of the function. The body's own children are
 * still visited, because a nested arrow function or an `if` body inside a function
 * is a unit in its own right.
 */
function visitCallable(ctx: WalkContext, node: ts.Node): void {
  const body = callableBodyOf(node);
  node.forEachChild((child) => {
    if (body !== undefined && child === body) {
      child.forEachChild((inner) => visit(ctx, inner));
      return;
    }
    visit(ctx, child);
  });
}

/**
 * The kind this node would be emitted as, or `'unknown'` when it must not become
 * a block. This is the single place where ambient handling, duplication
 * avoidance and the block toggle are applied.
 */
function emittableKind(ctx: WalkContext, node: ts.Node): CodeBlockKind {
  if (ctx.covered.has(node)) {
    return 'unknown';
  }
  if (ts.isVariableStatement(node)) {
    // Represented by its declarations instead.
    return 'unknown';
  }
  if (ts.isModuleBlock(node)) {
    // The `{ … }` of a namespace belongs to its `ModuleDeclaration`, which is
    // already a block with the same name and start line.
    return 'unknown';
  }
  if (isSignatureOnlyDeclaration(node, ctx.includeAmbient)) {
    if (isAmbientContainer(node)) {
      ctx.suppressed.add(node);
    }
    return 'unknown';
  }
  if (ts.isVariableDeclaration(node)) {
    if (!isStatementListDeclaration(node)) {
      // A `for (let i …)`, a `for (const x of …)` or a `catch (e)` binding is part
      // of the statement that owns it, not an analysable unit of its own.
      return 'unknown';
    }
    // `export declare const X: T` puts the `declare` modifier on the statement,
    // not on the declaration that is walked, so it has to be checked here.
    if (!ctx.includeAmbient && hasModifier(node.parent.parent, ts.SyntaxKind.DeclareKeyword)) {
      return 'unknown';
    }
  }
  const kind = classifyNode(node);
  if (kind === 'block' && !ctx.includeBlocks) {
    return 'unknown';
  }
  return kind;
}

function emit(ctx: WalkContext, node: ts.Node, kind: CodeBlockKind): boolean {
  if (ctx.blocks.length >= ctx.maxBlocks) {
    ctx.truncated = true;
    return false;
  }
  const range = toSourceRange(node, ctx.sf);
  const text = ctx.sf.text.slice(range.startOffset, range.endOffset);
  if (text.length === 0) {
    // A zero-width node from a partially recovered parse carries no content, and
    // an empty block would be a permanent, meaningless candidate in every search.
    return false;
  }
  const name = blockLabel(node);
  const id = makeBlockId(ctx.filePath, kind, name, range.startLine);
  if (ctx.ids.has(id)) {
    // `makeBlockId` is frozen at `file::kind::name::startLine`, so two constructs
    // that agree on all four (a one-line getter/setter pair, most commonly) cannot
    // be told apart. The first one in source order wins; a second block with a
    // duplicate id would silently overwrite the first in every id-keyed map.
    return false;
  }
  ctx.ids.add(id);

  const qualifiedName = buildQualifiedName(node, name);
  ctx.blocks.push({
    id,
    kind,
    name,
    qualifiedName,
    signature: buildSignature(node, ctx.sf),
    filePath: ctx.filePath,
    language: ctx.language,
    range,
    parentId: parentIdOf(ctx),
    container: containerOf(ctx),
    text,
    textHash: sha1Hex(text),
    tokenCount: estimateTokenCount(text),
  });
  ctx.covered.add(node);
  ctx.stack.push({ id, kind, name, qualifiedName });
  return true;
}

function parentIdOf(ctx: WalkContext): string | null {
  return ctx.stack.length === 0 ? null : ctx.stack[ctx.stack.length - 1].id;
}

/**
 * Name of the nearest enclosing class or function.
 *
 * Anonymous brace blocks are stepped over: they cannot name anything, so the
 * container has to be the meaningful construct around them (the method that owns
 * the `if` body), not the `{ … }` itself.
 */
function containerOf(ctx: WalkContext): string | null {
  for (let i = ctx.stack.length - 1; i >= 0; i--) {
    const entry = ctx.stack[i];
    if (entry.kind === 'block') {
      continue;
    }
    return entry.name ?? entry.qualifiedName ?? null;
  }
  return null;
}

/**
 * True for declarations that only *describe* an implementation.
 *
 * Overload signatures and ambient declarations have no body; the implementation
 * that follows them in the same file is the block that actually evolves. Emitting
 * both would double-count every overloaded method and show a "rename" from
 * `foo(x: string): void;` to `foo(x: string | number): void {}` that never
 * happened.
 *
 * `includeAmbientDeclarations` switches the whole family off, which is the honest
 * reading of an explicit opt-in: the caller has asked for declarations *as
 * declarations* and accepts the overlap that a bodyless signature implies.
 */
function isSignatureOnlyDeclaration(node: ts.Node, includeAmbient: boolean): boolean {
  if (includeAmbient) {
    return false;
  }
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    return true;
  }
  if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
    return true;
  }
  const body = callableBodyOf(node);
  return body === undefined && isCallableNode(node);
}

/** True for the node kinds that own a body, as opposed to a function *type*. */
function isCallableNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * True for declarations that own other declarations.
 *
 * Only these are worth suppressing wholesale when they turn out to be ambient: an
 * orphan member of a `declare class` is meaningless, whereas a rejected function
 * signature has nothing else inside it to lose.
 */
function isAmbientContainer(node: ts.Node): boolean {
  return (
    ts.isClassLike(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isStatementListDeclaration(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent);
}

function isInlineFunction(expression: ts.Expression): boolean {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function isDeclarationFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.d.ts') ||
    lower.endsWith('.d.mts') ||
    lower.endsWith('.d.cts') ||
    lower.endsWith('.d.tsx')
  );
}

/** Outermost-first for equal start offsets, then by id so the order is total. */
function compareBlocks(a: CodeBlock, b: CodeBlock): number {
  if (a.range.startOffset !== b.range.startOffset) {
    return a.range.startOffset - b.range.startOffset;
  }
  if (a.range.endOffset !== b.range.endOffset) {
    return b.range.endOffset - a.range.endOffset;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Local SHA-1 so the extractor does not depend on `src/similarity` (or vice versa). */
function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * Whitespace-separated token count.
 *
 * Deliberately crude: this runs for every block of every revision in history, and
 * its only jobs are to reject trivially small blocks cheaply and to give a stable
 * size proxy in the UI. The real token stream is produced later by
 * `src/normalization`, which is allowed to be expensive.
 */
function estimateTokenCount(text: string): number {
  let count = 0;
  let inToken = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const space =
      code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
    if (space) {
      inToken = false;
      continue;
    }
    if (!inToken) {
      count++;
      inToken = true;
    }
  }
  return count;
}

/**
 * Flattens a compiler diagnostic message.
 *
 * `messageText` is a plain string for a leaf diagnostic and a linked
 * `{ messageText, next }` chain for a compound one. Narrowing `unknown` (rather
 * than casting to a hand-written type) keeps this honest if the shape ever
 * changes, and the depth bound makes a malformed chain terminate.
 */
function flattenDiagnosticMessage(message: unknown, depth = 0): string {
  if (typeof message === 'string') {
    return message;
  }
  if (typeof message === 'number') {
    return `diagnostic ${message}`;
  }
  if (typeof message !== 'object' || message === null) {
    return 'unknown parse error';
  }
  const record = message as { messageText?: unknown; next?: unknown };
  const head =
    typeof record.messageText === 'string' || typeof record.messageText === 'number'
      ? String(record.messageText)
      : depth === 0
        ? flattenDiagnosticMessage(record.messageText, depth + 1)
        : 'unknown parse error';
  if (depth >= MAX_DIAGNOSTIC_DEPTH || !Array.isArray(record.next)) {
    return head;
  }
  const tail = record.next
    .map((entry) => flattenDiagnosticMessage(entry, depth + 1))
    .filter((entry) => entry.length > 0);
  return tail.length === 0 ? head : `${head} (${tail.join('; ')})`;
}
