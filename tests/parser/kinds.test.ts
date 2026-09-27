import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { blockLabel, classifyNode, createSourceFile, isFunctionLike } from '../../src/parser';
import type { CodeBlockKind, SupportedLanguage } from '../../src/types';

/**
 * Finds the first node in source order that satisfies a predicate, so a test can
 * classify a construct without depending on how the compiler nests it.
 */
function firstNode(sf: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node | null {
  let found: ts.Node | null = null;
  const walk = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }
    if (predicate(node)) {
      found = node;
      return;
    }
    node.forEachChild(walk);
  };
  sf.statements.forEach(walk);
  return found;
}

/** Compiles a snippet and classifies the first node of the requested kind. */
function classifyFirst(text: string, kind: ts.SyntaxKind): CodeBlockKind | null {
  const sf = createSourceFile('src/kinds.ts', text, 'typescript');
  const node = firstNode(sf, (candidate) => candidate.kind === kind);
  return node === null ? null : classifyNode(node);
}

/** Compiles a snippet and labels the first node of the requested kind. */
function labelFirst(text: string, kind: ts.SyntaxKind): string | null {
  const sf = createSourceFile('src/kinds.ts', text, 'typescript');
  const node = firstNode(sf, (candidate) => candidate.kind === kind);
  return node === null ? null : blockLabel(node);
}

function parseAs(text: string, language: SupportedLanguage = 'typescript'): ts.SourceFile {
  return createSourceFile('src/kinds.ts', text, language);
}

describe('classifyNode', () => {
  it('classifies declarations', () => {
    expect(classifyFirst('function load() {}', ts.SyntaxKind.FunctionDeclaration)).toBe('function');
    expect(classifyFirst('class Service {}', ts.SyntaxKind.ClassDeclaration)).toBe('class');
    expect(classifyFirst('interface Options {}', ts.SyntaxKind.InterfaceDeclaration)).toBe(
      'interface',
    );
    expect(classifyFirst('type Id = string;', ts.SyntaxKind.TypeAliasDeclaration)).toBe(
      'type-alias',
    );
    expect(classifyFirst('enum Level { A }', ts.SyntaxKind.EnumDeclaration)).toBe('enum');
    expect(classifyFirst('namespace ns {}', ts.SyntaxKind.ModuleDeclaration)).toBe('namespace');
    expect(classifyFirst('class C { m() {} }', ts.SyntaxKind.MethodDeclaration)).toBe('method');
    expect(classifyFirst('class C { constructor() {} }', ts.SyntaxKind.Constructor)).toBe(
      'constructor',
    );
  });

  it('treats accessors as methods', () => {
    const sf = parseAs('class C { get value(): number { return 1; } }');
    const getter = firstNode(sf, (node) => node.kind === ts.SyntaxKind.GetAccessor);
    expect(getter).not.toBeNull();
    expect(classifyNode(getter as ts.Node)).toBe('method');

    const sf2 = parseAs('class C { set value(v: number) {} }');
    const setter = firstNode(sf2, (node) => node.kind === ts.SyntaxKind.SetAccessor);
    expect(classifyNode(setter as ts.Node)).toBe('method');
  });

  it('treats a function-valued property as a method but a data field as unknown', () => {
    expect(
      classifyFirst('class C { onClick = () => {}; }', ts.SyntaxKind.PropertyDeclaration),
    ).toBe('method');
    expect(
      classifyFirst('class C { onClick: (e: Event) => void; }', ts.SyntaxKind.PropertyDeclaration),
    ).toBe('method');
    expect(classifyFirst('class C { count = 0; }', ts.SyntaxKind.PropertyDeclaration)).toBe(
      'unknown',
    );
  });

  it('treats a function-valued object property as an arrow function and data as unknown', () => {
    expect(classifyFirst('const o = { onA: () => 1 };', ts.SyntaxKind.PropertyAssignment)).toBe(
      'arrow-function',
    );
    expect(classifyFirst('const o = { name: "x" };', ts.SyntaxKind.PropertyAssignment)).toBe(
      'unknown',
    );
  });

  it('separates function-valued variables from plain ones', () => {
    expect(classifyFirst('const load = () => 1;', ts.SyntaxKind.VariableDeclaration)).toBe(
      'arrow-function',
    );
    expect(classifyFirst('const load = function () {};', ts.SyntaxKind.VariableDeclaration)).toBe(
      'arrow-function',
    );
    expect(classifyFirst('const timeout = 5;', ts.SyntaxKind.VariableDeclaration)).toBe('variable');
    // Destructuring has no single identifier to key a block on.
    expect(classifyFirst('const { a, b } = opts;', ts.SyntaxKind.VariableDeclaration)).toBe(
      'variable',
    );
    expect(classifyFirst('const a = 1, b = 2;', ts.SyntaxKind.VariableStatement)).toBe('variable');
  });

  it('classifies a bare arrow or function expression as an arrow function', () => {
    expect(classifyFirst('items.map((x) => x * 2);', ts.SyntaxKind.ArrowFunction)).toBe(
      'arrow-function',
    );
    expect(
      classifyFirst('const o = { a: function () {} };', ts.SyntaxKind.FunctionExpression),
    ).toBe('arrow-function');
  });

  it('classifies a statement block but never a function body', () => {
    expect(
      classifyFirst('function f() { if (a) { b(); } }', ts.SyntaxKind.IfStatement),
    ).not.toBeNull();
    const sf = parseAs('function f() { if (a) { b(); } }');
    const blocks: ts.Block[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isBlock(node)) {
        blocks.push(node);
      }
      node.forEachChild(walk);
    };
    sf.forEachChild(walk);
    const kinds = blocks.map((block) => classifyNode(block));
    expect(kinds).toContain('block');
    expect(kinds.filter((kind) => kind === 'block')).toHaveLength(1);
  });

  it('classifies an exported or config-shaped object literal', () => {
    expect(
      classifyFirst('export const config = { a: 1 };', ts.SyntaxKind.ObjectLiteralExpression),
    ).toBe('object-literal');
    expect(
      classifyFirst('const defaultOptions = { a: 1 };', ts.SyntaxKind.ObjectLiteralExpression),
    ).toBe('object-literal');
    expect(classifyFirst('module.exports = { a: 1 };', ts.SyntaxKind.ObjectLiteralExpression)).toBe(
      'object-literal',
    );
    expect(classifyFirst('const point = { x: 1 };', ts.SyntaxKind.ObjectLiteralExpression)).toBe(
      'unknown',
    );
  });

  it('returns unknown for everything else', () => {
    const sf = parseAs('import x from "y";\nconst a = 1;\nwhile (a) { a--; }');
    const identifiers: ts.Identifier[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        identifiers.push(node);
      }
      node.forEachChild(walk);
    };
    sf.forEachChild(walk);
    expect(identifiers.length).toBeGreaterThan(0);
    for (const identifier of identifiers) {
      expect(classifyNode(identifier)).toBe('unknown');
    }
    expect(classifyNode(sf)).toBe('unknown');
    expect(classifyFirst('a.b();', ts.SyntaxKind.ExpressionStatement)).toBe('unknown');
  });
});

