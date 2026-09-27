/**
 * One-line, human-readable signatures for a construct.
 *
 * Signatures are what a user reads in a tooltip, a filter list, or the ancestry
 * sidebar, so the constraints are aesthetic before they are technical: a single
 * line, no comments, no line breaks, bounded length. They are derived from the
 * AST rather than from the raw text so that a signature never changes because
 * someone reformatted the declaration — the signature is part of a block's
 * *identity* in the UI, not part of its content.
 */

import * as ts from 'typescript';
import { blockLabel, classifyNode, propertyNameText } from './kinds';
import type { CodeBlockKind } from '../types';

/** Hard cap on a rendered signature. */
const MAX_SIGNATURE_LENGTH = 240;

/** Per-segment caps, so one enormous type annotation cannot swallow the line. */
const MAX_RETURN_TYPE_LENGTH = 80;
const MAX_ALIAS_TARGET_LENGTH = 60;
const MAX_BINDING_NAME_LENGTH = 40;

/**
 * Parameters shown before the list is elided. Eight is chosen because no real
 * call site has more and the extra ones are almost always destructuring noise.
 */
const MAX_PARAMETERS = 8;

/** Object-literal keys shown in a signature. */
const MAX_OBJECT_KEYS = 4;

/** Upper bound on the number of `parent` hops walked while building a qualified name. A malformed or synthesised tree can in principle contain a cycle; the visited-set already stops that, and this bound makes the worst case provable. */
const MAX_CONTAINER_DEPTH = 64;

/**
 * Builds the single-line signature for a node, or `null` when nothing sensible can
 * be said.
 *
 * Shape: `[async ]function <name><T>(<params>)<: <type>>`, without the
 * `function` keyword when the value is reachable through a name (a `const` binding
 * or a member assignment), because `config.onTimeout(0): void` reads better than
 * `function config.onTimeout(0)`.
 *
 * Return types are printed **only when the source declares them**. There is no
 * invented placeholder for a missing annotation: the annotation's presence is
 * itself a meaningful, stable fact about the block, and fabricating a slot for it
 * would make every JavaScript function render identically to every typed one.
 *
 * Formatting-only details (`static`, `export`, `public`/`private`, parameter
 * default values, overload indices) are dropped on purpose: they change during
 * refactors that do not change what the code does, and Ancestry must not make a
 * signature look different because of that.
 *
 * The line is truncated with a U+2026 ellipsis at {@link MAX_PARAMETERS} parameters,
 * at {@link MAX_SIGNATURE_LENGTH} characters, and at the per-segment caps.
 */
export function buildSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  const kind = classifyNode(node);
  const target = resolveSignatureTarget(node, kind);
  if (target === null) {
    return null;
  }
  const raw = signatureForNode(target.node, sf, kind);
  if (raw === null) {
    return null;
  }
  const collapsed = collapseWhitespace(raw);
  if (collapsed.length === 0) {
    return null;
  }
  return truncate(collapsed, MAX_SIGNATURE_LENGTH);
}

/**
 * Dotted name for a block: the enclosing class/namespace path plus the block's own
 * name, e.g. `Service.authenticate` or `ns.inner.fn`.
 *
 * Only class-like and namespace-like containers contribute. Function containers do
 * not: a helper nested in a helper is described by its own block and by its
 * `container` field, and folding the outer function into the name would make the
 * qualified name churn every time an unrelated wrapper is inserted.
 *
 * The walk is cycle-guarded twice (visited set *and* a depth bound) because it
 * follows `parent` links on trees that may have been produced by a recovering
 * parser, where the invariants are not guaranteed.
 */
