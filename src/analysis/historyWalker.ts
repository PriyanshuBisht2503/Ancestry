/**
 * History traversal — specification §7, steps 1 and 2.
 *
 * Three questions are answered here, and each maps onto one of the pipeline's
 * phases:
 *
 *  1. *What are the versions of this file?* {@link HistoryWalker.fileHistory}
 *     walks `git log` for one path (`--follow` when configured) and reconstructs
 *     the rename chain, because a path change is the strongest move evidence
 *     there is (specification §4).
 *  2. *What else did those commits touch?* {@link HistoryWalker.pathsTouchedBy}
 *     is the **widening step**: the single most important behaviour of the whole
 *     search, because a function that was lifted out of `auth.ts` into
 *     `security/token.ts` shares no history with `auth.ts` — only its
 *     *committing* commit. Without this step that copy is invisible.
 *  3. *What else is in the tree?* {@link HistoryWalker.repositoryFiles} answers
 *     it for a commit, filtered by {@link skipReasonForPath} so generated output
 *     and dependencies never enter the search.
 *
 * ## Failure policy
 *
 * A single unanalysable commit must never abort an analysis (specification §10).
 * Every method here therefore answers with what it could obtain: a commit whose
 * diff cannot be read is skipped, and if it was one of the focus file's own
 * commits that skip is recorded as a truncation, because it *is* a gap in
 * coverage. The only exception is cancellation, which is re-thrown so a
 * cancelled run stops promptly instead of finishing useless work.
 *
 * @module analysis/historyWalker
 */

import { isAbortError } from '../git';
import type { GitRepository } from '../git';
import type { AnalysisProgress, GitCommit, GitFileChange } from '../types';
import { skipReasonForPath } from './safety';

/** Limits and switches for one traversal. */
export interface HistoryWalkOptions {
  /** `ancestry.git.maxHistoryDepth`: the newest N commits to inspect. */
  maxDepth: number;
  /** `ancestry.analysis.followRenames`: pass `--follow` to `git log`. */
  followRenames: boolean;
  /** Walk every ref (`--all`) rather than only HEAD's ancestry. */
  includeAllBranches: boolean;
  /** `ancestry.analysis.includeTests`. */
  includeTests: boolean;
  /** Cancellation signal handed to every git invocation. */
  signal?: AbortSignal;
  /** Progress sink; receives monotonic `AnalysisProgress` updates. */
  onProgress?: (progress: AnalysisProgress) => void;
}

/** One detected rename or copy of the focus file. */
export interface PathRename {
  fromPath: string;
  toPath: string;
  /** Commit at which the rename was introduced. */
  commit: string;
  /** Git's own similarity in `[0, 1]`; `0` when git reported none. */
  score: number;
}

/** The history of one path, oldest commit first. */
export interface PathHistory {
  /** The path the history was requested for. */
  path: string;
  /** Commits that touched the path (following renames), **oldest first**. */
  commits: GitCommit[];
  /** Rename chain, newest first. */
  renames: PathRename[];
  /**
   * True when the scan stopped before the beginning of the path's history, or
   * skipped a commit whose diff could not be read. Either way the ancestry is
   * partial and the UI must say so (specification §3.5, §6).
   */
  truncated: boolean;
  /** Human-readable reasons behind `truncated`, for the graph warnings. */
  reasons: string[];
}

/**
 * Walks the history of a repository, with every failure contained.
 *
 * One instance is created per analysis run. It holds no mutable state beyond a
 * small per-commit diff cache, which is what keeps a repeated
 * {@link HistoryWalker.pathsTouchedBy} over the same commit list free: the
 * widening step and the rename-chain step both need `getChangedFiles` for the
 * same commits.
 */
export class HistoryWalker {
  private readonly repo: GitRepository;
  private readonly options: HistoryWalkOptions;
  /** `commit hash` → its changed files, including per-commit failures. */
  private readonly changeCache = new Map<string, GitFileChange[] | null>();

  /**
   * @param repo - Repository to walk.
   * @param options - Depth, switches, cancellation and progress.
   */
  constructor(repo: GitRepository, options: HistoryWalkOptions) {
    this.repo = repo;
    this.options = options;
  }

