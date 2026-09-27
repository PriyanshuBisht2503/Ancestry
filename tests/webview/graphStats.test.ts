/**
 * The derived-graph functions are the answers the detail panel displays, and
 * every one of them has to be correct about graphs that are *wrong*: cycles from
 * a botched merge, a missing origin, a node id that does not exist. None of
 * those can be reproduced on demand in the real UI, so they are all pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  ancestryPath,
  clusterByFile,
  countEdgeTypes,
  descendants,
  groupByAuthor,
  nodeById,
  relatedNodes,
  summarizeGraph,
} from '../../src/webview/client/core/graph-stats';
import { DAY, makeEdge, makeGraph, makeNode, T0 } from './fixtures';

describe('ancestryPath', () => {
  it('walks a three-node chain back to the origin', () => {
    const n1 = makeNode('n1', { timestamp: T0, isOrigin: true });
    const n2 = makeNode('n2', { timestamp: T0 + DAY });
    const n3 = makeNode('n3', { timestamp: T0 + 2 * DAY, isFocus: true });
    const graph = makeGraph(
      [n3, n2, n1],
      [makeEdge('n3', 'n2'), makeEdge('n2', 'n1', 'MODIFIED_FROM')],
    );
    expect(ancestryPath(graph, 'n3')).toEqual(['n3', 'n2', 'n1']);
  });

  it('returns just the node for a root', () => {
    const graph = makeGraph([makeNode('only', { isOrigin: true })]);
    expect(ancestryPath(graph, 'only')).toEqual(['only']);
  });

  it('returns an empty array for an unknown node', () => {
    const graph = makeGraph([makeNode('a')]);
    expect(ancestryPath(graph, 'nope')).toEqual([]);
    expect(ancestryPath(graph, '')).toEqual([]);
    expect(ancestryPath(graph, undefined as unknown as string)).toEqual([]);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b'), makeNode('c')],
      [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')],
    );
    const path = ancestryPath(graph, 'a');
    expect(path[0]).toBe('a');
    expect(path.length).toBeLessThanOrEqual(3);
    expect(new Set(path).size).toBe(path.length);
  });

  it('stops at the last node when no origin was detected', () => {
    const graph = makeGraph(
      [makeNode('a', { timestamp: T0 }), makeNode('b', { timestamp: T0 + DAY })],
      [makeEdge('b', 'a')],
    );
    const path = ancestryPath(graph, 'b');
    expect(path).toEqual(['b', 'a']);
    expect(nodeById(graph, path[path.length - 1]!)?.isOrigin).toBe(false);
  });

  it('prefers a MERGED_FROM parent over a weaker one', () => {
    const graph = makeGraph(
      [makeNode('child'), makeNode('viaMove'), makeNode('viaMerge')],
      [makeEdge('child', 'viaMove', 'MOVED_FROM'), makeEdge('child', 'viaMerge', 'MERGED_FROM')],
    );
    expect(ancestryPath(graph, 'child')).toEqual(['child', 'viaMerge']);
  });

  it('prefers evolution over a move', () => {
    const graph = makeGraph(
      [makeNode('child'), makeNode('viaMove'), makeNode('viaEvolve')],
      [makeEdge('child', 'viaMove', 'MOVED_FROM'), makeEdge('child', 'viaEvolve', 'EVOLVED_FROM')],
    );
    expect(ancestryPath(graph, 'child')).toEqual(['child', 'viaEvolve']);
  });

  it('ignores edges whose endpoints are not in the graph', () => {
    const graph = makeGraph([makeNode('a')], [makeEdge('a', 'ghost')]);
    expect(ancestryPath(graph, 'a')).toEqual(['a']);
  });
});

describe('descendants', () => {
  it('returns the forward closure', () => {
    const graph = makeGraph(
      ['a', 'b', 'c', 'island'].map((id) => makeNode(id)),
      [makeEdge('b', 'a'), makeEdge('c', 'b')],
    );
    const result = descendants(graph, 'a');
    expect(result[0]).toBe('a');
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c']));
    expect(result).not.toContain('island');
  });

  it('terminates on a cycle', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [makeEdge('b', 'a'), makeEdge('a', 'b')],
    );
    const result = descendants(graph, 'a');
    expect(new Set(result).size).toBe(result.length);
    expect(new Set(result)).toEqual(new Set(['a', 'b']));
  });

  it('returns an empty array for an unknown node', () => {
    expect(descendants(makeGraph([makeNode('a')]), 'ghost')).toEqual([]);
  });
});

describe('summarizeGraph', () => {
  it('describes size, spread and time span', () => {
    const graph = makeGraph([
      makeNode('a', { timestamp: T0, filePath: 'src/a.ts', author: { name: 'Ada', email: 'a@b' } }),
      makeNode('b', {
        timestamp: T0 + 730 * DAY,
        filePath: 'src/b.ts',
        author: { name: 'Grace', email: 'g@b' },
      }),
      makeNode('c', {
        timestamp: T0 + 400 * DAY,
        filePath: 'src/a.ts',
        author: { name: 'Ada', email: 'a@b' },
      }),
    ]);
    expect(summarizeGraph(graph)).toBe('3 versions · 2 files · 2 authors over 2 years');
  });

  it('singularises a single version', () => {
    const graph = makeGraph([makeNode('a', { timestamp: T0 })]);
    expect(summarizeGraph(graph)).toBe('1 version · 1 file · 1 author over an instant');
  });

  it('says so when nothing matched', () => {
    expect(summarizeGraph(makeGraph([]))).toBe('No matching versions found');
  });

  it('counts an anonymous author as one distinct author', () => {
    const graph = makeGraph([
      makeNode('a', { author: { name: '', email: '' } }),
      makeNode('b', { author: { name: '', email: '' } }),
    ]);
    expect(summarizeGraph(graph)).toMatch(/1 author/);
  });
});

describe('groupByAuthor', () => {
  it('sorts descending by count', () => {
    const graph = makeGraph([
      makeNode('a', { author: { name: 'Ada', email: '' } }),
      makeNode('b', { author: { name: 'Grace', email: '' } }),
      makeNode('c', { author: { name: 'Grace', email: '' } }),
      makeNode('d', { author: { name: 'Linus', email: '' } }),
    ]);
    expect(groupByAuthor(graph)).toEqual([
      { author: 'Grace', count: 2 },
      { author: 'Ada', count: 1 },
      { author: 'Linus', count: 1 },
    ]);
  });

  it('breaks ties alphabetically for determinism', () => {
    const graph = makeGraph([
      makeNode('a', { author: { name: 'Zoe', email: '' } }),
      makeNode('b', { author: { name: 'Amy', email: '' } }),
    ]);
    expect(groupByAuthor(graph).map((entry) => entry.author)).toEqual(['Amy', 'Zoe']);
  });

  it('labels an anonymous author', () => {
    const graph = makeGraph([makeNode('a', { author: { name: '', email: '' } })]);
    expect(groupByAuthor(graph)).toEqual([{ author: '(unknown)', count: 1 }]);
  });
});

describe('clusterByFile', () => {
  it('sorts descending by count then by path', () => {
    const graph = makeGraph([
      makeNode('a', { filePath: 'src/b.ts' }),
      makeNode('b', { filePath: 'src/a.ts' }),
      makeNode('c', { filePath: 'src/b.ts' }),
    ]);
    expect(clusterByFile(graph)).toEqual([
      { filePath: 'src/b.ts', count: 2 },
      { filePath: 'src/a.ts', count: 1 },
    ]);
  });

  it('handles an empty graph', () => {
    expect(clusterByFile(makeGraph([]))).toEqual([]);
  });
});

describe('nodeById', () => {
  it('finds a node and returns null on a miss', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')]);
    expect(nodeById(graph, 'b')?.id).toBe('b');
    expect(nodeById(graph, 'missing')).toBeNull();
    expect(nodeById(graph, '')).toBeNull();
    expect(nodeById(graph, undefined as unknown as string)).toBeNull();
  });

  it('returns the first node when ids are duplicated', () => {
    const graph = makeGraph([
      makeNode('dup', { blockName: 'first' }),
      makeNode('dup', { blockName: 'second' }),
    ]);
    expect(nodeById(graph, 'dup')?.blockName).toBe('first');
  });

  it('caches per graph object but not across graphs', () => {
    const first = makeGraph([makeNode('a')]);
    const second = makeGraph([makeNode('b')]);
    expect(nodeById(first, 'a')).not.toBeNull();
    expect(nodeById(second, 'a')).toBeNull();
    expect(nodeById(second, 'b')).not.toBeNull();
  });
});

describe('relatedNodes', () => {
  it('returns the node plus its direct neighbours, chronologically', () => {
    const graph = makeGraph(
      [
        makeNode('mid', { timestamp: T0 + 10 * DAY }),
        makeNode('early', { timestamp: T0 }),
        makeNode('late', { timestamp: T0 + 20 * DAY }),
        makeNode('island', { timestamp: T0 + DAY }),
      ],
      [makeEdge('mid', 'early'), makeEdge('late', 'mid')],
    );
    expect(relatedNodes(graph, 'mid')).toEqual(['early', 'mid', 'late']);
  });

  it('never repeats the node itself, even with a self edge', () => {
    const graph = makeGraph([makeNode('a')], [makeEdge('a', 'a')]);
    expect(relatedNodes(graph, 'a')).toEqual(['a']);
  });

  it('returns an empty array for an unknown node', () => {
    expect(relatedNodes(makeGraph([makeNode('a')]), 'ghost')).toEqual([]);
  });
});

describe('countEdgeTypes', () => {
  it('reports a zero for every type present in the domain model', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [makeEdge('a', 'b', 'EVOLVED_FROM'), makeEdge('a', 'b', 'EVOLVED_FROM')],
    );
    const counts = countEdgeTypes(graph);
    expect(counts.EVOLVED_FROM).toBe(2);
    expect(counts.MOVED_FROM).toBe(0);
    expect(Object.keys(counts)).toHaveLength(5);
  });
});
