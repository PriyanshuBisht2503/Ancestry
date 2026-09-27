/**
 * Reusable fixtures for the graph tests.
 *
 * Every timestamp, hash and clock value here is fixed, so nothing in the suite
 * depends on the wall clock and every expectation is reproducible. The
 * factories compose: `makeCandidate` builds a block, a commit and a similarity
 * score, and `makeInput` builds a focus plus its candidate list.
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, SCHEMA_URI, makeBlockId, makeNodeId } from '../../src/types';
import type {
  AncestryEdge,
  AncestryGraph,
  AncestryNode,
  CodeBlock,
  GitCommit,
  GraphStats,
  MatchClassification,
  SimilarityResult,
  SimilarityThresholds,
} from '../../src/types';
import type { GraphBuildInput, VersionCandidate } from '../../src/graph';

/** The specification §3.3 defaults: strong 0.90, possible 0.75, ignore 0.60. */
export const DEFAULT_THRESHOLDS: SimilarityThresholds = Object.freeze({
  strong: 0.9,
  possible: 0.75,
  ignore: 0.6,
});

/** Fixed "now" for every graph built from these fixtures. */
export const FIXED_NOW = 1_700_000_000_000;

/** Fixed base author date: 2020-09-13T12:26:40Z. */
export const BASE_TIMESTAMP = 1_600_000_000_000;

/** The block id used by the default block and by the default similarity result. */
export const FOCUS_BLOCK_ID = makeBlockId('src/utils/format.ts', 'function', 'formatBytes', 10);

function hashFor(index: number): string {
  return index.toString(16).padStart(40, '0');
}

/** A fixed commit; only the fields you pass are changed. */
export function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  const hash = overrides.hash ?? hashFor(1);
  return {
    hash,
    shortHash: overrides.shortHash ?? hash.slice(0, 7),
    parents: [],
    author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
    authorTimestamp: BASE_TIMESTAMP,
    commitTimestamp: BASE_TIMESTAMP,
    subject: 'synthetic commit',
    body: '',
    refs: [],
    isMerge: false,
    ...overrides,
  };
}

/**
 * A fixed code block in `src/utils/format.ts`. The id is derived from
 * file + kind + name + start line, exactly like the parser does, so overriding
 * any of those without an explicit `id` still produces a coherent block.
 */
export function makeBlock(overrides: Partial<CodeBlock> = {}): CodeBlock {
  const filePath = overrides.filePath ?? 'src/utils/format.ts';
  const kind = overrides.kind ?? 'function';
  const name = overrides.name === undefined ? 'formatBytes' : overrides.name;
  const startLine = overrides.range?.startLine ?? 10;
  const endLine = overrides.range?.endLine ?? startLine + 10;
  return {
    id: makeBlockId(filePath, kind, name, startLine),
    kind,
    name,
    qualifiedName: name,
    signature: name === null ? null : `${name}(value: number): string`,
    filePath,
    language: 'typescript',
    range: {
      startOffset: 0,
      endOffset: 240,
      startLine,
      startColumn: 1,
      endLine,
      endColumn: 1,
    },
    parentId: null,
    container: null,
    text: 'export function formatBytes(value: number): string { return String(value); }',
    textHash: `text-${hashFor(1).slice(0, 6)}`,
    tokenCount: 24,
    ...overrides,
  };
}

/** Classification implied by a score under {@link DEFAULT_THRESHOLDS} (§3.3). */
export function classifyScore(
  value: number,
  thresholds: SimilarityThresholds = DEFAULT_THRESHOLDS,
): MatchClassification {
  if (value >= thresholds.strong) {
    return 'strong';
  }
  if (value >= thresholds.possible) {
    return 'possible';
  }
  if (value >= thresholds.ignore) {
    return 'weak';
  }
  return 'unrelated';
}

/** A `SimilarityResult` whose breakdown agrees with the aggregate score. */
export function makeSimilarity(
  value: number,
  overrides: Partial<SimilarityResult> = {},
): SimilarityResult {
  return {
    sourceBlockId: FOCUS_BLOCK_ID,
    candidateBlockId: FOCUS_BLOCK_ID,
    similarity: value,
    breakdown: { jaccard: value, simhash: value, lcs: value, shape: value },
    classification: classifyScore(value),
    componentsUsed: ['jaccard', 'simhash', 'lcs', 'shape'],
    ...overrides,
  };
}

/** A version candidate: a block, a commit, a focus-relative score. */
export function makeCandidate(overrides: Partial<VersionCandidate> = {}): VersionCandidate {
  const block = overrides.block ?? makeBlock();
  const commit = overrides.commit ?? makeCommit();
  return {
    block,
    commit,
    similarity: overrides.similarity ?? makeSimilarity(0.95),
    branches: overrides.branches === undefined ? ['main'] : overrides.branches,
    isDeleted: overrides.isDeleted ?? false,
    renameEvidence: overrides.renameEvidence ?? null,
    previousPath: overrides.previousPath ?? null,
  };
}

