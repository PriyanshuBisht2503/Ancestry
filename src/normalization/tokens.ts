/**
 * AST → canonical token stream.
 *
 * The traversal is a pre-order, source-ordered walk over `forEachChild` (never
 * `getChildren`, which would surface comment trivia). Three kinds of token come
 * out of one visit:
 *
 *  1. **Node tokens** — one per meaningful construct. Structural constructs emit
 *     `s:<SyntaxKind>` so that the construct is recoverable from
 *     `normalizedText` alone (the `nodeType` field is deliberately *not* hashed;
 *     it exists for debugging). Leaf-ish nodes emit their canonical value
 *     instead: `id:3` for an identifier, `lit:num:60` for a number.
 *  2. **Gap tokens** — the keywords, operators and punctuation that sit *between*
 *     two children of a node. They are read with a trivia-skipping scanner over
 *     the same offsets the AST reports, which is what makes the stream
 *     formatting-independent for free: indentation, line breaks and comments are
 *     never returned by the scanner.
 *  3. **Opaque tokens** — identifier-shaped scanner tokens in a gap that are not
 *     in the contextual-keyword allowlist become the constant `name`, so no
 *     source-derived word can leak into the stream through the gap path.
 *
 * Formatting that is *structural* rather than cosmetic is deliberately erased
 * because it cannot change behaviour: statement terminators (semicolon
 * insertion) and trailing commas are dropped. A `,` is only dropped when the very
 * next token closes a bracket, so real element separators survive.
 *
 * Trivia, comments, JSDoc, JSX text, template quasi text and regex bodies never
 * reach the stream. `maxTokens` and `maxDepth` bound pathological input; both
 * report through `TokenizeOutput.warnings` rather than throwing.
 */

import * as ts from 'typescript';
import type { NormalizedToken, NormalizedTokenKind } from '../types';
import type { Canonicalizer, IdentifierRole } from './identifiers';
import { classifyIdentifier } from './identifiers';
import {
  normalizeBigIntLiteral,
  normalizeNumericLiteral,
  normalizeStringLiteral,
  normalizeTemplateLiteral,
} from './literals';

/** Everything the tokenizer needs from the caller. */
export interface TokenizeContext {
  /** Name allocator; seeded by the tokenizer with the root declaration name. */
  canonicalizer: Canonicalizer;
  /** Names bound inside the block, from `collectDeclaredNames`. */
  declared: ReadonlySet<string>;
  /**
   * When `true` (the default wired into `normalizeBlock`) a structural token
   * carries its `SyntaxKind` (`s:IfStatement`); when `false` every structural
   * token collapses to `s:node`, producing a purely lexical stream. The flag
   * exists so a caller can request a cheap pre-screening stream whose hash is
   * structure-insensitive; `nodeType` is populated either way.
   */
  includeNodeTypes: boolean;
}

/** Recursion and output bounds. */
export interface TokenizeLimits {
  /** Hard cap on emitted tokens. Default 20000. */
  maxTokens?: number;
  /** Hard cap on block nesting depth. Default 200. */
  maxDepth?: number;
}

/** Sink for non-fatal problems. */
export interface TokenizeOutput {
  /** Human-readable reasons the stream is incomplete. Never contains source text. */
  warnings: string[];
}

const DEFAULT_MAX_TOKENS = 20_000;
const DEFAULT_MAX_DEPTH = 200;

/** Truncation marker emitted instead of descending past `maxDepth`. */
const TRUNCATION_TOKEN = '…';

/** Value emitted for an identifier-shaped gap token that is not an allowlisted word. */
const OPAQUE_NAME_TOKEN = 'name';

/**
 * Constructs whose meaning depends on nesting level. Their token value carries a
 * `d<depth>:` prefix so that `{a;{b}}` and `{a;b;}` differ in `normalizedText`
 * and not only in the (unhashed) `depth` field.
 */
const DEPTH_SENSITIVE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
  ts.SyntaxKind.TemplateExpression,
]);

/**
 * Words that TypeScript's scanner reports as `Identifier` but that are part of
 * the language's fixed vocabulary. They are emitted verbatim; anything else found
 * in a gap becomes {@link OPAQUE_NAME_TOKEN}.
 */
const CONTEXTUAL_WORDS: ReadonlySet<string> = new Set([
  'abstract',
  'accessor',
  'as',
  'asserts',
  'async',
  'await',
  'checks',
  'const',
  'declare',
  'from',
  'get',
  'global',
  'infer',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'of',
  'out',
  'override',
  'readonly',
  'require',
  'satisfies',
  'set',
  'type',
  'unique',
  'var',
  'yield',
]);

