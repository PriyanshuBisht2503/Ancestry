/**
 * Branch attribution: which branches contain a given commit.
 *
 * The graph's Y axis is one row per branch (specification §6.1), and a node
 * whose commit no branch points at renders as `(detached)`. Answering that per
 * node is the only place in the pipeline where an obvious implementation is
 * quadratic in *git process spawns*, so the cost model is spelled out here
 * rather than left to a reader to discover.
 *
 * ## Why not one `merge-base` call per (commit × branch)
 *
 * `git merge-base --is-ancestor <commit> <tip>` is the right primitive — it is
 * exact, it is O(1) in the repository's size, and it needs no enumeration. It is
 * also, used naively, `C × B` child processes: 2 000 commits × 50 branches is
 * 100 000 spawns, which is minutes of wall clock and would make the extension
 * look hung. Ancestry therefore bounds the sweep in four ways, all of which
 * must hold for a lookup to cost a process spawn:
 *
 *  1. **Branch cap.** At most {@link DEFAULT_MAX_PROBED_BRANCHES} branches are
 *     ever probed. A repository with more is reported through
 *     {@link BranchIndex.warnings} rather than silently truncated.
 *  2. **Tip shortcut.** A commit that *is* a probed branch's tip is answered
 *     from the pre-computed tip table: zero spawns.
 *  3. **Work-list bound.** Attribution is resolved for an explicit work list
 *     ({@link BranchIndex.prime}) and only for commits that reached the graph —
 *     one per *accepted candidate*, which is bounded by `maxBlocksTotal`, not by
 *     the number of blocks parsed. A 200-node graph on 3 branches is at most
 *     600 probes; a 200-node graph on 50 branches is at most the cap.
 *  4. **Total work-list cap.** {@link BranchIndex.MAX_PRIMED_COMMITS} bounds the
 *     work list itself, so a pathological repository cannot turn one stage into
 *     an unbounded fan-out even with the caps above.
 *
 * Every answer is memoised for the engine's lifetime, so the second lookup of a
 * commit — and every repeat of a whole phase — costs nothing. The cap on the
 * branch count is what makes the bound *reproducible*: the probed set is the
 * first N branches in a fixed sort, so two runs of the same analysis probe the
 * same branches and produce the same graph.
 *
 * Concurrency is bounded ({@link DEFAULT_PROBE_CONCURRENCY}) because 600
 * simultaneous `git` children would thrash. The *result* does not depend on the
 * interleaving: `branchesFor` returns a sorted set derived from a per-branch
 * verdict, not from completion order.
 *
 * @module analysis/branchIndex
 */

import { GitRepository, parseBranches, runGit } from '../git';
import type { GitRunner } from '../git';
import { REF_FORMAT } from '../git/format';
import type { Logger } from '../logger';

/**
 * Default ceiling on distinct branches probed per commit.
 *
 * 50 is chosen to cover "every branch a human could plausibly want on a Y
 * axis" (typically far fewer) while making the worst case
 * `primed commits × 50` probes, which is bounded and reported.
 */
export const DEFAULT_MAX_PROBED_BRANCHES = 50;

/** Default number of `git` children allowed to run at once. */
export const DEFAULT_PROBE_CONCURRENCY = 8;

/** Tunables for {@link BranchIndex}. All fields are optional. */
export interface BranchIndexOptions {
  /** Branches probed per commit. Defaults to {@link DEFAULT_MAX_PROBED_BRANCHES}. */
  maxBranches?: number;
  /** Upper bound on the number of distinct commits {@link BranchIndex.prime} resolves. */
  maxPrimedCommits?: number;
  /** Simultaneous `git` children. Defaults to {@link DEFAULT_PROBE_CONCURRENCY}. */
  concurrency?: number;
  /**
   * Command runner, injectable so tests can count invocations. Defaults to
   * {@link runGit}, which is the same runner `GitRepository` uses.
   */
  runner?: GitRunner;
  /** Optional logger. Only counts and names are ever written to it. */
  logger?: Logger;
}

