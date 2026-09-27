/**
 * Safety rails for the analysis pipeline — specification §7 and §10.
 *
 * Every rule in this file exists because the alternative is an analysis that
 * misrepresents its own coverage or hangs the extension host:
 *
 *  - {@link enforceRepositorySizeLimit} refuses a repository that cannot be
 *    scanned inside the user's time budget, and says which setting to raise.
 *  - {@link repositoryWarnings} turns the *soft* repository facts (shallow clone,
 *    detached HEAD, unborn HEAD, no identity, no remote) into the human-readable
 *    warnings specification §10 requires to be recorded rather than thrown.
 *  - {@link skipReasonForPath} is the search-scope filter of §7: generated
 *    output, dependencies, lockfiles and minified bundles are excluded, and every
 *    exclusion is a *reason string* so it can be surfaced instead of silently
 *    narrowing the search.
 *  - {@link AbortBudget} is the single cancellation primitive. It is checked
 *    between every expensive step, so cancelling an analysis is prompt rather
 *    than eventual.
 *
 * None of these functions log. Paths are never written to a log here; only
 * counts, sizes and reason strings leave this module.
 */

import { AncestryError, isTestPath } from '../types';
import type { RepoInfo } from '../types';

/**
 * Directory names that never contain hand-written source worth analysing.
 *
 * A *segment* match, not a prefix match: `src/dist/index.ts` and
 * `packages/app/dist/index.ts` are both excluded, and a file that merely
 * mentions `build` in its name (`src/builders/parse.ts`) is not.
 */
export const SKIPPED_DIRECTORIES: readonly string[] = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'vendor',
  'target',
]);

/**
 * Generated lockfiles: machine-written, enormous, and full of repeated
 * structure that would otherwise dominate the block count.
 */
export const SKIPPED_LOCKFILES: ReadonlySet<string> = Object.freeze(
  new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']),
);

/** Minified bundles: one enormous line, and semantically uninteresting. */
const MINIFIED_PATTERN = /\.min\.[cm]?js$/i;

/** Snapshot files (`*.snap`): recorded output, not logic. */
const SNAPSHOT_PATTERN = /\.snap$/i;

const SHALLOW_WARNING =
  'This is a shallow clone. Commits older than the shallow boundary are not available, ' +
  'so the ancestry may look more recent than it is. Run "git fetch --unshallow" for complete history.';

const DETACHED_WARNING =
  'HEAD is detached. Ancestry is reconstructed from the commit graph rather than from a branch, ' +
  'and commits that no branch points at are shown as "(detached)".';

const UNBORN_WARNING =
  'This repository has no commits yet, so there is no history to analyse. Only the working tree exists.';

const NO_REMOTE_WARNING =
  'This repository has no "origin" remote, so Ancestry could not consider any history beyond what is stored locally.';

/**
 * Refuse a repository that exceeds the configured size ceiling.
 *
 * The refusal is a hard failure on purpose: a repository too large to scan
 * cannot produce an ancestry, and a *partial* answer for something that large
 * would misrepresent coverage (specification §6). Both the measured size and the
 * setting to raise are named, so the user can act without reading the source.
 *
 * @param info - Probed repository metadata.
 * @param limitBytes - `ancestry.git.maxRepositorySizeBytes`.
 * @throws {AncestryError} with code `REPOSITORY_TOO_LARGE`.
 */
export function enforceRepositorySizeLimit(info: RepoInfo, limitBytes: number): void {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    // A nonsensical limit is a configuration problem, not a repository problem;
    // refusing to scan anything would be a worse answer than scanning.
    return;
  }
  const size = info.worktreeSizeBytes;
  if (!Number.isFinite(size) || size <= limitBytes) {
    return;
  }
  throw new AncestryError(
    'REPOSITORY_TOO_LARGE',
    `This repository is too large to analyse: it holds about ${formatBytes(size)} of Git objects, ` +
      `and the limit is ${formatBytes(limitBytes)}. ` +
      'Raise "Ancestry: Git Max Repository Size Bytes" to analyse it anyway.',
    {
      detail:
        `measured worktreeSizeBytes=${size} against git.maxRepositorySizeBytes=${limitBytes}; ` +
        `raise ancestry.git.maxRepositorySizeBytes above ${limitBytes} to proceed`,
    },
  );
}

/**
 * Human-readable, non-fatal notes about the repository itself.
 *
 * Specification §10 is explicit that a shallow clone and a detached HEAD are
 * **warnings, not failures**: the analysis proceeds with the history available
 * and the limitation is recorded in `graph.warnings`. Only a failure to
 * establish the repository at all aborts.
 *
 * The structured fields are re-derived here rather than merely forwarding
 * `info.warnings`, so the function behaves correctly for a `RepoInfo` assembled
 * by a test or by a future non-git source. Warnings git itself already recorded —
 * currently the missing `user.name`/`user.email`, which `RepoInfo` has no
 * structured field for — are appended verbatim.
 *
 * @param info - Probed repository metadata.
 * @returns Zero or more warning strings, de-duplicated, in a stable order.
 */
export function repositoryWarnings(info: RepoInfo): string[] {
  const out: string[] = [];
  const add = (message: string): void => {
    if (message.length > 0 && !out.includes(message)) {
      out.push(message);
    }
  };

  if (info.isShallow) {
    add(SHALLOW_WARNING);
  }
  if (info.isDetachedHead) {
    add(DETACHED_WARNING);
  }
  if (info.headCommit === null) {
    add(UNBORN_WARNING);
  }
  if (info.remoteUrl === null) {
    add(NO_REMOTE_WARNING);
  }
  for (const warning of info.warnings ?? []) {
    add(warning);
  }
  return out;
}

