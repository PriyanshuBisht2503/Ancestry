/**
 * Degenerate inputs — specification §10: "one unanalysable file or commit must
 * never abort an analysis."
 *
 * Every case here is something the orchestrator can realistically hand over (or
 * something a future caller could construct by mistake): nothing, a focus that
 * is not in the candidate list, duplicated identities, clock skew, missing
 * branches, and a very large candidate set.
 */

import { describe, expect, it } from 'vitest';

import { AncestryGraphBuilder } from '../../src/graph';
import type { VersionCandidate } from '../../src/graph';
import { makeBlock, makeCandidate, makeCommit, makeInput, makeSimilarity } from './inputs.test';

/** Distinct in its first 12 characters, because `makeNodeId` truncates there. */
function hashFor(index: number): string {
  return `${index.toString(16).padStart(8, '0')}${'0'.repeat(32)}`;
}

function version(
  index: number,
  similarity: number,
  timestamp = 1_000_000 * index,
  overrides: Partial<VersionCandidate> = {},
): VersionCandidate {
  const hash = hashFor(index);
  return makeCandidate({
    commit: makeCommit({ hash, shortHash: hash.slice(0, 7), authorTimestamp: timestamp }),
    similarity: makeSimilarity(similarity),
    ...overrides,
  });
}

function build(overrides: Parameters<typeof makeInput>[0] = {}) {
  return new AncestryGraphBuilder(makeInput(overrides)).build();
}

