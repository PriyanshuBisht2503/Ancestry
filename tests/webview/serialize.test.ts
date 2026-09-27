/**
 * `sanitizeGraph` is the boundary between an in-process analysis result (or a
 * JSON file on disk) and a webview that runs bundled third-party code. These
 * tests are therefore written as *attacks* as much as features: every case is
 * something that, unhandled, would either crash the panel, poison the render
 * matrices, or mislead the user about how much history is on screen.
 */

import { describe, expect, it } from 'vitest';
import {
  graphToJson,
  parseGraphJson,
  sanitizeGraph,
  toWebviewPayload,
} from '../../src/webview/serialize';
import { SCHEMA_URI } from '../../src/types';
import { makeGraph, makeNode, T0 } from './fixtures';

describe('sanitizeGraph — total function', () => {
  it('never throws on hostile or nonsensical input', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      '',
      'a string',
      true,
      [],
      [1, 2, 3],
      {},
      { nodes: 'not an array' },
      { nodes: [null, undefined, 1, 'x'] },
      { edges: [null, 3] },
      { nodes: [{}], edges: [{}] },
      Object.create({ evil: true }),
      new Date(),
      () => undefined,
    ];
    for (const input of inputs) {
      const result = sanitizeGraph(input as never);
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
      expect(result.schema).toBe(SCHEMA_URI);
    }
  });

  it('returns an empty but valid graph for a cyclic payload', () => {
    const cyclic: Record<string, unknown> = { nodes: [], edges: [] };
    cyclic.self = cyclic;
    const result = sanitizeGraph(cyclic as never);
    expect(result.nodes).toEqual([]);
    expect(result.schema).toBe(SCHEMA_URI);
  });
});

