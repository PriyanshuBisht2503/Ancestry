/**
 * Graph construction — specification §6.
 *
 * The reference fixture is a four-version linear history of one block in one
 * file, which makes every count in `GraphStats` checkable by hand. The
 * remaining cases cover the envelope, node/edge field mapping, the two-pass
 * origin marking, propagation of the orchestrator's cost accounting, and the
 * deduplication contract.
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, SCHEMA_URI, makeEdgeId, makeNodeId } from '../../src/types';
import type { AncestryGraph } from '../../src/types';
import { AncestryGraphBuilder, MAX_PREDECESSORS_PER_NODE, rankPredecessors } from '../../src/graph';
import type { VersionCandidate } from '../../src/graph';
import {
  FIXED_NOW,
  makeBlock,
  makeCandidate,
  makeCommit,
  makeInput,
  makeSimilarity,
} from './inputs.test';

/** Distinct in its first 12 characters, because `makeNodeId` truncates there. */
function hashFor(index: number): string {
  return `${index.toString(16).padStart(8, '0')}${'0'.repeat(32)}`;
}

/** One version of the reference block: index 1..4, oldest first. */
function version(index: number, similarity: number, endLine: number): VersionCandidate {
  const hash = hashFor(index);
  return makeCandidate({
    commit: makeCommit({
      hash,
      shortHash: hash.slice(0, 7),
      authorTimestamp: 1_000_000 * index,
    }),
    block: makeBlock({
      range: {
        startOffset: 0,
        endOffset: 240,
        startLine: 10,
        startColumn: 1,
        endLine,
        endColumn: 1,
      },
    }),
    similarity: makeSimilarity(similarity),
  });
}

function referenceGraph(): AncestryGraph {
  const v1 = version(1, 0.88, 20);
  const v2 = version(2, 0.92, 22);
  const v3 = version(3, 0.96, 24);
  const focus = version(4, 1, 25);
  return new AncestryGraphBuilder(
    makeInput({
      focus,
      candidates: [focus, v3, v1, v2],
      fileHistory: [v1, v2, v3, focus].map((candidate) => candidate.commit),
      stats: { filesInspected: 12, blocksCompared: 37, truncated: false },
    }),
  ).build();
}

describe('graph envelope', () => {
  it('carries the frozen schema, engine version and injected clock', () => {
    const graph = referenceGraph();
    expect(graph.schema).toBe(SCHEMA_URI);
    expect(graph.schema).toBe('ancestry://graph/v1');
    expect(graph.engineVersion).toBe(ENGINE_VERSION);
    expect(graph.repositoryRoot).toBe('/repo');
    expect(graph.generatedAt).toBe(FIXED_NOW);
    expect(graph.id).toBe('graph-fixture');
    expect(graph.unparsed).toEqual([]);
  });

  it('derives a stable sha1 graph id when none is supplied', () => {
    const focus = version(4, 1, 25);
    const withId = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus], graphId: undefined }),
    ).build();
    const again = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus], graphId: undefined }),
    ).build();
    const later = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus], graphId: undefined, now: () => FIXED_NOW + 1 }),
    ).build();
    const elsewhere = new AncestryGraphBuilder(
      makeInput({
        focus,
        candidates: [focus],
        graphId: undefined,
        repositoryRoot: '/other',
      }),
    ).build();

    expect(withId.id).toMatch(/^[0-9a-f]{40}$/);
    expect(again.id).toBe(withId.id);
    expect(later.id).not.toBe(withId.id);
    expect(elsewhere.id).not.toBe(withId.id);
  });
});