/** A branch and the commit it points at. */
export interface BranchTip {
  branch: string;
  tip: string;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Memoised commit → branch attribution for one repository.
 *
 * Synchronous by design for the read side: {@link BranchIndex.branchesFor} is on
 * the hot path of graph assembly and must not return a promise, because the
 * graph builder's contract is a pure synchronous function of its input. The
 * asynchronous work therefore happens up front in {@link BranchIndex.prime},
 * which the similarity stage calls before it needs branch names.
 *
 * Instances hold no open handles; {@link BranchIndex.dispose} only drops the
 * memo tables so a long-lived engine does not retain every commit it ever saw.
 */
export class BranchIndex {
  /** Hard ceiling on the {@link BranchIndex.prime} work list. */
  static readonly MAX_PRIMED_COMMITS = 2048;

  private readonly cwd: string;
  private readonly runner: GitRunner;
  private readonly maxBranches: number;
  private readonly maxPrimedCommits: number;
  private readonly concurrency: number;
  private readonly logger: Logger | undefined;

  /** Probed branches, sorted, capped. Empty until the first access. */
  private branches: BranchTip[] | null = null;
  /** In-flight or completed branch listing, so concurrent callers share it. */
  private listing: Promise<BranchTip[]> | null = null;

  /** `commit hash` → the branches that point exactly at it. */
  private readonly tipOwners = new Map<string, string[]>();

  /** `commit hash` → every branch containing it. The memo table. */
  private readonly attribution = new Map<string, string[]>();

  /** `commit hash` → `branch` → contained. Per-probe memo, so a shared ancestor is probed once. */
  private readonly probes = new Map<string, Map<string, boolean>>();

  private readonly notes: string[] = [];
  /** Number of `merge-base` probes actually issued; the cost the caps bound. */
  private probesIssued = 0;
  private disposed = false;

  /**
   * @param repo - The repository whose refs are attributed. Only its working-tree
   *   root is used, so every git invocation below goes through the injectable
   *   runner and stays observable.
   * @param options - Caps, concurrency, runner and logger.
   */
  constructor(repo: GitRepository, options: BranchIndexOptions = {}) {
    this.cwd = repo.getRepositoryRoot();
    this.runner = options.runner ?? runGit;
    this.maxBranches = positive(options.maxBranches, DEFAULT_MAX_PROBED_BRANCHES);
    this.maxPrimedCommits = positive(options.maxPrimedCommits, BranchIndex.MAX_PRIMED_COMMITS);
    this.concurrency = positive(options.concurrency, DEFAULT_PROBE_CONCURRENCY);
    this.logger = options.logger;
  }

  /**
   * Resolve branch attribution for `commits`, so that later
   * {@link BranchIndex.branchesFor} calls are free.
   *
   * Idempotent and order-insensitive: a commit already in the memo is skipped,
   * as is a commit that is a probed branch's tip. Safe to call repeatedly and
   * concurrently; the in-flight probes are shared.
   *
   * Never throws for a git failure. A probe that cannot be answered is treated
   * as "not contained", which keeps the graph renderable and costs one warning
   * rather than aborting an analysis over a cosmetic axis (specification §10).
   *
   * @param commits - Commit hashes whose attribution is wanted.
   * @returns The number of commits that required at least one `git` probe.
   */
  async prime(commits: readonly string[]): Promise<number> {
    if (this.disposed) {
      return 0;
    }
    const tips = await this.listTips();
    if (tips.length === 0) {
      return 0;
    }

    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const commit of commits) {
      if (typeof commit !== 'string' || commit.length === 0) {
        continue;
      }
      if (seen.has(commit) || this.attribution.has(commit) || this.tipOwners.has(commit)) {
        continue;
      }
      seen.add(commit);
      wanted.push(commit);
    }
    // Deterministic order: a run must probe the same commits in the same order
    // even when the caller assembled the list from a Map.
    wanted.sort();
    if (wanted.length > this.maxPrimedCommits) {
      this.note(
        `branch attribution was limited to the first ${this.maxPrimedCommits} of ${wanted.length} commits; ` +
          'nodes on the remaining commits are shown without a branch',
      );
      wanted.length = this.maxPrimedCommits;
    }
    if (wanted.length === 0) {
      return 0;
    }

