/**
 * Relationship inference — specification §4.
 *
 * One dedicated case per edge type from the §4 table, plus the rules that make
 * the table deterministic: evidence ranking (rename > name > similarity), the
 * confidence ordering, and the rule that a cross-file pair with nothing but
 * similarity is a *copy*, never a *move*.
 */

import { describe, expect, it } from 'vitest';

import { makeEdgeId } from '../../src/types';
import {
  MAX_PREDECESSORS_PER_NODE,
  PREDECESSOR_MARGIN_FLOOR,
  classifyMoveEvidence,
  comparePredecessorRank,
  computeLineDelta,
  couldBeRelated,
  decideRelationship,
  edgeSimilarity,
  isPrimaryPredecessor,
  predecessorMargin,
  rankPredecessors,
  similarityBonus,
} from '../../src/graph';
import type { EdgeDecision, VersionCandidate } from '../../src/graph';
import {
  DEFAULT_THRESHOLDS,
  makeBlock,
  makeCandidate,
  makeCommit,
  makeNode,
  makeSimilarity,
} from './inputs.test';

const T = DEFAULT_THRESHOLDS;

function decide(
  child: VersionCandidate,
  parent: VersionCandidate,
  similarity: number,
  isMergeRelationship = false,
): EdgeDecision {
  return decideRelationship({
    child,
    parent,
    childNodeId: 'child',
    parentNodeId: 'parent',
    similarity,
    thresholds: T,
    isMergeRelationship,
  });
}

describe('specification §4 — MERGED_FROM', () => {
  it('is assigned when the child commit is a merge and the parent is one of its parents', () => {
    const parentHash = 'a'.repeat(40);
    const parent = makeCandidate({ commit: makeCommit({ hash: parentHash }) });
    const child = makeCandidate({
      commit: makeCommit({ hash: 'b'.repeat(40), isMerge: true, parents: [parentHash] }),
    });

    // Parentage beats similarity: the pair is merged even though the score is
    // below the possible threshold.
    const decision = decide(child, parent, 0.5);

    expect(decision.type).toBe('MERGED_FROM');
    expect(decision.emit).toBe(true);
    expect(decision.sameFile).toBe(true);
    expect(decision.rationale).toContain('merge commit');
    expect(decision.rationale).toContain(parentHash.slice(0, 7));
    expect(decision.confidence).toBeGreaterThan(0.85);
  });

  it('is not assigned when the parent is merely an earlier commit of a non-merge', () => {
    const parent = makeCandidate({ commit: makeCommit({ hash: 'a'.repeat(40) }) });
    const child = makeCandidate({
      commit: makeCommit({ hash: 'b'.repeat(40), isMerge: false, parents: ['a'.repeat(40)] }),
    });
    expect(decide(child, parent, 0.95).type).toBe('EVOLVED_FROM');
  });
});