describe('isFunctionLike', () => {
  it('is true only for callable kinds', () => {
    expect(isFunctionLike('function')).toBe(true);
    expect(isFunctionLike('arrow-function')).toBe(true);
    expect(isFunctionLike('method')).toBe(true);
    expect(isFunctionLike('constructor')).toBe(true);
    expect(isFunctionLike('block')).toBe(false);
    expect(isFunctionLike('variable')).toBe(false);
    expect(isFunctionLike('class')).toBe(false);
    expect(isFunctionLike('unknown')).toBe(false);
  });
});

describe('blockLabel', () => {
  it('uses the declared name', () => {
    expect(labelFirst('export function load() {}', ts.SyntaxKind.FunctionDeclaration)).toBe('load');
    expect(labelFirst('class Service {}', ts.SyntaxKind.ClassDeclaration)).toBe('Service');
    expect(labelFirst('interface Options {}', ts.SyntaxKind.InterfaceDeclaration)).toBe('Options');
    expect(labelFirst('namespace ns {}', ts.SyntaxKind.ModuleDeclaration)).toBe('ns');
    expect(labelFirst('class C { authenticate() {} }', ts.SyntaxKind.MethodDeclaration)).toBe(
      'authenticate',
    );
  });

  it('labels a constructor', () => {
    expect(labelFirst('class C { constructor() {} }', ts.SyntaxKind.Constructor)).toBe(
      'constructor',
    );
  });

  it('borrows the binding name for an anonymous function', () => {
    expect(labelFirst('const load = () => 1;', ts.SyntaxKind.ArrowFunction)).toBe('load');
    expect(labelFirst('const o = { onA: () => 1 };', ts.SyntaxKind.ArrowFunction)).toBe('onA');
    expect(
      labelFirst('Service.prototype.validate = function () {};', ts.SyntaxKind.FunctionExpression),
    ).toBe('Service.prototype.validate');
    expect(labelFirst('const f = function g() {};', ts.SyntaxKind.FunctionExpression)).toBe('g');
  });

  it('has no name for an anonymous construct', () => {
    expect(labelFirst('items.map((x) => x);', ts.SyntaxKind.ArrowFunction)).toBeNull();
    const sf = parseAs('function f() { if (a) { b(); } }');
    const ifStatement = firstNode(sf, (node) => node.kind === ts.SyntaxKind.IfStatement);
    const body = (ifStatement as ts.IfStatement).thenStatement;
    expect(ts.isBlock(body)).toBe(true);
    expect(blockLabel(body)).toBeNull();
  });

  it('keeps computed and quoted property names readable', () => {
    const sf = parseAs('class C { *[Symbol.iterator]() {} }');
    const method = firstNode(sf, (node) => node.kind === ts.SyntaxKind.MethodDeclaration);
    expect(blockLabel(method as ts.Node)).toBe('[Symbol.iterator]');

    const sf2 = parseAs('class C { "quoted"() {} }');
    const method2 = firstNode(sf2, (node) => node.kind === ts.SyntaxKind.MethodDeclaration);
    expect(blockLabel(method2 as ts.Node)).toBe('quoted');
  });
});
