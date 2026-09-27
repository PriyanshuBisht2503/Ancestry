/**
 * The repository facade: everything Ancestry knows how to ask Git.
 *
 * Design rules for this layer:
 *  - Every public method validates its inputs through `src/git/safety.ts` first.
 *    Validation is not the caller's job, because the values come from a user
 *    selection, a cache entry, or another module that may have its own bug.
 *  - Every failure is an `AncestryError`. A raw `Error` escaping this module
 *    would take down the extension host.
 *  - "This path/commit does not exist" is data, not an error, whenever the
 *    caller can act on it — a block that was deleted is a normal outcome for an
 *    ancestry tool, so `null`/empty results are returned instead of throwing.
 *  - Nothing here logs file content. Only paths, hashes, counts and sizes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AncestryError } from '../types';
import type {
  GitBlameResult,
  GitBranch,
  GitCommit,
  GitFileChange,
  LogOptions,
  RepoInfo,
} from '../types';
import { GitCommandError, runGit } from './exec';
import type { GitExecOptions, GitRunner } from './exec';
import { assertSafeGitPathOrNull, assertSafeRepoPath, assertSafeRevision } from './safety';
import {
  COMMIT_FORMAT_ARG,
  REF_FORMAT,
  parseBlamePorcelain,
  parseBranches,
  parseCommits,
  parseNameStatusZ,
} from './format';

/**
 * Flags prepended to every invocation. `--no-pager` keeps output deterministic
 * when a caller of ours happens to have a pager configured, `-c color.ui=false`
 * keeps ANSI escapes out of the parsers, and `-c core.quotepath=false` stops
 * Git from octal-escaping non-ASCII paths (which would break unicode fixtures
 * and, more importantly, break matching against a user's real file name).
 */
const GIT_BASE_ARGS: readonly string[] = [
  '--no-pager',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotepath=false',
];

/**
 * Default file-size ceiling, mirroring `ancestry.git.maxFileSizeBytes`.
 * Applied before any `git show` so a single multi-gigabyte blob cannot exhaust
 * the extension host.
 */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Page size used when walking history to satisfy an `until` predicate. */
const DEFAULT_PAGE_SIZE = 500;

/** Hard stop on over-fetching, so a pathological `until` cannot loop forever. */
const MAX_PAGES = 400;

/** `LogOptions` plus the one knob git supports that the shared contract omits. */
export interface AncestryLogOptions extends LogOptions {
  /** Emit oldest-first (`git log --reverse`). Useful for building a timeline. */
  reverse?: boolean;
}

function trimmedLine(value: string): string {
  return value.replace(/\s+$/, '').trim();
}

function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read a `key: value` counter out of `git count-objects -v` output.
 */
function countObjectsKiB(stdout: string, key: string): number {
  const pattern = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm');
  const match = pattern.exec(stdout);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

/**
 * True when git failed only because the repository has no commits yet.
 *
 * `git log` and `git diff-tree` both exit 128 with "does not have any commits
 * yet" / "unknown revision" on an unborn branch. That is a legitimate answer to
 * "what is in this repository's history?" — namely, nothing — so it is
 * translated into an empty result instead of an error. Any other non-zero exit
 * is a real failure and keeps its `AncestryError`.
 */
function isUnbornHistoryError(stderr: string): boolean {
  return /does not have any commits yet|unknown revision or path not in|bad revision|Needed a single revision/i.test(
    stderr,
  );
}

/** Clamp a caller-supplied 1-based line number. */
function clampLine(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(value));
}

/**
 * Number of lines in a text blob. A trailing newline terminates the last line
 * rather than starting an empty one, so it must not be counted.
 */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Read-only accessor for one Git repository.
 *
 * Instances are cheap: they hold only the root path and an optional cache, and
 * the cache is filled lazily by {@link GitRepository.refreshInfo}. The
 * constructor is private so that a `GitRepository` always refers to a directory
 * that was proven to be inside a repository.
 */
export class GitRepository {
  /** Working-tree root; also the `cwd` used for every git invocation. */
  private readonly root: string;

  /** Injected command runner, so tests can substitute their own. */
  private readonly runner: GitRunner;

