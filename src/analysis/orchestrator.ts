/**
 * The analysis orchestrator — the one integrating layer.
 *
 * Every other module in Ancestry is a pure capability: git answers questions
 * about a repository, the parser turns text into blocks, normalisation erases
 * cosmetic differences, similarity scores pairs, and the graph builder infers
 * relationships. This module is the only place that knows the *order* those must
 * run in, keeps the bookkeeping between them, and applies the safety rails.
 *
 * ## The pipeline
 *
 * | Phase | What happens | Why it is here |
 * |---|---|---|
 * | `resolve-repository` | open the repository, enforce the size limit, record soft warnings | the only phase whose failure aborts |
 * | `parse-selection` | read the working tree, resolve the selection to one block | §2.2; may synthesise a pseudo-block |
 * | `read-history` | walk the focus file's commits and its rename chain | §7 step 1 |
 * | `extract-blocks` | parse every `(commit, path)` the history touched | §7 step 2 — the widening that finds moved code |
 * | `match-history` | normalise, shortlist, score against the focus block | §3 |
 * | `cross-file-search` | sweep other files at HEAD and other branch tips | §7 step 3 |
 * | `build-graph` | hand the scored candidates to the pure builder | §6 |
 * | `detect-origin` | verify the disclaimer reached the payload | §5 |
 * | `done` | package the result, record the repository's HEAD | — |
 *
 * ## Invariants
 *
 *  - **Only establishing the repository aborts.** Every other failure is
 *    contained: into `unparsed` with a reason, or into `warnings`. A binary file,
 *    an unparseable revision, a failing `git show`, a corrupt cache record, a
 *    branch lookup that will not answer — none of them end a run
 *    (specification §10).
 *  - **Progress is monotonic and clamped.** The webview animates a bar from
 *    `AnalysisProgress.ratio`, so the reporter below maps each phase onto a
 *    fixed window of the global range and never emits a value lower than the last.
 *  - **Determinism.** No `Math.random`; the clock is injected through
 *    `AnalysisEngineOptions.now`; every emitted collection is sorted with a total
 *    order; git calls are issued in a fixed order.
 *  - **No source text is ever logged.** Only paths, counts, sizes and error codes
 *    reach the logger (specification §8.2).
 *
 * @module analysis/orchestrator
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_CONFIG, normalizeThresholds } from '../config';
import type { AncestryConfig } from '../config';
import { GitRepository, isAbortError, runGit } from '../git';
import { AncestryGraphBuilder, ORIGIN_DISCLAIMER } from '../graph';
import type { RenameEvidence, VersionCandidate } from '../graph';
import type { Logger } from '../logger';
import { normalizeBlock } from '../normalization';
import {
  blocksWithinFile,
  findBestBlockForRange,
  languageFor,
  parseSourceFromBuffer,
} from '../parser';
import { AncestryError, makeBlockId, moduleForPath } from '../types';
import type {
  AnalysisProgress,
  AnalysisResult,
  AncestryGraph,
  CodeBlock,
  GitCommit,
  ICacheStore,
  NormalizedBlock,
  RepoInfo,
  SourceRange,
} from '../types';
import { BranchIndex } from './branchIndex';
import { BlockExtractor } from './blockExtractor';
import { HistoryWalker } from './historyWalker';
import type { PathHistory } from './historyWalker';
import { SimilarityStage, focusSimilarityResult, versionKey } from './similarityStage';
import type { SimilarityStageResult, StageCandidate } from './similarityStage';
import {
  AbortBudget,
  enforceRepositorySizeLimit,
  repositoryWarnings,
  skipReasonForPath,
} from './safety';

/** One analysis request: a file, an optional selection, and optional plumbing. */
export interface AnalysisRequest {
  /** Absolute path to the file containing the selection. */
  filePath: string;
  /** 1-based inclusive selection start. Defaults to the whole file. */
  startLine?: number;
  /** 1-based inclusive selection end. Defaults to the whole file. */
  endLine?: number;
  /** Cancellation signal, forwarded to every git call. */
  signal?: AbortSignal;
  /** Progress sink. Ratios are monotonic and clamped to `[0, 1]`. */
  onProgress?: (progress: AnalysisProgress) => void;
}

/** Construction options for {@link AnalysisEngine}. */
export interface AnalysisEngineOptions {
  /** Settings, as read by `src/config`. Defaults to `DEFAULT_CONFIG`. */
  config: AncestryConfig;
  /** Optional logger. A no-op logger is used when omitted. */
  logger?: Logger;
  /** Local index, or `null`/omitted to run without a cache. */
  cache?: ICacheStore | null;
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Repository opener, injectable so a test can substitute a repository without
   * a working tree. Defaults to {@link GitRepository.detect}.
   */
  createRepository?: (startPath: string) => Promise<GitRepository>;
}

/** The pipeline's phases, in the order they run. */
export const ANALYSIS_PHASES: readonly AnalysisProgress['phase'][] = Object.freeze([
  'resolve-repository',
  'parse-selection',
  'read-history',
  'extract-blocks',
  'match-history',
  'cross-file-search',
  'build-graph',
  'detect-origin',
  'done',
]);

/**
 * Each phase's slice of the global progress range.
 *
 * The weights are a judgement call about where the time goes, chosen so the bar
 * moves smoothly instead of sitting still: history and extraction dominate, graph
 * assembly is nearly free, and the last two phases are bookkeeping.
 */
const PHASE_WINDOWS: ReadonlyMap<AnalysisProgress['phase'], readonly [number, number]> = new Map<
  AnalysisProgress['phase'],
  readonly [number, number]
>([
  ['resolve-repository', [0, 0.05]],
  ['parse-selection', [0.05, 0.12]],
  ['read-history', [0.12, 0.22]],
  ['extract-blocks', [0.22, 0.55]],
  ['match-history', [0.55, 0.78]],
  ['cross-file-search', [0.78, 0.92]],
  ['build-graph', [0.92, 0.97]],
  ['detect-origin', [0.97, 0.99]],
  ['done', [0.99, 1]],
]);