describe('sanitizeGraph — node validation', () => {
  it('drops nodes whose id is missing or not a string', () => {
    const graph = makeGraph([
      makeNode('keep'),
      { ...makeNode('bad'), id: undefined as unknown as string },
      { ...makeNode('bad2'), id: 7 as unknown as string },
      { ...makeNode('bad3'), id: '' },
    ]);
    const result = sanitizeGraph(graph);
    expect(result.nodes.map((node) => node.id)).toEqual(['keep']);
    expect(result.warnings.join(' ')).toMatch(/Dropped 3 malformed or duplicate node/);
  });

  it('drops nodes without a usable file path', () => {
    const graph = makeGraph([
      makeNode('keep'),
      { ...makeNode('noPath'), filePath: '' },
      { ...makeNode('nullPath'), filePath: null as unknown as string },
    ]);
    expect(sanitizeGraph(graph).nodes.map((node) => node.id)).toEqual(['keep']);
  });

  it('drops duplicate node ids, keeping the first', () => {
    const graph = makeGraph([
      makeNode('dup', { blockName: 'first' }),
      makeNode('other'),
      makeNode('dup', { blockName: 'second' }),
    ]);
    const result = sanitizeGraph(graph);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.blockName).toBe('first');
  });

  it('clamps out-of-range similarity into [0, 1]', () => {
    const graph = makeGraph([
      makeNode('high', { similarity: 1.0000000004 }),
      makeNode('low', { similarity: -3 }),
      makeNode('nan', { similarity: Number.NaN }),
      makeNode('inf', { similarity: Number.POSITIVE_INFINITY }),
      makeNode('str', { similarity: '0.5' as unknown as number }),
    ]);
    const values = sanitizeGraph(graph).nodes.map((node) => node.similarity);
    expect(values).toEqual([1, 0, 0, 0, 0]);
  });

  it('drops non-finite timestamps and line numbers', () => {
    const graph = makeGraph([
      makeNode('a', {
        timestamp: Number.NaN,
        lineStart: Number.NaN,
        lineEnd: Number.NEGATIVE_INFINITY,
      }),
    ]);
    const node = sanitizeGraph(graph).nodes[0]!;
    expect(Number.isFinite(node.timestamp)).toBe(true);
    expect(node.lineStart).toBe(0);
    expect(node.lineEnd).toBe(0);
  });

  it('never lets lineEnd precede lineStart', () => {
    const graph = makeGraph([makeNode('a', { lineStart: 40, lineEnd: 4 })]);
    const node = sanitizeGraph(graph).nodes[0]!;
    expect(node.lineEnd).toBeGreaterThanOrEqual(node.lineStart);
  });

  it('whitelists classification, blockKind and language', () => {
    const graph = makeGraph([
      makeNode('a', {
        classification: 'catastrophic' as never,
        blockKind: 'nonsense' as never,
        language: 'brainfuck' as never,
      }),
    ]);
    const node = sanitizeGraph(graph).nodes[0]!;
    expect(node.classification).toBe('unrelated');
    expect(node.blockKind).toBe('unknown');
    expect(node.language).toBe('unknown');
  });

  it('caps string lengths', () => {
    const graph = makeGraph([
      makeNode('a', {
        blockName: 'n'.repeat(100_000),
        signature: 's'.repeat(100_000),
        filePath: 'f'.repeat(5000),
      }),
    ]);
    const node = sanitizeGraph(graph).nodes[0]!;
    expect(node.blockName!.length).toBeLessThanOrEqual(256);
    expect(node.signature!.length).toBeLessThanOrEqual(2000);
    expect(node.filePath.length).toBeLessThanOrEqual(1024);
  });

  it('coerces a broken author into empty strings rather than dropping the node', () => {
    const graph = makeGraph([
      makeNode('a', { author: null as never }),
      makeNode('b', { author: { name: 5, email: [] } as never }),
      makeNode('c', { author: { name: 'Grace', email: 'g@example.com' } }),
    ]);
    const nodes = sanitizeGraph(graph).nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.author).toEqual({ name: '', email: '' });
    expect(nodes[1]?.author).toEqual({ name: '', email: '' });
    expect(nodes[2]?.author.name).toBe('Grace');
  });

  it('de-duplicates and caps the branch list', () => {
    const graph = makeGraph([
      makeNode('a', { branches: ['main', 'main', 'dev', '', 'x'.repeat(1000)] }),
    ]);
    const node = sanitizeGraph(graph).nodes[0]!;
    expect(node.branches).toEqual(['main', 'dev', 'x'.repeat(256)]);
  });

  it('rejects a node carrying a __proto__ key', () => {
    const hostile = JSON.parse('{"id":"a","filePath":"a.ts","__proto__":{"polluted":true}}');
    const graph = makeGraph([hostile, makeNode('b')]);
    const result = sanitizeGraph(graph);
    expect(result.nodes.map((node) => node.id)).toEqual(['b']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sanitizeGraph — edge validation', () => {
  it('drops edges with an unknown type', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [
        {
          id: 'e1',
          from: 'a',
          to: 'b',
          type: 'SPAWNED_FROM' as never,
          similarity: 0.5,
          confidence: 0.5,
          sameFile: true,
          lineDelta: null,
          rationale: '',
        },
        {
          id: 'e2',
          from: 'b',
          to: 'a',
          type: 'EVOLVED_FROM',
          similarity: 0.5,
          confidence: 0.5,
          sameFile: true,
          lineDelta: null,
          rationale: '',
        },
      ],
    );
    const result = sanitizeGraph(graph);
    expect(result.edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('drops dangling edges whose endpoint was also removed', () => {
    const graph = makeGraph(
      [makeNode('a', { id: 'a' })],
      [
        {
          id: 'e1',
          from: 'a',
          to: 'ghost',
          type: 'EVOLVED_FROM',
          similarity: 1,
          confidence: 1,
          sameFile: false,
          lineDelta: null,
          rationale: '',
        },
      ],
    );
    expect(sanitizeGraph(graph).edges).toEqual([]);
  });

  it('clamps similarity and confidence, and coerces non-finite lineDelta to null', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [
        {
          id: 'e1',
          from: 'a',
          to: 'b',
          type: 'COPIED_FROM',
          similarity: 4,
          confidence: -1,
          sameFile: true,
          lineDelta: Number.NaN,
          rationale: 'x'.repeat(10_000),
        },
      ],
    );
    const edge = sanitizeGraph(graph).edges[0]!;
    expect(edge.similarity).toBe(1);
    expect(edge.confidence).toBe(0);
    expect(edge.lineDelta).toBeNull();
    expect(edge.rationale.length).toBeLessThanOrEqual(2000);
  });

  it('synthesises an id when one is missing', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [
        {
          from: 'a',
          to: 'b',
          type: 'MERGED_FROM',
          similarity: 1,
          confidence: 1,
          sameFile: false,
          lineDelta: null,
          rationale: '',
        } as never,
      ],
    );
    expect(sanitizeGraph(graph).edges[0]?.id).toBe('MERGED_FROM:a->b');
  });
});

