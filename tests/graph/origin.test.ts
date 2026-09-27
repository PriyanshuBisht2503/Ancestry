/**
 * Origin detection — specification §5.
 *
 * Origin is the *earliest detected semantic match*, never an authorship claim.
 * These tests pin the three §5 bases, the inconclusive path, cycle safety and
 * the exact disclaimer wording.
 */

import { describe, expect, it } from 'vitest';

import type { AncestryEdge, AncestryNode } from '../../src/types';
import {
  ORIGIN_DISCLAIMER,
  ORIGIN_TERM,
  collectAncestors,
  detectOrigin,
  explainInconclusive,
  isAncestryEdgeType,
  originPath,
} from '../../src/graph';
import { DEFAULT_THRESHOLDS, makeEdge, makeGraph, makeNode } from './inputs.test';

const T = DEFAULT_THRESHOLDS;

function chain(
  specs: Array<{ id: string; similarity: number; timestamp: number; commit: string }>,
): AncestryNode[] {
  return specs.map((spec) =>
    makeNode({
      id: spec.id,
      similarity: spec.similarity,
      classification:
        spec.similarity >= T.strong
          ? 'strong'
          : spec.similarity >= T.possible
            ? 'possible'
            : 'weak',
      timestamp: spec.timestamp,
      commit: spec.commit,
      shortCommit: spec.commit.slice(0, 7),
      isFocus: spec.id === 'focus',
    }),
  );
}

/** Links each version to the previous one, oldest first. */
function link(nodes: readonly AncestryNode[]): AncestryEdge[] {
  const ordered = [...nodes].sort((a, b) => a.timestamp - b.timestamp);
  const edges: AncestryEdge[] = [];
  for (let i = 1; i < ordered.length; i++) {
    edges.push(makeEdge(ordered[i]!, ordered[i - 1]!, { type: 'EVOLVED_FROM' }));
  }
  return edges;
}

describe('ORIGIN_DISCLAIMER', () => {
  it('is the specification §5 wording, verbatim', () => {
    expect(ORIGIN_DISCLAIMER).toBe(
      'Git history records commits, not intentions. This is the earliest version Ancestry detected that is sufficiently similar to your selection — not proof of original authorship. The search covered the history available in this repository, which may be truncated by a shallow clone or by the configured depth limit.',
    );
  });

  it('calls the result an earliest version and makes no authorship claim', () => {
    expect(ORIGIN_DISCLAIMER).toContain('earliest version');
    expect(ORIGIN_DISCLAIMER).toContain('not proof of original authorship');
    expect(ORIGIN_DISCLAIMER).not.toMatch(/first version ever written/i);
    expect(ORIGIN_DISCLAIMER).not.toMatch(/originally authored/i);
    expect(ORIGIN_DISCLAIMER).not.toMatch(/written by\b/i);
  });

  it('names the result with the fixed §5 term', () => {
    expect(ORIGIN_TERM).toBe('earliest detected semantic match');
  });
});

describe('detectOrigin', () => {
  it('resolves a four-node linear chain to the oldest qualifying node', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.88, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.92, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'v3', similarity: 0.96, timestamp: 3000, commit: 'c'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 4000, commit: 'd'.repeat(40) },
    ]);
    const edges = link(nodes);

    const origin = detectOrigin(nodes, 'focus', T, edges);

    expect(origin).not.toBeNull();
    expect(origin?.nodeId).toBe('v1');
    expect(origin?.basis).toBe('earliest-match');
    expect(origin?.similarity).toBe(0.88);
    expect(origin?.filePath).toBe('src/utils/format.ts');
    expect(origin?.disclaimer).toBe(ORIGIN_DISCLAIMER);
  });

  it('skips ancestors below possible and reports earliest-match', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.5, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.85, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'v3', similarity: 0.88, timestamp: 3000, commit: 'c'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 4000, commit: 'd'.repeat(40) },
    ]);
    const edges = link(nodes);

    const origin = detectOrigin(nodes, 'focus', T, edges);

    expect(origin?.nodeId).toBe('v2');
    expect(origin?.basis).toBe('earliest-match');
  });

  it('reports earliest-strong-match when the oldest qualifies as strong', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.93, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'v3', similarity: 0.97, timestamp: 3000, commit: 'c'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 4000, commit: 'd'.repeat(40) },
    ]);
    const edges = link(nodes);

    const origin = detectOrigin(nodes, 'focus', T, edges);

    expect(origin?.nodeId).toBe('v1');
    expect(origin?.basis).toBe('earliest-strong-match');
  });

  it('returns null when fewer than two nodes qualify', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 2000, commit: 'b'.repeat(40) },
    ]);
    const edges = link(nodes);

    expect(detectOrigin(nodes, 'focus', T, edges)).toBeNull();
  });

  it('returns null when nothing is above ignore', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.2, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 2000, commit: 'b'.repeat(40) },
    ]);
    expect(detectOrigin(nodes, 'focus', T, link(nodes))).toBeNull();
  });

  it('returns null for an unknown focus id', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 3000, commit: 'c'.repeat(40) },
    ]);
    expect(detectOrigin(nodes, 'nope', T, link(nodes))).toBeNull();
  });

  it('terminates on a cyclic graph and picks the earliest node', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 3000, commit: 'c'.repeat(40) },
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const cyclic: AncestryEdge[] = [
      makeEdge(byId.get('v2')!, byId.get('v1')!, { type: 'EVOLVED_FROM' }),
      makeEdge(byId.get('focus')!, byId.get('v2')!, { type: 'EVOLVED_FROM' }),
      // back edge: the oldest points at the newest, which cannot be true in git
      // but must not hang the traversal.
      makeEdge(byId.get('v1')!, byId.get('focus')!, { type: 'COPIED_FROM' }),
    ];

    const origin = detectOrigin(nodes, 'focus', T, cyclic);

    expect(origin?.nodeId).toBe('v1');
    expect(
      collectAncestors(nodes, 'focus', cyclic)
        .map((node) => node.id)
        .sort(),
    ).toEqual(['v1', 'v2']);
  });

  it('walks through merged, moved and copied relationships too', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 3000, commit: 'c'.repeat(40) },
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const mixed: AncestryEdge[] = [
      makeEdge(byId.get('v2')!, byId.get('v1')!, { type: 'MERGED_FROM' }),
      makeEdge(byId.get('focus')!, byId.get('v2')!, { type: 'MOVED_FROM', sameFile: false }),
    ];
    expect(detectOrigin(nodes, 'focus', T, mixed)?.nodeId).toBe('v1');
  });

  it('falls back to a time-ordered chain when no edges are supplied', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'later', similarity: 0.95, timestamp: 9000, commit: 'z'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 4000, commit: 'c'.repeat(40) },
    ]);
    // Without edges the focus is at t=4000, so `later` (t=9000) is not an ancestor.
    expect(detectOrigin(nodes, 'focus', T)?.nodeId).toBe('v1');
  });
});

