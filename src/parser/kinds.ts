/**
 * Maps TypeScript AST nodes onto Ancestry's deliberately narrow
 * {@link CodeBlockKind} vocabulary.
 *
 * The vocabulary is narrow on purpose: only *named* or *semantically meaningful*
 * constructs are blocks, so that reformatting, statement reordering, or a rename
 * cannot fragment one unit of meaning into several. Every decision below is
 * therefore about "is this thing a unit a person would ask the ancestry of?" and
 * not about "is this interesting to the compiler?".
 *
 * This module is pure and context-free: it answers *what kind is this node?*, not
 * *should this node become a block?*. The second question — which needs scope,
 * ambient-declaration and duplication rules — belongs to `./blocks`.
 */

import * as ts from 'typescript';
import type { CodeBlockKind } from '../types';

/**
 * Kinds that represent something callable.
 *
 * `block` is deliberately excluded: a bare `{ ... }` has no callable identity, so
 * treating it as function-like would let "how did this function evolve?" questions
 * resolve to an anonymous brace block.
 */
const FUNCTION_LIKE_KINDS: ReadonlySet<CodeBlockKind> = new Set<CodeBlockKind>([
  'function',
  'arrow-function',
  'method',
  'constructor',
]);

/**
 * Substrings that mark a variable as configuration-shaped.
 *
 * Object literals are only blocks when they are *exported* or look like
 * configuration, because a bare `const point = { x: 1, y: 2 }` is a value used by
 * the code around it, whereas `export const config = { ... }` is a published
 * surface whose evolution is worth charting. These names are the ones that show up
 * in real "the config changed and the app broke" stories.
 */
const CONFIG_NAME_HINTS: readonly string[] = [
  'config',
  'option',
  'setting',
  'default',
  'constant',
  'schema',
  'manifest',
  'route',
  'plugin',
  'middleware',
  'provider',
  'registry',
  'mapping',
  'table',
];

/**
 * Classifies a node into a {@link CodeBlockKind}, or `'unknown'` when the node is
 * not a unit Ancestry tracks.
 *
 * The mapping, and why:
 *
 * - `FunctionDeclaration` → `function`. The canonical named unit.
 * - `ClassDeclaration` → `class`; a *class expression* is `unknown` because it is
 *   a value with no identity of its own — the variable holding it is the unit.
 * - `InterfaceDeclaration` → `interface`, `TypeAliasDeclaration` → `type-alias`,
 *   `EnumDeclaration` → `enum`: contracts are tracked because their evolution is
 *   the story users actually care about.
 * - `ModuleDeclaration`/`ModuleBlock` → `namespace`: namespacing changes are
 *   structural, and the two node kinds exist because `namespace a.b {}` nests.
 * - `MethodDeclaration`/`MethodSignature` → `method`; `GetAccessor`/`SetAccessor`
 *   → `method` as well, since moving a getter to a field is a refactor Ancestry
 *   should present as one evolving member rather than as an unrelated pair.
 * - `Constructor` → `constructor`, kept distinct so the graph can label it.
 * - `PropertyDeclaration`/`PropertySignature` → `method` **only** when it holds a
 *   function (an arrow/class field is a method in everything but syntax) or is
 *   declared with a function type. A data field is `unknown`: hundreds of
 *   `private x: number` blocks would bury the handful of real methods.
 * - `PropertyAssignment` → `arrow-function` only when its value is a function, for
 *   the same reason: `name: 'x'` inside a config object is data.
 * - `VariableStatement`/`VariableDeclaration` → `arrow-function` when the value is
 *   a function, otherwise `variable`. `function` is reserved for *declarations*:
 *   `const f = function () {}` is tracked as the binding `f`, because the binding
 *   is what a user selects and what survives a rewrite of the value.
 *   A destructuring pattern has no single name to key a block on → `variable`.
 * - `ArrowFunction`/`FunctionExpression` reached on their own → `arrow-function`.
 * - `Block` → `block` only at statement position (an `if`/`for`/`try` body). The
 *   body of a function, of a class static block, or of a `catch` clause is part of
 *   its owner and must never be emitted separately, or every function would be
 *   split into "the function" and "the block that is the function".
 * - `ObjectLiteralExpression` → `object-literal` when assigned to an exported or
 *   configuration-shaped variable (or to `export default` / `module.exports`).
 * - Everything else → `unknown`.
 */