/**
 * Accepted-candidate count at or below which the cross-file sweep (§7 step 3)
 * always runs.
 *
 * On its own this number was the wrong test, and the way it was wrong is worth
 * recording. The rationale is a cost one — "a history that already found several
 * plausible ancestors is a better answer than a repository-wide guess" — but the
 * count it was applied to included every earlier version of the block *in its own
 * file*. A function that evolved across five commits therefore suppressed the
 * sweep every time, which is precisely backwards: the more interesting a
 * selection's own history is, the likelier a copy of it is sitting in some other
 * file, and that is the only question the sweep exists to answer.
 *
 * {@link shouldSkipSweep} now applies the count only to candidates that actually
 * reached outside the focus module. See its comment for the module comparison.
 */
const CROSS_FILE_TRIGGER = 4;

/** Revisions the cross-file sweep reads, at most. Bounds §7 step 3. */
const MAX_SWEEP_REVISIONS = 8;

/** Wall-clock ceiling for the cross-file sweep, in milliseconds. */
const SWEEP_BUDGET_MS = 20_000;

/** File versions read concurrently during extraction. Bounded to keep the host responsive. */
const EXTRACTION_CONCURRENCY = 4;

/** A path Ancestry refused, with the reason it must be shown. */
type UnparsedEntry = { filePath: string; reason: string };

const NOOP_LOGGER: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  exception: () => undefined,
  child: () => NOOP_LOGGER,
  dispose: () => undefined,
};

/**
 * Reports monotonic, clamped progress.
 *
 * Two properties are guaranteed and both are load-bearing for the webview: the
 * ratio never decreases (a bar that jumps backwards reads as a bug), and it never
 * leaves `[0, 1]`. A report for a phase the pipeline has already passed — a
 * git-layer note arriving late, say — is folded into the current ratio rather than
 * rewinding it.
 */
class ProgressReporter {
  private readonly sink: ((progress: AnalysisProgress) => void) | undefined;
  private highest = 0;

  constructor(sink?: (progress: AnalysisProgress) => void) {
    this.sink = sink;
  }

  /** The last ratio emitted. */
  get ratio(): number {
    return this.highest;
  }

  report(
    phase: AnalysisProgress['phase'],
    withinPhase: number,
    message: string,
    total?: number,
    completed?: number,
  ): void {
    const window = PHASE_WINDOWS.get(phase) ?? ([0, 1] as const);
    const local = clamp01(withinPhase);
    const projected = window[0] + (window[1] - window[0]) * local;
    this.highest = Math.max(this.highest, clamp01(projected));
    const progress: AnalysisProgress = { phase, ratio: this.highest, message };
    if (total !== undefined) {
      progress.total = total;
    }
    if (completed !== undefined) {
      progress.completed = completed;
    }
    try {
      this.sink?.(progress);
    } catch {
      // A progress sink belongs to the UI; its failure must not fail an analysis.
    }
  }
}

/** The result of phase 1. */
interface RepositoryContext {
  repo: GitRepository;
  info: RepoInfo;
  relativePath: string;
  absolutePath: string;
}

/** What the cross-file sweep produced. */
interface SweepOutcome {
  accepted: VersionCandidate[];
  blocksCompared: number;
  truncated: boolean;
  warnings: string[];
  unparsed: UnparsedEntry[];
  cacheHits: number;
  cacheMisses: number;
  revisions: number;
  filesRead: number;
  skipped: boolean;
}

/** What the extraction phase produced. */
interface ExtractionOutcomeSummary {
  perCommit: Map<string, Map<string, CodeBlock[]>>;
  unparsed: UnparsedEntry[];
  filesInspected: number;
  blocksTruncated: boolean;
}

/**
 * The analysis engine.
 *
 * One instance is shared by every command for the lifetime of the extension host.
 * It holds no per-run state except the last result, so a re-invocation can redraw
 * without paying for a second scan.
 */
export class AnalysisEngine {
  private readonly config: AncestryConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly createRepository: (startPath: string) => Promise<GitRepository>;
  private cache: ICacheStore | null;
  private result: AnalysisResult | null = null;

