import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  createSourceFile,
  getScriptKind,
  languageFor,
  parseSource,
  parseSourceFromBuffer,
  toSourceRange,
} from '../../src/parser';
import { AncestryError } from '../../src/types';
import type { CodeBlock } from '../../src/types';

function names(blocks: readonly CodeBlock[]): string[] {
  return blocks.map((block) => `${block.kind}:${block.name ?? '<anon>'}`);
}

describe('languageFor', () => {
  it('uses the shared extension table', () => {
    expect(languageFor('src/a.ts')).toBe('typescript');
    expect(languageFor('src/a.mts')).toBe('typescript');
    expect(languageFor('src/a.cts')).toBe('typescript');
    expect(languageFor('src/a.js')).toBe('javascript');
    expect(languageFor('src/a.mjs')).toBe('javascript');
    expect(languageFor('src/a.cjs')).toBe('javascript');
    expect(languageFor('src/a.tsx')).toBe('tsx');
    expect(languageFor('src/a.jsx')).toBe('jsx');
    expect(languageFor('src/a.json')).toBe('unknown');
    expect(languageFor('Makefile')).toBe('unknown');
  });

  it('normalises Windows separators before measuring the extension', () => {
    expect(languageFor('src\\nested\\a.ts')).toBe('typescript');
  });
});

describe('getScriptKind', () => {
  it('maps every language onto a parser dialect', () => {
    expect(getScriptKind('typescript')).toBe(ts.ScriptKind.TS);
    expect(getScriptKind('javascript')).toBe(ts.ScriptKind.JS);
    expect(getScriptKind('tsx')).toBe(ts.ScriptKind.TSX);
    expect(getScriptKind('jsx')).toBe(ts.ScriptKind.JSX);
    // Permissive: an unlabelled file is still worth parsing.
    expect(getScriptKind('unknown')).toBe(ts.ScriptKind.TS);
  });
});

describe('createSourceFile and toSourceRange', () => {
  const text = ['/** docs */', 'export class A {', '  m() {', '    return 1;', '  }', '}'].join(
    '\n',
  );

  it('populates parent links', () => {
    const sf = createSourceFile('src/a.ts', text, 'typescript');
    const methods: ts.MethodDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        methods.push(node);
      }
      node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    expect(methods).toHaveLength(1);
    expect(ts.isClassDeclaration(methods[0].parent)).toBe(true);
    expect(ts.isSourceFile(methods[0].parent.parent)).toBe(true);
  });

  it('reports 1-based lines with 0-based columns and exclusive offsets', () => {
    const sf = createSourceFile('src/a.ts', text, 'typescript');
    const classDeclaration = sf.statements[0];
    const range = toSourceRange(classDeclaration, sf);
    expect(range.startLine).toBe(2);
    expect(range.startColumn).toBe(0);
    expect(range.endLine).toBe(6);
    expect(text.slice(range.startOffset, range.endOffset)).toBe(
      'export class A {\n  m() {\n    return 1;\n  }\n}',
    );
  });

  it('can include the leading JSDoc on request', () => {
    const sf = createSourceFile('src/a.ts', text, 'typescript');
    const classDeclaration = sf.statements[0];
    const withDoc = toSourceRange(classDeclaration, sf, true);
    expect(withDoc.startLine).toBe(1);
    expect(withDoc.startOffset).toBe(0);
  });
});