describe('specification §4 — MOVED_FROM', () => {
  it('is assigned when git reported a rename of the containing file', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      commit: makeCommit({ hash: 'a'.repeat(40) }),
      similarity: makeSimilarity(0.93),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/strings.ts', name: 'renderBytes' }),
      commit: makeCommit({ hash: 'c'.repeat(40) }),
      similarity: makeSimilarity(0.93),
      renameEvidence: { fromPath: 'src/utils/format.ts', score: 0.96, commit: 'c'.repeat(40) },
    });

    const decision = decide(child, parent, 0.93);

    expect(decision.type).toBe('MOVED_FROM');
    expect(decision.emit).toBe(true);
    expect(decision.sameFile).toBe(false);
    expect(decision.lineDelta).toBeNull();
    expect(decision.rationale).toContain('git detected rename');
    expect(decision.rationale).toContain('src/utils/format.ts');
    expect(decision.rationale).toContain('src/utils/strings.ts');
    expect(decision.rationale).toContain('score 96%');
    expect(decision.confidence).toBeGreaterThan(0.7);
  });

  it('is assigned when the block name matches and the similarity is strong', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts' }),
      similarity: makeSimilarity(0.93),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      similarity: makeSimilarity(0.93),
    });

    const decision = decide(child, parent, 0.93);

    expect(decision.type).toBe('MOVED_FROM');
    expect(decision.rationale).toContain('name match');
    expect(decision.rationale).toContain('formatBytes');
  });

  it('is assigned when the path history says the block moved', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/old/format.ts' }),
      similarity: makeSimilarity(0.8),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      similarity: makeSimilarity(0.8),
      previousPath: 'src/old/format.ts',
    });

    const decision = decide(child, parent, 0.8);

    expect(decision.type).toBe('MOVED_FROM');
    expect(decision.rationale).toContain('path history');
    expect(decision.rationale).toContain('src/old/format.ts');
  });

  it('is never produced from similarity alone', () => {
    // Identical normalised text in two unrelated files, no rename, no matching
    // name: §4 says this is a copy.
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts', name: 'renderBytes' }),
      similarity: makeSimilarity(0.98),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts', name: 'formatBytes' }),
      similarity: makeSimilarity(0.98),
    });

    const decision = decide(child, parent, 0.98);

    expect(decision.type).toBe('COPIED_FROM');
    expect(decision.emit).toBe(true);
    expect(decision.rationale).toContain('no rename evidence');
    expect(classifyMoveEvidence(child, parent)).toBeNull();
  });

  it('is not produced for an anonymous block that merely moved path', () => {
    const parent = makeCandidate({
      block: makeBlock({
        filePath: 'src/legacy/blob.ts',
        name: null,
        range: {
          startOffset: 0,
          endOffset: 80,
          startLine: 42,
          startColumn: 1,
          endLine: 50,
          endColumn: 1,
        },
      }),
      similarity: makeSimilarity(0.9),
    });
    const child = makeCandidate({
      block: makeBlock({
        filePath: 'src/utils/blob.ts',
        name: null,
        range: {
          startOffset: 0,
          endOffset: 80,
          startLine: 42,
          startColumn: 1,
          endLine: 50,
          endColumn: 1,
        },
      }),
      similarity: makeSimilarity(0.9),
    });
    expect(decide(child, parent, 0.9).type).toBe('COPIED_FROM');
  });

  it('falls back to COPIED_FROM when a name match is only possible, not strong', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts' }),
      similarity: makeSimilarity(0.8),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      similarity: makeSimilarity(0.8),
    });
    expect(decide(child, parent, 0.8).type).toBe('COPIED_FROM');
  });
});

describe('specification §4 — EVOLVED_FROM / MODIFIED_FROM', () => {
  it('is assigned for a same-path pair at or above the possible threshold', () => {
    const parent = makeCandidate({ similarity: makeSimilarity(0.92) });
    const child = makeCandidate({ similarity: makeSimilarity(0.92) });

    const decision = decide(child, parent, 0.92);

    expect(decision.type).toBe('EVOLVED_FROM');
    expect(decision.sameFile).toBe(true);
    expect(decision.lineDelta).toBe(0);
    expect(decision.rationale).toContain('same file src/utils/format.ts');
    expect(decision.rationale).toContain('name "formatBytes" preserved');
  });

  it('is assigned for a same-path pair between ignore and possible, with low confidence', () => {
    const decision = decide(makeCandidate(), makeCandidate(), 0.7);
    expect(decision.type).toBe('MODIFIED_FROM');
    expect(decision.rationale).toContain('only a weak match');
    expect(decision.confidence).toBeLessThan(0.35);
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('reports the signed line-count delta of the same file', () => {
    const parent = makeCandidate({
      block: makeBlock({
        range: {
          startOffset: 0,
          endOffset: 100,
          startLine: 10,
          startColumn: 1,
          endLine: 20,
          endColumn: 1,
        },
      }),
    });
    const child = makeCandidate({
      block: makeBlock({
        range: {
          startOffset: 0,
          endOffset: 160,
          startLine: 10,
          startColumn: 1,
          endLine: 26,
          endColumn: 1,
        },
      }),
    });
    expect(decide(child, parent, 0.9).lineDelta).toBe(6);

    const shrunk = makeCandidate({
      block: makeBlock({
        range: {
          startOffset: 0,
          endOffset: 80,
          startLine: 10,
          startColumn: 1,
          endLine: 16,
          endColumn: 1,
        },
      }),
    });
    expect(decide(shrunk, parent, 0.9).lineDelta).toBe(-4);
  });

  it('emits nothing for a same-path pair below the ignore floor', () => {
    const decision = decide(makeCandidate(), makeCandidate(), 0.5);
    expect(decision.emit).toBe(false);
    expect(decision.confidence).toBe(0);
    expect(decision.rationale).toContain('below the ignore floor');
  });
});

describe('specification §4 — COPIED_FROM', () => {
  it('is assigned for a cross-file pair at or above the possible threshold', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/a.ts', name: 'a' }),
      similarity: makeSimilarity(0.95),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/b.ts', name: 'b' }),
      similarity: makeSimilarity(0.95),
    });
    const decision = decide(child, parent, 0.95);
    expect(decision.type).toBe('COPIED_FROM');
    expect(decision.rationale).toContain('different files');
    expect(decision.rationale).toContain('at or above the strong threshold');
  });

  it('reduces confidence between possible and strong', () => {
    const parent = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/a.ts', name: 'a' }),
    });
    const child = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/b.ts', name: 'b' }),
    });
    const strong = decide(child, parent, 0.95);
    const possible = decide(child, parent, 0.8);
    expect(possible.type).toBe('COPIED_FROM');
    expect(possible.rationale).toContain('below strong');
    expect(strong.confidence).toBeGreaterThan(possible.confidence);
  });

  it('emits nothing for a cross-file pair below the possible threshold', () => {
    const parent = makeCandidate({ block: makeBlock({ filePath: 'src/legacy/a.ts', name: 'a' }) });
    const child = makeCandidate({ block: makeBlock({ filePath: 'src/utils/b.ts', name: 'b' }) });
    const decision = decide(child, parent, 0.5);
    expect(decision.emit).toBe(false);
    expect(decision.rationale).toContain('no rename or name evidence');
  });
});