describe('nodes', () => {
  it('maps every field of a version candidate onto the node', () => {
    const graph = referenceGraph();
    const node = graph.nodes.find((candidate) => candidate.isFocus)!;
    expect(node).toBeDefined();
    expect(node.id).toBe(makeNodeId(node.blockId, node.commit));
    expect(node.blockName).toBe('formatBytes');
    expect(node.blockKind).toBe('function');
    expect(node.qualifiedName).toBe('formatBytes');
    expect(node.signature).toBe('formatBytes(value: number): string');
    expect(node.filePath).toBe('src/utils/format.ts');
    expect(node.module).toBe('src/utils');
    expect(node.lineStart).toBe(10);
    expect(node.lineEnd).toBe(25);
    expect(node.language).toBe('typescript');
    expect(node.hash).toBe(version(4, 1, 25).block.textHash);
    expect(node.author).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(node.shortCommit).toBe(node.commit.slice(0, 7));
    expect(node.branches).toEqual(['main']);
    expect(node.isDeleted).toBe(false);
  });

  it('marks the focus node with similarity 1 and a single focus', () => {
    const graph = referenceGraph();
    const focusNodes = graph.nodes.filter((node) => node.isFocus);
    expect(focusNodes).toHaveLength(1);
    expect(focusNodes[0]?.similarity).toBe(1);
    expect(focusNodes[0]?.classification).toBe('strong');
    expect(focusNodes[0]?.timestamp).toBe(4_000_000);
  });

  it('sorts nodes by timestamp, then path, then id', () => {
    const graph = referenceGraph();
    const keys = graph.nodes.map((node) => `${node.timestamp}|${node.filePath}|${node.id}`);
    expect([...keys].sort()).toEqual(keys);
    expect(graph.nodes.map((node) => node.similarity)).toEqual([0.88, 0.92, 0.96, 1]);
  });

  it('normalises branches to a sorted, de-duplicated list', () => {
    const focus = version(4, 1, 25);
    const older = version(1, 0.9, 20);
    const graph = new AncestryGraphBuilder(
      makeInput({
        focus,
        candidates: [focus, { ...older, branches: ['main', 'feature', 'main', 'bugfix'] }],
      }),
    ).build();
    const node = graph.nodes.find((candidate) => candidate.commit === older.commit.hash)!;
    expect(node.branches).toEqual(['bugfix', 'feature', 'main']);
  });
});

describe('origin marking', () => {
  it('marks exactly one node as the origin, in a second pass', () => {
    const graph = referenceGraph();
    const originNodes = graph.nodes.filter((node) => node.isOrigin);
    expect(originNodes).toHaveLength(1);
    expect(graph.origin).not.toBeNull();
    expect(originNodes[0]?.id).toBe(graph.origin?.nodeId);
    expect(graph.origin?.basis).toBe('earliest-match');
    expect(graph.origin?.timestamp).toBe(1_000_000);
    expect(graph.origin?.disclaimer).toContain('earliest version');
  });
});