  /**
   * History of `path`, oldest commit first, with its rename chain.
   *
   * The commit list comes from `git log` limited to `maxDepth + 1` entries, so
   * the truncation flag is *exact* rather than inferred: receiving the extra
   * commit proves the limit bit, and it is dropped. Asking for `maxDepth` and
   * guessing "maybe it truncated" would put a permanent partial-history banner
   * on every repository whose file history happens to be exactly the configured
   * length.
   *
   * `--follow` and `--all` are mutually exclusive in git, so when both are
   * requested the walk is retried without rename-following and says so. Losing
   * rename history degrades the *evidence* for a move; it must not lose the
   * whole history.
   *
   * Never throws for a git failure: an unreadable path yields an empty history
   * and a recorded reason.
   *
   * @param path - Repository-relative POSIX path.
   * @returns The path's history, oldest commit first.
   */
  async fileHistory(path: string): Promise<PathHistory> {
    const result: PathHistory = { path, commits: [], renames: [], truncated: false, reasons: [] };
    const depth = Math.max(1, Math.floor(this.options.maxDepth));

    let commits: GitCommit[];
    try {
      commits = await this.walk(path, depth + 1, this.options.followRenames);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      result.reasons.push(
        `history of ${path} could not be read (${describe(error)}); only the working-tree version is known`,
      );
      result.truncated = true;
      return result;
    }

    if (commits.length > depth) {
      // `git log` yields newest first, so the *last* entry is the oldest and the
      // one the limit dropped.
      result.truncated = true;
      result.reasons.push(
        `history of ${path} is longer than the configured ancestry.git.maxHistoryDepth of ${depth}; ` +
          'older versions were not inspected',
      );
      commits = commits.slice(0, depth);
    }

    // The pipeline reasons oldest-first — that is the direction an ancestry is
    // read in — and reversing here rather than asking git for `--reverse` is not
    // cosmetic: `--reverse` silently defeats `--follow`, so a rename would stop
    // the walk at the rename commit and the whole earlier history of the file
    // would be lost.
    //
    // The rename chain is derived from the *newest-first* order, because it is
    // derived by walking backwards: each `R` entry tells us the name the file had
    // before it, and the next commit back must be matched against that older name.
    result.renames = await this.renamesOf(path, commits, result);
    result.commits = commits.slice().reverse();
    return result;
  }

  /**
   * Union of every path the given commits touched, mapped to those commits.
   *
   * Both sides of a rename contribute: `a.ts → b.ts` makes `a.ts` and `b.ts`
   * equally interesting, and a scan that only saw `b.ts` would keep a stale
   * assumption about `a.ts` forever.
   *
   * Per-commit failures are contained. A commit whose diff cannot be read is
   * simply absent from the result.
   *
   * @param commits - Commits to inspect, in any order.
   * @returns `path` → the commits (input order preserved) that touched it.
   */
  async pathsTouchedBy(commits: GitCommit[]): Promise<Map<string, GitCommit[]>> {
    const out = new Map<string, GitCommit[]>();
    for (const commit of commits) {
      if (!commit || typeof commit.hash !== 'string' || commit.hash.length === 0) {
        continue;
      }
      const changes = await this.changedFiles(commit.hash);
      if (changes === null) {
        continue;
      }
      for (const change of changes) {
        if (change.oldPath !== null) {
          push(out, change.oldPath, commit);
        }
        push(out, change.path, commit);
      }
    }
    return out;
  }

  /**
   * Every analysable file in the tree at `commit`.
   *
   * Paths excluded by {@link skipReasonForPath} are dropped and counted, because
   * the caller reports the count as a warning: a file that Ancestry skipped must
   * always be visible in the report (specification §7). Silence would
   * misrepresent coverage.
   *
   * @param commit - Commit whose tree is listed.
   * @param signal - Cancellation signal, honoured before and after the listing.
   * @returns Sorted, de-duplicated repository-relative POSIX paths.
   */
  async repositoryFiles(commit: string, signal?: AbortSignal): Promise<string[]> {
    if (isCancelled(signal)) {
      return [];
    }
    const all = await this.safeListFiles(commit);
    if (isCancelled(signal)) {
      return [];
    }
    const keep: string[] = [];
    let skipped = 0;
    for (const filePath of all) {
      if (skipReasonForPath(filePath, this.options.includeTests) !== null) {
        skipped += 1;
        continue;
      }
      keep.push(filePath);
    }
    this.skipped += skipped;
    keep.sort();
    return keep;
  }

  /**
   * Number of paths {@link HistoryWalker.repositoryFiles} has excluded so far,
   * for the coverage warning the caller reports.
   */
  skippedPathCount(): number {
    return this.skipped;
  }

