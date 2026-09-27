import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/parser';
import type { CodeBlock } from '../../src/types';

/**
 * Two revisions of one file that differ only in formatting. Ancestry's identity
 * for a block is (file, kind, name, position), so everything a formatter can
 * change — indentation, line breaks, trailing commas, quote style in types —
 * must leave the block set intact. Only `textHash` and `range` may move, and
 * those are exactly what `src/normalization` exists to absorb.
 */
const TIGHT = `export class Service {
  async load(id: string, ttl: number): Promise<string> {
    const cache = this.cache.get(id);
    if (cache) {
      return cache;
    }
    const value = await this.fetch(id);
    if (ttl > 0) {
      this.cache.set(id, value);
    }
    return value;
  }
  validate(id: string): boolean {
    return id.length > 0;
  }
}
export const DEFAULT_TTL = 30;
export function helper(a: number, b: number): number {
  return a + b;
}
`;

const SPACED = `export class Service {
  async load(
    id: string,
    ttl: number,
  ): Promise<string> {
        const cache = this.cache.get(id);

    if (cache) {
            return cache;
    }

    const value = await this.fetch(id);

    if (ttl > 0) {
      this.cache.set(id, value);
        }

    return value;
  }

  validate(id: string): boolean {
    return id.length > 0;
  }
}

export const DEFAULT_TTL = 30;

export function helper(a: number, b: number): number {
  return a + b;
}
`;

function identity(block: CodeBlock): string {
  return `${block.kind}::${block.name ?? '<anon>'}::${block.qualifiedName ?? '<none>'}`;
}

describe('formatting invariance', () => {
  const tight = parseSource('src/service.ts', TIGHT).blocks;
  const spaced = parseSource('src/service.ts', SPACED).blocks;

  it('produces the same number of blocks', () => {
    expect(spaced).toHaveLength(tight.length);
  });

  it('produces the same kinds, names and qualified names in the same order', () => {
    expect(spaced.map(identity)).toEqual(tight.map(identity));
  });

  it('produces the same set of names', () => {
    const names = (blocks: readonly CodeBlock[]): string[] =>
      blocks.map((block) => `${block.kind}:${block.name ?? '<anon>'}`).sort();
    expect(names(spaced)).toEqual(names(tight));
  });

  it('produces identical signatures', () => {
    expect(spaced.map((block) => block.signature)).toEqual(tight.map((block) => block.signature));
  });

  it('keeps the containment tree', () => {
    const tree = (blocks: readonly CodeBlock[]): string[] =>
      blocks.map((block) => `${block.name ?? '<anon>'}<-${block.parentId ?? 'root'}`).sort();
    expect(tree(spaced)).toEqual(tree(tight));
  });

  it('changes the raw text and its hash, which is the point of later normalisation', () => {
    const loadTight = tight.find((block) => block.name === 'load');
    const loadSpaced = spaced.find((block) => block.name === 'load');
    expect(loadTight).toBeDefined();
    expect(loadSpaced).toBeDefined();
    expect(loadTight?.text).not.toBe(loadSpaced?.text);
    expect(loadTight?.textHash).not.toBe(loadSpaced?.textHash);
  });

  it('shifts the line numbers, as the editor would show them', () => {
    const validateTight = tight.find((block) => block.name === 'validate');
    const validateSpaced = spaced.find((block) => block.name === 'validate');
    expect(validateSpaced?.range.startLine).toBeGreaterThan(validateTight?.range.startLine ?? 0);
    expect(validateTight?.range.endLine).toBeLessThan(validateSpaced?.range.endLine ?? 0);
  });
});