  /**
   * @param options - Config, logger, cache, clock and repository opener.
   */
  constructor(options: AnalysisEngineOptions) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.createRepository =
      options.createRepository ?? ((startPath: string) => GitRepository.detect(startPath));
    this.cache = options.cache ?? null;
  }

  /**
   * Analyse the selected block in `request.filePath`.
   *
   * @param request - File, selection, cancellation and progress sink.
   * @returns The graph, the cost accounting, and the matches, strongest first.
   * @throws {AncestryError} for `NO_GIT_REPOSITORY`, `GIT_NOT_FOUND`,
   *   `REPOSITORY_TOO_LARGE`, `INVALID_PATH`, `BINARY_FILE`, `FILE_TOO_LARGE`,
   *   `UNSUPPORTED_LANGUAGE`, `CANCELLED` and `GIT_COMMAND_FAILED` — the failures
   *   that are about the *request*, not about one file inside the repository.
   */
  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const startedAt = this.now();
    const budget = new AbortBudget(request.signal, this.now);
    const reporter = new ProgressReporter(request.onProgress);
    const warnings: string[] = [];
    const unparsed: UnparsedEntry[] = [];
    budget.throwIfAborted();

    // ---- 1. resolve-repository ---------------------------------------------
    reporter.report('resolve-repository', 0, 'Locating the Git repository…');
    const context = await this.resolveRepository(request, budget, reporter);
    for (const warning of repositoryWarnings(context.info)) {
      warnings.push(warning);
    }
    reporter.report(
      'resolve-repository',
      1,
      `Repository ${path.basename(context.info.root) || context.info.root} resolved.`,
    );

    const thresholds = normalizeThresholds(this.config);
    const includeTests = this.config.analysis.includeTests;
    const branchIndex = new BranchIndex(context.repo, { logger: this.logger });

    try {
      // ---- 2. parse-selection ------------------------------------------------
      reporter.report('parse-selection', 0, 'Reading the selected file…');
      const focus = await this.resolveFocus(context, request, budget, reporter);
      if (focus.synthesized) {
        warnings.push(
          `no named construct covers ${context.relativePath}:${focus.block.range.startLine}` +
            `-${focus.block.range.endLine}; the selected lines are treated as a single unnamed block`,
        );
      }
      const focusNormalized = normalizeBlock(focus.block).normalized;
      reporter.report(
        'parse-selection',
        1,
        `Selected ${focus.block.qualifiedName ?? focus.block.name ?? 'the selection'} ` +
          `(lines ${focus.block.range.startLine}–${focus.block.range.endLine}).`,
      );

      // ---- 3. read-history ---------------------------------------------------
      reporter.report('read-history', 0, `Walking the history of ${context.relativePath}…`);
      const walker = new HistoryWalker(context.repo, {
        maxDepth: this.config.git.maxHistoryDepth,
        followRenames: this.config.analysis.followRenames,
        includeAllBranches: this.config.analysis.includeAllBranches,
        includeTests,
        signal: request.signal,
        onProgress: (progress) => reporter.report(progress.phase, 0, progress.message),
      });
      const history = await this.readHistory(walker, context, budget);
      for (const reason of history.reasons) {
        warnings.push(reason);
      }
      reporter.report(
        'read-history',
        1,
        `${history.commits.length} commit(s) touched ${context.relativePath}.`,
        history.commits.length,
        history.commits.length,
      );

      // ---- 4. extract-blocks -------------------------------------------------
      reporter.report('extract-blocks', 0, 'Reading the files those commits touched…');
      const extractor = new BlockExtractor(context.repo, {
        maxBlocksPerFile: this.config.analysis.maxBlocksPerFile,
        maxBytes: this.config.git.maxFileSizeBytes,
        repoRoot: context.info.root,
        cache: this.cache,
        logger: this.logger,
        now: this.now,
      });
      const extraction = await this.extractAll(
        extractor,
        walker,
        history,
        context,
        budget,
        reporter,
      );
      unparsed.push(...extraction.unparsed);
      if (extraction.blocksTruncated) {
        warnings.push(
          'at least one file hit ancestry.analysis.maxBlocksPerFile or its size limit, ' +
            'so not every version of that file is represented',
        );
      }

      // ---- 5. match-history ---------------------------------------------------
      reporter.report('match-history', 0, 'Comparing versions against the selection…');
      const renameEvidence = evidenceByPath(history);
      const candidates = toStageCandidates(extraction.perCommit, history.commits, renameEvidence);
      const headPaths = await this.pathsAtHead(context, budget);
      const stage = new SimilarityStage({
        thresholds,
        maxBlocksTotal: this.config.analysis.maxBlocksTotal,
        cache: this.cache,
        logger: this.logger,
        headPaths,
      });
      const focusCommit = await this.focusCommit(context, budget);
      const historyMatch = await stage.run(
        { block: focus.block, normalized: focusNormalized },
        candidates,
        branchIndex,
        budget,
      );
      warnings.push(...historyMatch.warnings);
      let blocksCompared = historyMatch.blocksCompared;
      let truncated = historyMatch.truncated || history.truncated;
      reporter.report(
        'match-history',
        1,
        `${historyMatch.accepted.length} version(s) at or above ignore ${thresholds.ignore}.`,
        undefined,
        blocksCompared,
      );

      // ---- 6. cross-file-search ------------------------------------------------
      reporter.report('cross-file-search', 0, 'Sweeping the rest of the repository…');
      const sweep = await this.crossFileSearch(
        stage,
        extractor,
        walker,
        context,
        focus.block,
        focusNormalized,
        historyMatch,
        branchIndex,
        budget,
        reporter,
      );
      warnings.push(...sweep.warnings);
      unparsed.push(...sweep.unparsed);
      blocksCompared += sweep.blocksCompared;
      truncated = truncated || sweep.truncated;
      const accepted = mergeAccepted(historyMatch.accepted, sweep.accepted);
      if (walker.skippedPathCount() > 0) {
        warnings.push(
          `${walker.skippedPathCount()} path(s) were excluded from the search by the generated-output, ` +
            'dependency and test filters',
        );
      }
      reporter.report(
        'cross-file-search',
        1,
        sweep.skipped
          ? 'The history already answered the question; no repository-wide sweep was needed.'
          : `Swept ${sweep.revisions} revision(s) and ${sweep.filesRead} file(s).`,
      );

      // ---- 7. build-graph -----------------------------------------------------
      reporter.report('build-graph', 0, 'Building the ancestry graph…');
      // The focus commit is primed after the matching pass, not before: priming
      // every candidate commit up front would make the git cost proportional to
      // the repository instead of to the graph.
      await branchIndex.prime([focusCommit.hash]);
      for (const branchWarning of branchIndex.warnings()) {
        warnings.push(branchWarning);
      }
      const focusEvidence = renameEvidence.get(focus.block.filePath) ?? null;
      const focusVersion: VersionCandidate = {
        block: focus.block,
        commit: focusCommit,
        similarity: focusSimilarityResult(focus.block.id),
        branches: branchIndex.branchesFor(focusCommit.hash),
        isDeleted: false,
        renameEvidence: focusEvidence,
        previousPath: focusEvidence?.fromPath ?? null,
      };
      const graph = new AncestryGraphBuilder({
        focus: focusVersion,
        candidates: [focusVersion, ...accepted],
        repositoryRoot: context.info.root,
        fileHistory: history.commits,
        thresholds,
        stats: {
          filesInspected: extraction.filesInspected + sweep.filesRead,
          blocksCompared,
          truncated,
        },
        warnings,
        unparsed,
        now: () => this.now(),
      }).build();
      reporter.report(
        'build-graph',
        1,
        `${graph.nodes.length} node(s), ${graph.edges.length} edge(s).`,
      );

      // ---- 8. detect-origin ----------------------------------------------------
      reporter.report('detect-origin', 0, 'Determining the earliest detected match…');
      verifyOrigin(graph);
      reporter.report(
        'detect-origin',
        1,
        graph.origin === null
          ? 'No origin could be established from the available history.'
          : `Earliest detected match: ${graph.origin.shortCommit} in ${graph.origin.filePath}.`,
      );

      // ---- 9. done --------------------------------------------------------------
      reporter.report('done', 0, 'Finishing…');
      const result: AnalysisResult = {
        graph,
        durationMs: Math.max(0, this.now() - startedAt),
        cache: {
          hits: historyMatch.cacheHits + sweep.cacheHits,
          misses: historyMatch.cacheMisses + sweep.cacheMisses,
          backend: this.cache?.info.backend ?? 'none',
        },
        matches: accepted.map((candidate) => candidate.similarity),
        warnings: graph.warnings,
      };
      this.result = result;
      await this.recordRepository(context.info, budget);
      reporter.report('done', 1, `Analysis finished in ${Math.round(result.durationMs)} ms.`);
      return result;
    } finally {
      branchIndex.dispose();
    }
  }

  /**
   * Analyse every top-level block of a file, best-effort.
   *
   * The block list comes from `blocksWithinFile`, so a method nested in a class is
   * covered by the class's own analysis instead of being analysed twice. A file
   * with no recognisable construct is analysed as a single selection covering the
   * whole file, so the command is never a dead end.
   *
   * Never throws. A repository that cannot be resolved, a file that cannot be
   * parsed, or a block whose analysis fails all yield a shorter list — the
   * command layer shows what succeeded and logs what did not, rather than failing
   * a whole-file request because one block was unreadable (specification §10).
   *
   * @param request - File to enumerate; the selection is ignored.
   * @returns One result per successfully analysed block, in file order.
   */
  async analyzeFile(request: AnalysisRequest): Promise<AnalysisResult[]> {
    const results: AnalysisResult[] = [];
    try {
      const context = await this.resolveRepository(
        request,
        new AbortBudget(request.signal, this.now),
        undefined,
      );
      const bytes = await this.readWorkingTree(context.absolutePath, context.relativePath);
      const text = bytes.toString('utf8');
      const parsed = parseSourceFromBuffer(context.relativePath, bytes, {
        maxBytes: this.config.git.maxFileSizeBytes,
        maxBlocks: this.config.analysis.maxBlocksPerFile,
      });
      const last = Math.max(1, countLines(text));
      const blocks = blocksWithinFile(parsed.blocks, 1, last);
      const targets =
        blocks.length > 0
          ? blocks
          : [synthesizeSelectionBlock(context.relativePath, text, 1, last)];
      for (const block of targets) {
        if (request.signal?.aborted === true) {
          break;
        }
        try {
          results.push(
            await this.analyze({
              filePath: request.filePath,
              startLine: block.range.startLine,
              endLine: block.range.endLine,
              signal: request.signal,
              onProgress: request.onProgress,
            }),
          );
        } catch (error) {
          this.logger.warn(
            `ancestry analysis: analysing ${context.relativePath} ` +
              `lines ${block.range.startLine}–${block.range.endLine} failed (${describe(error)}); continuing`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`ancestry analysis: enumerating blocks failed (${describe(error)})`);
    }
    return results;
  }

  /**
   * Probe a repository without analysing anything.
   *
   * Used to enable or disable the commands. The size limit is deliberately *not*
   * enforced here: the question is "is there a repository here", and refusing to
   * answer it because the repository is large would leave the user with no
   * explanation and no way to find out why a command is greyed out.
   *
   * @param filePath - Any path inside the working tree.
   * @returns Freshly probed repository metadata.
   */
  async inspectRepository(filePath: string): Promise<RepoInfo> {
    const repo = await this.createRepository(filePath);
    try {
      return await repo.refreshInfo();
    } finally {
      repo.dispose();
    }
  }

  /**
   * The most recent successful analysis, or `null`.
   *
   * Kept so a command can redraw the panel after a re-invocation without paying
   * for a second scan. It is not a cache: every run overwrites it.
   */
  lastResult(): AnalysisResult | null {
    return this.result;
  }

  /**
   * Release the engine's references.
   *
   * Aborts nothing and closes nothing: cancellation belongs to the caller that
   * owns the signal, and the local index is owned by the extension host, which
   * closes it during deactivation. The engine only stops holding them, so a
   * `dispose` during a run can never turn into a hang or a crash.
   */
  dispose(): void {
    this.cache = null;
    this.result = null;
  }

  // -------------------------------------------------------------------------
  // Phase 1
  // -------------------------------------------------------------------------

  /** Open the repository, probe it, and locate the requested file inside it. */
  private async resolveRepository(
    request: AnalysisRequest,
    budget: AbortBudget,
    reporter: ProgressReporter | undefined,
  ): Promise<RepositoryContext> {
    budget.throwIfAborted();
    const repo = await this.createRepository(request.filePath);
    let info: RepoInfo;
    try {
      info = await repo.refreshInfo({ signal: request.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // `refreshInfo` is best-effort by design; the conservative placeholder it
      // leaves behind is a valid input to everything downstream.
      this.logger.warn(
        `ancestry analysis: repository metadata could not be refreshed (${describe(error)})`,
      );
      info = repo.info;
    }
    enforceRepositorySizeLimit(info, this.config.git.maxRepositorySizeBytes);

    const root = path.resolve(info.root);
    const relative = toRepoRelative(root, path.resolve(request.filePath));
    reporter?.report(
      'resolve-repository',
      1,
      `Repository ${path.basename(root) || root} resolved.`,
    );
    return {
      repo,
      info,
      relativePath: relative,
      absolutePath: path.join(root, ...relative.split('/')),
    };
  }

  // -------------------------------------------------------------------------
  // Phase 2
  // -------------------------------------------------------------------------

  /**
   * Resolve the selection to exactly one block (specification §2.2).
   *
   * When nothing contains or overlaps the selection, a `block`-kind pseudo-block
   * covering exactly the selection is synthesised and normalised like any other:
   * Ancestry works on arbitrary code fragments, it just has no name to report
   * (§2.2 rule 3).
   */
  private async resolveFocus(
    context: RepositoryContext,
    request: AnalysisRequest,
    budget: AbortBudget,
    reporter: ProgressReporter,
  ): Promise<{ block: CodeBlock; synthesized: boolean }> {
    budget.throwIfAborted();
    const bytes = await this.readWorkingTree(context.absolutePath, context.relativePath);
    const text = bytes.toString('utf8');
    let parsed;
    try {
      parsed = parseSourceFromBuffer(context.relativePath, bytes, {
        maxBytes: this.config.git.maxFileSizeBytes,
        maxBlocks: this.config.analysis.maxBlocksPerFile,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // The selected file is not "one bad file in a batch" — it *is* the request.
      // Failing here is the specification §10 contract for the focus file, and the
      // parser already produced an error carrying the right code and message.
      throw error instanceof AncestryError
        ? error
        : new AncestryError('PARSE_FAILED', 'The selected file could not be parsed.', {
            detail: describe(error),
            cause: error,
          });
    }
    const last = Math.max(1, countLines(text));
    let start = clampLineTo(request.startLine, 1, last);
    let end = clampLineTo(request.endLine, last, last);
    if (end < start) {
      // A selection that ends before it starts is normalised rather than
      // rejected: an editor can report a transient inverted range mid-drag, and
      // swapping is what the user meant.
      const swap = start;
      start = end;
      end = swap;
    }
    const best = findBestBlockForRange(parsed.blocks, start, end);
    if (best !== null) {
      const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (errors.length > 0) {
        this.logger.debug(
          `ancestry analysis: ${context.relativePath} parsed with ${errors.length} error diagnostic(s); ` +
            'the recoverable blocks are still analysed',
        );
      }
      return { block: best, synthesized: false };
    }
    reporter.report(
      'parse-selection',
      0.5,
      `No named construct covers ${context.relativePath} line ${start}; ` +
        'the selection itself is analysed.',
    );
    return {
      block: synthesizeSelectionBlock(context.relativePath, text, start, end),
      synthesized: true,
    };
  }

  /** Read a working-tree file, mapping every failure to a clean `AncestryError`. */
  private async readWorkingTree(absolute: string, relative: string): Promise<Buffer> {
    try {
      return await fs.readFile(absolute);
    } catch (error) {
      const reason = error instanceof Error ? error.name : typeof error;
      throw new AncestryError('INVALID_PATH', 'The selected file could not be read from disk.', {
        detail: `${relative} could not be read (${reason})`,
        cause: error,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3
  // -------------------------------------------------------------------------

  /** Walk the focus file's history, containing a failure rather than propagating it. */
  private async readHistory(
    walker: HistoryWalker,
    context: RepositoryContext,
    budget: AbortBudget,
  ): Promise<PathHistory> {
    budget.throwIfAborted();
    try {
      return await walker.fileHistory(context.relativePath);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.logger.warn(
        `ancestry analysis: history of ${context.relativePath} could not be read (${describe(error)})`,
      );
      return {
        path: context.relativePath,
        commits: [],
        renames: [],
        truncated: true,
        reasons: [
          `the history of ${context.relativePath} could not be read (${describe(error)}); ` +
            'only the working-tree version is represented',
        ],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4
  // -------------------------------------------------------------------------

  /**
   * Parse every `(commit, path)` the history touched.
   *
   * This is the widening step of specification §7: for each commit in the focus
   * file's history, every *other* path that commit changed is read too. It is how
   * a function lifted out of `auth.ts` into `security/token.ts` is found at all —
   * the two files share a committing commit and nothing else.
   *
   * Work is issued with bounded concurrency, but each result is filed under its
   * `(commit, path)` key, so the output does not depend on completion order.
   */
  private async extractAll(
    extractor: BlockExtractor,
    walker: HistoryWalker,
    history: PathHistory,
    context: RepositoryContext,
    budget: AbortBudget,
    reporter: ProgressReporter,
  ): Promise<ExtractionOutcomeSummary> {
    const perCommit = new Map<string, Map<string, CodeBlock[]>>();
    const unparsed: UnparsedEntry[] = [];
    const touched = await walker.pathsTouchedBy(history.commits);
    const touchedByCommit = new Map<string, string[]>();
    for (const [filePath, commits] of touched) {
      for (const touchedCommit of commits) {
        const list = touchedByCommit.get(touchedCommit.hash);
        if (list === undefined) {
          touchedByCommit.set(touchedCommit.hash, [filePath]);
        } else {
          list.push(filePath);
        }
      }
    }
    const includeTests = this.config.analysis.includeTests;

    const tasks: Array<{ commit: string; path: string }> = [];
    for (const commit of history.commits) {
      const paths = new Set<string>([context.relativePath]);
      // `pathsTouchedBy` is keyed by path; invert it once so widening a commit
      // does not mean scanning every path in the repository.
      for (const widened of touchedByCommit.get(commit.hash) ?? []) {
        if (skipReasonForPath(widened, includeTests) === null) {
          paths.add(widened);
        }
      }
      for (const candidate of [...paths].sort()) {
        tasks.push({ commit: commit.hash, path: candidate });
      }
    }

    let blocksTruncated = false;
    let cacheHits = 0;
    let cacheMisses = 0;

    const consume = async (task: { commit: string; path: string }): Promise<void> => {
      const outcome = await extractor.fromCommit(task.commit, task.path, budget.cancellation);
      unparsed.push(...outcome.unparsed);
      cacheHits += outcome.cacheHits;
      cacheMisses += outcome.cacheMisses;
      if (outcome.truncated) {
        blocksTruncated = true;
      }
      if (outcome.blocks.length === 0) {
        return;
      }
      let byPath = perCommit.get(task.commit);
      if (byPath === undefined) {
        byPath = new Map<string, CodeBlock[]>();
        perCommit.set(task.commit, byPath);
      }
      byPath.set(task.path, dedupeBlocks([...(byPath.get(task.path) ?? []), ...outcome.blocks]));
    };

    let next = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(EXTRACTION_CONCURRENCY, tasks.length)) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          const task = tasks[index];
          if (task === undefined) {
            return;
          }
          budget.throwIfAborted();
          await consume(task);
          reporter.report(
            'extract-blocks',
            tasks.length === 0 ? 1 : next / tasks.length,
            `Read ${next} of ${tasks.length} file version(s).`,
            tasks.length,
            next,
          );
        }
      },
    );
    await Promise.all(workers);

    this.logger.debug(
      `ancestry analysis: read ${tasks.length} file version(s) ` +
        `(${cacheHits} block cache hit(s), ${cacheMisses} miss(es))`,
    );
    return { perCommit, unparsed, filesInspected: tasks.length, blocksTruncated };
  }

  // -------------------------------------------------------------------------
  // Phase 5 helpers
  // -------------------------------------------------------------------------

  /** The commit the focus block is attributed to, or a synthetic anchor. */
  private async focusCommit(context: RepositoryContext, budget: AbortBudget): Promise<GitCommit> {
    const head = context.info.headCommit;
    if (head === null) {
      // An unborn HEAD has no commit to attribute the working tree to. A synthetic
      // anchor keeps the graph renderable — one node, no edges — which is the
      // truthful answer for a repository with no history yet.
      return syntheticCommit(this.now());
    }
    budget.throwIfAborted();
    try {
      return await context.repo.getCommit(head);
    } catch (error) {
      this.logger.warn(
        `ancestry analysis: HEAD could not be read as a commit (${describe(error)}); ` +
          'the focus node is attributed to a synthetic commit',
      );
      return syntheticCommit(this.now());
    }
  }

  /** Every path present at `HEAD`, for `isDeleted`. An empty set means "unknown". */
  private async pathsAtHead(
    context: RepositoryContext,
    budget: AbortBudget,
  ): Promise<ReadonlySet<string>> {
    const head = context.info.headCommit;
    if (head === null) {
      return new Set<string>();
    }
    budget.throwIfAborted();
    try {
      return new Set(await context.repo.getAllFilesAtCommit(head));
    } catch (error) {
      this.logger.debug(
        `ancestry analysis: the HEAD tree could not be listed (${describe(error)}); ` +
          'no node is reported as deleted',
      );
      return new Set<string>();
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6
  // -------------------------------------------------------------------------

  /**
   * Sweep other files at HEAD and at the other branches' tips (§7 step 3).
   *
   * Runs only when the history-derived set is small, because a history that
   * already produced several plausible ancestors is a better answer than a
   * repository-wide guess. Everything is bounded: the number of revisions read,
   * a wall-clock budget, and the remaining `maxBlocksTotal` allowance.
   */
  private async crossFileSearch(
    stage: SimilarityStage,
    extractor: BlockExtractor,
    walker: HistoryWalker,
    context: RepositoryContext,
    focusBlock: CodeBlock,
    focusNormalized: NormalizedBlock,
    historyMatch: SimilarityStageResult,
    branchIndex: BranchIndex,
    budget: AbortBudget,
    reporter: ProgressReporter,
  ): Promise<SweepOutcome> {
    const outcome: SweepOutcome = {
      accepted: [],
      blocksCompared: 0,
      truncated: false,
      warnings: [],
      unparsed: [],
      cacheHits: 0,
      cacheMisses: 0,
      revisions: 0,
      filesRead: 0,
      skipped: false,
    };
    if (shouldSkipSweep(historyMatch.accepted, focusBlock.filePath)) {
      outcome.skipped = true;
      return outcome;
    }

    const revisions: string[] = [];
    const seen = new Set<string>();
    if (context.info.headCommit !== null) {
      seen.add(context.info.headCommit);
      revisions.push(context.info.headCommit);
    }
    for (const entry of await branchIndex.branchTips()) {
      if (revisions.length >= MAX_SWEEP_REVISIONS) {
        break;
      }
      if (seen.has(entry.tip)) {
        continue;
      }
      seen.add(entry.tip);
      revisions.push(entry.tip);
    }
    if (revisions.length === 0) {
      outcome.skipped = true;
      return outcome;
    }
    outcome.revisions = revisions.length;
    if (revisions.length >= MAX_SWEEP_REVISIONS) {
      outcome.warnings.push(
        `the cross-file sweep inspected the first ${MAX_SWEEP_REVISIONS} revision(s) only; ` +
          'the remaining branches were not swept',
      );
    }

    const startedAt = budget.elapsedMs();
    const allowance = Math.max(
      0,
      this.config.analysis.maxBlocksTotal - historyMatch.accepted.length,
    );
    const commitsByHash = new Map<string, GitCommit>();
    const refs: StageCandidate[] = [];
    let blocks = 0;
    let stop = false;

    for (let index = 0; index < revisions.length && !stop; index += 1) {
      budget.throwIfAborted();
      const revision = revisions[index]!;
      if (budget.elapsedMs() - startedAt > SWEEP_BUDGET_MS) {
        outcome.truncated = true;
        outcome.warnings.push(
          'the cross-file sweep stopped on its wall-clock budget, so the ancestry shown is partial',
        );
        break;
      }
      const files = await walker.repositoryFiles(revision, budget.cancellation);
      reporter.report(
        'cross-file-search',
        (index / revisions.length) * 0.7,
        `Sweeping ${files.length} file(s) at ${revision.slice(0, 8)}.`,
        files.length,
        0,
      );
      for (const filePath of files) {
        budget.throwIfAborted();
        if (filePath === focusBlock.filePath) {
          continue;
        }
        if (skipReasonForPath(filePath, this.config.analysis.includeTests) !== null) {
          continue;
        }
        if (blocks >= allowance) {
          outcome.truncated = true;
          outcome.warnings.push(
            `the cross-file sweep reached ancestry.analysis.maxBlocksTotal (${allowance} block(s)) ` +
              'before finishing, so the ancestry shown is partial',
          );
          stop = true;
          break;
        }
        const read = await extractor.fromCommit(revision, filePath, budget.cancellation);
        outcome.filesRead += 1;
        outcome.unparsed.push(...read.unparsed);
        outcome.cacheHits += read.cacheHits;
        outcome.cacheMisses += read.cacheMisses;
        if (read.truncated) {
          outcome.truncated = true;
        }
        if (read.blocks.length === 0) {
          continue;
        }
        blocks += read.blocks.length;
        let commit = commitsByHash.get(revision);
        if (commit === undefined) {
          commit = await this.commitOf(context, revision, budget);
          commitsByHash.set(revision, commit);
        }
        for (const block of read.blocks) {
          refs.push({ block, commit });
        }
      }
    }

    if (refs.length > 0) {
      const swept = await stage.sweep(
        { block: focusBlock, normalized: focusNormalized },
        refs,
        branchIndex,
        budget,
      );
      outcome.accepted = swept.accepted;
      outcome.blocksCompared = swept.blocksCompared;
      outcome.truncated = outcome.truncated || swept.truncated;
      outcome.warnings.push(...swept.warnings);
      outcome.cacheHits += swept.cacheHits;
      outcome.cacheMisses += swept.cacheMisses;
    }
    return outcome;
  }

  private async commitOf(
    context: RepositoryContext,
    revision: string,
    budget: AbortBudget,
  ): Promise<GitCommit> {
    budget.throwIfAborted();
    try {
      return await context.repo.getCommit(revision);
    } catch (error) {
      this.logger.debug(
        `ancestry analysis: ${revision.slice(0, 8)} could not be read as a commit (${describe(error)})`,
      );
      return syntheticCommit(this.now(), revision);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 9
  // -------------------------------------------------------------------------

  /**
   * Record the repository's HEAD so a later run knows what changed since the last
   * index build (specification §7, and the basis of phase 11's incremental scan).
   * Never throws: the index is an optimisation, and a failed write costs only
   * speed.
   */
  private async recordRepository(info: RepoInfo, budget: AbortBudget): Promise<void> {
    if (this.cache === null) {
      return;
    }
    budget.throwIfAborted();
    try {
      await this.cache.putRepository({
        repoRoot: info.root,
        headCommit: info.headCommit,
        lastIndexedAt: this.now(),
        indexedCommitCount: info.commitCount ?? 0,
      });
    } catch (error) {
      this.logger.debug(`ancestry analysis: the index header was not updated (${describe(error)})`);
    }
  }
}

/**
 * Is a usable `git` on the PATH?
 *
 * A single `git --version` with a short timeout, failures swallowed: the question
 * is asked by commands that are being enabled or disabled, so the only two answers
 * are "yes" and "no".
 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runGit(['--version'], { timeoutMs: 10_000, allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a repository-relative POSIX path.
 *
 * @throws {AncestryError} `INVALID_PATH` when the path is the repository root
 *   itself or lies outside the working tree. Either would produce a path that git
 *   and the graph cannot use, and silently clamping one would misattribute
 *   blocks.
 */
function toRepoRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (relative.length === 0) {
    throw new AncestryError(
      'INVALID_PATH',
      'Select a file inside the repository, not the folder itself.',
      { detail: `${absolute} is the working-tree root` },
    );
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AncestryError(
      'INVALID_PATH',
      'That file is outside the repository that was opened.',
      {
        detail: `${absolute} is not under ${root}`,
      },
    );
  }
  return relative;
}

/** Number of lines in `text`, not counting the empty line a trailing newline implies. */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Offsets at which each line of `text` begins. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Synthesise the `block`-kind pseudo-block of specification §2.2 rule 3.
 *
 * Ancestry still works on arbitrary code fragments; it simply has no name to
 * report. The offsets come from the real line starts, so the block's `text` is
 * exactly `source.slice(startOffset, endOffset)` — the same invariant every
 * parser-produced block satisfies, and what lets a synthesised block be
 * normalised, cached and compared like any other.
 */
function synthesizeSelectionBlock(
  relPath: string,
  text: string,
  startLine: number,
  endLine: number,
): CodeBlock {
  const starts = lineStartsOf(text);
  const lastLine = Math.max(1, starts.length - (text.endsWith('\n') ? 1 : 0));
  // `clampLineTo` bounds both ends into `[1, lastLine]`; the `Math.min` on `to`
  // keeps the end at or after the start, since an inverted range would otherwise
  // slice to a negative offset and yield an empty block.
  const from = clampLineTo(startLine, 1, lastLine) - 1;
  const to = Math.max(from + 1, clampLineTo(endLine, lastLine, lastLine)) - 1;
  const startOffset = starts[from] ?? 0;
  const endOfSelection = to + 1 < starts.length ? starts[to + 1]! : text.length;
  const trimmed = text.slice(startOffset, endOfSelection).replace(/[\s\uFEFF]+$/, '');
  const endOffset = startOffset + trimmed.length;
  const range: SourceRange = {
    startOffset,
    endOffset,
    startLine: from + 1,
    startColumn: 0,
    endLine: to + 1,
    endColumn: endOffset - (starts[to] ?? 0),
  };
  return {
    id: makeBlockId(relPath, 'block', null, range.startLine),
    kind: 'block',
    name: null,
    qualifiedName: null,
    signature: null,
    filePath: relPath,
    language: languageFor(relPath),
    range,
    parentId: null,
    container: null,
    text: trimmed,
    textHash: sha1(trimmed),
    tokenCount: estimateTokenCount(trimmed),
  };
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * Token count of a text, by the same "maximal alphanumeric run" rule the parser
 * uses. Only ever an estimate: the authoritative count comes from normalisation.
 */
function estimateTokenCount(text: string): number {
  let count = 0;
  let inToken = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isWord =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 /* _ */ ||
      code === 36; /* $ */
    if (isWord) {
      if (!inToken) {
        count += 1;
        inToken = true;
      }
    } else {
      inToken = false;
    }
  }
  return count;
}

/**
 * A commit-shaped record for a revision Ancestry could not read as a commit.
 *
 * Dropping those candidates would lose real versions, and inventing a
 * plausible-looking author or timestamp would be worse than an obviously empty
 * one. `isMerge: false` keeps it from claiming parentage it does not have.
 */
function syntheticCommit(now: number, hash?: string): GitCommit {
  const value = hash ?? '0'.repeat(40);
  return {
    hash: value,
    shortHash: value.slice(0, 12),
    parents: [],
    author: { name: '', email: '' },
    committer: { name: '', email: '' },
    authorTimestamp: now,
    commitTimestamp: now,
    subject: '',
    body: '',
    refs: [],
    isMerge: false,
  };
}

/** The strongest rename evidence per path, newest name first. */
function evidenceByPath(history: PathHistory): Map<string, RenameEvidence> {
  const out = new Map<string, RenameEvidence>();
  for (const rename of history.renames) {
    if (out.has(rename.toPath)) {
      continue;
    }
    out.set(rename.toPath, {
      fromPath: rename.fromPath,
      score: rename.score,
      commit: rename.commit,
    });
  }
  return out;
}

/** Flatten the per-commit, per-path block sets into a deterministically ordered list. */
function toStageCandidates(
  perCommit: ReadonlyMap<string, Map<string, CodeBlock[]>>,
  commits: readonly GitCommit[],
  renameEvidence: ReadonlyMap<string, RenameEvidence>,
): StageCandidate[] {
  const out: StageCandidate[] = [];
  for (const commit of commits) {
    const byPath = perCommit.get(commit.hash);
    if (byPath === undefined) {
      continue;
    }
    for (const filePath of [...byPath.keys()].sort()) {
      const evidence = renameEvidence.get(filePath) ?? null;
      for (const block of byPath.get(filePath) ?? []) {
        out.push({
          block,
          commit,
          renameEvidence: evidence,
          previousPath: evidence?.fromPath ?? null,
        });
      }
    }
  }
  return out;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** De-duplicate blocks two extraction passes produced for one path. */
function dedupeBlocks(blocks: CodeBlock[]): CodeBlock[] {
  const seen = new Set<string>();
  const out: CodeBlock[] = [];
  for (const block of blocks) {
    if (seen.has(block.id)) {
      continue;
    }
    seen.add(block.id);
    out.push(block);
  }
  return out;
}

/** Union of two accepted sets, keeping the strongest score for a repeated version. */
function mergeAccepted(
  primary: readonly VersionCandidate[],
  extra: readonly VersionCandidate[],
): VersionCandidate[] {
  const byKey = new Map<string, VersionCandidate>();
  for (const candidate of [...primary, ...extra]) {
    const key = versionKey(candidate.block, candidate.commit);
    const existing = byKey.get(key);
    if (
      existing === undefined ||
      candidate.similarity.similarity > existing.similarity.similarity
    ) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (right.similarity.similarity !== left.similarity.similarity) {
      return right.similarity.similarity - left.similarity.similarity;
    }
    return compareText(versionKey(left.block, left.commit), versionKey(right.block, right.commit));
  });
}

/**
 * Guarantee that specification §5's wording reached the payload.
 *
 * `detectOrigin` already stamps the canonical disclaimer, so this is a
 * verification rather than a repair: if that ever changed, the graph would present
 * an origin without the caveat that makes it defensible, and this is where the
 * drift would be caught. A missing origin is recorded too, so the UI can explain
 * *why* there is none instead of showing an empty panel (specification §10,
 * `NO_MATCHES`).
 */
function verifyOrigin(graph: AncestryGraph): void {
  const origin = graph.origin;
  if (origin === null) {
    graph.warnings.push(
      'no origin could be established: fewer than two versions of this code are similar enough to be ' +
        'considered related. Ancestry reports the earliest detected semantic match, never the original ' +
        'authorship. Lower "Ancestry: Similarity Possible Threshold" or raise "Ancestry: Git Max ' +
        'History Depth" to widen the search.',
    );
    return;
  }
  if (origin.disclaimer !== ORIGIN_DISCLAIMER) {
    graph.warnings.push(
      'the origin disclaimer did not match the wording required by the specification and was replaced',
    );
    origin.disclaimer = ORIGIN_DISCLAIMER;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Resolve one end of a selection to a 1-based line number.
 *
 * `fallback` is used when the caller supplied nothing, and is itself floored at
 * `minimum` so "no end line" means "the last line", never "before the start".
 *
 * The upper bound is applied by the CALLER with {@link clampLineTo}, not here.
 * That split is deliberate: this helper's third parameter is a *minimum*, and
 * passing a line count into it silently turns "clamp to the end of the file"
 * into "clamp to at least the end of the file" — which resolves every selection
 * to the file's last line. `clampLineTo` takes the bounds in the order they read
 * at the call site, which is the whole point of it existing.
 */
function clampLine(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(minimum, fallback);
  }
  return Math.max(minimum, Math.trunc(value));
}

/**
 * Clamp a line number into `[1, lastLine]`, substituting `fallback` when the
 * caller supplied nothing.
 *
 * The parameter order — value, then bounds low-to-high — matches how the bounds
 * are read at every call site, so there is no way to transpose them.
 */
function clampLineTo(value: number | undefined, fallback: number, lastLine: number): number {
  return Math.min(Math.max(1, clampLine(value, fallback, 1)), lastLine);
}

/**
 * Whether the cross-file sweep can be skipped as unnecessary.
 *
 * The cost argument for skipping only holds once the history walk has *already
 * answered the cross-file question*. Candidates that are all earlier versions of
 * the block in its own module have not answered it at all — they are the same
 * file, and the sweep is the only thing that ever looks at the others. So the
 * trigger is applied to the count of candidates that reached **outside the focus
 * module**, and a run whose accepted candidates are all same-module always
 * sweeps.
 *
 * Module rather than exact path, deliberately. With renames followed, a version of
 * the block from before the file was renamed carries the *old* path, so an exact
 * comparison would score an ordinary same-file ancestor as a cross-file hit and
 * suppress the sweep for exactly the histories that need it. The module is also
 * the axis the graph groups on, so "did we get outside this area of the
 * repository" is the question the user would ask.
 *
 * A block that genuinely moved to another module counts as cross-file, which is
 * the right answer: the sweep should run, because the file is somewhere history
 * has not been.
 */
function shouldSkipSweep(accepted: readonly VersionCandidate[], focusPath: string): boolean {
  if (accepted.length <= CROSS_FILE_TRIGGER) {
    return false;
  }
  const focusModule = moduleForPath(focusPath);
  return accepted.some((candidate) => moduleForPath(candidate.block.filePath) !== focusModule);
}

function describe(error: unknown): string {
  if (error instanceof AncestryError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}
