/**
 * Determinism — specification §6: "Layout is deterministic for a given graph —
 * no `Math.random`, no iteration-order dependence — so the same analysis always
 * produces the same picture."
 *
 * The interesting case is order-independence: the orchestrator discovers
 * candidates in whatever order the search happens to produce, and the graph
 * must be byte-identical regardless. Every permutation here is produced by a
 * fixed-seed generator, never `Math.random`.
 */

import { describe, expect, it } from 'vitest';

import { AncestryGraphBuilder } from '../../src/graph';
import type { GraphBuildInput, VersionCandidate } from '../../src/graph';
import { makeBlock, makeCandidate, makeCommit, makeInput, makeSimilarity } from './inputs.test';

/** Distinct in its first 12 characters, because `makeNodeId` truncates there. */
function hashFor(index: number): string {
  return `${index.toString(16).padStart(8, '0')}${'0'.repeat(32)}`;
}

/** Deterministic Fisher–Yates with a linear congruential generator. */
function shuffle<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = Math.floor((state / 0x100000000) * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

interface VersionSpec {
  index: number;
  timestamp: number;
  similarity: number;
  filePath: string;
  name: string;
  author: string;
  branches: string[];
  isDeleted?: boolean;
  renameFrom?: string;
  isMerge?: boolean;
  parents?: string[];
}

const SPECS: VersionSpec[] = [
  {
    index: 1,
    timestamp: 1_000_000,
    similarity: 0.88,
    filePath: 'src/utils/format.ts',
    name: 'formatBytes',
    author: 'Ada Lovelace',
    branches: ['main'],
  },
  {
    index: 2,
    timestamp: 2_000_000,
    similarity: 0.92,
    filePath: 'src/utils/format.ts',
    name: 'formatBytes',
    author: 'Ada Lovelace',
    branches: ['main', 'release/1.x'],
  },
  {
    index: 3,
    timestamp: 3_000_000,
    similarity: 0.94,
    filePath: 'src/legacy/format.ts',
    name: 'formatBytes',
    author: 'Grace Hopper',
    branches: ['legacy'],
    isDeleted: true,
  },
  {
    index: 4,
    timestamp: 4_000_000,
    similarity: 0.9,
    filePath: 'src/utils/strings.ts',
    name: 'renderBytes',
    author: 'Grace Hopper',
    branches: ['main'],
    renameFrom: 'src/legacy/format.ts',
  },
  {
    index: 5,
    timestamp: 5_000_000,
    similarity: 0.8,
    filePath: 'src/utils/other.ts',
    name: 'other',
    author: 'Alan Turing',
    branches: [],
  },
  {
    index: 6,
    timestamp: 6_000_000,
    similarity: 0.86,
    filePath: 'src/utils/merged.ts',
    name: 'merged',
    author: 'Ada Lovelace',
    branches: ['main', 'feature/merge'],
    isMerge: true,
    parents: [hashFor(2), hashFor(5)],
  },
  {
    index: 7,
    timestamp: 7_000_000,
    similarity: 0.65,
    filePath: 'src/utils/weak.ts',
    name: 'weak',
    author: 'Grace Hopper',
    branches: ['main'],
  },
  {
    index: 9,
    timestamp: 9_000_000,
    similarity: 1,
    filePath: 'src/utils/format.ts',
    name: 'formatBytes',
    author: 'Ada Lovelace',
    branches: ['main'],
  },
];

function version(spec: VersionSpec): VersionCandidate {
  const hash = hashFor(spec.index);
  return makeCandidate({
    block: makeBlock({ filePath: spec.filePath, name: spec.name }),
    commit: makeCommit({
      hash,
      shortHash: hash.slice(0, 7),
      authorTimestamp: spec.timestamp,
      author: {
        name: spec.author,
        email: `${spec.author.split(' ')[0]!.toLowerCase()}@example.com`,
      },
      isMerge: spec.isMerge === true,
      parents: spec.parents ?? [],
    }),
    similarity: makeSimilarity(spec.similarity),
    branches: spec.branches,
    isDeleted: spec.isDeleted === true,
    renameEvidence: spec.renameFrom
      ? { fromPath: spec.renameFrom, score: 0.96, commit: hash }
      : null,
  });
}

function richInput(overrides: Partial<GraphBuildInput> = {}): GraphBuildInput {
  const candidates = SPECS.map(version);
  const focus = candidates[candidates.length - 1]!;
  return makeInput({
    focus,
    candidates,
    fileHistory: candidates
      .filter((candidate) => candidate.block.filePath === focus.block.filePath)
      .map((candidate) => candidate.commit),
    warnings: ['detached HEAD'],
    unparsed: [
      { filePath: 'src/vendor/copy.ts', reason: 'unparseable' },
      { filePath: 'assets/logo.png', reason: 'binary' },
    ],
    graphId: undefined,
    ...overrides,
  });
}

describe('byte-identical output', () => {
  it('produces an identical graph on 25 consecutive builds', () => {
    const input = richInput();
    const first = JSON.stringify(new AncestryGraphBuilder(input).build());
    for (let i = 0; i < 24; i++) {
      expect(JSON.stringify(new AncestryGraphBuilder(input).build())).toBe(first);
    }
  });

  it('produces an identical graph for any candidate order', () => {
    const input = richInput();
    const expected = JSON.stringify(new AncestryGraphBuilder(input).build());
    for (let seed = 1; seed <= 12; seed++) {
      const shuffled = { ...input, candidates: shuffle(input.candidates, seed * 7919) };
      expect(JSON.stringify(new AncestryGraphBuilder(shuffled).build())).toBe(expected);
    }
    expect(
      JSON.stringify(
        new AncestryGraphBuilder({ ...input, candidates: [...input.candidates].reverse() }).build(),
      ),
    ).toBe(expected);
  });

  it('produces an identical graph however the branches are ordered', () => {
    const input = richInput();
    const expected = JSON.stringify(new AncestryGraphBuilder(input).build());
    const reversed = {
      ...input,
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        branches: [...candidate.branches].reverse(),
      })),
    };
    expect(JSON.stringify(new AncestryGraphBuilder(reversed).build())).toBe(expected);
  });

  it('never reads the ambient clock', () => {
    const input = richInput();
    const expected = JSON.stringify(new AncestryGraphBuilder(input).build());
    const original = Date.now;
    Date.now = (): number => {
      throw new Error('the builder must not call Date.now()');
    };
    try {
      expect(JSON.stringify(new AncestryGraphBuilder(input).build())).toBe(expected);
    } finally {
      Date.now = original;
    }
  });

  it('exercises a non-trivial graph', () => {
    const graph = new AncestryGraphBuilder(richInput()).build();
    expect(graph.nodes.length).toBe(SPECS.length);
    expect(graph.edges.length).toBeGreaterThan(5);
    expect(new Set(graph.edges.map((edge) => edge.type))).toContain('MOVED_FROM');
    expect(new Set(graph.edges.map((edge) => edge.type))).toContain('MERGED_FROM');
    expect(new Set(graph.edges.map((edge) => edge.type))).toContain('COPIED_FROM');
    expect(graph.origin).not.toBeNull();
  });
});