export function classifyNode(node: ts.Node): CodeBlockKind {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return 'function';
    case ts.SyntaxKind.ClassDeclaration:
      return 'class';
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration:
      return 'type-alias';
    case ts.SyntaxKind.EnumDeclaration:
      return 'enum';
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.ModuleBlock:
      return 'namespace';
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
      return 'method';
    case ts.SyntaxKind.Constructor:
      return 'constructor';
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return 'method';
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
      return isFunctionValuedProperty(node as ts.PropertyDeclaration | ts.PropertySignature)
        ? 'method'
        : 'unknown';
    case ts.SyntaxKind.PropertyAssignment:
      return isFunctionValue((node as ts.PropertyAssignment).initializer)
        ? 'arrow-function'
        : 'unknown';
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.VariableDeclaration:
      return classifyVariableNode(node as ts.VariableStatement | ts.VariableDeclaration);
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return 'arrow-function';
    case ts.SyntaxKind.Block:
      return isStatementPositionBlock(node as ts.Block) ? 'block' : 'unknown';
    case ts.SyntaxKind.ObjectLiteralExpression:
      return isConfigLikeObjectLiteral(node as ts.ObjectLiteralExpression)
        ? 'object-literal'
        : 'unknown';
    default:
      return 'unknown';
  }
}

/** True for kinds that denote something callable. */
export function isFunctionLike(kind: CodeBlockKind): boolean {
  return FUNCTION_LIKE_KINDS.has(kind);
}

/**
 * Best available human-readable name for a construct.
 *
 * Falls back to the enclosing binding for anonymous functions — that is what makes
 * `const f = () => {}` and `Service.prototype.validate = function () {}` show up
 * in a UI with something other than `<anon>`. Returns `null` when the construct
 * genuinely has no name (a bare statement block, an anonymous `export default`
 * class); callers substitute their own placeholder.
 */
export function blockLabel(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return namedDeclarationText(node.name);
  }

  if (ts.isModuleDeclaration(node)) {
    return namedDeclarationText(node.name);
  }

  if (ts.isModuleBlock(node)) {
    const owner = node.parent;
    return ts.isModuleDeclaration(owner) ? namedDeclarationText(owner.name) : null;
  }

  if (node.kind === ts.SyntaxKind.Constructor) {
    return 'constructor';
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    return propertyNameText(node.name);
  }

  if (
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node)
  ) {
    return propertyNameText(node.name);
  }

  if (ts.isVariableDeclaration(node)) {
    return identifierText(node.name);
  }

  if (ts.isVariableStatement(node)) {
    const first = node.declarationList.declarations[0];
    return first === undefined ? null : blockLabel(first);
  }

  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    // `const f = function g() {}` names itself `g`; an arrow has no own name.
    const own = ts.isFunctionExpression(node) ? node.name : undefined;
    return namedDeclarationText(own) ?? enclosingBindingLabel(node);
  }

  if (ts.isObjectLiteralExpression(node)) {
    return objectLiteralLabel(node);
  }

  return null;
}

/**
 * Renders a dotted name for an expression that is itself a name
 * (`Service`, `Service.prototype.validate`, `this.cache`).
 *
 * Shared with `./signature` so that "the name shown in the UI" and "the name shown
 * in the signature line" can never disagree. Returns `null` for anything that is
 * not a name, so callers never display `getText()` of an arbitrary expression.
 */