/**
 * Declaration-kind keywords that are interchangeable for structural purposes.
 *
 * `const` → `let` and `var` → `let` must hash identically (Phase 4 checkpoint).
 * The cost is real but bounded: reassignment is a *static* property that the
 * normalised stream no longer distinguishes, while the statement shape, the
 * initialiser and every operand still do. Dead-store and reassignment analysis is
 * the kind of question a similarity graph should not answer.
 */
const KEYWORD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  const: 'let',
  var: 'let',
});

/** Scanner tokens rendered as punctuation rather than operators. */
const PUNCTUATION_TEXTS: ReadonlySet<string> = new Set(['(', ')', '[', ']', '{', '}', ',', '@']);

/** Tokens after which a comma is a trailing (purely cosmetic) comma. */
const CLOSING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.GreaterThanToken,
]);

/** Identifiers that behave like keywords and must survive as verbatim keywords. */
const PSEUDO_KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined']);

const SYNTAX_KIND_NAMES: ReadonlyMap<number, string> = buildSyntaxKindNames();

/**
 * `SyntaxKind` → printable name.
 *
 * `ts.SyntaxKind[kind]` is unusable for punctuation and template nodes: the enum
 * carries `FirstPunctuation`/`FirstTemplateToken` aliases that share a value
 * with the real kind, and the *first* name wins in a reverse lookup. This table
 * keeps the last, most specific name instead (`OpenBraceToken`, not
 * `FirstPunctuation`).
 */
function buildSyntaxKindNames(): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const [name, value] of Object.entries(ts.SyntaxKind as unknown as Record<string, unknown>)) {
    if (typeof value !== 'number') {
      continue;
    }
    const existing = names.get(value);
    if (
      existing === undefined ||
      existing === 'Unknown' ||
      existing === 'EndOfFileToken' ||
      existing.startsWith('First') ||
      existing.startsWith('Last')
    ) {
      names.set(value, name);
    }
  }
  return names;
}

function kindName(kind: ts.SyntaxKind): string {
  return SYNTAX_KIND_NAMES.get(kind) ?? 'Unknown';
}

/** JSX text is raw markup: it is character data, never structure. */
function isJsxText(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.JsxText;
}

/**
 * Wrapper nodes that are erased entirely.
 *
 * Parenthesisation, `!`, `as T`, `<T>x` and `satisfies T` are all *compile-time*
 * assertions or pure grouping. Keeping them would make `(a + b)` differ from
 * `a + b` and `x as Foo` differ from `x`, neither of which changes the emitted
 * JavaScript. The inner expression is visited instead; the erased type argument
 * is dropped with the wrapper.
 */
function transparentChildren(node: ts.Node): readonly ts.Node[] | null {
  if (ts.isParenthesizedExpression(node)) {
    return [node.expression];
  }
  if (ts.isNonNullExpression(node)) {
    return [node.expression];
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return [node.expression];
  }
  if (node.kind === ts.SyntaxKind.TypeAssertionExpression) {
    return [(node as ts.TypeAssertion).expression];
  }
  if (node.kind === ts.SyntaxKind.PartiallyEmittedExpression) {
    return childNodes(node);
  }
  return null;
}

/** Source-ordered children, the way the scanner sees them. */
function childNodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

function isKeywordKind(kind: ts.SyntaxKind): boolean {
  if (kind < ts.SyntaxKind.FirstKeyword || kind > ts.SyntaxKind.LastKeyword) {
    return false;
  }
  return ts.tokenToString(kind) !== undefined;
}

function roleKind(role: IdentifierRole): NormalizedTokenKind {
  switch (role) {
    case 'param':
      return 'param';
    case 'property':
      return 'property';
    case 'type':
      return 'type';
    default:
      return 'identifier';
  }
}

/**
 * The module specifier of a static or dynamic import, or `null`.
 *
 * Returned verbatim behind `mod:`. This is the single place where real source
 * text reaches the stream, and it is kept on purpose: which module a block
 * depends on is part of its behaviour, and hiding it would make
 * `import {x} from 'a'` and `import {x} from 'b'` the same block. Everything
 * else textual (string bodies, template chunks, comments) is reduced to shape.
 */
function moduleSpecifierText(node: ts.StringLiteral): string | null {
  const parent = node.parent;
  if (parent === undefined) {
    return null;
  }
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return node.text;
  }
  if (
    ts.isImportEqualsDeclaration(parent) &&
    ts.isExternalModuleReference(parent.moduleReference)
  ) {
    const target = parent.moduleReference.expression;
    return ts.isStringLiteral(target) ? target.text : null;
  }
  if (
    ts.isImportTypeNode(parent) &&
    ts.isLiteralTypeNode(parent.argument) &&
    parent.argument.literal === node
  ) {
    return node.text;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node
  ) {
    return node.text;
  }
  return null;
}