describe('edges of the reference graph', () => {
  const graph = referenceGraph();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  it('draws one primary predecessor plus the branch, all of them same-file evolutions', () => {
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges.every((edge) => edge.type === 'EVOLVED_FROM')).toBe(true);
    expect(graph.edges.every((edge) => edge.sameFile)).toBe(true);
  });

  it('assigns the most similar earlier version as the primary predecessor', () => {
    const focus = graph.nodes.find((node) => node.isFocus)!;
    const incoming = graph.edges.filter((edge) => edge.from === focus.id);
    expect(incoming).toHaveLength(MAX_PREDECESSORS_PER_NODE);
    // Emitted order follows the edge sort (by `to`), the primary follows the
    // predecessor ranking: the most similar earlier version wins.
    const parents = incoming.map((edge) => byId.get(edge.to)!);
    expect(rankPredecessors(parents).map((node) => node.similarity)).toEqual([0.96, 0.92, 0.88]);
    expect(incoming.every((edge) => edge.id === makeEdgeId(focus.id, edge.to, edge.type))).toBe(
      true,
    );
  });

  it('records the derived pair similarity, confidence and line delta', () => {
    const focus = graph.nodes.find((node) => node.isFocus)!;
    const edges = graph.edges.filter((edge) => edge.from === focus.id);
    expect(edges.map((edge) => edge.similarity)).toEqual([0.88, 0.92, 0.96]);
    expect(edges.map((edge) => edge.lineDelta)).toEqual([5, 3, 1]);
    for (const edge of edges) {
      expect(edge.confidence).toBeGreaterThan(0.6);
      expect(edge.confidence).toBeLessThanOrEqual(1);
      expect(edge.rationale).toContain('same file');
    }
  });

  it('only ever points backwards in time', () => {
    for (const edge of graph.edges) {
      expect(byId.get(edge.from)!.timestamp).toBeGreaterThanOrEqual(byId.get(edge.to)!.timestamp);
    }
  });

  it('sorts edges by (from, to, type)', () => {
    const keys = graph.edges.map((edge) => `${edge.from}|${edge.to}|${edge.type}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it('never emits a MOVED_FROM edge for a similar pair in another file', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts', name: 'renderBytes' }),
      commit: makeCommit({ hash: 'a'.repeat(40), authorTimestamp: 1_000_000 }),
      similarity: makeSimilarity(0.98),
    });
    const focus = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts', name: 'formatBytes' }),
      commit: makeCommit({ hash: 'b'.repeat(40), authorTimestamp: 2_000_000 }),
      similarity: makeSimilarity(1),
    });
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, parent] }),
    ).build();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.type).toBe('COPIED_FROM');
  });

  it('emits MOVED_FROM when git reported the rename', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts' }),
      commit: makeCommit({ hash: 'a'.repeat(40), authorTimestamp: 1_000_000 }),
      similarity: makeSimilarity(0.95),
    });
    const focus = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts', name: 'renderBytes' }),
      commit: makeCommit({ hash: 'b'.repeat(40), authorTimestamp: 2_000_000 }),
      similarity: makeSimilarity(1),
      renameEvidence: { fromPath: 'src/legacy/format.ts', score: 0.96, commit: 'b'.repeat(40) },
    });
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, parent] }),
    ).build();
    expect(graph.edges[0]?.type).toBe('MOVED_FROM');
    expect(graph.edges[0]?.rationale).toContain('git detected rename');
    expect(graph.edges[0]?.lineDelta).toBeNull();
    expect(graph.edges[0]?.sameFile).toBe(false);
  });

  it('emits MERGED_FROM for every parent of a merge commit', () => {
    const left = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/left.ts', name: 'left' }),
      commit: makeCommit({ hash: 'a'.repeat(40), authorTimestamp: 1_000_000 }),
      similarity: makeSimilarity(0.85),
    });
    const right = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/right.ts', name: 'right' }),
      commit: makeCommit({ hash: 'b'.repeat(40), authorTimestamp: 1_500_000 }),
      similarity: makeSimilarity(0.8),
    });
    const focus = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/merged.ts', name: 'merged' }),
      commit: makeCommit({
        hash: 'c'.repeat(40),
        authorTimestamp: 2_000_000,
        isMerge: true,
        parents: [left.commit.hash, right.commit.hash],
      }),
      similarity: makeSimilarity(1),
    });
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, right, left] }),
    ).build();
    const focusNode = graph.nodes.find((node) => node.isFocus)!;
    const leftNode = graph.nodes.find((node) => node.commit === left.commit.hash)!;
    const rightNode = graph.nodes.find((node) => node.commit === right.commit.hash)!;
    const merges = graph.edges.filter(
      (edge) => edge.from === focusNode.id && edge.type === 'MERGED_FROM',
    );
    expect(merges).toHaveLength(2);
    expect(merges.map((edge) => edge.to).sort()).toEqual([leftNode.id, rightNode.id].sort());
    for (const edge of merges) {
      expect(edge.rationale).toContain('merge commit');
    }
  });

  it('keeps a node below the ignore floor in the graph but draws no edge to it', () => {
    const noise = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/other.ts', name: 'other' }),
      commit: makeCommit({ hash: 'a'.repeat(40), authorTimestamp: 1_000_000 }),
      similarity: makeSimilarity(0.4),
    });
    const focus = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      commit: makeCommit({ hash: 'b'.repeat(40), authorTimestamp: 2_000_000 }),
      similarity: makeSimilarity(1),
    });
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, noise] }),
    ).build();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });
});

describe('stats', () => {
  it('counts the reference graph exactly', () => {
    const graph = referenceGraph();
    expect(graph.stats).toEqual({
      nodeCount: 4,
      edgeCount: 6,
      fileCount: 1,
      authorCount: 1,
      commitCount: 4,
      branchCount: 1,
      earliestTimestamp: 1_000_000,
      latestTimestamp: 4_000_000,
      // Mean over the three non-focus nodes: (0.88 + 0.92 + 0.96) / 3.
      avgSimilarity: 0.92,
      // The focus is excluded from every similarity aggregate, so these are
      // counts of matched versions only.
      strongCount: 2,
      possibleCount: 1,
      truncated: false,
      filesInspected: 12,
      blocksCompared: 37,
    });
  });

  it('excludes the focus node from avgSimilarity and reports 0 without matches', () => {
    const focus = version(4, 1, 25);
    const alone = new AncestryGraphBuilder(makeInput({ focus, candidates: [focus] })).build();
    expect(alone.stats.avgSimilarity).toBe(0);
    expect(alone.stats.strongCount).toBe(0);
    expect(alone.stats.possibleCount).toBe(0);

    const older = version(1, 0.88, 20);
    const withOne = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, older] }),
    ).build();
    // Not (0.88 + 1) / 2, which would be 0.94.
    expect(withOne.stats.avgSimilarity).toBe(0.88);
  });

  it('propagates the cost accounting and the truncation flag', () => {
    const focus = version(4, 1, 25);
    const older = version(1, 0.9, 20);
    const graph = new AncestryGraphBuilder(
      makeInput({
        focus,
        candidates: [focus, older],
        stats: { filesInspected: 3, blocksCompared: 9, truncated: true },
      }),
    ).build();
    expect(graph.stats.truncated).toBe(true);
    expect(graph.stats.filesInspected).toBe(3);
    expect(graph.stats.blocksCompared).toBe(9);
    expect(graph.warnings.some((warning) => warning.includes('truncated'))).toBe(true);
  });

  it('defaults the cost accounting when the orchestrator reports none', () => {
    const focus = version(4, 1, 25);
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus], stats: undefined }),
    ).build();
    expect(graph.stats.filesInspected).toBe(0);
    expect(graph.stats.blocksCompared).toBe(0);
    expect(graph.stats.truncated).toBe(false);
  });
});

describe('warnings and unparsed', () => {
  it('keeps the orchestrator warnings and appends the generated ones', () => {
    const focus = version(4, 1, 25);
    const graph = new AncestryGraphBuilder(
      makeInput({
        focus,
        candidates: [focus],
        warnings: ['detached HEAD', 'shallow clone'],
        unparsed: [
          { filePath: 'src/vendor/b.ts', reason: 'unparseable' },
          { filePath: 'src/assets/logo.png', reason: 'binary' },
          { filePath: 'src/vendor/b.ts', reason: 'unparseable' },
        ],
      }),
    ).build();
    expect(graph.warnings.slice(0, 2)).toEqual(['detached HEAD', 'shallow clone']);
    expect(new Set(graph.warnings).size).toBe(graph.warnings.length);
    expect(graph.unparsed).toEqual([
      { filePath: 'src/assets/logo.png', reason: 'binary' },
      { filePath: 'src/vendor/b.ts', reason: 'unparseable' },
    ]);
  });

  it('warns when the focus file history is missing versions of the focus path', () => {
    const focus = version(4, 1, 25);
    const older = version(1, 0.9, 20);
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, older], fileHistory: [older.commit] }),
    ).build();
    expect(graph.warnings.some((warning) => warning.includes('file history is missing'))).toBe(
      true,
    );
  });

  it('stays silent when the focus file history covers every version', () => {
    const graph = referenceGraph();
    expect(graph.warnings).toEqual([]);
  });
});

describe('candidate deduplication', () => {
  it('keeps the higher-similarity candidate for a colliding node id and warns', () => {
    const weak = version(1, 0.8, 20);
    const strong = { ...version(1, 0.93, 20) };
    const focus = version(4, 1, 25);
    const graph = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, weak, strong] }),
    ).build();
    expect(graph.nodes).toHaveLength(2);
    const kept = graph.nodes.find((node) => node.commit === weak.commit.hash)!;
    expect(kept.similarity).toBe(0.93);
    expect(
      graph.warnings.some((warning) => warning.startsWith('deduplicated 1 candidate(s)')),
    ).toBe(true);
  });

  it('breaks a similarity tie deterministically rather than by arrival order', () => {
    const first = version(1, 0.9, 20);
    const second = { ...version(1, 0.9, 20), isDeleted: true };
    const focus = version(4, 1, 25);
    const a = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, first, second] }),
    ).build();
    const b = new AncestryGraphBuilder(
      makeInput({ focus, candidates: [focus, second, first] }),
    ).build();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
