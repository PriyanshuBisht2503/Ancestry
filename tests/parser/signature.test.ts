import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { buildQualifiedName, buildSignature, createSourceFile } from '../../src/parser';

function parse(text: string, path = 'src/sig.ts'): ts.SourceFile {
  return createSourceFile(path, text, 'typescript');
}

/** Locates a declaration by kind, optionally disambiguated by its own name. */
function find(sf: ts.SourceFile, kind: ts.SyntaxKind, name?: string): ts.Node | null {
  let found: ts.Node | null = null;
  const walk = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }
    if (node.kind === kind) {
      if (name === undefined || ownName(node, sf) === name) {
        found = node;
        return;
      }
    }
    node.forEachChild(walk);
  };
  sf.forEachChild(walk);
  return found;
}

function ownName(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  const named = (node as ts.NamedDeclaration).name;
  return named === undefined ? null : named.getText(sf);
}

function sign(text: string, kind: ts.SyntaxKind, name?: string): string | null {
  const sf = parse(text);
  const node = find(sf, kind, name);
  if (node === null) {
    throw new Error(`fixture did not contain a node of kind ${ts.SyntaxKind[kind]}`);
  }
  return buildSignature(node, sf);
}

describe('buildSignature', () => {
  it('renders a TypeScript method with parameters and a return type', () => {
    expect(
      sign(
        'class S { authenticate(token: string, ttl: number): Promise<void> { return; } }',
        ts.SyntaxKind.MethodDeclaration,
      ),
    ).toBe('authenticate(token: string, ttl: number): Promise<void>');
  });

  it('renders a generic function', () => {
    expect(
      sign(
        'function pick<T, U extends object>(a: T, b: U): T { return a; }',
        ts.SyntaxKind.FunctionDeclaration,
      ),
    ).toBe('function pick<T, U extends object>(a: T, b: U): T');
  });

  it('elides parameters past the eighth', () => {
    const text =
      'function many(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number): number { return a; }';
    expect(sign(text, ts.SyntaxKind.FunctionDeclaration)).toBe(
      'function many(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, …): number',
    );
  });

  it('caps the whole line at 240 characters', () => {
    const longType = Array.from({ length: 40 }, (_, i) => `Type${i}`).join(' | ');
    const text = `function wide(): ${longType} { throw new Error('x'); }`;
    const rendered = sign(text, ts.SyntaxKind.FunctionDeclaration) ?? '';
    expect(rendered.length).toBeLessThanOrEqual(240);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('does not invent a return type that the source never declared', () => {
    expect(sign('async function load(id) { return id; }', ts.SyntaxKind.FunctionDeclaration)).toBe(
      'async function load(id)',
    );
    expect(sign('function load(id) { return id; }', ts.SyntaxKind.FunctionDeclaration)).toBe(
      'function load(id)',
    );
  });

  it('renders a generator', () => {
    expect(sign('function* gen() { yield 1; }', ts.SyntaxKind.FunctionDeclaration)).toBe(
      'function* gen()',
    );
    expect(sign('class C { *walk() { yield 1; } }', ts.SyntaxKind.MethodDeclaration)).toBe(
      '*walk()',
    );
  });

  it('renders a member-assignment function with its dotted target', () => {
    expect(
      sign('Service.prototype.validate = function () {};', ts.SyntaxKind.FunctionExpression),
    ).toBe('Service.prototype.validate()');
  });

  it('renders accessors and a constructor', () => {
    expect(sign('class C { get id(): string { return ""; } }', ts.SyntaxKind.GetAccessor)).toBe(
      'get id()',
    );
    expect(sign('class C { set id(v: string) {} }', ts.SyntaxKind.SetAccessor)).toBe(
      'set id(v: string)',
    );
    expect(
      sign('class Service { constructor(private name: string) {} }', ts.SyntaxKind.Constructor),
    ).toBe('new Service(name: string)');
  });

  it('renders declarations that are not callables', () => {
    expect(
      sign('export class Api extends Base implements Options {}', ts.SyntaxKind.ClassDeclaration),
    ).toBe('class Api extends Base implements Options');
    expect(sign('interface Options { a: number }', ts.SyntaxKind.InterfaceDeclaration)).toBe(
      'interface Options',
    );
    expect(sign('enum Level { A, B }', ts.SyntaxKind.EnumDeclaration)).toBe('enum Level');
    expect(sign('namespace ns { export const a = 1; }', ts.SyntaxKind.ModuleDeclaration)).toBe(
      'namespace ns',
    );
    expect(sign('type Id = string | number;', ts.SyntaxKind.TypeAliasDeclaration)).toBe(
      'type Id = string | number',
    );
    expect(sign('const TIMEOUT = 5;', ts.SyntaxKind.VariableDeclaration)).toBe('TIMEOUT');
    expect(sign('const timeout: number = 5;', ts.SyntaxKind.VariableDeclaration)).toBe(
      'timeout: number',
    );
  });

  it('renders an object literal as its leading keys', () => {
    expect(
      sign(
        'export const config = { retries: 3, timeout: 5, label: "x", deep: 1, extra: 2 };',
        ts.SyntaxKind.ObjectLiteralExpression,
      ),
    ).toBe('{ retries, timeout, label, deep, … }');
  });

  it('renders a statement block', () => {
    const sf = parse('function f() { if (a) { b(); } }');
    const ifStatement = find(sf, ts.SyntaxKind.IfStatement) as ts.IfStatement;
    expect(buildSignature(ifStatement.thenStatement, sf)).toBe('{ … }');
  });

  it('strips comments and collapses whitespace', () => {
    expect(
      sign(
        'function spread(\n  /* leading */ a:   string, // trailing\n  b: number\n): void {}',
        ts.SyntaxKind.FunctionDeclaration,
      ),
    ).toBe('function spread(a: string, b: number): void');
  });

  it('returns null when there is nothing sensible to say', () => {
    const sf = parse('const a = 1;');
    const identifier = find(sf, ts.SyntaxKind.Identifier, 'a');
    expect(identifier).not.toBeNull();
    expect(buildSignature(identifier as ts.Node, sf)).toBeNull();
  });
});

describe('buildQualifiedName', () => {
  it('prefixes the enclosing class', () => {
    const sf = parse('class Service { validate() { return 1; } }');
    const method = find(sf, ts.SyntaxKind.MethodDeclaration, 'validate') as ts.Node;
    expect(buildQualifiedName(method, 'validate')).toBe('Service.validate');
  });

  it('walks nested namespaces', () => {
    const sf = parse('namespace ns { namespace inner { export function fn() {} } }');
    const fn = find(sf, ts.SyntaxKind.FunctionDeclaration, 'fn') as ts.Node;
    expect(buildQualifiedName(fn, 'fn')).toBe('ns.inner.fn');
  });

  it('handles a dotted namespace name', () => {
    const sf = parse('namespace a.b { export function fn() {} }');
    const fn = find(sf, ts.SyntaxKind.FunctionDeclaration, 'fn') as ts.Node;
    expect(buildQualifiedName(fn, 'fn')).toBe('a.b.fn');
  });

  it('returns the bare name for a top-level construct and null when there is none', () => {
    const sf = parse('function top() {}');
    const fn = find(sf, ts.SyntaxKind.FunctionDeclaration, 'top') as ts.Node;
    expect(buildQualifiedName(fn, 'top')).toBe('top');
    expect(buildQualifiedName(fn, null)).toBeNull();
  });

  it('does not loop forever on a cyclic parent chain', () => {
    const looping: { parent?: unknown; kind: number } = { kind: 1 };
    looping.parent = looping;
    expect(buildQualifiedName(looping as unknown as ts.Node, 'x')).toBe('x');
  });
});
