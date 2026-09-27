/**
 * Filtering is the most re-run logic in the webview (every keystroke and every
 * slider drag) and the hardest to eyeball in a 3D scene — a subtly wrong edge
 * set looks like a rendering bug. These tests exercise each dimension in
 * isolation, then in combination, because "each dimension alone" and "the
 * dimensions together" fail in different ways.
 */

import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  availableFilterOptions,
  describeHiddenReasons,
  filterDefaults,
  nodeBranchKeys,
} from '../../src/webview/client/core/filter';
import { DETACHED_BRANCH } from '../../src/webview/client/core/domain';
import { DAY, makeEdge, makeGraph, makeNode, T0 } from './fixtures';

const GRAPH = makeGraph(
  [
    makeNode('main-old', {
      timestamp: T0,
      filePath: 'src/app/one.ts',
      branches: ['main'],
      author: { name: 'Ada', email: 'ada@example.com' },
      similarity: 0.95,
      classification: 'strong',
    }),
    makeNode('feature-new', {
      timestamp: T0 + 10 * DAY,
      filePath: 'src/webview/two.ts',
      branches: ['feature/x'],
      author: { name: 'Grace', email: 'grace@example.com' },
      similarity: 0.6,
      classification: 'possible',
      // A commit distinct from the `aaaa…` every `makeNode` default carries, so
      // the "matches a commit" searches below cannot match two nodes at once.
      commit: 'b'.repeat(40),
      shortCommit: 'bbbbbbbbbbb',
    }),
    makeNode('detached', {
      timestamp: T0 + 20 * DAY,
      filePath: 'docs/notes.md',
      branches: [],
      author: { name: 'Ada', email: 'ada@example.com' },
      similarity: 0.2,
      classification: 'weak',
      commit: 'ffffffffffff',
      shortCommit: 'ffffffffffff',
    }),
  ],
  [
    makeEdge('main-old', 'feature-new', 'EVOLVED_FROM'),
    makeEdge('feature-new', 'detached', 'MERGED_FROM'),
    makeEdge('main-old', 'detached', 'COPIED_FROM'),
  ],
);

function visible(result: ReturnType<typeof applyFilter>): string[] {
  return [...result.visibleNodeIds].sort();
}

describe('applyFilter — empty filter', () => {
  it('returns everything for an empty object', () => {
    const result = applyFilter(GRAPH, {});
    expect(visible(result)).toEqual(['detached', 'feature-new', 'main-old']);
    expect(result.hiddenCount).toBe(0);
    expect(result.visibleEdges).toHaveLength(3);
  });

  it('treats empty arrays as "no restriction"', () => {
    const result = applyFilter(GRAPH, {
      branches: [],
      files: [],
      authors: [],
      edgeTypes: [],
      search: '',
    });
    expect(result.hiddenCount).toBe(0);
  });

  it('handles a null/undefined filter without throwing', () => {
    expect(() => applyFilter(GRAPH, null as never)).not.toThrow();
    expect(() => applyFilter(GRAPH, undefined as never)).not.toThrow();
  });
});

describe('applyFilter — branch dimension', () => {
  it('keeps only nodes on the selected branch', () => {
    expect(visible(applyFilter(GRAPH, { branches: ['main'] }))).toEqual(['main-old']);
  });

  it('keeps detached nodes only when (detached) is selected', () => {
    expect(visible(applyFilter(GRAPH, { branches: ['main'] }))).not.toContain('detached');
    expect(visible(applyFilter(GRAPH, { branches: [DETACHED_BRANCH] }))).toEqual(['detached']);
  });

  it('treats the set as an OR', () => {
    expect(visible(applyFilter(GRAPH, { branches: ['main', 'feature/x'] }))).toEqual([
      'feature-new',
      'main-old',
    ]);
  });
});

describe('applyFilter — file dimension', () => {
  it('is prefix-aware', () => {
    const result = applyFilter(GRAPH, { files: ['src/app'] });
    expect(visible(result)).toEqual(['main-old']);
  });

  it('accepts an exact path', () => {
    expect(visible(applyFilter(GRAPH, { files: ['docs/notes.md'] }))).toEqual(['detached']);
  });

  it('does not match a suffix-only selection', () => {
    expect(applyFilter(GRAPH, { files: ['one.ts'] }).hiddenCount).toBe(3);
  });
});

describe('applyFilter — author dimension', () => {
  it('keeps only the selected author', () => {
    expect(visible(applyFilter(GRAPH, { authors: ['Grace'] }))).toEqual(['feature-new']);
  });

  it('falls back to the email local part', () => {
    expect(visible(applyFilter(GRAPH, { authors: ['grace'] }))).toEqual(['feature-new']);
  });
});