export function dottedName(node: ts.Node): string | null {
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this';
  }
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const left = dottedName(node.expression);
    return left === null ? null : `${left}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    const left = dottedName(node.expression);
    const arg = node.argumentExpression;
    if (left === null || arg === undefined) {
      return null;
    }
    const key = ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) ? arg.text : null;
    return key === null ? null : `${left}.${key}`;
  }
  return null;
}

/**
 * Text of a property name, including computed names.
 *
 * A computed name that is a plain member expression (`[Symbol.iterator]`) keeps
 * its readable form; anything else is bracketed so the UI never shows a wall of
 * expression source as a "name".
 */
export function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) {
    return null;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = dottedName(name.expression);
    return inner === null ? null : `[${inner}]`;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text.length > 0 ? name.text : null;
  }
  return null;
}

/** True when an expression is an inline function value. */
export function isFunctionValue(expression: ts.Expression | undefined): boolean {
  return (
    expression !== undefined &&
    (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
  );
}

/**
 * The body node of a callable, or `undefined` for anything else (including a
 * type node and an overload signature, which have no body).
 *
 * Written out node by node rather than as a cast from `ts.isFunctionLike` because
 * `SignatureDeclaration` also covers function *types*, which have no body at all.
 * Shared with `./blocks` so that "the body belongs to its owner" is decided the
 * same way in both the classifier and the extractor.
 */
export function callableBodyOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.body;
  }
  return undefined;
}

function isFunctionValuedProperty(node: ts.PropertyDeclaration | ts.PropertySignature): boolean {
  if (isFunctionValue(ts.isPropertyDeclaration(node) ? node.initializer : undefined)) {
    return true;
  }
  // A field declared with a function type (`onClick: (e: Event) => void`) is a
  // method in every respect except syntax, and tracking it is the point.
  const type = node.type;
  return type !== undefined && (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type));
}

function classifyVariableNode(node: ts.VariableStatement | ts.VariableDeclaration): CodeBlockKind {
  const declaration = ts.isVariableStatement(node)
    ? node.declarationList.declarations[0]
    : (node as ts.VariableDeclaration);
  if (declaration === undefined) {
    return 'variable';
  }
  const name = identifierText(declaration.name);
  if (name === null) {
    // Destructuring: `const { a, b } = opts`. There is no single identifier to
    // key a block on, so this stays a plain variable rather than inventing one.
    return 'variable';
  }
  return isFunctionValue(declaration.initializer) ? 'arrow-function' : 'variable';
}

/**
 * A `Block` is only a block of its own when it *is* a statement.
 *
 * The exclusions are the important part: a function/method/accessor body, a class
 * static block body, a `catch` body, a namespace body and a bare `{ }` used as an
 * object-literal/arrow body all belong to their owner. Emitting them would split
 * one function into two overlapping blocks and make the selection→block mapping
 * return the anonymous wrapper instead of the function the user pointed at.
 */
function isStatementPositionBlock(node: ts.Block): boolean {
  const parent = node.parent;
  if (ts.isSourceFile(parent)) {
    return false;
  }
  if (callableBodyOf(parent) === node) {
    return false;
  }
  if (
    ts.isClassStaticBlockDeclaration(parent) ||
    ts.isCatchClause(parent) ||
    ts.isModuleBlock(parent)
  ) {
    return false;
  }
  return ts.isStatement(parent) || ts.isCaseOrDefaultClause(parent);
}

function isConfigLikeObjectLiteral(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    if (isExportedVariable(parent)) {
      return true;
    }
    const name = identifierText(parent.name);
    return name !== null && looksLikeConfigName(name);
  }
  if (ts.isExportAssignment(parent) && parent.expression === node) {
    // `export default { … }` and `export = { … }` are both published module
    // surfaces, which is exactly what an object-literal block is for.
    return true;
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // `module.exports = { … }` is the CommonJS spelling of the same thing, and it
    // is how a large part of the JavaScript in any repository publishes itself.
    const target = dottedName(parent.left);
    return target === 'module.exports' || target === 'exports';
  }
  return false;
}

function isExportedVariable(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return false;
  }
  const statement = list.parent;
  return (
    ts.isVariableStatement(statement) &&
    (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function looksLikeConfigName(name: string): boolean {
  const lower = name.toLowerCase();
  return CONFIG_NAME_HINTS.some((hint) => lower.indexOf(hint) >= 0);
}

function namedDeclarationText(name: ts.Node | undefined): string | null {
  if (name === undefined) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text.length > 0 ? name.text : null;
  }
  return null;
}

function identifierText(name: ts.BindingName): string | null {
  return ts.isIdentifier(name) && name.text.length > 0 ? name.text : null;
}

function objectLiteralLabel(node: ts.ObjectLiteralExpression): string | null {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) {
    return identifierText(parent.name);
  }
  if (ts.isExportAssignment(parent)) {
    return parent.isExportEquals === true ? 'export=' : 'default';
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return dottedName(parent.left);
  }
  return null;
}

/**
 * Name a function inherits from the binding it is assigned to.
 *
 * Handles the three shapes that appear in real code: a `const` binding, an object
 * or class property (`Service.prototype.validate = function () {}` arrives as a
 * plain assignment to a member expression, not as a `PropertyAssignment`), and a
 * function nested directly inside another construct.
 */
function enclosingBindingLabel(node: ts.Node): string | null {
  const parent = node.parent;
  if (ts.isSourceFile(parent)) {
    return null;
  }
  if (ts.isVariableDeclaration(parent)) {
    return identifierText(parent.name);
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return propertyNameText(parent.name);
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return dottedName(parent.left);
  }
  return blockLabel(parent);
}
