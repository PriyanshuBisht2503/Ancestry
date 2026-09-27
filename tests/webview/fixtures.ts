/**
 * A deterministic graph factory for the webview tests.
 *
 * Every fixture is built from an explicit partial, so a test can state only the
 * one field it cares about and rely on the defaults being *valid* — a fixture
 * that accidentally violates the domain model would make a sanitiser test pass
 * for the wrong reason.
 */

import type {
  AncestryEdge,
  AncestryEdgeType,
  AncestryGraph,
  AncestryNode,
  GraphStats,
} from '../../src/types';
import { SCHEMA_URI } from '../../src/types';

/** A fixed base timestamp so nothing in the tests depends on the wall clock. */
export const T0 = Date.UTC(2023, 0, 1);
export const DAY = 24 * 60 * 60 * 1000;

/** Fields a test may override when building a node. */
export type NodeOverrides = Partial<AncestryNode>;

/** Builds a valid node with sensible defaults. */
export function makeNode(id: string, overrides: NodeOverrides = {}): AncestryNode {
  return {
    id,
    blockId: `block::${id}`,
    blockName: id,
    blockKind: 'function',
    qualifiedName: `mod.${id}`,
    signature: `function ${id}(): void`,
    filePath: 'src/app/service.ts',
    commit: 'a'.repeat(40),
    shortCommit: 'aaaaaaaaaaa',
    author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    timestamp: T0,
    hash: 'h'.repeat(40),
    lineStart: 1,
    lineEnd: 10,
    language: 'typescript',
    similarity: 1,
    classification: 'strong',
    isFocus: false,
    isOrigin: false,
    branches: ['main'],
    isDeleted: false,
    module: 'src/app',
    ...overrides,
  };
}

/** Builds a valid edge with sensible defaults. */
export function makeEdge(
  from: string,
  to: string,
  type: AncestryEdgeType = 'EVOLVED_FROM',
  overrides: Partial<AncestryEdge> = {},
): AncestryEdge {
  return {
    id: `${type}:${from}->${to}`,
    from,
    to,
    type,
    similarity: 0.9,
    confidence: 0.8,
    sameFile: true,
    lineDelta: 2,
    rationale: 'test fixture',
    ...overrides,
  };
}

/** Zeroed stats, so a test only has to state the counts it asserts on. */
export function makeStats(overrides: Partial<GraphStats> = {}): GraphStats {
  return {
    nodeCount: 0,
    edgeCount: 0,
    fileCount: 0,
    authorCount: 0,
    commitCount: 0,
    branchCount: 0,
    earliestTimestamp: null,
    latestTimestamp: null,
    avgSimilarity: 0,
    strongCount: 0,
    possibleCount: 0,
    truncated: false,
    filesInspected: 0,
    blocksCompared: 0,
    ...overrides,
  };
}

/** Builds a valid graph with the given nodes and edges. */
export function makeGraph(
  nodes: AncestryNode[] = [],
  edges: AncestryEdge[] = [],
  overrides: Partial<AncestryGraph> = {},
): AncestryGraph {
  return {
    id: 'graph-1',
    schema: SCHEMA_URI,
    engineVersion: '0.1.0',
    focusBlockId: nodes[0]?.blockId ?? '',
    repositoryRoot: 'c:/repo',
    generatedAt: T0,
    nodes,
    edges,
    origin: null,
    stats: makeStats({ nodeCount: nodes.length, edgeCount: edges.length }),
    warnings: [],
    unparsed: [],
    ...overrides,
  };
}

/** A three-node linear lineage: `n3` descends from `n2` descends from `n1`. */
export function makeChainGraph(): AncestryGraph {
  const n1 = makeNode('n1', {
    timestamp: T0,
    similarity: 0.62,
    classification: 'possible',
    isOrigin: true,
    filePath: 'src/legacy/helper.ts',
    branches: ['main'],
  });
  const n2 = makeNode('n2', {
    timestamp: T0 + 30 * DAY,
    similarity: 0.81,
    classification: 'possible',
    filePath: 'src/app/helper.ts',
    branches: ['main'],
  });
  const n3 = makeNode('n3', {
    timestamp: T0 + 90 * DAY,
    similarity: 0.95,
    classification: 'strong',
    isFocus: true,
    filePath: 'src/app/service.ts',
    branches: ['main'],
  });
  return makeGraph(
    [n3, n2, n1],
    [makeEdge('n3', 'n2', 'EVOLVED_FROM'), makeEdge('n2', 'n1', 'MODIFIED_FROM')],
    { focusBlockId: 'block::n3' },
  );
}
