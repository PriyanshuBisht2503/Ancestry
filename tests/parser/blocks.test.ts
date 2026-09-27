import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { collectDiagnostics, createSourceFile, extractBlocks, parseSource } from '../../src/parser';
import { makeBlockId } from '../../src/types';
import type { CodeBlock, CodeBlockKind } from '../../src/types';

/** A realistic module: every construct the extractor is expected to recognise. */
const REALISTIC = `/** Top-of-file documentation for the service module. */
import { readFile } from 'node:fs/promises';

export const TIMEOUT_MS = 5_000;

export interface Options {
  retries: number;
}

export type Handler = (event: string) => void;

export enum Level {
  Debug = 0,
  Info = 1,
}

export const config = {
  retries: 3,
  level: Level.Info,
  onError: (error: unknown) => {
    return String(error);
  },
};

export namespace transport {
  export function inner<T>(value: T): T {
    return value;
  }
}

export class Service {
  #cache = new Map<string, string>();
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get id(): string {
    return this.name;
  }

  async load(id: string): Promise<string> {
    return readFile(id).then((data) => data.toString());
  }
}

export function compute(x: number): number {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}
`;

function blocksOf(text: string, path = 'src/service.ts'): CodeBlock[] {
  return parseSource(path, text).blocks;
}

function byName(blocks: readonly CodeBlock[], name: string): CodeBlock | undefined {
  return blocks.find((block) => block.name === name);
}

function kindsOf(blocks: readonly CodeBlock[]): CodeBlockKind[] {
  return [...new Set(blocks.map((block) => block.kind))].sort();
}

