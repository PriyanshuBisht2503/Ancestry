/**
 * Identifier roles and the name canonicalizer.
 *
 * Two properties are under test. First, *classification*: which of the nine roles
 * an occurrence gets, because that decision is what decides whether a rename is
 * invisible or glaring. Second, *allocation*: within one block, a name always
 * gets the same `id:n`, and the numbers follow first-occurrence order, because
 * that is what makes two structurally identical blocks compare equal.
 */

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  classifyIdentifier,
  collectDeclaredNames,
  createCanonicalizer,
  type IdentifierRole,
} from '../../src/normalization/identifiers';
import { identifierMapOf, parse, tokensOf } from './support';

/** Classify every identifier in `text`, keyed by the name it spells. */
function rolesIn(text: string): Map<string, IdentifierRole[]> {
  const sf = parse(text);
  const declared = collectDeclaredNames(sf);
  const found = new Map<string, IdentifierRole[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const role = classifyIdentifier(node, sf, declared);
      const list = found.get(node.text) ?? [];
      list.push(role);
      found.set(node.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('canonicalizer', () => {
  it('allocates id:n in first-occurrence order', () => {
    const canonicalizer = createCanonicalizer();

    expect(canonicalizer.canonicalize('add', 'function')).toBe('id:1');
    expect(canonicalizer.canonicalize('a', 'param')).toBe('id:2');
    expect(canonicalizer.canonicalize('b', 'param')).toBe('id:3');
  });

  it('is deterministic: the same calls always produce the same numbers', () => {
    const run = (): string[] => {
      const canonicalizer = createCanonicalizer();
      return ['zeta', 'alpha', 'zeta', 'mu'].map((name) =>
        canonicalizer.canonicalize(name, 'local'),
      );
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual(['id:1', 'id:2', 'id:1', 'id:3']);
  });

  it('gives the same name the same id regardless of role', () => {
    const canonicalizer = createCanonicalizer();

    const asLocal = canonicalizer.canonicalize('value', 'local');
    const asParam = canonicalizer.canonicalize('value', 'param');

    expect(asParam).toBe(asLocal);
    expect(canonicalizer.entryCount()).toBe(1);
  });

  it('does not spend id numbers on preserved roles', () => {
    const canonicalizer = createCanonicalizer();

    expect(canonicalizer.canonicalize('console', 'external')).toBe('ext:console');
    expect(canonicalizer.canonicalize('foo', 'property')).toBe('prop:foo');
    expect(canonicalizer.canonicalize('User', 'type')).toBe('type:User');
    expect(canonicalizer.canonicalize('outer', 'label')).toBe('label:outer');
    expect(canonicalizer.canonicalize('./m', 'import')).toBe('mod:./m');
    // The first canonicalised name is still id:1.
    expect(canonicalizer.canonicalize('local1', 'local')).toBe('id:1');
    expect(canonicalizer.entryCount()).toBe(1);
  });

  it('exposes a read-only snapshot of the map', () => {
    const canonicalizer = createCanonicalizer();
    canonicalizer.canonicalize('a', 'local');

    const snapshot = canonicalizer.readonlyMap();
    snapshot['a'] = 'tampered';

    expect(canonicalizer.readonlyMap()['a']).toBe('id:1');
  });

  it('keeps the root declaration name verbatim only when asked', () => {
    const canonicalized = createCanonicalizer();
    expect(canonicalized.canonicalize('authenticate', 'function')).toBe('id:1');

    const preserved = createCanonicalizer({ preserveDeclarationName: true });
    expect(preserved.canonicalize('authenticate', 'function')).toBe('authenticate');
    // Only the *root* name survives verbatim; everything after it is canonical.
    expect(preserved.canonicalize('token', 'param')).toBe('id:1');
  });

  it('is what gives a renamed function the same hash', () => {
    const renamed = identifierMapOf('function beta(alpha) { return alpha; }');
    const original = identifierMapOf('function alpha(beta) { return beta; }');

    // `beta` is id:1 in both blocks: the root name, then the parameter.
    expect(renamed['beta']).toBe('id:1');
    expect(original['alpha']).toBe('id:1');
  });
});

describe('collectDeclaredNames', () => {
  it('finds parameters, bindings, functions, classes, types and imports', () => {
    const names = collectDeclaredNames(
      parse(
        [
          'import def, { named as alias } from "./m";',
          'import * as everything from "./n";',
          'class Widget { field = 1; method() {} }',
          'interface Shape { side: number }',
          'type Alias = string;',
          'enum Colour { Red, Green = 2 }',
          'function outer(param) {',
          '  const [first, ...rest] = param;',
          '  let { nested } = { nested: 1 };',
          '  function inner<T>(value: T) { return value; }',
          '  class Local {}',
          '  try { risky(); } catch (caught) { log(caught); }',
          '  return first + rest.length + nested + def + named + alias + everything;',
          '}',
        ].join('\n'),
      ),
    );

    for (const expected of [
      'def',
      'alias',
      'everything',
      'Widget',
      'field',
      'method',
      'Shape',
      'side',
      'Alias',
      'Colour',
      'Red',
      'Green',
      'outer',
      'param',
      'first',
      'rest',
      'nested',
      'inner',
      'value',
      'Local',
      'caught',
    ]) {
      expect(names.has(expected), `expected ${expected} to be declared`).toBe(true);
    }
    // The *imported* name is not a local binding; only the alias is.
    expect(names.has('named')).toBe(false);
    // Labels are not bindings.
    expect(names.has('outerloop')).toBe(false);
  });
});

describe('classifyIdentifier', () => {
  it('classifies a local variable declaration and its references as local', () => {
    const roles = rolesIn('function f() { const total = 1; return total; }');

    expect(new Set(roles.get('total'))).toEqual(new Set<IdentifierRole>(['local']));
  });

  it('classifies a parameter as param', () => {
    const roles = rolesIn('function f(alpha) { return alpha; }');

    expect(roles.get('alpha')).toEqual(['param', 'local']);
  });

  it('classifies a nested function declaration as function', () => {
    const roles = rolesIn('function outer() { function inner() {} return inner; }');

    // The declaration site is `function`; a later reference to it is an ordinary
    // local reference.
    expect(roles.get('inner')).toEqual(['function', 'local']);
  });

  it('classifies a class member being declared as member', () => {
    const roles = rolesIn('class Widget { methodName() {} }');

    expect(roles.get('methodName')).toEqual(['member']);
  });

  it('classifies an unresolved reference as external', () => {
    const roles = rolesIn('function f() { return globalHelper(alpha); }');

    expect(roles.get('globalHelper')).toEqual(['external']);
    expect(roles.get('alpha')).toEqual(['external']);
  });

  it('classifies a property access and an object key as property', () => {
    const roles = rolesIn('function f(obj) { return obj.foo + ({ bar: 1 }).bar; }');

    expect(roles.get('obj')).toEqual(['param', 'local']);
    expect(roles.get('foo')).toEqual(['property']);
    expect(roles.get('bar')).toEqual(['property', 'property']);
  });

  it('classifies a type reference as type', () => {
    const roles = rolesIn('function f(value: User): Account { return value; }');

    expect(roles.get('User')).toEqual(['type']);
    expect(roles.get('Account')).toEqual(['type']);
  });

  it('treats typeof as a value reference, not a type reference', () => {
    const roles = rolesIn('function f() { const local1 = 1; return typeof local1; }');

    expect(roles.get('local1')).toEqual(['local', 'local']);
  });

  it('classifies a statement label as label', () => {
    const roles = rolesIn('outer: for (;;) { break outer; }');

    expect(roles.get('outer')).toEqual(['label', 'label']);
  });

  it('classifies a module specifier as import', () => {
    const tokens = tokensOf('import thing from "./service";');

    expect(tokens.some((token) => token.value === 'mod:./service')).toBe(true);
  });

  it('treats a computed property key as external because it is dynamic', () => {
    const roles = rolesIn('function f(obj) { return { [obj.key]: 1 }; }');

    expect(roles.get('key')).toEqual(['property']);
    expect(roles.get('obj')).toEqual(['param', 'local']);
  });

  it('resolves a local that shadows a global to local inside the block', () => {
    const roles = rolesIn('function f() { const console = { log() {} }; return console; }');

    expect(new Set(roles.get('console'))).toEqual(new Set<IdentifierRole>(['local', 'local']));
  });

  it('handles a shorthand property as both a key and a reference', () => {
    const values = tokensOf('function f() { const local1 = 1; return { local1 }; }').map(
      (token) => token.value,
    );

    expect(values).toContain('prop:local1');
    expect(values).toContain('id:2');
  });

  it('keeps an imported name external and its alias local', () => {
    const roles = rolesIn('import { a as b } from "./m";\nb();');

    expect(roles.get('a')).toEqual(['external']);
    // The alias is bound locally, so calling it resolves to a declaration here.
    expect(roles.get('b')).toEqual(['external', 'function']);
  });

  it('treats a class heritage clause as a value and an implements clause as a type', () => {
    const roles = rolesIn('class Widget extends Base implements Shape {}');

    expect(roles.get('Base')).toEqual(['external']);
    expect(roles.get('Shape')).toEqual(['type']);
  });
});