export function buildQualifiedName(node: ts.Node, name: string | null): string | null {
  const segments: string[] = [];
  const seen = new Set<ts.Node>();
  let current: ts.Node = node.parent;
  let depth = 0;

  while (!ts.isSourceFile(current) && depth < MAX_CONTAINER_DEPTH) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const segment = containerSegment(current);
    if (segment !== null) {
      segments.unshift(segment);
    }
    current = current.parent;
    depth++;
  }

  if (name !== null && name.length > 0) {
    segments.push(name);
  }
  return segments.length === 0 ? null : segments.join('.');
}

/** Name of an enclosing class/namespace, or null for anything else. */
function containerSegment(node: ts.Node): string | null {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name !== undefined && node.name.text.length > 0 ? node.name.text : null;
  }
  if (ts.isModuleDeclaration(node)) {
    // A `ModuleBlock` contributes nothing: its parent `ModuleDeclaration` already
    // carries the name, and counting both would render `ns.ns.inner`.
    return node.name !== undefined && node.name.text.length > 0 ? node.name.text : null;
  }
  return null;
}

/**
 * Finds the node a signature should be derived from.
 *
 * A `const load = async () => {}` is classified as an `arrow-function` block whose
 * node is a `VariableDeclaration`; the interesting parts live on the initialiser.
 * Delegating here means every branch below can assume a construct it understands.
 */
function resolveSignatureTarget(
  node: ts.Node,
  kind: CodeBlockKind,
): { node: ts.Node; kind: CodeBlockKind } | null {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    const initializer = node.initializer;
    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      return { node: initializer, kind };
    }
  }
  if (kind === 'unknown') {
    return null;
  }
  return { node, kind };
}

function signatureForNode(node: ts.Node, sf: ts.SourceFile, kind: CodeBlockKind): string | null {
  switch (kind) {
    case 'function':
    case 'arrow-function':
      return callableSignature(node, sf);
    case 'method':
      return methodSignature(node, sf);
    case 'constructor':
      return constructorSignature(node, sf);
    case 'class':
      return classSignature(node, sf);
    case 'interface':
      return heritageSignature(node, sf, 'interface');
    case 'type-alias':
      return typeAliasSignature(node, sf);
    case 'enum':
      return `enum ${blockLabel(node) ?? ''}`.trim();
    case 'namespace':
      return `namespace ${blockLabel(node) ?? ''}`.trim();
    case 'object-literal':
      return objectLiteralSignature(node);
    case 'variable':
      return variableSignature(node, sf);
    case 'block':
      return '{ … }';
    case 'unknown':
    default:
      return null;
  }
}

/**
 * Shared shape for function declarations, function expressions and arrows.
 */
function callableSignature(node: ts.Node, sf: ts.SourceFile): string {
  const prefix: string[] = [];
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
    prefix.push('async');
  }
  const name = callableName(node);
  const isArrow = ts.isArrowFunction(node);
  // The `function` keyword belongs to the *declaration form*. A function
  // expression is only rendered with it when the name shown is its own
  // (`const f = function g() {}` → `function g()`); when the name comes from the
  // binding it was assigned to, the binding reads better on its own
  // (`Service.prototype.validate = function () {}` → `Service.prototype.validate()`).
  const useKeyword = ts.isFunctionDeclaration(node) || isSelfNamedFunctionExpression(node, name);
  if (useKeyword) {
    prefix.push(isGenerator(node) ? 'function*' : 'function');
  }
  // The name, its type parameters and the parameter list are glued together: they
  // are one syntactic run in the source, and inserting a space would make the
  // rendered signature differ from the declaration it describes.
  const head = `${name ?? ''}${typeParametersText(node, sf)}(${parameterList(node, sf)})`;
  const line = [...prefix, `${head}${returnTypeText(node, sf)}`]
    .filter((part) => part.length > 0)
    .join(' ');
  return isArrow && name === null ? `${line} =>` : line;
}

function methodSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = accessorName(node);
    if (name === null) {
      return null;
    }
    const keyword = ts.isGetAccessorDeclaration(node) ? 'get ' : 'set ';
    return `${keyword}${name}${typeParametersText(node, sf)}(${parameterList(node, sf)})`;
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    const prefix: string[] = [];
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
      prefix.push('async');
    }
    const name = propertyNameText(node.name);
    if (name === null) {
      return null;
    }
    const head = `${isGenerator(node) ? '*' : ''}${name}${typeParametersText(node, sf)}(${parameterList(
      node,
      sf,
    )})`;
    return [...prefix, `${head}${returnTypeText(node, sf)}`]
      .filter((part) => part.length > 0)
      .join(' ');
  }
  // A function-valued class field reached through its declaration.
  if (ts.isPropertyDeclaration(node)) {
    return node.initializer !== undefined ? callableSignature(node.initializer, sf) : null;
  }
  return null;
}

function constructorSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  if (!ts.isConstructorDeclaration(node)) {
    return null;
  }
  const owner = ts.isClassLike(node.parent) ? node.parent.name?.text : undefined;
  const name = owner !== undefined && owner.length > 0 ? owner : 'constructor';
  return `new ${name}${typeParametersText(node, sf)}(${parameterList(node, sf)})`;
}

function classSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) {
    return null;
  }
  const parts: string[] = ['class'];
  const name = node.name !== undefined ? node.name.text : null;
  if (name !== null && name.length > 0) {
    parts.push(name);
  }
  parts.push(typeParametersText(node, sf));
  const heritage = heritageText(node, sf);
  if (heritage !== null) {
    parts.push(heritage);
  }
  return parts.join(' ');
}

function heritageSignature(node: ts.Node, sf: ts.SourceFile, keyword: string): string | null {
  if (!ts.isInterfaceDeclaration(node) && !ts.isClassDeclaration(node)) {
    return null;
  }
  const parts: string[] = [keyword];
  if (node.name !== undefined && node.name.text.length > 0) {
    parts.push(node.name.text);
  }
  parts.push(typeParametersText(node, sf));
  const heritage = heritageText(node, sf);
  if (heritage !== null) {
    parts.push(heritage);
  }
  return parts.join(' ');
}

function typeAliasSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  if (!ts.isTypeAliasDeclaration(node)) {
    return null;
  }
  const name = node.name.text;
  const target = collapseWhitespace(textOf(node.type, sf));
  const rendered = truncate(target, MAX_ALIAS_TARGET_LENGTH);
  const parameters = typeParametersText(node, sf);
  return `type ${name}${parameters} = ${rendered.length === 0 ? '…' : rendered}`;
}

function objectLiteralSignature(node: ts.Node): string | null {
  if (!ts.isObjectLiteralExpression(node)) {
    return null;
  }
  const keys: string[] = [];
  for (const member of node.properties) {
    if (keys.length >= MAX_OBJECT_KEYS) {
      break;
    }
    const key = propertyNameText(member.name);
    if (key !== null) {
      keys.push(key);
    }
  }
  const body = keys.join(', ');
  const elision = node.properties.length > keys.length ? ', …' : '';
  return `{ ${body}${elision} }`;
}

function variableSignature(node: ts.Node, sf: ts.SourceFile): string | null {
  const declaration = ts.isVariableStatement(node)
    ? node.declarationList.declarations[0]
    : ts.isVariableDeclaration(node)
      ? node
      : undefined;
  if (declaration === undefined) {
    return null;
  }
  const name = blockLabel(declaration);
  if (name === null) {
    return null;
  }
  const type =
    declaration.type !== undefined
      ? truncate(collapseWhitespace(textOf(declaration.type, sf)), MAX_RETURN_TYPE_LENGTH)
      : '';
  return type.length === 0 ? name : `${name}: ${type}`;
}

/**
 * The name a callable presents, in order of preference: its own name (a named
 * function expression), then the name inherited from what it is bound to — which
 * covers `const load = ...` as well as the dotted
 * `Service.prototype.validate = function () {}` shape.
 */
