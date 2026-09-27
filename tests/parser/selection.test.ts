import { describe, expect, it } from 'vitest';
import {
  blocksWithinFile,
  findBestBlockForRange,
  findEnclosingBlock,
  parseSource,
  summarizeBlocks,
} from '../../src/parser';
import type { CodeBlock } from '../../src/types';

function blocksOf(text: string, path = 'src/service.ts'): CodeBlock[] {
  return parseSource(path, text).blocks;
}

function selected(blocks: readonly CodeBlock[], startLine: number, endLine: number): string {
  const block = findBestBlockForRange(blocks, startLine, endLine);
  return block === null ? '<null>' : `${block.kind}:${block.name ?? '<anon>'}`;
}

const SIBLINGS = `export function alpha() {
  return 1;
}

export function beta() {
  const total = 2;
  return total + 1;
}
`;

const UNEVEN = `export function wide() {
  const x = 1;
  return x;
}

export function narrow() {
  return 2;
}
`;

const NESTED = `export class Service {
  load(id: string): string {
    const helper = () => {
      return id.trim();
    };
    return helper();
  }
}
`;

const CONTAINER = `export class Holder {
  load(id: string): string {
    return id;
  }

  save(id: string): string {
    return id;
  }
}
`;

describe('findBestBlockForRange', () => {
  const siblings = blocksOf(SIBLINGS);

  it('returns the method when the selection is exactly a method', () => {
    const blocks = blocksOf(NESTED);
    expect(selected(blocks, 2, 7)).toBe('method:load');
  });

  it('returns the class when the selection spans the whole class', () => {
    const blocks = blocksOf(CONTAINER);
    expect(selected(blocks, 1, 9)).toBe('class:Holder');
  });

  it('returns the function for a selection on a single statement inside it', () => {
    expect(selected(siblings, 6, 6)).toBe('variable:total');
    // `return total + 1;` is not a block of its own, so the tightest enclosing
    // unit is the function.
    expect(selected(siblings, 7, 7)).toBe('function:beta');
  });

  it('prefers the smallest enclosing block over the class that contains it', () => {
    const blocks = blocksOf(CONTAINER);
    expect(selected(blocks, 6, 8)).toBe('method:save');
  });

  it('falls back to the largest overlap when nothing contains the selection', () => {
    // The selection spans both functions, so neither contains it: `beta` overlaps
    // four lines against `alpha`'s three and therefore wins.
    expect(selected(siblings, 1, 8)).toBe('function:beta');
  });

  it('breaks an equal overlap towards the smaller span', () => {
    // `wide` (1-4) and `narrow` (6-8) each overlap lines 2-8 in three lines, so
    // the tie is broken by the tighter block rather than by the earlier one.
    const blocks = blocksOf(UNEVEN);
    expect(selected(blocks, 2, 8)).toBe('function:narrow');
  });

  it('breaks an identical span towards the more specific kind', () => {
    const blocks = blocksOf('export class One { run() { return 1; } }\n');
    // Class and method occupy the same single line, so specificity decides.
    expect(selected(blocks, 1, 1)).toBe('method:run');
  });

  it('returns the nested arrow for a selection inside it', () => {
    const blocks = blocksOf(NESTED);
    expect(selected(blocks, 3, 5)).toBe('arrow-function:helper');
  });

  it('normalises a reversed range', () => {
    const blocks = blocksOf(CONTAINER);
    expect(findBestBlockForRange(blocks, 7, 5)).toBe(findBestBlockForRange(blocks, 5, 7));
  });

  it('returns null when there are no blocks at all', () => {
    expect(findBestBlockForRange([], 1, 1)).toBeNull();
  });

  it('still answers for a file that has no callable constructs', () => {
    expect(selected(blocksOf('const a = 1;', 'src/plain.ts'), 1, 1)).toBe('variable:a');
  });
});

describe('findEnclosingBlock', () => {
  const blocks = blocksOf(CONTAINER);

  it('returns the outermost containing block', () => {
    const enclosing = findEnclosingBlock(blocks, 6, 6);
    expect(enclosing?.kind).toBe('class');
    expect(enclosing?.name).toBe('Holder');
  });

  it('returns null when the range is not contained', () => {
    expect(findEnclosingBlock(blocks, 1, 40)).toBeNull();
    expect(findEnclosingBlock([], 1, 1)).toBeNull();
  });
});

describe('blocksWithinFile', () => {
  const blocks = blocksOf(CONTAINER);

  it('returns only the non-overlapping top-level blocks in the range', () => {
    const top = blocksWithinFile(blocks, 1, 9);
    expect(top.map((block) => block.name)).toEqual(['Holder']);
  });

  it('promotes a nested block when its container is out of range', () => {
    const methods = blocksWithinFile(blocks, 2, 8);
    expect(methods.map((block) => block.name)).toEqual(['load', 'save']);
  });

  it('ignores blocks that only partially overlap the range', () => {
    // `Holder` starts above the range and `load` ends below it, so only `save` is
    // wholly inside.
    expect(blocksWithinFile(blocks, 5, 100).map((block) => block.name)).toEqual(['save']);
  });

  it('returns an empty list for an empty range', () => {
    expect(blocksWithinFile(blocks, 100, 200)).toEqual([]);
  });
});

describe('summarizeBlocks', () => {
  it('summarises counts by kind', () => {
    const summary = summarizeBlocks(blocksOf(CONTAINER));
    expect(summary).toContain('1 class');
    expect(summary).toContain('2 methods');
    expect(summary).toContain('(3 blocks)');
  });

  it('pluralises a single block', () => {
    expect(summarizeBlocks(blocksOf('export function only() {}\n'))).toBe('1 function (1 block)');
  });

  it('reports an empty file', () => {
    expect(summarizeBlocks([])).toBe('no blocks');
  });
});