describe('sanitizeGraph — graph-level caps', () => {
  it('caps the node count and records a warning', () => {
    const nodes = Array.from({ length: 20_050 }, (_, index) => makeNode(`n${index}`));
    const result = sanitizeGraph(makeGraph(nodes));
    expect(result.nodes).toHaveLength(20_000);
    expect(result.warnings.join(' ')).toMatch(/truncated/i);
  });

  it('caps the edge count and records a warning', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = Array.from({ length: 61_000 }, (_, index) => ({
      id: `e${index}`,
      from: 'a',
      to: 'b',
      type: 'EVOLVED_FROM' as const,
      similarity: 0.5,
      confidence: 0.5,
      sameFile: true,
      lineDelta: null,
      rationale: '',
    }));
    const result = sanitizeGraph(makeGraph(nodes, edges));
    expect(result.edges.length).toBeLessThanOrEqual(60_000);
    expect(result.warnings.join(' ')).toMatch(/truncated/i);
  });

  it('caps retained warnings and unparsed entries', () => {
    const graph = makeGraph([], [], {
      warnings: Array.from({ length: 500 }, (_, index) => `w${index}`),
      unparsed: Array.from({ length: 900 }, (_, index) => ({
        filePath: `f${index}.ts`,
        reason: 'x',
      })),
    });
    const result = sanitizeGraph(graph);
    expect(result.warnings.length).toBeLessThanOrEqual(100);
    expect(result.unparsed.length).toBeLessThanOrEqual(500);
  });

  it('keeps stats numeric and null-safe', () => {
    const graph = makeGraph([], [], {
      stats: {
        ...makeGraph().stats,
        nodeCount: Number.NaN,
        avgSimilarity: 42,
        earliestTimestamp: 'soon' as unknown as number,
      },
    });
    const result = sanitizeGraph(graph);
    expect(result.stats.nodeCount).toBe(0);
    expect(result.stats.avgSimilarity).toBe(1);
    expect(result.stats.earliestTimestamp).toBeNull();
  });

  it('validates the origin record, defaulting an unknown basis to inconclusive', () => {
    const graph = makeGraph([makeNode('a')], [], {
      origin: {
        nodeId: 'a',
        filePath: 'a.ts',
        commit: 'c',
        shortCommit: 'c',
        author: { name: 'A', email: 'a@b' },
        timestamp: T0,
        similarity: 0.9,
        basis: 'because' as never,
        disclaimer: 'd',
      },
    });
    expect(sanitizeGraph(graph).origin?.basis).toBe('inconclusive');
  });
});

describe('toWebviewPayload', () => {
  it('sanitises the graph and caps the focus source', () => {
    const payload = toWebviewPayload(
      makeGraph([makeNode('a', { similarity: 9 })]),
      'z'.repeat(500_000),
      { durationMs: 12, cacheHits: 3, cacheMisses: 4 },
    );
    expect(payload.graph.nodes[0]?.similarity).toBe(1);
    expect(payload.focusSource.length).toBeLessThanOrEqual(200_000);
    expect(payload.stats).toEqual({ durationMs: 12, cacheHits: 3, cacheMisses: 4 });
    expect(payload.engineVersion).toBe('0.1.0');
  });

  it('coerces broken run stats to zero', () => {
    const payload = toWebviewPayload(makeGraph(), '', {
      durationMs: Number.NaN,
      cacheHits: -5,
      cacheMisses: Number.POSITIVE_INFINITY,
    });
    expect(payload.stats).toEqual({ durationMs: 0, cacheHits: 0, cacheMisses: 0 });
  });
});

describe('graphToJson / parseGraphJson', () => {
  it('round-trips through JSON', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')], []);
    const parsed = parseGraphJson(graphToJson(graph));
    expect(parsed).not.toBeNull();
    expect(parsed?.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('is stable: two exports of the same graph are byte-identical', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')], []);
    expect(graphToJson(graph)).toBe(graphToJson(graph));
  });

  it('is pretty-printed with two-space indentation', () => {
    const json = graphToJson(makeGraph([makeNode('a')]));
    expect(json.split('\n')[1]).toMatch(/^ {2}"/);
  });

  it('rejects a wrong schema', () => {
    const graph = makeGraph([makeNode('a')]);
    const tampered = JSON.stringify({ ...graph, schema: 'ancestry://graph/v999' });
    expect(parseGraphJson(tampered)).toBeNull();
  });

  it('rejects non-JSON, non-objects and empty input', () => {
    expect(parseGraphJson('not json')).toBeNull();
    expect(parseGraphJson('')).toBeNull();
    expect(parseGraphJson('[]')).toBeNull();
    expect(parseGraphJson('null')).toBeNull();
    expect(parseGraphJson('42')).toBeNull();
    expect(parseGraphJson(undefined as unknown as string)).toBeNull();
  });

  it('sanitises a hand-edited file with the right schema', () => {
    const edited = JSON.stringify({
      schema: SCHEMA_URI,
      nodes: [{ id: 'a', filePath: 'a.ts', similarity: 99 }],
      edges: [],
    });
    const parsed = parseGraphJson(edited);
    expect(parsed?.nodes[0]?.similarity).toBe(1);
  });
});
