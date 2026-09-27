/**
 * Scaffolding for the analysis tests.
 *
 * Every helper drives the real `git` binary against a throwaway repository, so
 * the tests exercise the same code path the extension does. Nothing here is
 * imported from `tests/git` — the analysis suite owns its own builders so a
 * change to the git suite's fixtures cannot silently change what "an interesting
 * repository" means here.
 *
 * Determinism is the whole point. Author and committer identity, the default
 * branch name, line endings, signing, hooks and commit timestamps are all pinned,
 * because ancestry assertions depend on ordering and must not depend on the
 * machine's clock, its global git config, or its user templates.
 *
 * The scenario repository is built here too, so `scenarios.test.ts` and the rest
 * of the suite agree on what a "renamed copy" or a "modified copy" is.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCacheStore } from '../../src/cache';
import { runGit } from '../../src/git/exec';
import type { GitExecResult } from '../../src/git/exec';
import type { GitPerson, ICacheStore } from '../../src/types';

/** A throwaway repository on disk. */
export interface TempRepo {
  /** Absolute path to the repository working tree. */
  dir: string;
}

/** Either shape is accepted, so a helper can also take a bare path. */
export type RepoLike = TempRepo | string;

function dirOf(repo: RepoLike): string {
  return typeof repo === 'string' ? repo : repo.dir;
}

/**
 * Base instant for the pinned clock: 2020-01-01T00:00:00Z.
 *
 * Far enough in the past that no commit can collide with a repository that was
 * genuinely created today, and fixed so two runs of the same test produce the
 * same author timestamps.
 */
const BASE_TIME_MS = Date.UTC(2020, 0, 1, 0, 0, 0);

/** Each commit advances one minute, so two commits never share a timestamp. */
const CLOCK_STEP_MS = 60_000;

const clockByRepo = new Map<string, number>();
const createdDirs: string[] = [];

/** Deterministic identities, so author assertions never depend on the host. */
export const TEST_AUTHOR: GitPerson = { name: 'Ada Lovelace', email: 'ada@example.com' };
export const TEST_COMMITTER: GitPerson = { name: 'Grace Hopper', email: 'grace@example.com' };
export const SECOND_AUTHOR: GitPerson = { name: 'Alan Turing', email: 'alan@example.com' };

/**
 * Hides the developer's global and system git config.
 *
 * `src/git/exec.ts` treats `options.env` as an explicit, trusted override, which
 * is why this works: without it a machine-level `core.hooksPath` or
 * `commit.gpgsign = true` would make these tests pass on one machine and fail on
 * another.
 */