describe('explainInconclusive', () => {
  it('produces the inconclusive record when only one node qualifies', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 2000, commit: 'b'.repeat(40) },
    ]);
    const record = explainInconclusive(nodes, 'focus', T, link(nodes));
    expect(record?.basis).toBe('inconclusive');
    expect(record?.nodeId).toBe('v1');
    expect(record?.disclaimer).toBe(ORIGIN_DISCLAIMER);
  });

  it('falls back to the focus node when nothing clears possible', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.2, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 2000, commit: 'b'.repeat(40) },
    ]);
    const record = explainInconclusive(nodes, 'focus', T, link(nodes));
    expect(record?.basis).toBe('inconclusive');
    expect(record?.nodeId).toBe('focus');
  });

  it('returns null when the origin is conclusive and for unknown ids', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 3000, commit: 'c'.repeat(40) },
    ]);
    const edges = link(nodes);
    expect(explainInconclusive(nodes, 'focus', T, edges)).toBeNull();
    expect(explainInconclusive(nodes, 'nope', T, edges)).toBeNull();
  });
});

describe('isAncestryEdgeType', () => {
  it('accepts every relationship the graph can contain', () => {
    for (const type of [
      'EVOLVED_FROM',
      'COPIED_FROM',
      'MODIFIED_FROM',
      'MOVED_FROM',
      'MERGED_FROM',
    ]) {
      expect(isAncestryEdgeType(type)).toBe(true);
    }
    expect(isAncestryEdgeType('SOMETHING_ELSE')).toBe(false);
  });
});

describe('originPath', () => {
  it('follows a chain back to the origin', () => {
    const nodes = chain([
      { id: 'v1', similarity: 0.88, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'v2', similarity: 0.92, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'v3', similarity: 0.96, timestamp: 3000, commit: 'c'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 4000, commit: 'd'.repeat(40) },
    ]);
    const graph = makeGraph(nodes, link(nodes));
    expect(originPath(graph, 'focus')).toEqual(['focus', 'v3', 'v2', 'v1']);
    expect(originPath(graph, 'v2')).toEqual(['v2', 'v1']);
    expect(originPath(graph, 'v1')).toEqual(['v1']);
  });

  it('picks the best-ranked predecessor when a node has a branch', () => {
    const nodes = chain([
      { id: 'older', similarity: 0.8, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'better', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
      { id: 'focus', similarity: 1, timestamp: 3000, commit: 'c'.repeat(40) },
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const branched: AncestryEdge[] = [
      makeEdge(byId.get('focus')!, byId.get('older')!, { type: 'EVOLVED_FROM' }),
      makeEdge(byId.get('focus')!, byId.get('better')!, { type: 'EVOLVED_FROM' }),
    ];
    expect(originPath(makeGraph(nodes, branched), 'focus')).toEqual(['focus', 'better']);
  });

  it('terminates on a cycle', () => {
    const nodes = chain([
      { id: 'a', similarity: 0.95, timestamp: 1000, commit: 'a'.repeat(40) },
      { id: 'b', similarity: 0.95, timestamp: 2000, commit: 'b'.repeat(40) },
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const cyclic: AncestryEdge[] = [
      makeEdge(byId.get('a')!, byId.get('b')!, { type: 'EVOLVED_FROM' }),
      makeEdge(byId.get('b')!, byId.get('a')!, { type: 'EVOLVED_FROM' }),
    ];
    const path = originPath(makeGraph(nodes, cyclic), 'a');
    expect(path[0]).toBe('a');
    expect(new Set(path).size).toBe(path.length);
  });

  it('returns an empty path for an unknown node id', () => {
    const node = makeNode({ id: 'only' });
    expect(originPath(makeGraph([node]), 'nope')).toEqual([]);
  });
});