describe('extractBlocks on a realistic module', () => {
  const result = parseSource('src/service.ts', REALISTIC);

  it('reports no diagnostics for valid source', () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.language).toBe('typescript');
    expect(result.sourceLength).toBe(REALISTIC.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('produces every recognised kind', () => {
    expect(kindsOf(result.blocks)).toEqual(
      [
        'arrow-function',
        'block',
        'class',
        'constructor',
        'enum',
        'function',
        'interface',
        'method',
        'namespace',
        'type-alias',
        'variable',
      ].sort(),
    );
  });

  it('keeps the doc comment out of the block range', () => {
    const service = byName(result.blocks, 'Service');
    expect(service).toBeDefined();
    // The JSDoc occupies line 1; the class starts well after it.
    expect(service?.range.startLine).toBe(31);
    expect(service?.text.startsWith('export class Service')).toBe(true);
    expect(service?.text).not.toContain('Top-of-file documentation');
  });

  it('wires the containment tree for a method inside a class inside a namespace', () => {
    const namespace = byName(result.blocks, 'transport');
    const classBlock = byName(result.blocks, 'Service');
    const method = byName(result.blocks, 'load');
    const inner = byName(result.blocks, 'inner');
    const getter = result.blocks.filter((block) => block.name === 'id');
    const constructor = byName(result.blocks, 'constructor');

    expect(namespace?.parentId).toBeNull();
    expect(classBlock?.parentId).toBeNull();
    expect(method?.parentId).toBe(classBlock?.id);
    expect(constructor?.parentId).toBe(classBlock?.id);
    expect(getter.every((block) => block.parentId === classBlock?.id)).toBe(true);
    expect(inner?.parentId).toBe(namespace?.id);
  });

  it('names the enclosing class or function as the container', () => {
    expect(byName(result.blocks, 'load')?.container).toBe('Service');
    expect(byName(result.blocks, 'constructor')?.container).toBe('Service');
    expect(byName(result.blocks, 'inner')?.container).toBe('transport');
    expect(byName(result.blocks, 'Service')?.container).toBeNull();
    expect(byName(result.blocks, 'compute')?.container).toBeNull();
  });

  it('qualifies names through classes and namespaces', () => {
    expect(byName(result.blocks, 'load')?.qualifiedName).toBe('Service.load');
    expect(byName(result.blocks, 'inner')?.qualifiedName).toBe('transport.inner');
    expect(byName(result.blocks, 'compute')?.qualifiedName).toBe('compute');
  });

  it('nests the object literal inside its exported variable without duplicating it', () => {
    const config = byName(result.blocks, 'config');
    const onError = byName(result.blocks, 'onError');
    expect(config?.kind).toBe('variable');
    expect(onError?.kind).toBe('arrow-function');
    expect(onError?.parentId).toBe(config?.id);
    // The literal is represented by the declaration that binds it, never twice.
    expect(
      result.blocks.filter((block) => block.range.startLine === config?.range.startLine),
    ).toHaveLength(1);
  });

  it('does not emit a block for a function body or a class static block', () => {
    const load = byName(result.blocks, 'load');
    expect(load).toBeDefined();
    const insideBody = result.blocks.filter(
      (block) =>
        block.id !== load?.id &&
        block.range.startLine >= (load?.range.startLine ?? 0) &&
        block.range.endLine <= (load?.range.endLine ?? 0) &&
        block.kind === 'block',
    );
    expect(insideBody).toHaveLength(0);
  });

  it('emits a statement block for a branch inside a function', () => {
    const branch = result.blocks.find(
      (block) => block.kind === 'block' && block.container === 'compute',
    );
    expect(branch).toBeDefined();
    expect(branch?.parentId).toBe(byName(result.blocks, 'compute')?.id);
    expect(branch?.name).toBeNull();
  });

  it('never emits a class field or a private field', () => {
    const fieldNames = ['#cache', 'name'];
    for (const field of fieldNames) {
      expect(byName(result.blocks, field)).toBeUndefined();
    }
  });

  it('derives ids with the frozen scheme and hashes the exact source slice', () => {
    for (const block of result.blocks) {
      expect(block.id).toBe(
        makeBlockId('src/service.ts', block.kind, block.name, block.range.startLine),
      );
      expect(block.text).toBe(REALISTIC.slice(block.range.startOffset, block.range.endOffset));
      expect(block.textHash).toBe(createHash('sha1').update(block.text, 'utf8').digest('hex'));
      expect(block.textHash).toHaveLength(40);
      expect(block.tokenCount).toBeGreaterThan(0);
      expect(block.filePath).toBe('src/service.ts');
      expect(block.language).toBe('typescript');
    }
  });

  it('sorts by start offset and gives each block a unique id', () => {
    const offsets = result.blocks.map((block) => block.range.startOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(new Set(result.blocks.map((block) => block.id)).size).toBe(result.blocks.length);
  });

  it('includes the nested text in the outer text', () => {
    const classBlock = byName(result.blocks, 'Service');
    const method = byName(result.blocks, 'load');
    expect(classBlock?.text).toContain(method?.text ?? '');
  });
});

describe('extractBlocks and ambient declarations', () => {
  const OVERLOADED = `export class Api {
  fetch(url: string): Promise<string>;
  fetch(url: number): Promise<string>;
  async fetch(url: string | number): Promise<string> {
    return String(url);
  }
}
`;

  it('yields exactly one method block per overloaded declaration', () => {
    const methods = blocksOf(OVERLOADED).filter((block) => block.name === 'fetch');
    expect(methods).toHaveLength(1);
    expect(methods[0].kind).toBe('method');
    expect(methods[0].text).toBe(
      'async fetch(url: string | number): Promise<string> {\n    return String(url);\n  }',
    );
  });

  it('keeps decorators inside the range of the member they annotate', () => {
    const text = `class C {
  @logged()
  @memo()
  cached(key: string): string {
    return key;
  }
}
`;
    const block = byName(blocksOf(text), 'cached');
    expect(block?.text.startsWith('@logged()')).toBe(true);
    expect(block?.text).toContain('@memo()');
    expect(block?.range.startLine).toBe(2);
  });

  it('skips .d.ts content and declare declarations by default', () => {
    const declaration = [
      'export declare function ambient(x: string): void;',
      'export interface Ambient { a: number }',
      'export declare class AmbientClass { m(): void }',
      'export declare const AMBIENT_VALUE: number;',
    ].join('\n');
    expect(blocksOf(declaration, 'src/types.d.ts')).toEqual([]);
    expect(blocksOf('export declare const VALUE: number;', 'src/a.ts')).toEqual([]);
  });

  it('keeps non-ambient declarations of a .ts file but not their ambient neighbours', () => {
    const mixed = [
      'export declare function ambient(x: string): void;',
      'export interface Real { a: number }',
      'export declare class AmbientClass { m(): void }',
    ].join('\n');
    const blocks = blocksOf(mixed, 'src/types.ts');
    expect(blocks.map((block) => block.name)).toEqual(['Real']);
    // The members of the ambient class must not leak out as orphans.
    expect(blocks.some((block) => block.name === 'm')).toBe(false);
  });

  it('extracts ambient declarations when explicitly asked', () => {
    const declaration = [
      'export declare function ambient(x: string): void;',
      'export interface Ambient { a: number }',
      'export declare class AmbientClass { m(): void }',
      'export declare const AMBIENT_VALUE: number;',
    ].join('\n');
    const sf = createSourceFile('src/types.d.ts', declaration, 'typescript');
    const { blocks } = extractBlocks(sf, 'src/types.d.ts', 'typescript', {
      includeAmbientDeclarations: true,
    });
    expect(kindsOf(blocks)).toEqual(['class', 'function', 'interface', 'method', 'variable']);
  });
});

describe('extractBlocks options', () => {
  const MANY = `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }
export function d() { return 4; }
`;

  it('emits an object-literal block for a published module surface', () => {
    const commonJs = 'module.exports = { retries: 3, onError: (e) => String(e) };\n';
    const blocks = blocksOf(commonJs, 'src/index.js');
    const literal = blocks.find((block) => block.kind === 'object-literal');
    expect(literal?.name).toBe('module.exports');
    expect(literal?.text.startsWith('{ retries')).toBe(true);
    // The function-valued property is still its own block, nested inside.
    expect(blocks.find((block) => block.name === 'onError')?.parentId).toBe(literal?.id);

    const esm = 'export default { retries: 3 };\n';
    expect(blocksOf(esm, 'src/index.ts').map((block) => block.kind)).toContain('object-literal');
  });

  it('never emits a block of kind unknown', () => {
    const result = parseSource('src/service.ts', REALISTIC);
    expect(result.blocks.some((block) => block.kind === 'unknown')).toBe(false);
  });

  it('honours maxBlocks and warns about the truncation', () => {
    const result = parseSource('src/many.ts', MANY, { maxBlocks: 2 });
    expect(result.blocks).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toContain('2');
  });

  it('does not warn when the cap is not reached', () => {
    expect(parseSource('src/many.ts', MANY, { maxBlocks: 10 }).diagnostics).toEqual([]);
  });

  it('can suppress statement blocks', () => {
    const text = 'export function f(a: boolean) {\n  if (a) {\n    return 1;\n  }\n}\n';
    expect(blocksOf(text).some((block) => block.kind === 'block')).toBe(true);
    const sf = createSourceFile('src/f.ts', text, 'typescript');
    const { blocks } = extractBlocks(sf, 'src/f.ts', 'typescript', { includeBlocks: false });
    expect(blocks.some((block) => block.kind === 'block')).toBe(false);
    expect(blocks.map((block) => block.kind)).toEqual(['function']);
  });
});

describe('recovering from a broken file', () => {
  const BROKEN = `export function first(a: number): number {
  return a;
}

export class Broken {
  method() {
    return 1;
`;

  it('reports the syntax error as an error diagnostic', () => {
    const { diagnostics } = parseSource('src/broken.ts', BROKEN);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].line).toBeGreaterThan(0);
    expect(diagnostics[0].message.length).toBeGreaterThan(0);
  });

  it('still returns every block that parsed', () => {
    const blocks = blocksOf(BROKEN);
    expect(blocks.map((block) => block.name)).toEqual(['first', 'Broken', 'method']);
  });

  it('exposes the same diagnostics through collectDiagnostics', () => {
    const sf = createSourceFile('src/broken.ts', BROKEN, 'typescript');
    const diagnostics = collectDiagnostics(sf);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');

    const clean = createSourceFile('src/clean.ts', 'const a = 1;', 'typescript');
    expect(collectDiagnostics(clean)).toEqual([]);
  });
});