/** Flags of a regex literal. The pattern is read once and immediately discarded. */
function regexTokenValue(node: ts.Node, sf: ts.SourceFile): string {
  let literal: string;
  try {
    literal = node.getText(sf);
  } catch {
    return 'lit:regex';
  }
  // Walk back over the flag characters; whatever precedes them is the closing
  // delimiter. No regular expression is applied to source text anywhere.
  let index = literal.length - 1;
  while (index >= 0) {
    const code = literal.charCodeAt(index);
    const isFlag = (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
    if (!isFlag) {
      break;
    }
    index -= 1;
  }
  const flags = literal.slice(index + 1);
  return flags.length === 0 ? 'lit:regex' : `lit:regex:${flags}`;
}

/**
 * Name of the construct a block text is about, used to seed the canonicalizer.
 *
 * With `preserveDeclarationName` the first name the canonicalizer sees is the
 * root declaration's, so the root is found here: the first top-level statement
 * when the block text is a whole file, or the node itself when it is already a
 * declaration. An arrow assigned to a variable has no name of its own; the walk
 * reaches the variable name next, which is the desired behaviour anyway.
 */
function rootDeclarationName(root: ts.Node): string | null {
  const candidate = ts.isSourceFile(root) ? root.statements[0] : root;
  if (candidate === undefined) {
    return null;
  }
  if (
    ts.isFunctionDeclaration(candidate) ||
    ts.isFunctionExpression(candidate) ||
    ts.isClassDeclaration(candidate) ||
    ts.isClassExpression(candidate) ||
    ts.isInterfaceDeclaration(candidate) ||
    ts.isTypeAliasDeclaration(candidate) ||
    ts.isEnumDeclaration(candidate) ||
    ts.isModuleDeclaration(candidate)
  ) {
    return candidate.name?.text ?? null;
  }
  return null;
}

function isTemplateExpression(node: ts.Node): node is ts.TemplateExpression {
  return node.kind === ts.SyntaxKind.TemplateExpression;
}

/**
 * Recursive-descent tokenizer.
 *
 * A class rather than a closure because the walk needs four pieces of mutable
 * state that must stay in sync: the output array, the shared scanner (whose
 * position must only ever move forwards), the emitted-token count used for the
 * cap, and the one-shot warnings.
 */
class Tokenizer {
  private readonly tokens: NormalizedToken[] = [];
  private readonly scanner: ts.Scanner;
  private readonly sourceFile: ts.SourceFile;
  private readonly context: TokenizeContext;
  private readonly limits: Required<TokenizeLimits>;
  private readonly warnings: string[];
  private readonly root: ts.Node;
  private truncated = false;
  private depthWarned = false;

  constructor(
    root: ts.Node,
    sf: ts.SourceFile,
    context: TokenizeContext,
    limits: Required<TokenizeLimits>,
    warnings: string[],
  ) {
    this.root = root;
    this.sourceFile = sf;
    this.context = context;
    this.limits = limits;
    this.warnings = warnings;
    this.scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      sf.text,
    );
  }

  run(): NormalizedToken[] {
    const rootName = rootDeclarationName(this.root);
    if (rootName !== null) {
      // Must happen before any other name so that `preserveDeclarationName` has a
      // well-defined target and the root name is `id:1` by default.
      this.context.canonicalizer.canonicalize(rootName, 'function');
    }
    this.visit(this.root, 0);
    return this.tokens;
  }

  private push(kind: NormalizedTokenKind, value: string, nodeType: string, depth: number): void {
    if (this.tokens.length >= this.limits.maxTokens) {
      if (!this.truncated) {
        this.truncated = true;
        this.tokens.push({ kind: 'punct', value: TRUNCATION_TOKEN, nodeType: 'Unknown', depth });
        this.warnings.push(
          `normalization truncated: token limit ${this.limits.maxTokens} reached; the block is only partially normalised`,
        );
      }
      return;
    }
    this.tokens.push({ kind, value, nodeType, depth });
  }

  private visit(node: ts.Node, depth: number): void {
    if (isJsxText(node)) {
      // Raw markup character data. Never emitted, never recursed into.
      return;
    }
    if (
      node.kind === ts.SyntaxKind.EndOfFileToken ||
      node.kind === ts.SyntaxKind.NotEmittedStatement
    ) {
      // The end-of-file marker and TypeScript's phantom `;` for error recovery
      // are artefacts of parsing, not program structure.
      return;
    }
    if (depth > this.limits.maxDepth) {
      this.push('punct', TRUNCATION_TOKEN, 'Unknown', depth);
      if (!this.depthWarned) {
        this.depthWarned = true;
        this.warnings.push(
          `normalization truncated: depth limit ${this.limits.maxDepth} reached; deeper constructs are omitted`,
        );
      }
      return;
    }
    if (this.tokens.length >= this.limits.maxTokens) {
      this.push('punct', TRUNCATION_TOKEN, 'Unknown', depth);
      return;
    }

    const transparent = transparentChildren(node);
    if (transparent !== null) {
      for (const child of transparent) {
        this.visit(child, depth);
      }
      return;
    }

    const nextDepth = DEPTH_SENSITIVE_KINDS.has(node.kind) ? depth + 1 : depth;
    this.emitNodeToken(node, depth);

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      // A prefix operator is a *token*, not a node, so `forEachChild` yields only
      // the operand and the gap scanner would otherwise emit the operator as raw
      // text (`-`) while a binary operator — which `forEachChild` does yield, as
      // `operatorToken` — arrives as `s:PlusToken`. Emitting it explicitly keeps
      // unary and binary operators in one vocabulary.
      //
      // This is not cosmetic. `!x` and `x` are different programs, `-x` and `x`
      // are different programs, and `typeof x` and `x` are different programs.
      // Erasing the operator would make a negated condition hash identically to
      // a positive one, which is precisely the class of false negative the
      // normalisation contract forbids.
      this.push('operator', `s:${kindName(node.operator)}`, 'PrefixUnaryOperator', depth);
      this.visit(node.operand, nextDepth);
      return;
    }

    if (isTemplateExpression(node)) {
      // Quasi text and the `${`/`}` delimiters are not scanned: the hole count is
      // already in `lit:tmpl:<n>`, and the expressions are normalised in full.
      for (const span of node.templateSpans) {
        this.visit(span.expression, nextDepth);
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      return;
    }

    const children = childNodes(node);
    if (children.length === 0) {
      // A leaf carries no gap of its own: the region between its start and its end
      // *is* the token the node token just described. Re-scanning it would emit
      // the identifier or literal text a second time.
      return;
    }
    let cursor = this.nodeStart(node);
    for (const child of children) {
      const gapEnd = Math.min(Math.max(cursor, this.nodeStart(child)), Math.max(cursor, node.end));
      this.scanGap(cursor, gapEnd, depth);
      this.visit(child, nextDepth);
      cursor = Math.max(cursor, child.end);
    }
    this.scanGap(cursor, Math.max(cursor, node.end), depth);
  }

  /** Start offset of a node, skipping leading trivia and JSDoc. */
  private nodeStart(node: ts.Node): number {
    try {
      const start = node.getStart(this.sourceFile);
      return start >= 0 ? start : node.pos;
    } catch {
      return node.pos;
    }
  }

  private scanGap(from: number, to: number, depth: number): void {
    const text = this.sourceFile.text;
    const start = Math.max(0, Math.min(from, text.length));
    const end = Math.max(start, Math.min(to, text.length));
    if (end === start) {
      return;
    }
    this.scanner.setTextPos(start);
    const collected: Array<{ kind: ts.SyntaxKind; text: string }> = [];
    let peeked: ts.SyntaxKind = ts.SyntaxKind.Unknown;
    for (;;) {
      const token = this.scanner.scan();
      if (token === ts.SyntaxKind.EndOfFileToken) {
        break;
      }
      if (this.scanner.getTokenPos() >= end || this.scanner.getTextPos() > end) {
        // The token begins at or straddles the gap boundary: it belongs to a
        // sibling region and is only inspected, never emitted.
        peeked = token;
        break;
      }
      collected.push({ kind: token, text: this.scanner.getTokenText() });
    }
    for (let i = 0; i < collected.length; i += 1) {
      const entry = collected[i]!;
      if (entry.kind === ts.SyntaxKind.SemicolonToken) {
        continue;
      }
      if (entry.kind === ts.SyntaxKind.CommaToken) {
        const next = i + 1 < collected.length ? collected[i + 1]!.kind : peeked;
        if (CLOSING_KINDS.has(next)) {
          continue;
        }
      }
      this.emitGapToken(entry.kind, entry.text, depth);
    }
  }

  private emitGapToken(kind: ts.SyntaxKind, text: string, depth: number): void {
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) {
      const word = text.toLowerCase();
      if (CONTEXTUAL_WORDS.has(word)) {
        this.push('keyword', `kw:${KEYWORD_ALIASES[word] ?? word}`, kindName(kind), depth);
        return;
      }
      // A word the AST did not model (an implicit import attribute name, a
      // future contextual keyword). Emitting it would leak source text.
      this.push('identifier', OPAQUE_NAME_TOKEN, kindName(kind), depth);
      return;
    }
    if (isKeywordKind(kind)) {
      const word = (ts.tokenToString(kind) ?? text).toLowerCase();
      this.push('keyword', `kw:${KEYWORD_ALIASES[word] ?? word}`, kindName(kind), depth);
      return;
    }
    const kind2: NormalizedTokenKind = PUNCTUATION_TEXTS.has(text) ? 'punct' : 'operator';
    this.push(kind2, text, kindName(kind), depth);
  }

  private emitNodeToken(node: ts.Node, depth: number): void {
    const nodeType = kindName(node.kind);

    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      this.push('literal', regexTokenValue(node, this.sourceFile), nodeType, depth);
      return;
    }
    if (ts.isIdentifier(node)) {
      this.emitIdentifier(node, nodeType, depth);
      return;
    }
    if (ts.isPrivateIdentifier(node)) {
      this.push('property', `prop:#${node.text.slice(1)}`, nodeType, depth);
      return;
    }
    if (ts.isStringLiteral(node)) {
      const specifier = moduleSpecifierText(node);
      if (specifier !== null) {
        this.push('identifier', `mod:${specifier}`, nodeType, depth);
        return;
      }
      this.push('literal', normalizeStringLiteral(node), nodeType, depth);
      return;
    }
    if (ts.isNumericLiteral(node)) {
      this.push('literal', normalizeNumericLiteral(node), nodeType, depth);
      return;
    }
    if (ts.isBigIntLiteral(node)) {
      this.push('literal', normalizeBigIntLiteral(node), nodeType, depth);
      return;
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      this.push('literal', normalizeTemplateLiteral(node), nodeType, depth);
      return;
    }
    if (isKeywordKind(node.kind)) {
      const word = (ts.tokenToString(node.kind) ?? '').toLowerCase();
      this.push('keyword', `kw:${KEYWORD_ALIASES[word] ?? word}`, nodeType, depth);
      return;
    }
    const base = this.context.includeNodeTypes ? `s:${nodeType}` : 's:node';
    const value = DEPTH_SENSITIVE_KINDS.has(node.kind) ? `d${depth}:${base}` : base;
    this.push('punct', value, nodeType, depth);

    if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      // `{ foo }` names a key *and* a reference. The key is preserved as a
      // property (it is API surface); the reference is canonicalised by the child
      // visit, so the stream reads `s:ShorthandPropertyAssignment prop:foo id:3`.
      this.push('property', `prop:${node.name.text}`, nodeType, depth);
    }
  }

  private emitIdentifier(node: ts.Identifier, nodeType: string, depth: number): void {
    const name = node.text;
    if (PSEUDO_KEYWORDS.has(name)) {
      // `undefined` is an identifier to the parser but a value in the language.
      this.push('keyword', `kw:${name}`, nodeType, depth);
      return;
    }
    const role = classifyIdentifier(node, this.root, this.context.declared);
    this.push(roleKind(role), this.context.canonicalizer.canonicalize(name, role), nodeType, depth);
  }
}

/**
 * Convert an AST subtree into a canonical token stream.
 *
 * @param root Subtree to normalise. Usually the `SourceFile` of a block's text.
 * @param sf Source file the node belongs to; supplies the text the scanner reads.
 * @param ctx Canonicalizer, declared-name set and node-type policy.
 * @param limits Optional recursion/output caps.
 * @param out Optional warning sink; created when omitted (so the warnings are
 *   simply discarded, which is what a caller that does not care should get).
 */
export function tokenize(
  root: ts.Node,
  sf: ts.SourceFile,
  ctx: TokenizeContext,
  limits: TokenizeLimits = {},
  out: TokenizeOutput = { warnings: [] },
): NormalizedToken[] {
  const resolved: Required<TokenizeLimits> = {
    maxTokens:
      limits.maxTokens !== undefined && limits.maxTokens > 0
        ? limits.maxTokens
        : DEFAULT_MAX_TOKENS,
    maxDepth:
      limits.maxDepth !== undefined && limits.maxDepth > 0 ? limits.maxDepth : DEFAULT_MAX_DEPTH,
  };
  const warnings = out.warnings;
  const tokenizer = new Tokenizer(root, sf, ctx, resolved, warnings);
  return tokenizer.run();
}