describe('confidence', () => {
  const parent = makeCandidate({
    block: makeBlock({ filePath: 'src/legacy/format.ts' }),
    commit: makeCommit({ hash: 'a'.repeat(40) }),
    similarity: makeSimilarity(0.95),
  });

  it('orders merge > rename move > same-path evolve > cross-file copy', () => {
    const moved = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      commit: makeCommit({ hash: 'b'.repeat(40) }),
      similarity: makeSimilarity(0.95),
      renameEvidence: { fromPath: 'src/legacy/format.ts', score: 0.9, commit: 'b'.repeat(40) },
    });
    const samePath = makeCandidate({
      block: makeBlock({ filePath: 'src/legacy/format.ts' }),
      similarity: makeSimilarity(0.95),
    });
    const copied = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/other.ts', name: 'other' }),
      similarity: makeSimilarity(0.95),
    });
    const merge = makeCandidate({
      commit: makeCommit({ hash: 'c'.repeat(40), isMerge: true, parents: [parent.commit.hash] }),
      similarity: makeSimilarity(0.95),
    });

    const mergeConfidence = decide(merge, parent, 0.95).confidence;
    const moveConfidence = decide(moved, parent, 0.95).confidence;
    const evolveConfidence = decide(samePath, parent, 0.95).confidence;
    const copyConfidence = decide(copied, parent, 0.95).confidence;

    expect(mergeConfidence).toBeGreaterThan(moveConfidence);
    expect(moveConfidence).toBeGreaterThan(evolveConfidence);
    expect(evolveConfidence).toBeGreaterThan(copyConfidence);
  });

  it('keeps the ordering for every similarity value that can produce an edge', () => {
    for (const similarity of [0.75, 0.8, 0.9, 0.95, 1]) {
      const merge = makeCandidate({
        commit: makeCommit({ hash: 'c'.repeat(40), isMerge: true, parents: [parent.commit.hash] }),
      });
      const moved = makeCandidate({
        block: makeBlock({ filePath: 'src/utils/format.ts' }),
        commit: makeCommit({ hash: 'b'.repeat(40) }),
        renameEvidence: { fromPath: 'src/legacy/format.ts', score: 0.9, commit: 'b'.repeat(40) },
      });
      const samePath = makeCandidate({ block: makeBlock({ filePath: 'src/legacy/format.ts' }) });
      const copied = makeCandidate({
        block: makeBlock({ filePath: 'src/utils/other.ts', name: 'other' }),
      });
      expect(decide(merge, parent, similarity).confidence).toBeGreaterThan(
        decide(moved, parent, similarity).confidence,
      );
      expect(decide(moved, parent, similarity).confidence).toBeGreaterThan(
        decide(samePath, parent, similarity).confidence,
      );
      expect(decide(samePath, parent, similarity).confidence).toBeGreaterThan(
        decide(copied, parent, similarity).confidence,
      );
    }
  });

  it('penalises a name match below a git rename', () => {
    const renamed = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      commit: makeCommit({ hash: 'b'.repeat(40) }),
      renameEvidence: { fromPath: 'src/legacy/format.ts', score: 0.5, commit: 'b'.repeat(40) },
    });
    const nameOnly = makeCandidate({
      block: makeBlock({ filePath: 'src/utils/format.ts' }),
      commit: makeCommit({ hash: 'c'.repeat(40) }),
    });
    const viaRename = decide(renamed, parent, 0.95);
    const viaName = decide(nameOnly, parent, 0.95);
    expect(viaRename.type).toBe('MOVED_FROM');
    expect(viaName.type).toBe('MOVED_FROM');
    expect(viaRename.confidence).toBeGreaterThan(viaName.confidence);
  });

  it('computes the bonus from the ignore floor', () => {
    expect(similarityBonus(T.ignore, T)).toBe(0);
    expect(similarityBonus(1, T)).toBeCloseTo(0.1, 10);
    expect(similarityBonus(0.8, T)).toBeCloseTo(0.05, 10);
    expect(similarityBonus(0.5, T)).toBe(0);
  });
});