describe('parseSourceFromBuffer', () => {
  it('throws BINARY_FILE for binary content', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    let caught: unknown;
    try {
      parseSourceFromBuffer('assets/logo.png', bytes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AncestryError);
    expect((caught as AncestryError).code).toBe('BINARY_FILE');
    expect((caught as AncestryError).userMessage).toContain('logo.png');
  });

  it('strips a UTF-8 BOM so line numbers match the editor', () => {
    const source = 'export function load() {\n  return 1;\n}\n';
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
    const result = parseSourceFromBuffer('src/a.ts', bytes);
    const block = result.blocks[0];
    expect(block.range.startLine).toBe(1);
    expect(block.text.startsWith('export function')).toBe(true);
    expect(result.sourceLength).toBe(source.length);
  });

  it('throws FILE_TOO_LARGE above the byte limit', () => {
    const bytes = Buffer.from('export const a = 1;\n', 'utf8');
    let caught: unknown;
    try {
      parseSourceFromBuffer('src/a.ts', bytes, { maxBytes: 4 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AncestryError);
    expect((caught as AncestryError).code).toBe('FILE_TOO_LARGE');
  });

  it('accepts a file exactly at the limit', () => {
    const bytes = Buffer.from('export const a = 1;\n', 'utf8');
    expect(
      parseSourceFromBuffer('src/a.ts', bytes, { maxBytes: bytes.length }).blocks,
    ).toHaveLength(1);
  });

  it('enforces the same size limit through parseSource', () => {
    let caught: unknown;
    try {
      parseSource('src/a.ts', 'export const a = 1;\n', { maxBytes: 4 });
    } catch (error) {
      caught = error;
    }
    expect((caught as AncestryError).code).toBe('FILE_TOO_LARGE');
  });
});

describe('language-specific syntax', () => {
  it('parses JSX in a .tsx file', () => {
    const text = [
      'export function Panel(props: { title: string }) {',
      '  return (',
      '    <div className="panel" onClick={() => props.title}>',
      '      <span>{props.title.toUpperCase()}</span>',
      '      {props.title ? <b>yes</b> : null}',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const result = parseSource('src/panel.tsx', text);
    expect(result.language).toBe('tsx');
    expect(result.diagnostics).toEqual([]);
    expect(names(result.blocks)).toContain('function:Panel');
    expect(names(result.blocks)).toContain('arrow-function:<anon>');
  });

  it('treats JSX in a .ts file as a syntax error but still returns blocks', () => {
    const text = 'export const element = <div>hi</div>;\n';
    const result = parseSource('src/element.ts', text);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('modern and awkward syntax', () => {
  it('handles generators, async methods, getters and setters', () => {
    const text = [
      'export class Registry {',
      '  *walk(): Generator<string> {',
      '    yield "a";',
      '  }',
      '  async load(id: string): Promise<void> {}',
      '  get size(): number {',
      '    return 1;',
      '  }',
      '  set size(value: number) {}',
      '}',
    ].join('\n');
    const result = parseSource('src/registry.ts', text);
    expect(result.diagnostics).toEqual([]);
    expect(names(result.blocks)).toEqual([
      'class:Registry',
      'method:walk',
      'method:load',
      'method:size',
      'method:size',
    ]);
  });

  it('handles satisfies, as, optional chaining and nested template literals', () => {
    const text = [
      'const config = { retries: 3 } satisfies Record<string, number>;',
      'const coerced = config.retries as unknown as string;',
      'export function render(user: { name?: string }): string {',
      '  const name = user?.name;',
      '  const label = name ?? "anon";',
      '  return `hello ${`nested ${label} tail`} from ${config.retries}`;',
      '}',
    ].join('\n');
    const result = parseSource('src/render.ts', text);
    expect(result.diagnostics).toEqual([]);
    const render = result.blocks.find((block) => block.name === 'render');
    expect(render?.text).toContain('${`nested ${label} tail`}');
    expect(result.blocks.some((block) => block.kind === 'variable')).toBe(true);
  });

  it('never emits private fields or class static blocks', () => {
    const text = [
      'export class Registry {',
      '  static #instances = 0;',
      '  #entries = new Map<string, number>();',
      '  static {',
      '    Registry.#instances = 1;',
      '  }',
      '  register(key: string): void {',
      '    this.#entries.set(key, 1);',
      '  }',
      '}',
    ].join('\n');
    const result = parseSource('src/registry.ts', text);
    expect(result.diagnostics).toEqual([]);
    expect(names(result.blocks)).toEqual(['class:Registry', 'method:register']);
    const classBlock = result.blocks[0];
    expect(classBlock.text).toContain('static {');
  });

  it('keeps a computed method name readable', () => {
    const text =
      'export class C {\n  *[Symbol.iterator](): Iterator<string> {\n    yield "a";\n  }\n}\n';
    const result = parseSource('src/c.ts', text);
    expect(names(result.blocks)).toEqual(['class:C', 'method:[Symbol.iterator]']);
  });

  it('survives an empty file and a file of only comments', () => {
    expect(parseSource('src/empty.ts', '').blocks).toEqual([]);
    expect(parseSource('src/comments.ts', '// nothing here\n/* nor here */\n').blocks).toEqual([]);
  });

  it('parses an unlabelled extension permissively but reports it as unknown', () => {
    const result = parseSource('vendor/tool', 'export function run() {}\n');
    expect(result.language).toBe('unknown');
    expect(names(result.blocks)).toEqual(['function:run']);
  });
});