function callableName(node: ts.Node): string | null {
  if (ts.isFunctionExpression(node) && node.name !== undefined && node.name.text.length > 0) {
    return node.name.text;
  }
  const label = blockLabel(node);
  return label === null ? null : truncate(label, MAX_BINDING_NAME_LENGTH);
}

/** True when a function expression's rendered name is the name it declared itself. */
function isSelfNamedFunctionExpression(node: ts.Node, name: string | null): boolean {
  return ts.isFunctionExpression(node) && node.name !== undefined && name === node.name.text;
}

function accessorName(node: ts.AccessorDeclaration): string | null {
  return propertyNameText(node.name);
}

function isGenerator(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.asteriskToken !== undefined;
  }
  return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function parameterList(node: ts.Node, sf: ts.SourceFile): string {
  if (!ts.isFunctionLike(node)) {
    return '';
  }
  const parameters = node.parameters;
  const shown = Math.min(parameters.length, MAX_PARAMETERS);
  const parts: string[] = [];
  for (let i = 0; i < shown; i++) {
    parts.push(parameterText(parameters[i], sf));
  }
  if (parameters.length > shown) {
    parts.push('…');
  }
  return parts.join(', ');
}

function parameterText(parameter: ts.ParameterDeclaration, sf: ts.SourceFile): string {
  const prefix = parameter.dotDotDotToken !== undefined ? '...' : '';
  let name = prefix + collapseWhitespace(textOf(parameter.name, sf));
  if (parameter.questionToken !== undefined) {
    name += '?';
  }
  if (parameter.type === undefined) {
    return name;
  }
  return `${name}: ${collapseWhitespace(textOf(parameter.type, sf))}`;
}

function typeParametersText(node: ts.Node, sf: ts.SourceFile): string {
  if (!ts.isFunctionLike(node) || node.typeParameters === undefined) {
    return '';
  }
  const inner = node.typeParameters
    .map((parameter) => collapseWhitespace(textOf(parameter, sf)))
    .filter((parameter) => parameter.length > 0)
    .join(', ');
  return inner.length === 0 ? '' : `<${inner}>`;
}

function returnTypeText(node: ts.Node, sf: ts.SourceFile): string {
  if (!ts.isFunctionLike(node) || node.type === undefined) {
    return '';
  }
  const rendered = truncate(collapseWhitespace(textOf(node.type, sf)), MAX_RETURN_TYPE_LENGTH);
  return rendered.length === 0 ? '' : `: ${rendered}`;
}

/** `extends Base` / `implements Foo, Bar`, whichever the node declares. */
function heritageText(
  node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
  sf: ts.SourceFile,
): string | null {
  const clauses = node.heritageClauses;
  if (clauses === undefined || clauses.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const clause of clauses) {
    const keyword =
      clause.token === ts.SyntaxKind.ExtendsKeyword
        ? 'extends'
        : clause.token === ts.SyntaxKind.ImplementsKeyword
          ? 'implements'
          : null;
    if (keyword === null) {
      continue;
    }
    const types = clause.types.map((type) => collapseWhitespace(textOf(type, sf)));
    if (types.length > 0) {
      parts.push(`${keyword} ${types.join(', ')}`);
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** `node.getText(sf)`, guarded against a detached node. */
function textOf(node: ts.Node, sf: ts.SourceFile): string {
  return sf.text.slice(node.getStart(sf), node.getEnd());
}

/**
 * Collapses every run of whitespace to a single space.
 *
 * Comments are removed as a side effect of operating on the AST (a comment is
 * trivia, not a child), so no comment stripping pass is needed or wanted.
 */
function collapseWhitespace(value: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isSpace =
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 13 ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0xa0;
    if (isSpace) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += value[i];
  }
  return out;
}

/** Cuts to `limit` characters, spending one of them on the ellipsis. */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  if (limit <= 1) {
    return '…';
  }
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}