describe('rationales', () => {
  it('names the evidence for every emitted decision', () => {
    const samples: Array<[VersionCandidate, VersionCandidate, number, string]> = [
      [
        makeCandidate({
          commit: makeCommit({ hash: 'b'.repeat(40), isMerge: true, parents: ['a'.repeat(40)] }),
        }),
        makeCandidate({ commit: makeCommit({ hash: 'a'.repeat(40) }) }),
        0.95,
        'merge commit',
      ],
      [
        makeCandidate({
          block: makeBlock({ filePath: 'src/utils/format.ts' }),
          commit: makeCommit({ hash: 'c'.repeat(40) }),
          renameEvidence: { fromPath: 'src/legacy/format.ts', score: 0.96, commit: 'c'.repeat(40) },
        }),
        makeCandidate({
          block: makeBlock({ filePath: 'src/legacy/format.ts' }),
          commit: makeCommit({ hash: 'a'.repeat(40) }),
        }),
        0.95,
        'git detected rename',
      ],
      [makeCandidate(), makeCandidate(), 0.95, 'same file'],
      [makeCandidate(), makeCandidate(), 0.7, 'weak match'],
      [
        makeCandidate({ block: makeBlock({ filePath: 'src/utils/x.ts', name: 'x' }) }),
        makeCandidate({ block: makeBlock({ filePath: 'src/utils/y.ts', name: 'y' }) }),
        0.95,
        'no rename evidence',
      ],
    ];
    for (const [child, parent, similarity, evidence] of samples) {
      const decision = decide(child, parent, similarity);
      expect(decision.emit).toBe(true);
      expect(decision.rationale.length).toBeGreaterThan(20);
      expect(decision.rationale).toContain(evidence);
      expect(decision.rationale.endsWith('.')).toBe(true);
    }
  });
});

describe('edgeSimilarity', () => {
  it('is the conservative minimum of the two focus-relative scores', () => {
    const parent = makeCandidate({ similarity: makeSimilarity(0.8) });
    const child = makeCandidate({ similarity: makeSimilarity(1) });
    expect(edgeSimilarity(child, parent)).toBe(0.8);
    expect(edgeSimilarity(parent, child)).toBe(0.8);
  });

  it('is defensive about a missing score', () => {
    const child = makeCandidate();
    const parent = makeCandidate();
    const broken = { ...parent, similarity: undefined } as unknown as VersionCandidate;
    expect(edgeSimilarity(child, broken)).toBe(0);
  });
});

describe('couldBeRelated', () => {
  it('agrees with the authoritative decision', () => {
    const scores = [0.1, 0.6, 0.7, 0.75, 0.9, 1];
    for (const childScore of scores) {
      for (const parentScore of scores) {
        for (const [childBlock, parentBlock] of [
          [makeBlock(), makeBlock()],
          [
            makeBlock({ filePath: 'src/utils/b.ts', name: 'b' }),
            makeBlock({ filePath: 'src/utils/a.ts', name: 'a' }),
          ],
        ]) {
          const child = makeCandidate({
            block: childBlock,
            similarity: makeSimilarity(childScore),
          });
          const parent = makeCandidate({
            block: parentBlock,
            similarity: makeSimilarity(parentScore),
          });
          expect(couldBeRelated(child, parent, T)).toBe(
            decide(child, parent, edgeSimilarity(child, parent)).emit,
          );
        }
      }
    }
  });
});