    const work: Array<{ commit: string; tip: BranchTip }> = [];
    for (const commit of wanted) {
      for (const tip of tips) {
        work.push({ commit, tip });
      }
    }
    await this.runPool(work, async (item) => {
      const contained = await this.probe(item.commit, item.tip);
      this.record(item.commit, item.tip.branch, contained);
    });

    for (const commit of wanted) {
      this.finalise(commit);
    }
    this.logger?.debug(
      `ancestry analysis: attributed ${wanted.length} commit(s) across ${tips.length} branch(es) ` +
        `in ${this.probeCount} git probe(s)`,
    );
    return wanted.length;
  }

  /**
   * Branches containing `commit`, sorted, or `[]` when none is known.
   *
   * A commit that has not been through {@link BranchIndex.prime} and is not a
   * branch tip yields `[]`; the graph renders that as `(detached)`
   * (specification §6.1), which is the honest answer for "we did not ask".
   */
  branchesFor(commit: string): string[] {
    if (this.disposed || typeof commit !== 'string' || commit.length === 0) {
      return [];
    }
    const memo = this.attribution.get(commit);
    if (memo !== undefined) {
      return memo;
    }
    const tips = this.tipOwners.get(commit);
    return tips === undefined ? [] : tips;
  }

  /**
   * The probed branch names, sorted and capped.
   *
   * Synchronous: it returns whatever is already known, and an empty list before
   * the first {@link BranchIndex.prime}. Callers that need the real list await
   * {@link BranchIndex.branchTips} instead.
   */
  listBranches(): string[] {
    if (this.branches === null) {
      return [];
    }
    return this.branches.map((entry) => entry.branch);
  }

  /**
   * The probed branches with their tips, sorted by branch name.
   *
   * @returns One entry per probed branch. Empty when there is no branch at all
   *   (an unborn HEAD, for instance).
   */
  async branchTips(): Promise<BranchTip[]> {
    return this.listTips();
  }

  /** The commit a probed branch points at, or `null` for an unknown branch. */
  tipOf(branch: string): string | null {
    if (this.branches === null) {
      return null;
    }
    return this.branches.find((entry) => entry.branch === branch)?.tip ?? null;
  }

  /**
   * Non-fatal notes raised while building the index, in a stable order.
   *
   * Currently: the branch cap biting, and the prime work-list cap biting. Both
   * describe a *narrowed* attribution, which the UI must be able to state.
   */
  warnings(): string[] {
    return [...this.notes];
  }

  /** Total `git` probes issued, for diagnostics and for the memoisation test. */
  get probeCount(): number {
    return this.probesIssued;
  }

  /** Drop the memo tables. No handles are held, so this cannot hang or throw. */
  dispose(): void {
    this.disposed = true;
    this.branches = null;
    this.listing = null;
    this.tipOwners.clear();
    this.attribution.clear();
    this.probes.clear();
  }

  // -------------------------------------------------------------------------
  // Branch listing
  // -------------------------------------------------------------------------