  /** Populated by {@link GitRepository.refreshInfo}. */
  private infoCache: RepoInfo | null = null;

  private constructor(options: { root: string }, runner: GitRunner) {
    this.root = path.resolve(options.root);
    this.runner = runner;
  }

  /**
   * Find the repository that owns `startPath` by walking upwards.
   *
   * A candidate is any directory containing a `.git` *entry* — a directory for a
   * normal clone, a file for a linked worktree or a submodule, both of which are
   * first-class in modern git. The candidate is then confirmed with
   * `rev-parse`, which also yields the canonical top level, so a bare repository
   * (no working tree) is skipped and the search continues upward.
   *
   * @throws {AncestryError} with code `NO_GIT_REPOSITORY` when nothing is found.
   */
  static async detect(startPath: string, exec: GitRunner = runGit): Promise<GitRepository> {
    if (typeof startPath !== 'string' || startPath.trim().length === 0) {
      throw new AncestryError(
        'INVALID_PATH',
        'A file or folder is required to locate a Git repository.',
      );
    }

    const start = path.resolve(startPath);
    let directory = start;
    try {
      const stats = await fs.stat(start);
      if (!stats.isDirectory()) {
        directory = path.dirname(start);
      }
    } catch {
      // A path that does not exist still has a meaningful parent chain.
      directory = path.dirname(start);
    }

    const visited = new Set<string>();
    for (;;) {
      if (!visited.has(directory)) {
        visited.add(directory);
        const candidate = await probeCandidate(directory, exec);
        if (candidate !== null) {
          return new GitRepository({ root: candidate }, exec);
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }

    throw new AncestryError(
      'NO_GIT_REPOSITORY',
      'The selected file is not inside a Git repository.',
      {
        detail: `searched upward from ${start} without finding a working tree`,
      },
    );
  }

  /**
   * Open a repository whose root is already known.
   *
   * @throws {AncestryError} with code `NO_GIT_REPOSITORY` when `root` is not in
   *   a repository.
   */
  static async open(root: string, exec: GitRunner = runGit): Promise<GitRepository> {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new AncestryError('INVALID_PATH', 'A repository folder is required.');
    }
    const resolved = path.resolve(root);
    const candidate = await probeCandidate(resolved, exec);
    if (candidate === null) {
      throw new AncestryError(
        'NO_GIT_REPOSITORY',
        'That folder is not the root of a Git repository.',
        {
          detail: `no working tree found at ${resolved}`,
        },
      );
    }
    return new GitRepository({ root: candidate }, exec);
  }

  /**
   * Repository metadata, cached.
   *
   * Synchronous by contract, so it returns a conservative, clearly-flagged
   * placeholder until {@link GitRepository.refreshInfo} has run. Callers that
   * need real values (the analysis pipeline does) must refresh first.
   */
  get info(): RepoInfo {
    if (this.infoCache !== null) {
      return this.infoCache;
    }
    return {
      root: this.root,
      gitDir: path.join(this.root, '.git'),
      isBare: false,
      isShallow: false,
      isDetachedHead: false,
      headCommit: null,
      headBranch: null,
      branches: [],
      commitCount: null,
      worktreeSizeBytes: 0,
      remoteUrl: null,
      warnings: ['Repository information has not been loaded yet; call refreshInfo() first.'],
    };
  }

  /** The working-tree root as an absolute path. */
  getRepositoryRoot(): string {
    return this.root;
  }

  /** Re-probe the repository and replace the cached {@link info}. */
  async refreshInfo(options: GitExecOptions = {}): Promise<RepoInfo> {
    const probeOptions: GitExecOptions = { allowFailure: true, ...options, cwd: this.root };
    const run = (args: string[]): Promise<string> =>
      this.runner([...GIT_BASE_ARGS, ...args], probeOptions).then((result) =>
        result.exitCode === 0 ? result.stdout : '',
      );

    // Independent probes, issued together: eleven sequential 20 ms spawns would
    // be visible in the extension host's UI responsiveness budget.
    const [
      topLevel,
      gitDir,
      isBare,
      insideWorkTree,
      head,
      headRef,
      shallow,
      count,
      remote,
      refs,
      objects,
      userName,
      userEmail,
    ] = await Promise.all([
      run(['rev-parse', '--show-toplevel']),
      run(['rev-parse', '--absolute-git-dir']),
      run(['rev-parse', '--is-bare-repository']),
      run(['rev-parse', '--is-inside-work-tree']),
      run(['rev-parse', '--verify', 'HEAD']),
      run(['symbolic-ref', '--short', '-q', 'HEAD']),
      run(['rev-parse', '--is-shallow-repository']),
      run(['rev-list', '--count', 'HEAD']),
      run(['remote', 'get-url', 'origin']),
      run(['for-each-ref', '--format=' + REF_FORMAT, 'refs/heads', 'refs/remotes']),
      run(['count-objects', '-v']),
      run(['config', '--get', 'user.name']),
      run(['config', '--get', 'user.email']),
    ]);

    const topLevelPath = trimmedLine(topLevel);
    const root = topLevelPath.length > 0 ? path.resolve(topLevelPath) : this.root;
    const headCommit = trimmedLine(head).length > 0 ? trimmedLine(head) : null;
    const headBranch = trimmedLine(headRef).length > 0 ? trimmedLine(headRef) : null;
    const isShallow = trimmedLine(shallow) === 'true';
    const warnings: string[] = [];

    if (isShallow) {
      warnings.push(
        'This is a shallow clone. Commits older than the shallow boundary are not available, ' +
          'so ancestry may look more recent than it is.',
      );
    }
    if (headRef.trim().length === 0) {
      warnings.push(
        'HEAD is detached. Ancestry is reconstructed from the commit graph rather than from a branch, ' +
          'and no branch filter will be applied.',
      );
    }
    if (headCommit === null) {
      warnings.push('This repository has no commits yet, so there is no history to analyse.');
    }
    if (trimmedLine(userName).length === 0 || trimmedLine(userEmail).length === 0) {
      warnings.push(
        'git user.name and/or user.email are not configured for this repository; ' +
          'commit authorship shown in the graph may be incomplete.',
      );
    }

    const info: RepoInfo = {
      root,
      gitDir: trimmedLine(gitDir).length > 0 ? trimmedLine(gitDir) : path.join(root, '.git'),
      isBare: trimmedLine(isBare) === 'true' || trimmedLine(insideWorkTree) === 'false',
      isShallow,
      isDetachedHead: headRef.trim().length === 0,
      headCommit,
      headBranch,
      branches: parseBranches(refs, headBranch),
      commitCount: parseIntOrNull(count),
      // `count-objects` reports KiB; loose and packed objects are disjoint.
      worktreeSizeBytes:
        (countObjectsKiB(objects, 'size-pack') + countObjectsKiB(objects, 'size')) * 1024,
      remoteUrl: trimmedLine(remote).length > 0 ? trimmedLine(remote) : null,
      warnings,
    };

    this.infoCache = info;
    return info;
  }

  /** The commit HEAD points at, or `null` for an unborn branch. */
  async getCurrentCommit(): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', 'HEAD']);
    if (result.exitCode !== 0) {
      return null;
    }
    const commit = trimmedLine(result.stdout);
    return commit.length > 0 ? commit : null;
  }