/** Build input whose focus is also its first candidate. */
export function makeInput(overrides: Partial<GraphBuildInput> = {}): GraphBuildInput {
  const focus = overrides.focus ?? makeCandidate({ similarity: makeSimilarity(1) });
  return {
    focus,
    candidates: overrides.candidates ?? [focus],
    repositoryRoot: '/repo',
    fileHistory: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    stats: { filesInspected: 4, blocksCompared: 4, truncated: false },
    warnings: [],
    unparsed: [],
    now: () => FIXED_NOW,
    graphId: 'graph-fixture',
    ...overrides,
  };
}

/** A node fixture, defaulting to the focus block at a fixed commit. */
export function makeNode(overrides: Partial<AncestryNode> = {}): AncestryNode {
  const commit = overrides.commit ?? hashFor(4);
  const blockId = overrides.blockId ?? FOCUS_BLOCK_ID;
  return {
    id: overrides.id ?? makeNodeId(blockId, commit),
    blockId,
    blockName: overrides.blockName === undefined ? 'formatBytes' : overrides.blockName,
    blockKind: 'function',
    qualifiedName: 'formatBytes',
    signature: 'formatBytes(value: number): string',
    filePath: 'src/utils/format.ts',
    commit,
    shortCommit: commit.slice(0, 7),
    author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    timestamp: BASE_TIMESTAMP,
    hash: `text-${commit.slice(0, 6)}`,
    lineStart: 10,
    lineEnd: 20,
    language: 'typescript',
    similarity: 1,
    classification: 'strong',
    isFocus: true,
    isOrigin: false,
    branches: ['main'],
    isDeleted: false,
    module: 'src/utils',
    ...overrides,
  };
}

/** An edge fixture built from two nodes. */
export function makeEdge(
  from: AncestryNode,
  to: AncestryNode,
  overrides: Partial<AncestryEdge> = {},
): AncestryEdge {
  return {
    id: overrides.id ?? `${overrides.type ?? 'EVOLVED_FROM'}:${from.id}->${to.id}`,
    from: from.id,
    to: to.id,
    type: overrides.type ?? 'EVOLVED_FROM',
    similarity: overrides.similarity ?? to.similarity,
    confidence: overrides.confidence ?? 0.7,
    sameFile: overrides.sameFile ?? from.filePath === to.filePath,
    lineDelta: overrides.lineDelta === undefined ? 0 : overrides.lineDelta,
    rationale: overrides.rationale ?? 'synthetic edge',
    ...overrides,
  };
}

function statsFor(nodes: readonly AncestryNode[], edges: readonly AncestryEdge[]): GraphStats {
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    fileCount: new Set(nodes.map((node) => node.filePath)).size,
    authorCount: new Set(nodes.map((node) => node.author.email)).size,
    commitCount: new Set(nodes.map((node) => node.commit)).size,
    branchCount: new Set(nodes.flatMap((node) => node.branches)).size,
    earliestTimestamp: nodes.length === 0 ? null : Math.min(...nodes.map((n) => n.timestamp)),
    latestTimestamp: nodes.length === 0 ? null : Math.max(...nodes.map((n) => n.timestamp)),
    avgSimilarity: 0,
    strongCount: 0,
    possibleCount: 0,
    truncated: false,
    filesInspected: 0,
    blocksCompared: 0,
  };
}

/** A minimal but complete graph wrapper for the origin tests. */
export function makeGraph(
  nodes: AncestryNode[],
  edges: AncestryEdge[] = [],
  overrides: Partial<AncestryGraph> = {},
): AncestryGraph {
  return {
    id: 'graph-fixture',
    schema: SCHEMA_URI,
    engineVersion: ENGINE_VERSION,
    focusBlockId: nodes[0]?.blockId ?? FOCUS_BLOCK_ID,
    repositoryRoot: '/repo',
    generatedAt: FIXED_NOW,
    nodes,
    edges,
    origin: null,
    stats: statsFor(nodes, edges),
    warnings: [],
    unparsed: [],
    ...overrides,
  };
}

describe('graph test fixtures', () => {
  it('produces a coherent block, candidate and node chain', () => {
    const candidate = makeCandidate();
    const node = makeNode();
    const input = makeInput();
    expect(candidate.block.id).toBe(FOCUS_BLOCK_ID);
    expect(node.id).toBe(makeNodeId(FOCUS_BLOCK_ID, node.commit));
    expect(input.candidates).toContain(input.focus);
    expect(input.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(makeSimilarity(0.95).classification).toBe('strong');
    expect(makeSimilarity(0.8).classification).toBe('possible');
    expect(makeSimilarity(0.65).classification).toBe('weak');
    expect(makeSimilarity(0.2).classification).toBe('unrelated');
  });
});
