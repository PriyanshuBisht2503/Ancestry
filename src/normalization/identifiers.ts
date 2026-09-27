/**
 * Identifier role classification and name canonicalisation.
 *
 * This module is the reason a renamed function still matches its ancestors.
 * Two ideas do the work:
 *
 *  1. **Roles decide what survives.** Not every name is free to change: a
 *     property name, a type name and a module specifier are part of a program's
 *     observable contract (or of its dependency graph), so collapsing them
 *     would make genuinely different code hash the same. Those roles are
 *     *preserved* verbatim behind a namespace prefix.
 *  2. **Everything else is a number.** Anything declared inside the block is
 *     replaced by `id:n` in first-occurrence order, so `add(a, b)` and
 *     `sum(x, y)` produce byte-identical streams.
 *
 * The identifier-role table, as implemented:
 *
 * | Role       | Meaning                                            | Emitted       |
 * | ---------- | -------------------------------------------------- | ------------- |
 * | `local`    | variable/class/type/import declared inside block     | `id:n`        |
 * | `param`    | function parameter                                  | `id:n`        |
 * | `function` | function declared inside the block                   | `id:n`        |
 * | `member`   | class/enum member being declared                    | `id:n`        |
 * | `external` | free identifier resolving to nothing in the block    | `ext:<name>`  |
 * | `property` | `obj.foo`, `{ foo: 1 }`, class/interface member ref  | `prop:<name>` |
 * | `type`     | type-reference name                                 | `type:<name>` |
 * | `label`    | statement label                                     | `label:<name>`|
 * | `import`   | module specifier of an import / dynamic `import()`  | `mod:<name>`  |
 *
 * Preserved vs discarded, stated explicitly:
 *  - **Preserved:** `external`, `property`, `type`, `label` and `import` names,
 *    because they name a dependency, an API surface or a control-flow target.
 *    Discarding them would violate the plan's rule "do not remove information
 *    that changes program behavior".
 *  - **Discarded:** every local, parameter, function and member *name*. Only
 *    their identity-as-a-number survives, plus the `id:n` → original mapping in
 *    `NormalizedBlock.identifierMap` for explainability.
 *  - Module specifiers are the one place where preserved text equals raw source
 *    text (`mod:./utils`). It is kept because a block's dependency on a module
 *    is behaviourally significant, and it is the only source-derived string
 *    that reaches the stream. Everything else (string literals, template text,
 *    comments, formatting) never leaves `literals.ts`/`tokens.ts`.
 */

import * as ts from 'typescript';

/**
 * How an identifier occurrence is treated. See the module table above.
 *
 * `local`, `param`, `function` and `member` are *canonicalised* to `id:n`;
 * the remaining five are *preserved* with a role prefix.
 */
export type IdentifierRole =
  'local' | 'param' | 'function' | 'member' | 'external' | 'property' | 'type' | 'label' | 'import';

/** Value prefix per preserved role. Canonicalised roles have no prefix. */
const PRESERVED_PREFIX: Readonly<Partial<Record<IdentifierRole, string>>> = Object.freeze({
  external: 'ext:',
  property: 'prop:',
  type: 'type:',
  label: 'label:',
  import: 'mod:',
});

/** Options accepted by {@link createCanonicalizer}. */
export interface CanonicalizerOptions {
  /**
   * Keep the root declaration's own name verbatim instead of canonicalising it.
   *
   * Defaults to `false`. v1 canonicalises the root name on purpose: a *renamed*
   * function must still match its ancestors, and the function's name is the
   * single most likely thing to change in that scenario. Set this to `true` only
   * when the caller has already established that the name is stable (for
   * example a public API entry point), accepting that a rename then breaks
   * matching and that the real name re-enters `normalizedText`.
   */
  preserveDeclarationName?: boolean;
}

/**
 * Per-block name allocator.
 *
 * Implementations are stateful: allocate the numbers in traversal order, then
 * reuse the instance for the whole block so that the same original name always
 * maps to the same `id:n`.
 */
export interface Canonicalizer {
  /**
   * Canonicalise `name` for `role`. Repeated calls with the same name return the
   * same string within one block, which is what keeps structural fidelity (two
   * uses of one variable look identical).
   */
  canonicalize(name: string, role: IdentifierRole): string;
  /** Snapshot of the original → canonical map, for `NormalizedBlock.identifierMap`. */
  readonlyMap(): Record<string, string>;
  /** Number of distinct names allocated an `id:n`. */
  entryCount(): number;
}