  /** The checked-out branch, or `null` when HEAD is detached. */
  async getHeadBranch(): Promise<string | null> {
    const result = await this.git(['symbolic-ref', '--short', '-q', 'HEAD']);
    if (result.exitCode !== 0) {
      return null;
    }
    const branch = trimmedLine(result.stdout);
    return branch.length > 0 ? branch : null;
  }

  /** All local and remote-tracking branches, with the current one flagged. */
  async getBranches(): Promise<GitBranch[]> {
    const result = await this.git([
      'for-each-ref',
      '--format=' + REF_FORMAT,
      'refs/heads',
      'refs/remotes',
    ]);
    return parseBranches(result.stdout, await this.getHeadBranch());
  }

  /**
   * Walk the commit history.
   *
   * `--topo-order` is used so parents are never emitted before their children;
   * with equal commit timestamps (common in imported history, and unavoidable in
   * tests) date order is ambiguous, and an ancestry graph built on it would
   * report the same repository differently on two machines.
   *
   * `--follow` (which makes `git log` walk renames) requires exactly one
   * pathspec and is therefore mutually exclusive with `--all`; asking for both
   * yields rename-following history from HEAD only.
   *
   * `options.until` is evaluated as a *stop* predicate: the commit that
   * satisfies it is the boundary and is not included. Because git cannot
   * evaluate a JavaScript predicate, the scan pages with `--skip` and stops as
   * soon as the predicate matches.
   */
  async getCommitHistory(options: AncestryLogOptions = {}): Promise<GitCommit[]> {
    const baseArgs = ['log', '--no-color', '--topo-order'];
    if (options.includeAllBranches) {
      baseArgs.push('--all');
    }
    if (options.reverse) {
      baseArgs.push('--reverse');
    }
    baseArgs.push(COMMIT_FORMAT_ARG);

    const follow = options.followRenames === true && typeof options.path === 'string';
    if (follow) {
      baseArgs.push('--follow');
    }

    const since = options.since === undefined ? 'HEAD' : assertSafeRevision(options.since);
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit));
    const skip = options.skip === undefined ? 0 : Math.max(0, Math.trunc(options.skip));
    const until = options.until;

    const pathArgs = (): string[] =>
      typeof options.path === 'string' ? ['--', assertSafeRepoPath(options.path)] : [];

    // One fetch per page, and "no history yet" is an answer, not a failure.
    const fetchPage = async (args: string[]): Promise<GitCommit[]> => {
      const result = await this.git(args, { allowFailure: true, signal: options.signal });
      if (result.exitCode !== 0) {
        if (isUnbornHistoryError(result.stderr)) {
          return [];
        }
        throw new GitCommandError(
          `git ${args.join(' ')}`,
          'could not walk history',
          result.stderr,
          result.exitCode,
          result.durationMs,
        );
      }
      return parseCommits(result.stdout);
    };

    if (!until) {
      const args = [...baseArgs, since];
      if (limit !== undefined) {
        args.push(`--max-count=${limit}`);
      }
      if (skip > 0) {
        args.push(`--skip=${skip}`);
      }
      args.push(...pathArgs());
      return fetchPage(args);
    }

    const pageSize =
      limit !== undefined && limit > 0 ? Math.min(limit, DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    const collected: GitCommit[] = [];
    let offset = skip;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const args = [
        ...baseArgs,
        since,
        `--max-count=${pageSize}`,
        `--skip=${offset}`,
        ...pathArgs(),
      ];
      const commits = await fetchPage(args);
      if (commits.length === 0) {
        break;
      }
      offset += commits.length;

      let stop = false;
      for (const commit of commits) {
        if (until(commit)) {
          stop = true;
          break;
        }
        collected.push(commit);
        if (limit !== undefined && collected.length >= limit) {
          stop = true;
          break;
        }
      }
      if (stop) {
        break;
      }
      if (commits.length < pageSize) {
        break;
      }
    }

    return limit !== undefined ? collected.slice(0, limit) : collected;
  }

  /**
   * A single commit, by any revision git understands.
   *
   * @throws {AncestryError} with code `NO_MATCHES` when the revision is unknown.
   */
  async getCommit(hash: string): Promise<GitCommit> {
    const rev = assertSafeRevision(hash);
    const result = await this.git(['log', '--no-color', '-1', COMMIT_FORMAT_ARG, rev], {
      allowFailure: true,
    });
    const commits = parseCommits(result.stdout);
    const commit = commits[0];
    if (commit === undefined) {
      throw new AncestryError('NO_MATCHES', 'That commit does not exist in this repository.', {
        detail: `revision ${rev} produced no commit (git exit ${result.exitCode})`,
      });
    }
    return commit;
  }

  /**
   * The text of `filePath` at `commit`, or `null` when the path does not exist
   * there (a block introduced later, or deleted earlier).
   *
   * @throws {AncestryError} with code `FILE_TOO_LARGE` when the blob exceeds
   *   {@link DEFAULT_MAX_FILE_BYTES}.
   */
  getFileAtCommit(commit: string, filePath: string): Promise<string | null> {
    return this.getFileTextAtCommit(commit, filePath, DEFAULT_MAX_FILE_BYTES);
  }

  /**
   * The text of `filePath` at `commit`, refusing blobs larger than `maxBytes`.
   *
   * The size is probed with `cat-file -s` *before* the blob is read, so an
   * oversized file costs one small round trip instead of its full transfer into
   * the extension host.
   *
   * @returns `null` when the path is absent at that commit.
   * @throws {AncestryError} with code `FILE_TOO_LARGE` when the blob is too big.
   */
  async getFileTextAtCommit(
    commit: string,
    filePath: string,
    maxBytes: number,
  ): Promise<string | null> {
    const rev = assertSafeRevision(commit);
    const safePath = assertSafeRepoPath(filePath);
    return this.showFile(rev, safePath, maxBytes);
  }

  /**
   * Files changed by `commit`.
   *
   * Compared against the first parent, and `--root` makes the first commit in
   * a repository report its whole tree; without it `diff-tree` prints nothing
   * for a root commit and Ancestry would silently lose the origin of every
   * repository.
   *
   * `-m --first-parent` is what makes a *merge* answerable: by default
   * `diff-tree` prints nothing at all for a merge commit, which would read as
   * "the merge changed nothing". For a single-parent commit both flags are
   * no-ops, so one code path serves every commit.
   */
  async getChangedFiles(commit: string): Promise<GitFileChange[]> {
    const rev = assertSafeRevision(commit);
    const result = await this.git(
      [
        'diff-tree',
        '-r',
        '-M',
        '-C',
        '--root',
        '-m',
        '--first-parent',
        '--name-status',
        '--no-commit-id',
        '-z',
        rev,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 && isUnbornHistoryError(result.stderr)) {
      return [];
    }
    if (result.exitCode !== 0) {
      throw new GitCommandError(
        `git diff-tree ${rev}`,
        'could not read the file changes',
        result.stderr,
        result.exitCode,
        result.durationMs,
      );
    }
    return parseNameStatusZ(result.stdout);
  }

  /**
   * History of one path.
   *
   * Accepts either `(filePath, options)` or a ready-made options object, because
   * call sites usually already hold a `LogOptions` with a `path` field and
   * copying it out is pure noise.
   */
  async getFileHistory(
    filePathOrOptions: string | AncestryLogOptions,
    options: AncestryLogOptions = {},
  ): Promise<GitCommit[]> {
    const merged: AncestryLogOptions =
      typeof filePathOrOptions === 'string'
        ? { ...options, path: filePathOrOptions }
        : { ...filePathOrOptions };
    const safePath = assertSafeGitPathOrNull(merged.path);
    if (safePath === null) {
      throw new AncestryError('INVALID_PATH', 'A file path is required to walk file history.');
    }
    return this.getCommitHistory({ ...merged, path: safePath });
  }

  /** Every path in the tree at `commit`, in git's own (sorted) order. */
  async getAllFilesAtCommit(commit: string): Promise<string[]> {
    const rev = assertSafeRevision(commit);
    const result = await this.git(['ls-tree', '-r', '--name-only', '-z', rev], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      // An unborn HEAD, or a commit that is not a tree: "nothing there" is the
      // answer, not a failure.
      return [];
    }
    return result.stdout
      .split('\u0000')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\\/g, '/'));
  }

  /**
   * Attribute lines of `filePath` at `commit` to their authors.
   *
   * `startLine`/`endLine` are 1-based and inclusive, and are clamped to the
   * file; when the path is absent the result is empty rather than an error,
   * because "this file did not exist yet" is a normal answer during a history
   * scan.
   */
  async getBlame(
    commit: string,
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<GitBlameResult> {
    const rev = assertSafeRevision(commit);
    const safePath = assertSafeRepoPath(filePath);
    const empty: GitBlameResult = {
      filePath: safePath,
      commit: rev,
      lines: [],
      authorLineCounts: [],
    };

    const size = await this.getObjectSize(rev, safePath);
    if (size === null) {
      return empty;
    }
    if (size > DEFAULT_MAX_FILE_BYTES) {
      throw new AncestryError('FILE_TOO_LARGE', 'That file is too large to blame.', {
        detail: `${safePath} at ${rev} is ${size} bytes`,
      });
    }

    const args = ['blame', '--porcelain', rev, '--', safePath];
    if (startLine !== undefined || endLine !== undefined) {
      const text = await this.showFile(rev, safePath, DEFAULT_MAX_FILE_BYTES);
      if (text === null) {
        return empty;
      }
      const lineCount = countLines(text);
      if (lineCount === 0) {
        return empty;
      }
      const first = clampLine(startLine, 1, 1);
      const last = clampLine(endLine, lineCount, first);
      if (last < first) {
        return empty;
      }
      // The range is injected before the `--` separator so git cannot mistake
      // it for a path; the path itself is validated and sits after the `--`.
      args.splice(2, 0, '-L', `${first},${Math.min(last, lineCount)}`);
    }

    const result = await this.git(args, { allowFailure: true });
    if (result.exitCode !== 0) {
      // Git refuses to blame some states (an empty file, a range that starts
      // past EOF on some versions). An empty attribution is the safe answer:
      // claiming a line belongs to nobody is better than claiming the wrong one.
      return empty;
    }
    return parseBlamePorcelain(result.stdout, safePath, rev);
  }

  /** Best common ancestor of two revisions, or `null` when unrelated. */
  async getMergeBase(a: string, b: string): Promise<string | null> {
    const left = assertSafeRevision(a);
    const right = assertSafeRevision(b);
    const result = await this.git(['merge-base', left, right], { allowFailure: true });
    if (result.exitCode !== 0) {
      return null;
    }
    const base = trimmedLine(result.stdout);
    return base.length > 0 ? base : null;
  }

  /** The first parent of a commit, or `null` for a root commit. */
  async getFirstParent(hash: string): Promise<string | null> {
    const rev = assertSafeRevision(hash);
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${rev}^1`], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const parent = trimmedLine(result.stdout);
    return parent.length > 0 ? parent : null;
  }

  /** Files changed by `commit`, reporting renames and copies at 50 % similarity. */
  async findRenames(commit: string): Promise<GitFileChange[]> {
    const rev = assertSafeRevision(commit);
    const result = await this.git(
      [
        'diff-tree',
        '-r',
        '-M50%',
        '-C50%',
        '--root',
        '-m',
        '--first-parent',
        '--name-status',
        '--no-commit-id',
        '-z',
        rev,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 && isUnbornHistoryError(result.stderr)) {
      return [];
    }
    if (result.exitCode !== 0) {
      throw new GitCommandError(
        `git diff-tree ${rev}`,
        'could not read the file changes',
        result.stderr,
        result.exitCode,
        result.durationMs,
      );
    }
    return parseNameStatusZ(result.stdout);
  }

  /**
   * Paths touched between two commits — the primitive that makes an incremental
   * re-index cheap.
   *
   * Renames contribute *both* the old and the new path. An incremental scan that
   * only saw the destination would keep a stale entry for the deleted source
   * file forever.
   */
  async getChangedFilesSince(from: string, to = 'HEAD'): Promise<string[]> {
    const left = assertSafeRevision(from);
    const right = assertSafeRevision(to);
    const result = await this.git(['diff', '--name-status', '-M', '-z', left, right, '--'], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      if (isUnbornHistoryError(result.stderr)) {
        return [];
      }
      throw new GitCommandError(
        `git diff ${left} ${right}`,
        'could not diff the two revisions',
        result.stderr,
        result.exitCode,
        result.durationMs,
      );
    }
    const paths: string[] = [];
    for (const change of parseNameStatusZ(result.stdout)) {
      if (change.oldPath !== null) {
        paths.push(change.oldPath);
      }
      paths.push(change.path);
    }
    return Array.from(new Set(paths));
  }

  /** Whether `filePath` is present in the index or the working tree. */
  async isPathTracked(filePath: string): Promise<boolean> {
    const safePath = assertSafeRepoPath(filePath);
    const result = await this.git(['ls-files', '-z', '--', safePath], { allowFailure: true });
    return (
      result.exitCode === 0 &&
      result.stdout.split('\u0000').some((entry) => entry.trim().length > 0)
    );
  }

  /** Whether the working tree differs from the index for `filePath`. */
  async isDirty(filePath: string): Promise<boolean> {
    const safePath = assertSafeRepoPath(filePath);
    const result = await this.git(['status', '--porcelain', '-z', '--', safePath]);
    return result.stdout.length > 0;
  }

  /**
   * Size in bytes of `commit:filePath`, or `null` when the path is absent.
   *
   * Used as a cheap guard before any blob is transferred into this process.
   */
  async getObjectSize(commit: string, filePath: string): Promise<number | null> {
    const rev = assertSafeRevision(commit);
    const safePath = assertSafeRepoPath(filePath);
    const result = await this.git(['cat-file', '-s', `${rev}:${safePath}`], { allowFailure: true });
    if (result.exitCode !== 0) {
      return null;
    }
    return parseIntOrNull(result.stdout);
  }

  /** Tag names, sorted by git. */
  async listTags(): Promise<string[]> {
    const result = await this.git(['tag', '--list']);
    return result.stdout
      .split('\n')
      .map((line) => trimmedLine(line))
      .filter((line) => line.length > 0);
  }

  /** The commit a ref points at, or `null` when the ref does not exist. */
  async getRefHash(ref: string): Promise<string | null> {
    const safeRef = assertSafeRevision(ref);
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${safeRef}^{commit}`], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const hash = trimmedLine(result.stdout);
    return hash.length > 0 ? hash : null;
  }

  /** Drop every cached value. The instance stays usable. */
  dispose(): void {
    this.infoCache = null;
  }

  /**
   * Read a blob at a known-good revision, with the size safeguard applied first.
   *
   * `cat-file -s` costs one small round trip and tells us both whether the path
   * exists and whether it is safe to read, so an oversized or absent file never
   * gets a chance to allocate its own size in memory.
   *
   * @returns `null` when the path is absent at `rev`.
   */
  private async showFile(rev: string, safePath: string, maxBytes: number): Promise<string | null> {
    const size = await this.getObjectSize(rev, safePath);
    if (size === null) {
      return null;
    }
    if (size > maxBytes) {
      throw new AncestryError(
        'FILE_TOO_LARGE',
        'That file is too large to analyse at this commit.',
        {
          detail: `${safePath} at ${rev} is ${size} bytes, limit is ${maxBytes}`,
        },
      );
    }

    const result = await this.git(['show', `${rev}:${safePath}`], { allowFailure: true });
    if (result.exitCode === 0) {
      return result.stdout;
    }
    // The size probe already proved the object exists, so a failure here is a
    // real git problem and must not be disguised as "file not there".
    throw new GitCommandError(
      `git show ${rev}:${safePath}`,
      'could not read blob',
      result.stderr,
      result.exitCode,
      result.durationMs,
    );
  }

  /**
   * Single funnel for every git invocation, so the cwd, the base flags and the
   * sanitised environment are guaranteed to apply uniformly.
   */
  private git(args: string[], options: GitExecOptions = {}): ReturnType<GitRunner> {
    return this.runner([...GIT_BASE_ARGS, ...args], { cwd: this.root, ...options });
  }
}