/**
 * Cancellation and elapsed-time budget for one analysis run.
 *
 * The budget wraps an `AbortSignal` and an injected clock, and exists so that
 * every stage of the pipeline asks the *same* question the same way
 * ({@link AbortBudget.check}) and reports elapsed time the same way. No stage
 * touches `signal.aborted` directly, which is what makes "cancelled" a single
 * observable outcome rather than a race between half a dozen call sites.
 *
 * The clock is injected because `durationMs` appears in the result and in the
 * graph payload; an ambient clock would make two identical runs differ.
 */
export class AbortBudget {
  private readonly signal: AbortSignal | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;

  /**
   * @param signal - Cancellation signal, if the caller has one.
   * @param now - Injectable clock returning epoch milliseconds.
   */
  constructor(signal?: AbortSignal, now: () => number = Date.now) {
    this.signal = signal;
    this.now = now;
    this.startedAt = now();
  }

  /** The wrapped signal, for handing to APIs that take one. */
  get cancellation(): AbortSignal | undefined {
    return this.signal;
  }

  /** True once the wrapped signal has fired. */
  get aborted(): boolean {
    return this.signal?.aborted === true;
  }

  /**
   * Throw the canonical cancellation error.
   *
   * @throws {AncestryError} with code `CANCELLED` when the signal has fired.
   */
  throwIfAborted(): void {
    if (this.signal?.aborted === true) {
      throw new AncestryError('CANCELLED', 'The ancestry analysis was cancelled.', {
        detail: 'an AbortSignal passed to the analysis fired',
        cause: this.signal.reason,
      });
    }
  }

  /**
   * Non-throwing form of {@link AbortBudget.throwIfAborted}, for hot loops that
   * check every few hundred items.
   *
   * @returns `true` while the run may continue, `false` once cancelled.
   */
  check(): boolean {
    return this.signal?.aborted !== true;
  }

  /** Milliseconds since the budget was created, per the injected clock. */
  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  /**
   * Fail once the run has been going for longer than `limitMs`.
   *
   * Used for coarse guards ("do not start another 200-file sweep this late")
   * rather than as the cancellation mechanism, which is {@link AbortBudget.check}.
   *
   * @throws {AncestryError} with code `CANCELLED` when the wall-clock budget is spent.
   */
  throwIfElapsed(limitMs: number): void {
    if (Number.isFinite(limitMs) && limitMs > 0 && this.elapsedMs() > limitMs) {
      throw new AncestryError('CANCELLED', 'The ancestry analysis was cancelled.', {
        detail: `the ${limitMs}ms wall-clock budget for this stage was exceeded`,
      });
    }
  }
}

/**
 * Reconcile a configured history depth with what the repository actually has.
 *
 * The distinction matters for honesty: `limit` is what the scan should request,
 * while `truncated` says whether that request lost anything. Reporting a limit
 * that was never reached as a truncation would put a permanent "partial history"
 * banner on every small repository, and reporting a hit as complete would
 * misstate coverage.
 *
 * @param configured - `ancestry.git.maxHistoryDepth`.
 * @param available - Number of commits actually available to the scan.
 * @returns The limit to use and whether the ceiling bound the result.
 */
export function clampHistoryLimit(
  configured: number,
  available: number,
): { limit: number; truncated: boolean } {
  const wanted = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0;
  const have = Number.isFinite(available) && available > 0 ? Math.floor(available) : 0;
  if (wanted === 0) {
    return { limit: have, truncated: false };
  }
  if (have === 0) {
    return { limit: wanted, truncated: false };
  }
  return { limit: Math.min(wanted, have), truncated: have > wanted };
}

/**
 * Why a path is excluded from the search, or `null` to keep it.
 *
 * Returning a *reason* rather than a boolean is deliberate: specification §7
 * requires that a file Ancestry skipped is always visible in the report, so the
 * filter has to be able to explain itself and the caller has to be able to
 * record the explanation.
 *
 * Order is fixed so the reported reason is deterministic: build output and
 * dependencies first (they are the largest exclusion by count), then
 * machine-written files, then tests (which the user can switch back on).
 *
 * @param filePath - Repository-relative path, in either separator style.
 * @param includeTests - `ancestry.analysis.includeTests`.
 * @returns A specific reason string, or `null` when the path should be analysed.
 */
export function skipReasonForPath(filePath: string, includeTests: boolean): string | null {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return 'not a usable file path';
  }
  const posix = filePath.trim().replace(/\\/g, '/');
  const segments = posix.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return 'path resolves to nothing';
  }
  const base = segments[segments.length - 1]!;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    if (SKIPPED_DIRECTORIES.includes(segment)) {
      return describeDirectory(segment);
    }
  }
  if (SKIPPED_LOCKFILES.has(base)) {
    return 'generated lockfile';
  }
  if (MINIFIED_PATTERN.test(base)) {
    return 'minified bundle';
  }
  if (SNAPSHOT_PATTERN.test(base)) {
    return 'test snapshot file';
  }
  if (!includeTests && isTestPath(posix)) {
    return 'test or spec file (ancestry.analysis.includeTests is off)';
  }
  return null;
}

function describeDirectory(segment: string): string {
  switch (segment) {
    case '.git':
      return 'inside the Git metadata directory';
    case 'node_modules':
      return 'third-party dependency';
    case 'dist':
    case 'out':
    case 'build':
    case 'coverage':
      return `generated build output (${segment})`;
    case 'vendor':
      return 'vendored third-party code';
    case 'target':
      return 'build output (target)';
    default:
      return `excluded directory (${segment})`;
  }
}

/** Render a byte count for a user-facing message. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}