describe('applyFilter — similarity and time dimensions', () => {
  it('applies minSimilarity inclusively', () => {
    expect(visible(applyFilter(GRAPH, { minSimilarity: 0.6 }))).toEqual([
      'feature-new',
      'main-old',
    ]);
    expect(visible(applyFilter(GRAPH, { minSimilarity: 0.61 }))).toEqual(['main-old']);
  });

  it('clamps an out-of-range minSimilarity', () => {
    // `applyFilter` clamps to [0, 1], so 5 becomes 1 and only a perfect match
    // survives. -1 becomes 0, which excludes nothing.
    expect(visible(applyFilter(GRAPH, { minSimilarity: 5 }))).toEqual([]);
    expect(applyFilter(GRAPH, { minSimilarity: 5 }).hiddenCount).toBe(3);
    expect(applyFilter(GRAPH, { minSimilarity: -1 }).hiddenCount).toBe(0);
  });

  it('applies the time range inclusively on both bounds', () => {
    expect(visible(applyFilter(GRAPH, { fromTimestamp: T0 + 10 * DAY }))).toEqual([
      'detached',
      'feature-new',
    ]);
    expect(visible(applyFilter(GRAPH, { toTimestamp: T0 }))).toEqual(['main-old']);
  });

  it('matches nothing for an inverted range', () => {
    expect(applyFilter(GRAPH, { fromTimestamp: T0 + 100, toTimestamp: T0 }).hiddenCount).toBe(3);
  });

  it('ignores non-finite bounds', () => {
    expect(applyFilter(GRAPH, { fromTimestamp: Number.NaN }).hiddenCount).toBe(0);
  });
});

describe('applyFilter — edge types', () => {
  it('keeps only the selected edge types', () => {
    const result = applyFilter(GRAPH, { edgeTypes: ['MERGED_FROM'] });
    expect(result.visibleEdges.map((edge) => edge.type)).toEqual(['MERGED_FROM']);
  });

  it('does not remove the nodes an excluded edge touched', () => {
    const result = applyFilter(GRAPH, { edgeTypes: ['MERGED_FROM'] });
    expect(result.visibleNodeIds.size).toBe(3);
  });
});

describe('applyFilter — edge/endpoint coupling', () => {
  it('hides an edge when one endpoint is hidden', () => {
    const result = applyFilter(GRAPH, { authors: ['Ada'] });
    // `feature-new` is filtered out, so both of its edges must go too.
    expect(result.visibleEdges.map((edge) => edge.id).sort()).toEqual([
      'COPIED_FROM:main-old->detached',
    ]);
  });

  it('hides an edge when both endpoints are hidden', () => {
    const result = applyFilter(GRAPH, { authors: ['Grace'] });
    // Only `feature-new` is visible, so all three edges lose an endpoint.
    expect(result.visibleEdges).toHaveLength(0);
    expect(result.reasonCounts.endpoint).toBe(3);
  });
});

describe('applyFilter — combined filters are conjunctive', () => {
  it('intersects branch, file, author and similarity', () => {
    const result = applyFilter(GRAPH, {
      branches: ['main', 'feature/x'],
      files: ['src'],
      authors: ['Ada'],
      minSimilarity: 0.5,
    });
    expect(visible(result)).toEqual(['main-old']);
  });

  it('intersects branch and time range', () => {
    const result = applyFilter(GRAPH, {
      branches: ['main', 'feature/x'],
      fromTimestamp: T0 + 5 * DAY,
    });
    expect(visible(result)).toEqual(['feature-new']);
  });

  it('can legitimately produce an empty result', () => {
    const result = applyFilter(GRAPH, {
      branches: ['main'],
      files: ['docs'],
    });
    expect(result.visibleNodeIds.size).toBe(0);
    expect(result.visibleEdges).toHaveLength(0);
    expect(result.hiddenCount).toBe(3);
  });
});

describe('applyFilter — search', () => {
  it('is case-insensitive', () => {
    expect(visible(applyFilter(GRAPH, { search: 'ADA' }))).toEqual(['detached', 'main-old']);
    expect(visible(applyFilter(GRAPH, { search: 'ada' }))).toEqual(['detached', 'main-old']);
  });

  it('matches a commit prefix', () => {
    expect(visible(applyFilter(GRAPH, { search: 'FFFF' }))).toEqual(['detached']);
    expect(visible(applyFilter(GRAPH, { search: 'aaaaaaaaaaaa' }))).toEqual(['main-old']);
  });

  it('matches the file path and the block name', () => {
    expect(visible(applyFilter(GRAPH, { search: 'webview' }))).toEqual(['feature-new']);
    expect(visible(applyFilter(GRAPH, { search: 'feature-new' }))).toEqual(['feature-new']);
  });

  it('matches the qualified name and the module', () => {
    expect(visible(applyFilter(GRAPH, { search: 'mod.detached' }))).toEqual(['detached']);
  });

  it('ignores a whitespace-only query', () => {
    expect(applyFilter(GRAPH, { search: '   ' }).hiddenCount).toBe(0);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(applyFilter(GRAPH, { search: 'zzz-no-such-thing' }).hiddenCount).toBe(3);
  });
});