/**
 * Confirm that `directory` belongs to a working tree and return the canonical
 * top level. Returns `null` for "not a working tree here", which lets the caller
 * keep walking upward past a nested `.git` that is not usable.
 */
async function probeCandidate(directory: string, exec: GitRunner): Promise<string | null> {
  const dotGit = path.join(directory, '.git');
  let hasGitEntry = false;
  try {
    await fs.stat(dotGit);
    hasGitEntry = true;
  } catch {
    hasGitEntry = false;
  }
  if (!hasGitEntry) {
    return null;
  }

  let result;
  try {
    result = await exec(
      [...GIT_BASE_ARGS, 'rev-parse', '--show-toplevel', '--is-inside-work-tree'],
      { cwd: directory, allowFailure: true },
    );
  } catch {
    // A probe that cannot even start (no git binary) is not a reason to keep
    // walking; let the real command surface GIT_NOT_FOUND.
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }

  const [topLevel, insideWorkTree] = result.stdout.split('\n');
  if (trimmedLine(insideWorkTree ?? '') !== 'true') {
    // A bare repository: no working tree, so nothing for Ancestry to read.
    return null;
  }
  const resolved = trimmedLine(topLevel ?? '');
  return resolved.length > 0 ? path.resolve(resolved) : directory;
}