/**
 * Create a name allocator for one block.
 *
 * The very first name passed to {@link Canonicalizer.canonicalize} is treated as
 * the *root declaration name* — the tokenizer seeds it before walking — so that
 * `preserveDeclarationName` affects exactly the construct being analysed and not
 * every function in the file.
 */
export function createCanonicalizer(options: CanonicalizerOptions = {}): Canonicalizer {
  const preserveDeclarationName = options.preserveDeclarationName === true;
  const allocated = new Map<string, string>();
  let counter = 0;
  let seeded = false;

  return {
    canonicalize(name: string, role: IdentifierRole): string {
      const prefix = PRESERVED_PREFIX[role];
      if (prefix !== undefined) {
        return prefix + name;
      }
      const existing = allocated.get(name);
      if (existing !== undefined) {
        return existing;
      }
      if (preserveDeclarationName && !seeded) {
        seeded = true;
        allocated.set(name, name);
        return name;
      }
      seeded = true;
      counter += 1;
      const value = `id:${counter}`;
      allocated.set(name, value);
      return value;
    },
    readonlyMap(): Record<string, string> {
      const snapshot: Record<string, string> = {};
      for (const [name, value] of allocated) {
        snapshot[name] = value;
      }
      return snapshot;
    },
    entryCount(): number {
      return allocated.size;
    },
  };
}

/** Names whose occurrence is a declaration binding rather than a reference. */
function addBindingName(target: Set<string>, name: ts.BindingName): void {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    addBindingName(target, element.name);
  }
}

/**
 * Local name introduced by an import clause.
 *
 * Always `ImportSpecifier.name`: it is the *alias* the import binds locally
 * (`import { a as b }` binds `b`). `propertyName` is the name in the other
 * module, which is API surface and must not enter the declared set or a
 * reference to it would be canonicalised away.
 */
function addImportSpecifierName(target: Set<string>, node: ts.ImportSpecifier): void {
  target.add(node.name.text);
}

/**
 * Every name bound by a declaration inside `root`.
 *
 * Collected up front, because the `external` versus `local` decision cannot be
 * made while walking: a local declared *after* its use still shadows a global of
 * the same name. The set is intentionally scope-insensitive (nested functions
 * contribute too): a block is canonicalised as a unit, and hoisting a name from
 * an inner scope into the block's namespace is what makes an extracted
 * function comparable with its ancestors.
 *
 * Preserved-role names are *not* collected — a property, type or module name
 * that happens to share a spelling with a local must still resolve to the local.
 */
export function collectDeclaredNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      addBindingName(names, node.name);
    } else if (ts.isBindingElement(node)) {
      addBindingName(names, node.name);
    } else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      if (node.name) {
        names.add(node.name.text);
      }
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.name) {
        names.add(node.name.text);
      }
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (node.name) {
        names.add(node.name.text);
      }
    } else if (ts.isEnumMember(node) || isTypeParameterDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    } else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      if (ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    } else if (ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name) {
        names.add(node.name.text);
      }
    } else if (ts.isImportSpecifier(node)) {
      addImportSpecifierName(names, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return names;
}

/** `ts` exposes no `isTypeParameter`; narrow on the kind instead. */
function isTypeParameterDeclaration(node: ts.Node): node is ts.TypeParameterDeclaration {
  return node.kind === ts.SyntaxKind.TypeParameter;
}

/** Direct parent relationships that decide a role without a wider search. */
function directRole(node: ts.Identifier, declared: ReadonlySet<string>): IdentifierRole | null {
  const parent = node.parent;
  if (parent === undefined) {
    return null;
  }
  const name = node.text;

  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return 'label';
  }
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) {
    return 'label';
  }
  if (ts.isParameter(parent) && parent.name === node) {
    return 'param';
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return 'property';
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return 'property';
  }
  if (ts.isJsxNamespacedName(parent) && parent.name === node) {
    return 'property';
  }
  if (ts.isQualifiedName(parent)) {
    return 'type';
  }
  if (ts.isComputedPropertyName(parent)) {
    return 'external';
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return 'property';
  }
  if (ts.isPropertySignature(parent) && parent.name === node) {
    return 'property';
  }
  if (ts.isMethodSignature(parent) && parent.name === node) {
    return 'member';
  }
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return 'member';
  }
  if (
    (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) &&
    parent.name === node
  ) {
    return 'function';
  }
  if (ts.isImportSpecifier(parent)) {
    // Both spellings name something that lives in another module, which the role
    // table lists under `external`: the imported name (`a` in `{ a as b }`) is
    // API surface, and the local alias is the binding the import introduces. The
    // alias is still in the declared set, so a *reference* to it elsewhere in the
    // block resolves to `local`.
    return 'external';
  }
  if (
    (ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      isTypeParameterDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === node
  ) {
    return 'local';
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    // The key is emitted separately by the tokenizer; this occurrence is the
    // value reference, so fall through to the value rules.
    return null;
  }
  if (ts.isMetaProperty(parent)) {
    return 'external';
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) {
    return declared.has(name) ? 'function' : 'external';
  }
  if (ts.isTypeQueryNode(parent) && parent.exprName === node) {
    // `typeof x` references a value, not a type: keep the value rules.
    return null;
  }
  return null;
}

