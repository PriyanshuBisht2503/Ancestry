/**
 * Reusable scaffolding for the Git engine tests.
 *
 * Every helper drives the real `git` binary against a throwaway repository, so
 * the tests exercise the same code path the extension does. Determinism is the
 * whole point: author/committer identity, the default branch name, line endings
 * and commit timestamps are all pinned, because ancestry assertions that depend
 * on ordering must not depend on the machine's clock or its global git config.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../src/git/exec';
import type { GitExecResult } from '../../src/git/exec';
import type { GitPerson } from '../../src/types';

/** A throwaway repository on disk. */
export interface TempRepo {
  /** Absolute path to the repository working tree. */
  dir: string;
}

/** Either shape is accepted so helpers can be called with a bare path too. */
export type RepoLike = TempRepo | string;

function dirOf(repo: RepoLike): string {
  return typeof repo === 'string' ? repo : repo.dir;
}

/**
 * Fixed clock. Each commit advances one minute so that two commits created in
 * the same test never share a timestamp — `git log` orders by date, and equal
 * dates would make ordering (and therefore blame and `--topo-order` results)
 * ambiguous.
 */
const BASE_TIME_MS = Date.UTC(2020, 0, 1, 0, 0, 0);
const CLOCK_STEP_MS = 60_000;
const clockByRepo = new Map<string, number>();

/** Directories created by `makeTempRepo`, removed by `cleanup`. */
const createdDirs: string[] = [];

/**
 * Environment that hides the developer's global and system git config.
 *
 * `makeTempRepo` uses it for setup; tests that exercise something the *user's*
 * config could mask (for example the "no user.name configured" warning) pass it
 * to the method under test. It only works because the exec layer treats
 * `options.env` as an explicit, trusted override.
 */
export function hermeticEnv(repo: RepoLike): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: path.join(dirOf(repo), '.git', 'ancestry-empty-globalconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** Deterministic identities, so author assertions never depend on the host. */
export const TEST_AUTHOR: GitPerson = { name: 'Ada Lovelace', email: 'ada@example.com' };
export const TEST_COMMITTER: GitPerson = { name: 'Grace Hopper', email: 'grace@example.com' };
export const OTHER_AUTHOR: GitPerson = { name: '张三', email: 'zhang@example.com' };

/** ISO-8601 string for the n-th commit made in a repository. */
export function fixedDate(repo: RepoLike, offset = 0): string {
  const key = dirOf(repo);
  const ticks = (clockByRepo.get(key) ?? 0) + offset;
  return new Date(BASE_TIME_MS + ticks * CLOCK_STEP_MS).toISOString();
}

/**
 * Run git in `repo`, throwing on failure.
 *
 * `cmd` may be an argument array (preferred — no quoting rules to get wrong) or
 * a whitespace-separated string, which is split on spaces. Ancestry never builds
 * shell strings, and neither do the tests.
 */
export async function runIn(repo: RepoLike, cmd: string | string[]): Promise<GitExecResult> {
  const args = typeof cmd === 'string' ? cmd.split(/\s+/).filter(Boolean) : cmd;
  return runGit(args, { cwd: dirOf(repo) });
}

/** Run git in `repo` and return trimmed stdout, asserting success. */
export async function runInExpectingOutput(
  repo: RepoLike,
  cmd: string | string[],
): Promise<string> {
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
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` are set to an empty file and to
 * `1` so a developer's own global/system config (hooks, signing, templates,
 * `core.autocrlf`) cannot make these tests pass on one machine and fail on
 * another. These are explicit overrides, so the sanitising env layer in
 * `src/git/exec.ts` keeps them.
 */
export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-git-')));
  createdDirs.push(dir);
  clockByRepo.set(dir, 0);

  // Scratch files live *inside* .git so they can never end up in a commit:
  // several tests assert on the exact contents of the tree.
  const emptyGlobalConfig = path.join(dir, '.git', 'ancestry-empty-globalconfig');
  const noHooks = path.join(dir, '.git', 'ancestry-no-hooks');
  const baseEnv: NodeJS.ProcessEnv = hermeticEnv({ dir });

  await runGit(['-c', 'init.defaultBranch=main', 'init', '--quiet', dir], { env: baseEnv });
  await fs.writeFile(emptyGlobalConfig, '', 'utf8');
  await fs.mkdir(noHooks, { recursive: true });

  // Local config wins over anything the environment might still inject.
  for (const [key, value] of [
    ['user.name', TEST_COMMITTER.name],
    ['user.email', TEST_COMMITTER.email],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['init.defaultBranch', 'main'],
    ['advice.detachedHead', 'false'],
    ['diff.renames', 'true'],
    // Point hooks at an empty directory: a user template hook must never run.
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
  const target = path.join(dirOf(repo), relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content.replace(/\r\n/g, '\n'), 'utf8');
  return target;
}

/** Read a repository-relative file from the working tree. */
export async function readFile(repo: RepoLike, relativePath: string): Promise<string> {
  return fs.readFile(path.join(dirOf(repo), relativePath), 'utf8');
}

/** Delete a repository-relative file. */
export async function rmFile(repo: RepoLike, relativePath: string): Promise<void> {
  await fs.rm(path.join(dirOf(repo), relativePath), { force: true });
}

/**
 * Stage everything and create a commit with a pinned identity and timestamp.
 *
 * @param options.author Overrides the author identity.
 * @param options.date   Overrides the fixed clock for this commit.
 */
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
  return runInExpectingOutput(repo, ['rev-parse', 'HEAD']);
}

/** Create a branch at the current HEAD. */
export async function branch(repo: RepoLike, name: string): Promise<void> {
  await runInExpectingOutput(repo, ['branch', name]);
}

/** Create *and* check out a branch at the current HEAD. */
export async function checkoutNewBranch(repo: RepoLike, name: string): Promise<void> {
  await runInExpectingOutput(repo, ['checkout', '--quiet', '-b', name]);
}

/** Check out an existing ref (`main`, a sha, `HEAD~1`, …). */
export async function checkout(repo: RepoLike, ref: string): Promise<void> {
  await runInExpectingOutput(repo, ['checkout', '--quiet', ref]);
}

/**
 * Merge `ref` into the current branch, always producing a merge commit.
 *
 * `--no-ff` matters: a fast-forward merge would leave no merge commit to
 * exercise Ancestry's multi-parent handling.
 */
export async function merge(repo: RepoLike, message: string, ref: string): Promise<string> {
  await runIn(repo, ['merge', '--no-ff', '--no-verify', '-m', message, ref]);
  return runInExpectingOutput(repo, ['rev-parse', 'HEAD']);
}

/** Tag a ref (`tag(repo, 'v1', 'HEAD~1')`). */
export async function tag(repo: RepoLike, name: string, ref = 'HEAD'): Promise<void> {
  await runInExpectingOutput(repo, ['tag', name, ref]);
}

/** Remove every repository created by `makeTempRepo` in this process. */
export async function cleanup(): Promise<void> {
  const dirs = createdDirs.splice(0, createdDirs.length);
  const clocks = Array.from(clockByRepo.keys());
  for (const key of clocks) {
    clockByRepo.delete(key);
  }
  await Promise.all(
    dirs.map(async (dir) => {
      // `force` matters on Windows: git objects are read-only files, and a bare
      // `rm` on them fails with EPERM.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }),
  );
}

/** A tiny TypeScript source file, used as a stable blame/rename fixture. */
export function tsSource(body: string): string {
  return `export function alpha(): number {\n${body}\n}\n`;
}
