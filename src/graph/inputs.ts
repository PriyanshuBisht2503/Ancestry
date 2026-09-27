/**
 * Inputs of the graph builder — the contract with the analysis orchestrator.
 *
 * Everything the graph module needs is expressed here as plain data, so the
 * builder is a pure function of its input: no git, no filesystem, no parser and
 * no clock (the clock is injected). That is what makes the builder
 * deterministic and unit-testable — see docs/specification.md §6 ("Layout is
 * deterministic for a given graph — no `Math.random`, no iteration-order
 * dependence").
 *
 * The orchestrator is responsible for the expensive half of the pipeline
 * (history walking, block extraction, pairwise similarity against the *focus*
 * block). The graph module is responsible for the semantic half: which version
 * succeeded which, why, and where the ancestry started.
 */

import type {
  AncestryEdgeType,
  CodeBlock,
  GitCommit,
  GraphStats,
  SimilarityResult,
  SimilarityThresholds,
} from '../types';

/**
 * Evidence that git itself reported a rename of the containing file.
 *
 * Produced by `src/git` from `GitFileChange.status === 'R'` (or `'C'`) and is
 * the strongest non-merge evidence available to the graph (specification §4:
 * "an explicit git rename beats a name match, which beats similarity alone").
 */
export interface RenameEvidence {
  /** Path the file was renamed FROM, at the commit where the rename happened. */
  fromPath: string;
  /** Git's own rename score, 0..1. */
  score: number;
  /** Commit at which the rename was introduced. */
  commit: string;
}

/**
 * One *code version* in the graph: a block, in a file, at a commit
 * (specification §2.3 — the triple (block, file, commit)).
 *
 * The `similarity` field is always the score **against the focus block**, not
 * against the other candidates. Ancestry never computes candidate-to-candidate
 * similarity (that is `O(n²)` and the orchestrator deliberately does not do
 * it), so the builder derives an edge similarity from these focus-relative
 * scores — see `edgeSimilarity` in `./edge-inference`.
 */
export interface VersionCandidate {
  /** The block as it existed at `commit`. */
  block: CodeBlock;
  /** Commit the block was read at. */
  commit: GitCommit;
  /** Similarity of this candidate against the FOCUS block, already computed. */
  similarity: SimilarityResult;
  /** Short branch names containing `commit`. */
  branches: string[];
  /** True when the block no longer exists in the working tree. */
  isDeleted: boolean;
  /** Rename evidence for the file containing this block, if any. */
  renameEvidence?: RenameEvidence | null;
  /** Path the block occupied at the commit BEFORE this one, when it moved. */
  previousPath?: string | null;
}

/**
 * Everything the builder needs to produce an `AncestryGraph`.
 *
 * The builder never throws on a malformed `GraphBuildInput`: degenerate
 * combinations (empty candidate list, focus missing from the candidates,
 * duplicate ids, missing branches) are absorbed, reported through
 * `AncestryGraph.warnings`, and still produce a renderable graph
 * (specification §10: "one unanalysable file or commit must never abort an
 * analysis").
 */
export interface GraphBuildInput {
  /** The block the user selected. `input.focus` must also appear in `candidates`. */
  focus: VersionCandidate;
  candidates: VersionCandidate[];
  repositoryRoot: string;
  /**
   * Commits that touched the focus file, oldest → newest.
   *
   * Used for *coverage accounting* only: a node whose path is the focus path
   * but whose commit is absent from this list is a version of the focus file
   * the analysis never saw, which is reported as a warning. Rename evidence
   * itself can only come from git (see `RenameEvidence`) and from
   * `VersionCandidate.previousPath`, because a `GitCommit` carries no path.
   */
  fileHistory?: GitCommit[];
  thresholds: SimilarityThresholds;
  /** Files inspected and blocks compared, for honest cost accounting. */
  stats?: Partial<Pick<GraphStats, 'filesInspected' | 'blocksCompared' | 'truncated'>>;
  warnings?: string[];
  unparsed?: Array<{ filePath: string; reason: string }>;
  /** Injectable clock so the builder stays deterministic in tests. */
  now?: () => number;
  /** Injectable id generator for the graph id. */
  graphId?: string;
}

/** The relationship kinds the builder can infer (specification §4). */
export type RelationshipDecision = AncestryEdgeType;

/**
 * One ordered pair of candidates submitted for a relationship decision.
 *
 * `similarity` is the *derived* edge similarity for the pair
 * (`edgeSimilarity(child, parent)`), not the candidate's similarity to focus.
 */
export interface EdgeDecisionInput {
  child: VersionCandidate;
  parent: VersionCandidate;
  childNodeId: string;
  parentNodeId: string;
  similarity: number;
  thresholds: SimilarityThresholds;
  /** True when the child's commit is a merge and the parent is one of its parents. */
  isMergeRelationship: boolean;
}

/**
 * The verdict for one ordered pair.
 *
 * `emit` is false when the pair carries no relationship at all (e.g. two
 * unrelated files below the `possible` threshold). The `type` field is always
 * populated because it is part of the shared contract, but callers **must**
 * check `emit` before drawing an edge; the nominal type in that case is
 * `COPIED_FROM` and is never drawn.
 */
export interface EdgeDecision {
  type: AncestryEdgeType;
  confidence: number;
  rationale: string;
  sameFile: boolean;
  lineDelta: number | null;
  /** False ⇒ no edge is drawn for this pair. */
  emit: boolean;
}