  /**
   * List, filter and cap the branches, once.
   *
   * `GitRepository.getBranches()` would answer this too, but going through the
   * injectable runner keeps *every* git invocation of the analysis under one
   * observable seam, which is what makes the memoisation guarantee testable
   * rather than merely asserted in a comment.
   */
  private async listTips(): Promise<BranchTip[]> {
    if (this.branches !== null) {
      return this.branches;
    }
    if (this.listing !== null) {
      return this.listing;
    }
    this.listing = (async () => {
      let names: BranchTip[] = [];
      try {
        const result = await this.runner(
          [
            '--no-pager',
            '-c',
            'color.ui=false',
            'for-each-ref',
            `--format=${REF_FORMAT}`,
            'refs/heads',
          ],
          { cwd: this.cwd, allowFailure: true },
        );
        if (result.exitCode === 0) {
          names = parseBranches(result.stdout, null)
            .filter((branch) => !branch.isRemote)
            .map((branch) => ({ branch: branch.name, tip: branch.tip }))
            .filter((entry) => entry.branch.length > 0 && entry.tip.length > 0)
            .sort((left, right) =>
              left.branch < right.branch ? -1 : left.branch > right.branch ? 1 : 0,
            );
        }
      } catch (error) {
        this.note(
          `branches could not be listed (${describe(error)}); every node is shown without a branch`,
        );
        names = [];
      }

      if (names.length > this.maxBranches) {
        this.note(
          `this repository has ${names.length} branches; only the first ${this.maxBranches} ` +
            '(in name order) are used to attribute commits to a branch',
        );
        names = names.slice(0, this.maxBranches);
      }

      this.branches = names;
      for (const entry of names) {
        const owners = this.tipOwners.get(entry.tip);
        if (owners === undefined) {
          this.tipOwners.set(entry.tip, [entry.branch]);
        } else {
          owners.push(entry.branch);
          owners.sort();
        }
      }
      this.listing = null;
      return names;
    })();
    return this.listing;
  }

  // -------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------

  /** `git merge-base --is-ancestor`; exit code 0 means "contained". */
  private async probe(commit: string, tip: BranchTip): Promise<boolean> {
    const perCommit = this.probes.get(commit);
    const cached = perCommit?.get(tip.branch);
    if (cached !== undefined) {
      return cached;
    }
    let contained = false;
    try {
      const result = await this.runner(
        ['--no-pager', '-c', 'color.ui=false', 'merge-base', '--is-ancestor', commit, tip.tip],
        { cwd: this.cwd, allowFailure: true },
      );
      contained = result.exitCode === 0;
    } catch (error) {
      this.logger?.debug(
        `ancestry analysis: merge-base probe for ${commit.slice(0, 12)} against ` +
          `${tip.branch} failed (${describe(error)}); treating it as not contained`,
      );
      contained = false;
    }
    if (perCommit === undefined) {
      this.probes.set(commit, new Map([[tip.branch, contained]]));
    } else {
      perCommit.set(tip.branch, contained);
    }
    this.probesIssued += 1;
    return contained;
  }

  private record(commit: string, branch: string, contained: boolean): void {
    if (!contained) {
      return;
    }
    const current = this.attribution.get(commit);
    if (current === undefined) {
      this.attribution.set(commit, [branch]);
      return;
    }
    if (!current.includes(branch)) {
      current.push(branch);
      current.sort();
    }
  }

  private finalise(commit: string): void {
    const branches = this.attribution.get(commit) ?? [];
    this.attribution.set(commit, branches);
  }

  /** Run `work` with at most `concurrency` in flight, preserving nothing about order. */
  private async runPool(
    work: ReadonlyArray<{ commit: string; tip: BranchTip }>,
    run: (item: { commit: string; tip: BranchTip }) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const workers: Array<Promise<void>> = [];
    const width = Math.max(1, Math.min(this.concurrency, work.length));
    for (let i = 0; i < width; i += 1) {
      workers.push(
        (async () => {
          for (;;) {
            const index = next;
            next += 1;
            const item = work[index];
            if (item === undefined) {
              return;
            }
            await run(item);
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  private note(message: string): void {
    if (!this.notes.includes(message)) {
      this.notes.push(message);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}

/**
 * True when `args` is a branch-containment probe issued by {@link BranchIndex}.
 *
 * Exported so a test can count probes without depending on the exact argv
 * layout, which is an implementation detail of the git layer.
 */
export function isAncestryProbe(args: readonly string[]): boolean {
  return args.includes('--is-ancestor') && args.includes('merge-base');
}