export function hermeticEnv(repo: RepoLike): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: path.join(dirOf(repo), '.git', 'ancestry-empty-globalconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** ISO-8601 date for the n-th commit of a repository. */
export function fixedDate(repo: RepoLike, offset = 0): string {
  const ticks = (clockByRepo.get(dirOf(repo)) ?? 0) + offset;
  return new Date(BASE_TIME_MS + ticks * CLOCK_STEP_MS).toISOString();
}

/** Run git in `repo`, throwing on failure. `cmd` may be an argv array or a string. */
export async function runIn(repo: RepoLike, cmd: string | string[]): Promise<GitExecResult> {
  const args = typeof cmd === 'string' ? cmd.split(/\s+/).filter(Boolean) : cmd;
  return runGit(args, { cwd: dirOf(repo) });
}

/** Run git in `repo` and return trimmed stdout, asserting success. */
export async function out(repo: RepoLike, cmd: string | string[]): Promise<string> {
  const result = await runIn(repo, cmd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${Array.isArray(cmd) ? cmd.join(' ') : cmd} failed (${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Create an initialised, configured, empty repository.
 *
 * `init.defaultBranch=main` keeps ref names stable; `core.autocrlf=false` keeps
 * byte-level comparisons (and therefore similarity) stable on Windows;
 * `commit.gpgsign=false` avoids a signing prompt; and hooks are pointed at an
 * empty directory inside `.git` so a user-template hook can never run.
 */
export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-analysis-')));
  createdDirs.push(dir);
  clockByRepo.set(dir, 0);

  // Scratch files live inside .git so they can never end up in a commit.
  const emptyGlobalConfig = path.join(dir, '.git', 'ancestry-empty-globalconfig');
  const noHooks = path.join(dir, '.git', 'ancestry-no-hooks');
  const baseEnv = hermeticEnv({ dir });

  await runGit(['-c', 'init.defaultBranch=main', 'init', '--quiet', dir], { env: baseEnv });
  await fs.writeFile(emptyGlobalConfig, '', 'utf8');
  await fs.mkdir(noHooks, { recursive: true });

  for (const [key, value] of [
    ['user.name', TEST_COMMITTER.name],
    ['user.email', TEST_COMMITTER.email],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['init.defaultBranch', 'main'],
    ['advice.detachedHead', 'false'],
    ['diff.renames', 'true'],
    ['core.hooksPath', noHooks],
  ]) {
    await runGit(['config', '--local', key, value], { cwd: dir, env: baseEnv });
  }

  return { dir };
}

/** Write (or overwrite) a repository-relative file with LF line endings. */
export async function writeFile(
  repo: RepoLike,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = path.join(dirOf(repo), ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content.replace(/\r\n/g, '\n'), 'utf8');
  return target;
}

/** Read a repository-relative file from the working tree. */
export function readFile(repo: RepoLike, relativePath: string): Promise<string> {
  return fs.readFile(path.join(dirOf(repo), ...relativePath.split('/')), 'utf8');
}

/** Delete a repository-relative file from the working tree. */
export async function removeFile(repo: RepoLike, relativePath: string): Promise<void> {
  await fs.rm(path.join(dirOf(repo), ...relativePath.split('/')), { force: true });
}

/** Stage everything and commit with a pinned identity and timestamp. */
export async function commit(
  repo: RepoLike,
  message: string,
  options: { author?: GitPerson; date?: string } = {},
): Promise<string> {
  const key = dirOf(repo);
  const ticks = (clockByRepo.get(key) ?? 0) + 1;
  clockByRepo.set(key, ticks);
  const date = options.date ?? new Date(BASE_TIME_MS + ticks * CLOCK_STEP_MS).toISOString();
  const author = options.author ?? TEST_AUTHOR;

  await runIn(repo, ['add', '--all']);
  const result = await runGit(['commit', '--quiet', '--no-verify', '-m', message], {
    cwd: key,
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: TEST_COMMITTER.name,
      GIT_COMMITTER_EMAIL: TEST_COMMITTER.email,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }
  return out(repo, ['rev-parse', 'HEAD']);
}

/** Create a branch at the current HEAD. */
export function branch(repo: RepoLike, name: string): Promise<string> {
  return out(repo, ['branch', name]);
}

/** Create *and* check out a branch at the current HEAD. */
export async function checkoutNewBranch(repo: RepoLike, name: string): Promise<void> {
  await out(repo, ['checkout', '--quiet', '-b', name]);
}

/** Check out an existing ref (`main`, a sha, `HEAD~1`, …). */
export async function checkout(repo: RepoLike, ref: string): Promise<void> {
  await out(repo, ['checkout', '--quiet', ref]);
}

/**
 * Merge `ref` into the current branch, always producing a merge commit.
 *
 * `--no-ff` is what makes the merge scenario testable: a fast-forward merge
 * leaves no merge commit, and therefore no `MERGED_FROM` edge, to assert on.
 */
export async function merge(repo: RepoLike, message: string, ref: string): Promise<string> {
  await runIn(repo, ['merge', '--no-ff', '--no-verify', '-m', message, ref]);
  return out(repo, ['rev-parse', 'HEAD']);
}

/** Move a repository-relative file with `git mv`, preserving rename detection. */
export async function gitMove(repo: RepoLike, from: string, to: string): Promise<void> {
  await fs.mkdir(path.join(dirOf(repo), ...path.posix.dirname(to).split('/')), { recursive: true });
  await out(repo, ['mv', from, to]);
}

/** Remove every repository this module created. */
export async function cleanupRepos(): Promise<void> {
  const dirs = createdDirs.splice(0, createdDirs.length);
  for (const key of clockByRepo.keys()) {
    clockByRepo.delete(key);
  }
  await Promise.all(
    dirs.map(async (dir) => {
      // `force` matters on Windows: git objects are read-only, and a plain `rm`
      // on them fails with EPERM.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }),
  );
}

// ---------------------------------------------------------------------------
// Source fixtures
// ---------------------------------------------------------------------------

/**
 * The function the whole scenario repository is about: the *original*
 * `validateToken` of `src/auth.ts` (plan phase 12, scenario 1).
 *
 * Long enough that the MinHash component is meaningful, and written with nested
 * control flow so the structural feature vector has something to describe.
 */
export const ORIGINAL_VALIDATE_TOKEN = `export function validateToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length === 0) {
      return false;
    }
  }
  return parts[0].length > 0;
}`;

/**
 * Scenario 2: the same logic, every name changed, in another file. Must score
 * ≥ 0.9 and be classified `strong` — a renamed copy is a copy, not a move, so the
 * graph must link it with `COPIED_FROM` and never with `MOVED_FROM`.
 */
export const RENAMED_COPY = `export function checkApiKey(credential: string): boolean {
  if (credential.length === 0) {
    return false;
  }
  const segments = credential.split('.');
  if (segments.length !== 3) {
    return false;
  }
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].length === 0) {
      return false;
    }
  }
  return segments[0].length > 0;
}`;

/**
 * Scenario 3: structurally altered, in a third file. Must score ≥ 0.75 and be
 * classified `possible` — the extra guard clause and the reordered return are
 * exactly the kind of edit §3.4 says lands in that band.
 */
export const MODIFIED_COPY = `export function verifySession(candidate: string): boolean {
  if (candidate.length === 0) {
    return false;
  }
  const segments = candidate.split('.');
  if (segments.length !== 3) {
    return false;
  }
  if (segments[0].length === 0) {
    return false;
  }
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].length === 0) {
      return false;
    }
  }
  return segments[0].length > 2;
}`;

/**
 * Scenario 4's subject: a helper that is genuinely *moved* between files, so git
 * reports a rename and the graph can justify `MOVED_FROM`.
 */
export const FORMAT_HELPER_V1 = `export function formatLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'unnamed';
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}`;

export const FORMAT_HELPER_V2 = `export function formatLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'unnamed';
  }
  if (trimmed.length > 40) {
    return trimmed.slice(0, 40);
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}`;

/** A decoy: a completely different function that must never be `strong`. */
export const DECOY_RETRIEVE = `export async function retrieveProfile(userId: string): Promise<string> {
  const response = await fetch('https://example.invalid/users/' + userId);
  const payload = await response.json();
  return payload.displayName;
}`;

/** A second decoy, in the same file as {@link DECOY_RETRIEVE}, to vary the corpus. */
export const DECOY_THROTTLE = `export function throttle(fn: () => void, delay: number): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < delay) {
      return;
    }
    last = now;
    fn();
  };
}`;

/** A third decoy: control flow that *looks* like a validator but is not one. */
export const DECOY_PARSE_ROWS = `export function parseRows(input: string): string[] {
  const out: string[] = [];
  for (const line of input.split('\\n')) {
    if (line.length === 0) {
      continue;
    }
    out.push(line);
  }
  return out;
}`;

/** A line-by-line description of the scenario corpus, for the accuracy report. */
export const DECOY_PATHS: readonly string[] = ['src/decoys.ts'];

/** A file that parses but contains no analysable construct. */
export const EMPTY_MODULE = '// intentionally empty\nexport {};\n';

// ---------------------------------------------------------------------------
// The scenario repository
// ---------------------------------------------------------------------------

/** Commit subjects of the scenario repository, in the order they were created. */
export const SCENARIO_COMMITS = Object.freeze({
  original: 'feat(auth): add token validation',
  legacyCopy: 'chore(legacy): ship the validator with the 1.x client',
  securityCopy: 'feat(security): harden session validation',
  deleteFormat: 'refactor(utils): drop the old formatter',
  reinstateFormat: 'feat(utils): bring the formatter back under a new name',
  divergent: 'feat(hardening): reject short credentials',
  merged: 'Merge branch "feature/hardening"',
});

/** Paths of the scenario repository, for readable assertions. */
export const SCENARIO_PATHS = Object.freeze({
  original: 'src/auth.ts',
  legacyCopy: 'src/legacy/validate.js',
  securityCopy: 'src/security/token.ts',
  formatOld: 'src/utils/format.ts',
  formatNew: 'src/utils/strings.ts',
  decoys: 'src/decoys.ts',
});

/** Where each scenario lives in the history, as commit subjects. */
export interface ScenarioLayout {
  repo: TempRepo;
  /** The commit that introduced `src/auth.ts` — the origin of the whole story. */
  firstCommit: string;
  /** The commit that added the renamed copy. */
  copyCommit: string;
  /** The commit that added the modified copy. */
  securityCommit: string;
  /** The commit that removed the original file. */
  deleteCommit: string;
  /** The commit that brought the logic back after the gap. */
  reinstateCommit: string;
  /** The tip of the divergent hardening branch. */
  hardeningTip: string;
  /** The merge commit on `main`. */
  mergeCommit: string;
  /** A commit reachable from no branch. */
  orphanCommit: string;
  /** A commit that only ever existed on a deleted branch. */
  deadBranchCommit: string;
}

/**
 * Build the repository the plan's phase 12 asks for: the seven required
 * scenarios plus decoys that must not match.
 *
 * The commit order matters and is not incidental:
 *
 *  1. `src/auth.ts` with the original `validateToken` — the origin.
 *  2. `src/legacy/validate.js` with the same logic, renamed — scenario 2.
 *  3. `src/security/token.ts` with the altered version — scenario 3.
 *  4. `src/utils/format.ts` with a helper — the *old* half of scenario 4.
 *  5. `git mv` it to `src/utils/strings.ts` and edit it — scenario 4, so git
 *     itself reports the rename and `MOVED_FROM` is backed by real evidence
 *     rather than by a name coincidence.
 *  6. Delete `src/auth.ts` and re-introduce the function under a new name in the
 *     same file — scenario 7, across a genuine gap in the file's history.
 *  7. `src/decoys.ts` with three unrelated functions — the negatives.
 *  8. A `feature/hardening` branch diverging from `main` with a divergent edit to
 *     the re-introduced validator — scenario 5. The branch is then *left
 *     unmerged* so both lines of descent stay visible, and a second branch is
 *     created, merged, and deleted to leave one merge commit (scenario 6) and one
 *     commit on no branch at all.
 */
export async function makeScenarioRepo(): Promise<ScenarioLayout> {
  const repo = await makeTempRepo();

  // NOTE ON ORDERING: every step below writes (or moves, or removes) first and
  // commits second. `commit()` stages with `git add --all`, so a commit issued
  // before its change lands records an empty tree — and on a fresh repository
  // that is `git commit` exiting 1 with the reason on stdout, which surfaces as
  // a bare "exited non-zero" with empty stderr. These pairs were originally
  // inverted; the fixture had never been executed, so nothing caught it.
  await writeFile(repo, SCENARIO_PATHS.original, `${ORIGINAL_VALIDATE_TOKEN}\n`);
  const firstCommit = await commit(repo, SCENARIO_COMMITS.original, {
    author: TEST_AUTHOR,
    date: new Date(Date.UTC(2020, 0, 1, 9, 0, 0)).toISOString(),
  });

  await writeFile(repo, SCENARIO_PATHS.legacyCopy, `${RENAMED_COPY}\n`);
  const copyCommit = await commit(repo, SCENARIO_COMMITS.legacyCopy, {
    date: new Date(Date.UTC(2020, 0, 2, 9, 0, 0)).toISOString(),
  });

  await writeFile(repo, SCENARIO_PATHS.securityCopy, `${MODIFIED_COPY}\n`);
  const securityCommit = await commit(repo, SCENARIO_COMMITS.securityCopy, {
    date: new Date(Date.UTC(2020, 0, 3, 9, 0, 0)).toISOString(),
  });

  // Scenario 4, part one: the helper at its original path.
  await writeFile(repo, SCENARIO_PATHS.formatOld, `${FORMAT_HELPER_V1}\n`);
  await commit(repo, 'feat(utils): add a label formatter', {
    date: new Date(Date.UTC(2020, 0, 4, 9, 0, 0)).toISOString(),
  });

  // Scenario 4, part two: a real rename, then an edit at the destination.
  await gitMove(repo, SCENARIO_PATHS.formatOld, SCENARIO_PATHS.formatNew);
  await writeFile(repo, SCENARIO_PATHS.formatNew, `${FORMAT_HELPER_V2}\n`);
  await commit(repo, 'refactor(utils): rename the formatter module', {
    date: new Date(Date.UTC(2020, 0, 5, 9, 0, 0)).toISOString(),
  });

  // Scenario 7: delete the original file entirely…
  await removeFile(repo, SCENARIO_PATHS.original);
  const deleteCommit = await commit(repo, SCENARIO_COMMITS.deleteFormat, {
    date: new Date(Date.UTC(2020, 0, 6, 9, 0, 0)).toISOString(),
  });

  // …and bring the logic back in the same path, under a new name.
  await writeFile(
    repo,
    SCENARIO_PATHS.original,
    `export function validateToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length === 0) {
      return false;
    }
  }
  return parts[0].length > 0;
}
`,
  );
  const reinstateCommit = await commit(repo, SCENARIO_COMMITS.reinstateFormat, {
    date: new Date(Date.UTC(2020, 0, 7, 9, 0, 0)).toISOString(),
  });

  // The negatives.
  await writeFile(
    repo,
    SCENARIO_PATHS.decoys,
    `${DECOY_RETRIEVE}\n\nexport const DECOY_LINE = 42;\n\n${DECOY_THROTTLE}\n\n${DECOY_PARSE_ROWS}\n`,
  );
  await commit(repo, 'test(decoys): unrelated helpers that must not match', {
    date: new Date(Date.UTC(2020, 0, 8, 9, 0, 0)).toISOString(),
  });

  // Scenario 5: a divergent branch. Left unmerged so both lines stay visible.
  await checkoutNewBranch(repo, 'feature/hardening');
  await writeFile(
    repo,
    SCENARIO_PATHS.original,
    `export function validateToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  if (token.indexOf(' ') >= 0) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length === 0) {
      return false;
    }
  }
  return parts[0].length > 0;
}
`,
  );
  const hardeningTip = await commit(repo, SCENARIO_COMMITS.divergent, {
    author: SECOND_AUTHOR,
    date: new Date(Date.UTC(2020, 0, 9, 9, 0, 0)).toISOString(),
  });
  await checkout(repo, 'main');

  // Scenario 6: a branch that is merged (leaving a merge commit) and a second
  // branch that is deleted (leaving a commit on no branch at all).
  await checkoutNewBranch(repo, 'feature/mergeable');
  await writeFile(repo, 'CHANGELOG.md', '# Changelog\n\n- first release\n');
  await commit(repo, 'chore: add a release note', {
    date: new Date(Date.UTC(2020, 0, 10, 9, 0, 0)).toISOString(),
  });
  await checkout(repo, 'main');

  await checkoutNewBranch(repo, 'feature/orphan');
  await writeFile(repo, 'SCRATCH.md', '# Scratch\n');
  const orphanCommit = await commit(repo, 'chore: work that is never kept', {
    author: SECOND_AUTHOR,
    date: new Date(Date.UTC(2020, 0, 11, 9, 0, 0)).toISOString(),
  });
  await checkout(repo, 'main');
  await out(repo, ['branch', '-D', 'feature/orphan']);

  const mergeCommit = await merge(repo, SCENARIO_COMMITS.merged, 'feature/mergeable');
  await out(repo, ['branch', '-D', 'feature/mergeable']);

  // A branch created and deleted, so its tip belongs to no branch.
  await checkoutNewBranch(repo, 'feature/abandoned');
  await writeFile(repo, 'EXPERIMENT.md', '# Experiment\n');
  const deadBranchCommit = await commit(repo, 'chore: an abandoned experiment', {
    author: SECOND_AUTHOR,
    date: new Date(Date.UTC(2020, 0, 12, 9, 0, 0)).toISOString(),
  });
  await checkout(repo, 'main');
  await out(repo, ['branch', '-D', 'feature/abandoned']);

  return {
    repo,
    firstCommit,
    copyCommit,
    securityCommit,
    deleteCommit,
    reinstateCommit,
    hardeningTip,
    mergeCommit,
    orphanCommit,
    deadBranchCommit,
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Directories of cache stores this module created, removed by {@link cleanupRepos}. */
const cacheDirs: string[] = [];

/**
 * A real local index in a throwaway directory.
 *
 * The file backend is requested explicitly rather than `auto`: the tests assert on
 * hit/miss counts, and SQLite's asynchronous commit behaviour makes those counts
 * depend on the runtime rather than on the code under test.
 */
export async function makeCacheStore(): Promise<ICacheStore> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-cache-')));
  cacheDirs.push(dir);
  const store = await createCacheStore({ directory: dir, backend: 'file' });
  return store;
}

/** Close every cache store and remove its directory. */
export async function closeCacheStores(stores: readonly ICacheStore[]): Promise<void> {
  for (const store of stores) {
    await store.close().catch(() => undefined);
  }
  const dirs = cacheDirs.splice(0, cacheDirs.length);
  await Promise.all(
    dirs.map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }),
  );
}
