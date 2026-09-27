/**
 * The layout is the module that makes the *claim* of the whole product — that
 * the picture shows the true order and grouping of a block's history. These
 * tests therefore assert the semantic invariants (time goes right, branches go
 * on their own row, modules get their own lane, nothing overlaps) and, most
 * importantly, that it is deterministic: a visualisation that jitters between
 * renders is not a visualisation.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsSize,
  computeEdgeCurves,
  computeLayout,
  type LayoutNode,
} from '../../src/webview/client/core/layout';
import { DETACHED_BRANCH } from '../../src/webview/client/core/domain';
import { generateTimeTicks } from '../../src/webview/client/core/timeline';
import { DAY, makeEdge, makeGraph, makeNode, T0 } from './fixtures';

function positionsById(nodes: LayoutNode[]): Map<string, [number, number, number]> {
  return new Map(nodes.map((node) => [node.id, node.position]));
}

describe('computeLayout — X is time', () => {
  it('is monotonically non-decreasing with the timestamp', () => {
    const graph = makeGraph(
      [0, 1, 2, 3, 4].map((index) =>
        makeNode(`n${index}`, { timestamp: T0 + index * 7 * DAY, commit: `c${index}` }),
      ),
    );
    const { nodes } = computeLayout(graph);
    const byTime = [...nodes].sort((a, b) => {
      const left = graph.nodes.find((node) => node.id === a.id)!.timestamp;
      const right = graph.nodes.find((node) => node.id === b.id)!.timestamp;
      return left - right;
    });
    const xs = byTime.map((node) => node.position[0]);
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index]!).toBeGreaterThanOrEqual(xs[index - 1]!);
    }
  });

  it('starts the earliest node at X = 0 and ends the latest at the span', () => {
    const graph = makeGraph([
      makeNode('early', { timestamp: T0 }),
      makeNode('late', { timestamp: T0 + 10 * DAY }),
    ]);
    const byId = positionsById(computeLayout(graph).nodes);
    expect(byId.get('early')![0]).toBe(0);
    expect(byId.get('late')![0]).toBeGreaterThan(0);
  });

  it('maps time affinely: X distance is proportional to elapsed time', () => {
    const graph = makeGraph([
      makeNode('t0', { timestamp: T0, commit: 'c0' }),
      makeNode('t3', { timestamp: T0 + 3 * DAY, commit: 'c3' }),
      makeNode('t4', { timestamp: T0 + 4 * DAY, commit: 'c4' }),
    ]);
    const byId = positionsById(computeLayout(graph).nodes);
    const span = byId.get('t4')![0] - byId.get('t0')![0];
    // 3/4 of the elapsed 4 days should be 3/4 of the X span.
    expect(byId.get('t3')![0]).toBeCloseTo((3 / 4) * span, 3);
  });

  it('spans a wider X range when there are more distinct commits', () => {
    const few = makeGraph([
      makeNode('a', { timestamp: T0 }),
      makeNode('b', { timestamp: T0 + DAY }),
    ]);
    const many = makeGraph([
      makeNode('a', { timestamp: T0 }),
      makeNode('b', { timestamp: T0 + DAY }),
      makeNode('c', { timestamp: T0 + 2 * DAY }),
      makeNode('d', { timestamp: T0 + 3 * DAY }),
    ]);
    expect(boundsSize(computeLayout(many).bounds)[0]).toBeGreaterThan(
      boundsSize(computeLayout(few).bounds)[0],
    );
  });

  it('fans nodes out along X when every timestamp is identical', () => {
    const graph = makeGraph(['a', 'b', 'c'].map((id) => makeNode(id, { timestamp: T0 })));
    const xs = computeLayout(graph).nodes.map((node) => node.position[0]);
    expect(new Set(xs).size).toBe(3);
  });
});

describe('computeLayout — Y is branch', () => {
  it('gives a node with more branches the row of its branch', () => {
    const graph = makeGraph([
      makeNode('onMain', { branches: ['main'] }),
      makeNode('onFeature', { branches: ['feature/thing'] }),
    ]);
    const { axis, nodes } = computeLayout(graph);
    const byId = positionsById(nodes);
    const mainRow = axis.yRows.find((row) => row.label === 'main')!;
    const featureRow = axis.yRows.find((row) => row.label === 'feature/thing')!;
    expect(byId.get('onMain')![1]).toBe(mainRow.value);
    expect(byId.get('onFeature')![1]).toBe(featureRow.value);
    expect(mainRow.value).not.toBe(featureRow.value);
  });

  it('lists one row per branch, sorted, with the detached row last', () => {
    const graph = makeGraph([
      makeNode('a', { branches: ['zeta', 'alpha'] }),
      makeNode('b', { branches: [] }),
      makeNode('c', { branches: ['main'] }),
    ]);
    const labels = computeLayout(graph).axis.yRows.map((row) => row.label);
    expect(labels).toEqual(['alpha', 'main', 'zeta', DETACHED_BRANCH]);
    expect(labels[labels.length - 1]).toBe(DETACHED_BRANCH);
  });

  it('assigns a node on several branches to exactly one deterministic row', () => {
    const graph = makeGraph([makeNode('a', { branches: ['release', 'develop', 'main'] })]);
    const { axis, nodes } = computeLayout(graph);
    const rowValues = new Set(axis.yRows.map((row) => row.value));
    expect(rowValues.has(nodes[0]!.position[1])).toBe(true);
    // The smallest name wins, deterministically.
    const develop = axis.yRows.find((row) => row.label === 'develop')!;
    expect(nodes[0]!.position[1]).toBe(develop.value);
  });

  it('gives every row a distinct palette colour for the first ten branches', () => {
    const nodes = Array.from({ length: 10 }, (_, index) =>
      makeNode(`n${index}`, { branches: [`b${index}`] }),
    );
    const colors = computeLayout(makeGraph(nodes)).axis.yRows.map((row) => row.color);
    expect(new Set(colors).size).toBe(10);
  });

  it('is centred on Y = 0', () => {
    const graph = makeGraph([makeNode('a', { branches: ['only'] })]);
    const { axis, nodes } = computeLayout(graph);
    expect(nodes[0]!.position[1]).toBeCloseTo(0, 6);
    expect(axis.yRows[0]!.value).toBeCloseTo(0, 6);
  });
});

describe('computeLayout — Z is module', () => {
  it('gives distinct modules distinct lanes', () => {
    const graph = makeGraph([
      makeNode('a', { filePath: 'src/alpha/one.ts' }),
      makeNode('b', { filePath: 'src/beta/two.ts' }),
    ]);
    const { axis, nodes } = computeLayout(graph);
    const byId = positionsById(nodes);
    expect(axis.zLanes.map((lane) => lane.label)).toEqual(['src/alpha', 'src/beta']);
    expect(byId.get('a')![2]).not.toBe(byId.get('b')![2]);
  });

  it('orders lanes alphabetically for stability', () => {
    const graph = makeGraph([
      makeNode('a', { filePath: 'src/zulu/a.ts' }),
      makeNode('b', { filePath: 'src/alpha/b.ts' }),
      makeNode('c', { filePath: 'src/mike/c.ts' }),
    ]);
    expect(computeLayout(graph).axis.zLanes.map((lane) => lane.label)).toEqual([
      'src/alpha',
      'src/mike',
      'src/zulu',
    ]);
  });

  it('falls back to the node module when the file path is unusable', () => {
    const graph = makeGraph([makeNode('a', { filePath: '', module: 'custom/module' })]);
    expect(computeLayout(graph).axis.zLanes.map((lane) => lane.label)).toEqual(['custom/module']);
  });

  it('is centred on Z = 0', () => {
    const graph = makeGraph([makeNode('a', { filePath: 'src/only/a.ts' })]);
    expect(computeLayout(graph).nodes[0]!.position[2]).toBeCloseTo(0, 6);
  });
});

describe('computeLayout — collisions and the origin', () => {
  it('does not place two nodes at the same commit on the same point', () => {
    const graph = makeGraph(
      ['a', 'b', 'c'].map((id) => makeNode(id, { timestamp: T0, commit: 'same' })),
    );
    const points = computeLayout(graph).nodes.map((node) => node.position.join(','));
    expect(new Set(points).size).toBe(3);
  });

  it('separates two nodes in the same commit, branch and module', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')]);
    const byId = positionsById(computeLayout(graph).nodes);
    expect(byId.get('a')!.join(',')).not.toBe(byId.get('b')!.join(','));
  });

  it('offsets the origin node by originIsolation', () => {
    const withoutOrigin = computeLayout(
      makeGraph([makeNode('a', { isOrigin: true }), makeNode('b', { isOrigin: false })]),
      { originIsolation: 0 },
    );
    const withOrigin = computeLayout(
      makeGraph([makeNode('a', { isOrigin: true }), makeNode('b', { isOrigin: false })]),
      { originIsolation: 2.5 },
    );
    const plainBefore = positionsById(withoutOrigin.nodes).get('b')![1];
    const plainAfter = positionsById(withOrigin.nodes).get('b')![1];
    const originBefore = positionsById(withoutOrigin.nodes).get('a')![1];
    const originAfter = positionsById(withOrigin.nodes).get('a')![1];
    expect(originAfter - originBefore).toBeCloseTo(2.5, 3);
    expect(plainAfter).toBeCloseTo(plainBefore, 3);
  });

  it('respects custom gaps', () => {
    const graph = makeGraph([
      makeNode('a', { filePath: 'src/a/x.ts' }),
      makeNode('b', { filePath: 'src/b/x.ts' }),
    ]);
    const tight = computeLayout(graph, { zGap: 1 });
    const loose = computeLayout(graph, { zGap: 10 });
    expect(boundsSize(loose.bounds)[2]).toBeGreaterThan(boundsSize(tight.bounds)[2]);
  });
});

describe('computeLayout — determinism', () => {
  const graph = makeGraph(
    [
      makeNode('n1', { timestamp: T0, branches: ['main'] }),
      makeNode('n2', { timestamp: T0, branches: ['main'] }),
      makeNode('n3', { timestamp: T0 + DAY, branches: ['dev'], filePath: 'src/x/y.ts' }),
      makeNode('n4', { timestamp: T0 + 3 * DAY, branches: [], isOrigin: true }),
    ],
    [makeEdge('n2', 'n1'), makeEdge('n3', 'n2')],
  );

  it('produces identical output for the same graph', () => {
    expect(JSON.stringify(computeLayout(graph))).toBe(JSON.stringify(computeLayout(graph)));
  });

  it('is insensitive to the input order of nodes', () => {
    const shuffled = makeGraph([...graph.nodes].reverse(), graph.edges);
    const a = positionsById(computeLayout(graph).nodes);
    const b = positionsById(computeLayout(shuffled).nodes);
    for (const [id, position] of a) {
      expect(b.get(id)).toEqual(position);
    }
  });
});

describe('computeLayout — degenerate graphs', () => {
  it('handles an empty graph', () => {
    const result = computeLayout(makeGraph([]));
    expect(result.nodes).toEqual([]);
    expect(result.axis.yRows).toEqual([]);
    expect(result.axis.zLanes).toEqual([]);
    expect(result.bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });

  it('handles a single node', () => {
    const result = computeLayout(makeGraph([makeNode('only')]));
    expect(result.nodes).toHaveLength(1);
    expect(result.bounds.min[0]).toBeLessThanOrEqual(result.bounds.max[0]);
    expect(Number.isFinite(result.nodes[0]!.position[1])).toBe(true);
  });

  it('nudges a zero-extent axis so fitToGraph never divides by zero', () => {
    const result = computeLayout(makeGraph([makeNode('only')]));
    expect(result.bounds.max[1]).toBeGreaterThan(result.bounds.min[1]);
    expect(boundsSize(result.bounds).every((size) => size > 0)).toBe(true);
  });

  it('replaces non-finite timestamps with 0 rather than poisoning the bounds', () => {
    const graph = makeGraph([
      makeNode('a', { timestamp: Number.NaN }),
      makeNode('b', { timestamp: T0 }),
    ]);
    const result = computeLayout(graph);
    expect(result.nodes.every((node) => node.position.every(Number.isFinite))).toBe(true);
  });

  it('tolerates nonsense options', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')]);
    const result = computeLayout(graph, {
      xGap: Number.NaN,
      yGap: 0,
      zGap: -5,
      jitter: Number.NaN,
    });
    expect(result.nodes.every((node) => node.position.every(Number.isFinite))).toBe(true);
  });
});

describe('computeLayout — axis metadata', () => {
  it('labels the axes and emits time ticks covering the range', () => {
    const graph = makeGraph([
      makeNode('a', { timestamp: T0 }),
      makeNode('b', { timestamp: T0 + 200 * DAY }),
    ]);
    const { axis } = computeLayout(graph);
    expect(axis.xLabel).toBe('Time');
    expect(axis.yLabel).toBe('Branch');
    expect(axis.zLabel).toBe('Module');
    expect(axis.xTicks.length).toBeGreaterThan(1);
    expect(axis.xTicks[0]!.timestamp).toBeCloseTo(T0, -1);
  });
});

describe('generateTimeTicks', () => {
  it('covers the range and respects targetCount', () => {
    const min = T0;
    const max = T0 + 400 * DAY;
    for (const target of [3, 5, 8, 12, 20]) {
      const ticks = generateTimeTicks(min, max, target);
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.length).toBeLessThanOrEqual(24);
      expect(ticks[0]!.timestamp).toBe(min);
      expect(ticks[ticks.length - 1]!.timestamp).toBe(max);
      for (const tick of ticks) {
        expect(tick.timestamp).toBeGreaterThanOrEqual(min);
        expect(tick.timestamp).toBeLessThanOrEqual(max);
        expect(tick.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('never emits more than 24 ticks, even for a 500-year span', () => {
    const ticks = generateTimeTicks(T0, T0 + 500 * 365.25 * DAY, 50);
    expect(ticks.length).toBeLessThanOrEqual(24);
    expect(ticks[0]!.timestamp).toBe(T0);
    expect(ticks[ticks.length - 1]!.timestamp).toBeCloseTo(T0 + 500 * 365.25 * DAY, -1);
  });

  it('is deterministic', () => {
    const a = generateTimeTicks(T0, T0 + 90 * DAY, 7);
    const b = generateTimeTicks(T0, T0 + 90 * DAY, 7);
    expect(a).toEqual(b);
  });

  it('handles a zero-width and an inverted range', () => {
    expect(generateTimeTicks(T0, T0)).toHaveLength(1);
    expect(generateTimeTicks(T0, T0 - 1)).toEqual([]);
    expect(generateTimeTicks(Number.NaN, T0)).toEqual([]);
  });
});

describe('computeEdgeCurves', () => {
  const nodes: LayoutNode[] = [
    { id: 'a', position: [0, 0, 0] },
    { id: 'b', position: [10, 0, 0] },
  ];

  it('produces a polyline for each resolvable edge', () => {
    const curves = computeEdgeCurves(nodes, [makeEdge('a', 'b')]);
    const curve = curves.get('EVOLVED_FROM:a->b')!;
    expect(curve.length).toBeGreaterThan(2);
    expect(curve[0]).toEqual([0, 0, 0]);
    expect(curve[curve.length - 1]).toEqual([10, 0, 0]);
  });

  it('skips edges whose endpoints are not in the layout', () => {
    const curves = computeEdgeCurves(nodes, [makeEdge('a', 'ghost'), makeEdge('ghost', 'b')]);
    expect(curves.size).toBe(0);
  });

  it('handles coincident endpoints without producing NaN', () => {
    const curves = computeEdgeCurves(
      [
        { id: 'a', position: [3, 3, 3] },
        { id: 'b', position: [3, 3, 3] },
      ],
      [makeEdge('a', 'b')],
    );
    const curve = curves.get('EVOLVED_FROM:a->b')!;
    expect(curve.every((point) => point.every(Number.isFinite))).toBe(true);
  });

  it('bows two edges between the same points in different directions', () => {
    const forward = computeEdgeCurves(nodes, [makeEdge('a', 'b', 'EVOLVED_FROM')]).get(
      'EVOLVED_FROM:a->b',
    )!;
    const reverse = computeEdgeCurves(nodes, [makeEdge('b', 'a', 'COPIED_FROM')]).get(
      'COPIED_FROM:b->a',
    )!;
    const forwardMid = forward[Math.floor(forward.length / 2)]!;
    const reverseMid = reverse[Math.floor(reverse.length / 2)]!;
    expect(Math.sign(forwardMid[1])).not.toBe(Math.sign(reverseMid[1]));
  });
});