/** Containers whose children are members rather than statements or bindings. */
function isMemberOwner(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isTypeLiteralNode(node) ||
    ts.isEnumDeclaration(node)
  );
}

/**
 * True when `child` sits in `parent`'s *name* position.
 *
 * The member fallback must not fire for a name merely nested inside a class — a
 * superclass reference (`class A extends B`) is inside the class body but is a
 * value reference, not a member being declared.
 */
function isNamePositionOf(parent: ts.Node, child: ts.Node): boolean {
  if (!ts.isIdentifier(child)) {
    return false;
  }
  switch (parent.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.TypeLiteral:
    case ts.SyntaxKind.ObjectLiteralExpression:
      return (parent as ts.NamedDeclaration).name === child;
    default:
      return false;
  }
}

/** Nodes that end the upward search: past them, nothing is a member of the block. */
function isScopeBoundary(node: ts.Node): boolean {
  return (
    isMemberOwner(node) ||
    ts.isStatement(node) ||
    ts.isSourceFile(node) ||
    ts.isFunctionLike(node) ||
    ts.isObjectLiteralExpression(node)
  );
}

/**
 * Decide the role of one identifier occurrence.
 *
 * Resolution order (first match wins):
 *  1. statement / loop label → `label`
 *  2. parameter binding → `param`
 *  3. `obj.foo`, `{ foo: 1 }`, JSX attribute, computed-name escape hatch → `property`
 *  4. qualified name, or any identifier sitting in a type position → `type`
 *  5. class / enum member being declared → `member`
 *  6. function being declared → `function`; call or `new` target → `function`
 *     when it resolves to a declaration in the block, else `external`; import
 *     specifier names → `external` (they name another module's API)
 *  7. declaration binding → `local`
 *  8. fallback: `declared.has(name) ? 'local' : 'external'`
 *
 * Rule 4 is why a local variable that shadows a global of the same name still
 * resolves to `local` *as a reference* while its own declaration resolves to
 * `local` too: a declaration name is never in a type position, and a
 * type-position reference to a local name is rare enough that preserving it
 * (`type:x`) is the conservative choice — it can only cause false *differences*,
 * never a false match.
 */
export function classifyIdentifier(
  node: ts.Identifier,
  root: ts.Node,
  declared: ReadonlySet<string>,
): IdentifierRole {
  const name = node.text;
  const direct = directRole(node, declared);
  if (direct !== null) {
    return direct;
  }
  if (ts.isPartOfTypeNode(node)) {
    return 'type';
  }
  // Declaration targets the direct rules did not cover: walk up towards `root`
  // looking for a member container, stopping at the first scope boundary so a
  // reference nested inside a class is not mistaken for a member declaration.
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined && current !== root) {
    if (isMemberOwner(parent) && isNamePositionOf(parent, current)) {
      return 'member';
    }
    if (isScopeBoundary(parent)) {
      break;
    }
    current = parent;
    parent = parent.parent;
  }
  return declared.has(name) ? 'local' : 'external';
}