describe('applyFilter — reasonCounts', () => {
  it('is empty when nothing is hidden', () => {
    expect(applyFilter(GRAPH, {}).reasonCounts).toEqual({});
  });

  it('attributes each rejection to its dimension', () => {
    const result = applyFilter(GRAPH, { minSimilarity: 0.9, authors: ['Ada'] });
    expect(result.reasonCounts.minSimilarity).toBeGreaterThan(0);
    expect(result.reasonCounts.author).toBeGreaterThan(0);
  });

  it('renders a human-readable summary', () => {
    const result = applyFilter(GRAPH, { minSimilarity: 0.9 });
    expect(describeHiddenReasons(result)).toMatch(/minSimilarity/);
    expect(describeHiddenReasons(applyFilter(GRAPH, {}))).toBe('No nodes hidden');
  });
});

describe('availableFilterOptions', () => {
  const options = availableFilterOptions(GRAPH);

  it('lists unique, sorted values per dimension', () => {
    expect(options.branches).toEqual([DETACHED_BRANCH, 'feature/x', 'main']);
    expect(options.files).toEqual(['docs/notes.md', 'src/app/one.ts', 'src/webview/two.ts']);
    expect(options.authors).toEqual(['Ada', 'Grace']);
    for (const list of [options.branches, options.files, options.authors]) {
      expect(new Set(list).size).toBe(list.length);
      expect([...list].sort()).toEqual(list);
    }
  });

  it('lists only the edge types present, in canonical order', () => {
    expect(options.edgeTypes).toEqual(['EVOLVED_FROM', 'COPIED_FROM', 'MERGED_FROM']);
  });

  it('reports the similarity and timestamp extents', () => {
    expect(options.minSimilarity).toBeCloseTo(0.2, 6);
    expect(options.maxSimilarity).toBeCloseTo(0.95, 6);
    expect(options.minTimestamp).toBe(T0);
    expect(options.maxTimestamp).toBe(T0 + 20 * DAY);
  });

  it('handles an empty graph', () => {
    const empty = availableFilterOptions(makeGraph([]));
    expect(empty.branches).toEqual([]);
    expect(empty.edgeTypes).toEqual([]);
    expect(empty.minSimilarity).toBe(0);
    expect(empty.maxSimilarity).toBe(1);
    expect(empty.minTimestamp).toBe(0);
    expect(empty.maxTimestamp).toBe(0);
  });
});

describe('filterDefaults', () => {
  it('widens every dimension, so the first render shows the whole graph', () => {
    const defaults = filterDefaults(GRAPH);
    const result = applyFilter(GRAPH, defaults);
    expect(result.hiddenCount).toBe(0);
    expect(result.visibleEdges).toHaveLength(3);
  });

  it('spans the full timestamp range and the full edge-type set', () => {
    const defaults = filterDefaults(GRAPH);
    expect(defaults.fromTimestamp).toBe(T0);
    expect(defaults.toTimestamp).toBe(T0 + 20 * DAY);
    expect(defaults.edgeTypes).toEqual([
      'EVOLVED_FROM',
      'MODIFIED_FROM',
      'MOVED_FROM',
      'COPIED_FROM',
      'MERGED_FROM',
    ]);
  });

  it('works on an empty graph', () => {
    const defaults = filterDefaults(makeGraph([]));
    expect(defaults).toEqual({
      branches: [],
      files: [],
      authors: [],
      minSimilarity: 0,
      fromTimestamp: 0,
      toTimestamp: 0,
      edgeTypes: ['EVOLVED_FROM', 'MODIFIED_FROM', 'MOVED_FROM', 'COPIED_FROM', 'MERGED_FROM'],
      search: '',
    });
  });
});

describe('nodeBranchKeys', () => {
  it('de-duplicates and trims', () => {
    expect(nodeBranchKeys(makeNode('a', { branches: [' main ', 'main', 'dev'] }))).toEqual([
      'main',
      'dev',
    ]);
  });

  it('returns an empty list for a node with no refs', () => {
    expect(nodeBranchKeys(makeNode('a', { branches: [] }))).toEqual([]);
  });
});