describe('empty and single inputs', () => {
  it('builds a focus-only graph from an empty candidate list', () => {
    const focus = version(4, 1);
    const graph = build({ focus, candidates: [] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.isFocus).toBe(true);
    expect(graph.edges).toHaveLength(0);
    expect(graph.origin).toBeNull();
    expect(graph.stats.avgSimilarity).toBe(0);
    expect(graph.stats.earliestTimestamp).toBe(4_000_000);
    expect(
      graph.warnings.some((warning) => warning.includes('was missing from the candidate list')),
    ).toBe(true);
  });

  it('builds a graph with no edges from a single node', () => {
    const focus = version(1, 1);
    const graph = build({ focus, candidates: [focus] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.origin).toBeNull();
    expect(graph.warnings).toEqual([]);
  });

  it('adds the focus when it is absent from the candidates', () => {
    const focus = version(4, 1);
    const graph = build({ focus, candidates: [version(1, 0.9), version(2, 0.95)] });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.filter((node) => node.isFocus)).toHaveLength(1);
    expect(graph.warnings).toHaveLength(1);
  });

  it('survives malformed candidate records', () => {
    const focus = version(2, 1);
    const broken = { block: { id: 'x' } } as unknown as VersionCandidate;
    const graph = build({ focus, candidates: [focus, version(1, 0.9), broken] });
    expect(graph.nodes).toHaveLength(2);
    expect(
      graph.warnings.some((warning) => warning.includes('malformed candidate record(s)')),
    ).toBe(true);
  });
});

describe('duplicate node ids', () => {
  it('collapses them, keeps the strongest and records the loss', () => {
    const focus = version(9, 1);
    const graph = build({
      focus,
      candidates: [focus, version(1, 0.7), version(1, 0.8), version(1, 0.95), version(1, 0.99)],
    });
    expect(graph.nodes).toHaveLength(2);
    const kept = graph.nodes.find((node) => !node.isFocus)!;
    expect(kept.similarity).toBe(0.99);
    const warning = graph.warnings.find((entry) => entry.startsWith('deduplicated'))!;
    expect(warning).toContain('3 candidate(s)');
  });

  it('is order-independent when every colliding candidate has the same score', () => {
    const focus = version(9, 1);
    const a = { ...version(1, 0.9), branches: ['main'] };
    const b = { ...version(1, 0.9), branches: ['topic'] };
    const forward = build({ focus, candidates: [focus, a, b] });
    const backward = build({ focus, candidates: [focus, b, a] });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
    expect(forward.nodes).toHaveLength(2);
  });
});

describe('clock skew and ties', () => {
  it('accepts a candidate with an identical timestamp', () => {
    const focus = version(3, 1, 5_000_000);
    const graph = build({ focus, candidates: [focus, version(1, 0.9, 5_000_000)] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.stats.earliestTimestamp).toBe(5_000_000);
    expect(graph.stats.latestTimestamp).toBe(5_000_000);
  });

  it('orders a full tie by commit hash, deterministically', () => {
    const focus = version(9, 1, 7_000_000);
    const forward = build({
      focus,
      candidates: [focus, version(1, 0.9, 7_000_000), version(2, 0.95, 7_000_000)],
    });
    const backward = build({
      focus,
      candidates: [version(2, 0.95, 7_000_000), version(1, 0.9, 7_000_000), focus],
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
    // All three share one timestamp, so the (timestamp, commit) order decides:
    // v1 < v2 < focus, which makes v1 the only predecessor of v2 and both of
    // them predecessors of the focus.
    expect(forward.edges).toHaveLength(3);
    const focusNode = forward.nodes.find((node) => node.isFocus)!;
    const focusIncoming = forward.edges.filter((edge) => edge.from === focusNode.id);
    expect(focusIncoming.map((edge) => edge.to).sort()).toEqual(
      [hashFor(1), hashFor(2)].map((hash) => `${makeBlock().id}@${hash.slice(0, 12)}`).sort(),
    );
    expect(focusIncoming.find((edge) => edge.similarity === 0.95)?.to).toContain(
      hashFor(2).slice(0, 12),
    );
  });

  it('terminates when every candidate shares one timestamp', () => {
    const focus = version(50, 1, 1_234_567);
    const candidates = [focus];
    for (let i = 1; i < 40; i++) {
      candidates.push(version(i, 0.9, 1_234_567));
    }
    const graph = build({ focus, candidates });
    expect(graph.nodes).toHaveLength(40);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.warnings.some((warning) => warning.includes('fan-out capped'))).toBe(true);
    const again = build({ focus, candidates: [...candidates].reverse() });
    expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
  });

  it('draws a merge edge even when the parent shares the child timestamp', () => {
    const parent = version(1, 0.5, 4_000_000);
    const focus = makeCandidate({
      commit: makeCommit({
        hash: hashFor(2),
        shortHash: hashFor(2).slice(0, 7),
        authorTimestamp: 4_000_000,
        isMerge: true,
        parents: [hashFor(1)],
      }),
      similarity: makeSimilarity(1),
    });
    const graph = build({ focus, candidates: [focus, parent] });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.type).toBe('MERGED_FROM');
  });
});

describe('incomplete records', () => {
  it('accepts a candidate with no branches', () => {
    const focus = version(2, 1);
    const graph = build({
      focus,
      candidates: [focus, version(1, 0.9, 1_000_000, { branches: [] })],
    });
    const node = graph.nodes.find((candidate) => !candidate.isFocus)!;
    expect(node.branches).toEqual([]);
    expect(graph.stats.branchCount).toBe(1);
  });

  it('accepts a candidate whose similarity record is missing a breakdown', () => {
    const focus = version(2, 1);
    const odd = { ...version(1, 0.9, 1_000_000) };
    odd.similarity = { ...odd.similarity, breakdown: {} as typeof odd.similarity.breakdown };
    const graph = build({ focus, candidates: [focus, odd] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });

  it('never lets a candidate point at itself', () => {
    const focus = version(1, 1);
    const self = {
      ...version(1, 1),
      similarity: makeSimilarity(1, {
        sourceBlockId: 'src/utils/format.ts::function::formatBytes::10',
        candidateBlockId: 'src/utils/format.ts::function::formatBytes::10',
      }),
    };
    const graph = build({ focus, candidates: [focus, self] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it('does not loop on mutually declared moves', () => {
    const a = version(1, 0.9, 1_000_000, {
      block: makeBlock({ filePath: 'src/a/one.ts', name: 'one' }),
      previousPath: 'src/b/two.ts',
    });
    const b = version(2, 0.9, 2_000_000, {
      block: makeBlock({ filePath: 'src/b/two.ts', name: 'two' }),
      previousPath: 'src/a/one.ts',
    });
    const graph = build({ focus: b, candidates: [a, b] });
    expect(graph.nodes).toHaveLength(2);
    for (const edge of graph.edges) {
      expect(edge.from).not.toBe(edge.to);
      expect(edge.type).toBe('MOVED_FROM');
    }
  });

  it('falls back to default thresholds when the caller supplies nonsense', () => {
    const focus = version(2, 1);
    const graph = new AncestryGraphBuilder(
      makeInput({
        focus,
        candidates: [focus, version(1, 0.9, 1_000_000)],
        thresholds: { strong: Number.NaN, possible: 0, ignore: -1 },
      }),
    ).build();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.type).toBe('EVOLVED_FROM');
  });
});

describe('scale', () => {
  it('builds 5 000 candidates in well under two seconds', () => {
    const focus = version(5_000, 1, 5_000_000_000);
    const candidates: VersionCandidate[] = [focus];
    for (let i = 1; i < 5_000; i++) {
      candidates.push(version(i, 0.95, i * 1_000));
    }

    const started = process.hrtime.bigint();
    const graph = new AncestryGraphBuilder(makeInput({ focus, candidates })).build();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(graph.nodes).toHaveLength(5_000);
    // 0 + 1 + 2 incoming edges for the first three nodes, then the cap of 3
    // for every remaining node.
    expect(graph.edges).toHaveLength(3 + 3 * 4_997);
    expect(graph.warnings.filter((w) => w.includes('fan-out capped'))).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