  private async safeListFiles(commit: string): Promise<string[]> {
    try {
      return await this.repo.getAllFilesAtCommit(commit);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.options.onProgress?.({
        phase: 'cross-file-search',
        ratio: 0,
        message: `files at ${commit.slice(0, 12)} could not be listed (${describe(error)})`,
      });
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Paths excluded by the search-scope filter so far. */
  private skipped = 0;

  /**
   * One `git log` for the path, newest first, with `limit` entries.
   *
   * `limit` is the depth the caller wants *plus one*, so receiving the extra
   * commit is proof that the ceiling bit — exact, rather than a guess that would
   * put a permanent partial-history banner on every repository whose file history
   * happens to be exactly as long as the configured depth.
   *
   * `--reverse` is deliberately **not** requested. Git's `--follow` cannot be
   * combined with it: asking for both yields rename-following history that stops
   * at the rename commit, which would silently lose every earlier version of a
   * renamed file. The newest-first order is reversed by the caller instead.
   */
  private async walk(path: string, limit: number, follow: boolean): Promise<GitCommit[]> {
    const attempt = (useFollow: boolean): Promise<GitCommit[]> =>
      this.repo.getCommitHistory({
        path,
        limit,
        followRenames: useFollow,
        includeAllBranches: this.options.includeAllBranches,
        signal: this.options.signal,
      });

    if (!follow) {
      return attempt(false);
    }
    try {
      return await attempt(true);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // `--follow` requires exactly one pathspec and cannot be combined with
      // `--all`; degrade to a plain path walk rather than losing the history.
      this.options.onProgress?.({
        phase: 'read-history',
        ratio: 0,
        message: `rename-following history is unavailable here; ${path} is walked without --follow`,
      });
      return attempt(false);
    }
  }

  /**
   * Reconstruct the rename chain by walking the commit list from newest to
   * oldest and following each `R`/`C` entry backwards.
   *
   * `git log --follow` reports the *old* path for pre-rename commits, so the
   * commit list alone does not say when the name changed; only
   * `getChangedFiles(commit)` does, which is why the chain is derived here rather
   * than assumed. {@link HistoryWalker.fileHistory} passes the newest-first order
   * for exactly this reason.
   *
   * @param path - The path the history was requested for.
   * @param commits - Commits in newest-first order.
   * @param history - Mutated to record truncation when a diff cannot be read.
   * @returns The rename chain, newest rename first.
   */
  private async renamesOf(
    path: string,
    commits: readonly GitCommit[],
    history: PathHistory,
  ): Promise<PathRename[]> {
    const renames: PathRename[] = [];
    let current = path;
    for (const commit of commits) {
      const changes = await this.changedFiles(commit.hash);
      if (changes === null) {
        history.truncated = true;
        history.reasons.push(
          `the changes of commit ${commit.shortHash} could not be read, so a version of ${path} may be missing`,
        );
        continue;
      }
      for (const change of changes) {
        if (change.path !== current) {
          continue;
        }
        if (change.status !== 'R' && change.status !== 'C') {
          continue;
        }
        const fromPath = change.oldPath;
        if (fromPath === null || fromPath.length === 0 || fromPath === current) {
          continue;
        }
        renames.push({
          fromPath,
          toPath: current,
          commit: commit.hash,
          // `parseNameStatusZ` already normalises git's 0..100 score to 0..1, which
          // is the scale `RenameEvidence.score` and the graph's rationale use.
          score: clamp01(change.similarity ?? 0),
        });
        current = fromPath;
      }
    }
    return renames;
  }

  /** `getChangedFiles` with memoisation; `null` records a per-commit failure. */
  private async changedFiles(commit: string): Promise<GitFileChange[] | null> {
    const cached = this.changeCache.get(commit);
    if (cached !== undefined) {
      return cached;
    }
    let value: GitFileChange[] | null;
    try {
      value = await this.repo.getChangedFiles(commit);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      value = null;
    }
    this.changeCache.set(commit, value);
    return value;
  }
}

/**
 * Paths that differ between two revisions, for an incremental re-run.
 *
 * Renames contribute both the old and the new path, so an incremental scan that
 * only saw the destination would keep a stale entry for the deleted source file
 * (which is exactly what `src/git`'s `getChangedFilesSince` guarantees).
 *
 * Never throws: a diff that cannot be produced is an empty change set, and an
 * empty change set is a correct answer to "what changed?" for a repository with
 * no history.
 *
 * @param repo - Repository to diff.
 * @param from - The revision the index was built at.
 * @param to - The revision to bring it to. Defaults to `HEAD`.
 * @param signal - Cancellation signal, checked before and after the diff.
 * @returns Sorted, de-duplicated repository-relative POSIX paths.
 */
export async function changedPathsSince(
  repo: GitRepository,
  from: string,
  to?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (isCancelled(signal)) {
    return [];
  }
  try {
    const paths = await repo.getChangedFilesSince(from, to);
    if (isCancelled(signal)) {
      return [];
    }
    return [...new Set(paths)].sort();
  } catch {
    return [];
  }
}

function push(map: Map<string, GitCommit[]>, key: string, commit: GitCommit): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [commit]);
    return;
  }
  if (!list.includes(commit)) {
    list.push(commit);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}

/**
 * True when `signal` has fired.
 *
 * A helper rather than a repeated `signal?.aborted === true`: TypeScript narrows a
 * repeated readonly property access, so a second identical comparison in the same
 * function is reported as unreachable.
 */
function isCancelled(signal?: AbortSignal): boolean {
  return signal !== undefined && signal.aborted;
}