describe('computeLineDelta', () => {
  it('is null when the paths differ', () => {
    const parent = makeBlock({ filePath: 'src/legacy/a.ts' });
    const child = makeBlock({ filePath: 'src/utils/b.ts' });
    expect(computeLineDelta(child, parent)).toBeNull();
  });

  it('is the signed span delta for the same path', () => {
    const parent = makeBlock({
      range: {
        startOffset: 0,
        endOffset: 100,
        startLine: 10,
        startColumn: 1,
        endLine: 20,
        endColumn: 1,
      },
    });
    const child = makeBlock({
      range: {
        startOffset: 0,
        endOffset: 130,
        startLine: 40,
        startColumn: 1,
        endLine: 53,
        endColumn: 1,
      },
    });
    expect(computeLineDelta(child, parent)).toBe(3);
  });
});

describe('rankPredecessors', () => {
  const sameSimNewer = makeNode({
    id: 'b',
    similarity: 0.95,
    timestamp: 3000,
    commit: 'c'.repeat(40),
  });
  const sameSimOlder = makeNode({
    id: 'c',
    similarity: 0.95,
    timestamp: 1000,
    commit: 'a'.repeat(40),
  });
  const weakerNewer = makeNode({
    id: 'a',
    similarity: 0.8,
    timestamp: 2000,
    commit: 'd'.repeat(40),
  });
  const weakestOldest = makeNode({
    id: 'd',
    similarity: 0.7,
    timestamp: 500,
    commit: 'e'.repeat(40),
  });

  it('orders by similarity desc, then timestamp asc, then id asc', () => {
    const ranked = rankPredecessors([weakestOldest, weakerNewer, sameSimNewer, sameSimOlder]).map(
      (node) => node.id,
    );
    expect(ranked).toEqual(['c', 'b', 'a', 'd']);
  });

  it('does not mutate its input', () => {
    const input = [weakestOldest, sameSimNewer];
    rankPredecessors(input);
    expect(input.map((node) => node.id)).toEqual(['d', 'b']);
  });

  it('is a total order even for identical similarity and timestamp', () => {
    const a = makeNode({ id: 'zzz', similarity: 0.9, timestamp: 1, commit: 'a'.repeat(40) });
    const b = makeNode({ id: 'aaa', similarity: 0.9, timestamp: 1, commit: 'a'.repeat(40) });
    expect(rankPredecessors([a, b]).map((node) => node.id)).toEqual(['aaa', 'zzz']);
    expect(comparePredecessorRank(a, a)).toBe(0);
  });
});

describe('isPrimaryPredecessor', () => {
  it('derives the margin from the thresholds', () => {
    expect(predecessorMargin(T)).toBeCloseTo(0.15, 10);
    expect(predecessorMargin({ strong: 0.92, possible: 0.8, ignore: 0.6 })).toBeCloseTo(0.12, 10);
    expect(predecessorMargin({ strong: 0.8, possible: 0.79, ignore: 0.6 })).toBe(
      PREDECESSOR_MARGIN_FLOOR,
    );
  });

  it('keeps a branch visible within the margin and drops the tail outside it', () => {
    const best = makeNode({ id: 'best', similarity: 0.95 });
    const branch = makeNode({ id: 'branch', similarity: 0.85 });
    const tail = makeNode({ id: 'tail', similarity: 0.6 });
    expect(isPrimaryPredecessor(best, branch, T)).toBe(true);
    expect(isPrimaryPredecessor(best, tail, T)).toBe(false);
    expect(isPrimaryPredecessor(best, best, T)).toBe(false);
  });

  it('drops a predecessor that cannot clear possible on its own', () => {
    const best = makeNode({ id: 'best', similarity: 0.95 });
    const weak = makeNode({ id: 'weak', similarity: 0.7 });
    expect(isPrimaryPredecessor(best, weak, T)).toBe(false);
  });
});

describe('edge ids', () => {
  it('match makeEdgeId so duplicates are detectable', () => {
    const from = 'src/a.ts::function::f::1@aaaaaaaaaaaa';
    const to = 'src/a.ts::function::f::1@bbbbbbbbbbbb';
    expect(makeEdgeId(from, to, 'EVOLVED_FROM')).toBe(`EVOLVED_FROM:${from}->${to}`);
  });
});

describe('MAX_PREDECESSORS_PER_NODE', () => {
  it('is the documented fan-out cap', () => {
    expect(MAX_PREDECESSORS_PER_NODE).toBe(3);
  });
});
