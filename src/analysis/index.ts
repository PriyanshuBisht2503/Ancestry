/**
 * Public surface of the analysis orchestrator.
 *
 * Everything outside `src/analysis` imports from here, so the internal file layout
 * (safety rails, branch attribution, history traversal, extraction, matching,
 * pipeline) can change without rippling through the extension — and there is
 * exactly one place to look for "how do I turn a selection into a graph?".
 *
 * The contract this module honours:
 *
 *  - **Selection in, one graph out.** `analyze` never returns several graphs for
 *    one selection (specification §2.2); `analyzeFile` is the explicitly
 *    per-block variant.
 *  - **One bad file never aborts a run.** Every failure that is about a file
 *    inside the repository becomes an `unparsed` entry or a warning
 *    (specification §10).
 *  - **Determinism.** No `Math.random`; the clock is injected; every emitted
 *    collection is totally ordered (specification §6.1).
 *  - **Local only.** No network call is made anywhere in this module, and no
 *    source text is written to a log (specification §8).
 *
 * @module analysis
 */

export { AnalysisEngine, ANALYSIS_PHASES, isGitAvailable } from './orchestrator';
export type { AnalysisRequest, AnalysisEngineOptions } from './orchestrator';

export {
  AbortBudget,
  clampHistoryLimit,
  enforceRepositorySizeLimit,
  repositoryWarnings,
  skipReasonForPath,
} from './safety';

export { BranchIndex, DEFAULT_MAX_PROBED_BRANCHES, isAncestryProbe } from './branchIndex';
export type { BranchIndexOptions, BranchTip } from './branchIndex';

export { HistoryWalker, changedPathsSince } from './historyWalker';
export type { HistoryWalkOptions, PathHistory, PathRename } from './historyWalker';

export { BlockExtractor } from './blockExtractor';
export type { ExtractorOptions, ExtractionOutcome } from './blockExtractor';

export {
  SimilarityStage,
  focusSimilarityResult,
  versionKey,
  LINEAR_PREFILTER_LIMIT,
} from './similarityStage';
export type {
  SimilarityStageOptions,
  SimilarityStageResult,
  StageCandidate,
} from './similarityStage';
