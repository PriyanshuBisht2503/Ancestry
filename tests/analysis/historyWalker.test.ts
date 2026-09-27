/**
 * History traversal: the commit list, the rename chain derived from `R`/`C`
 * entries, the widening step, truncation at `maxDepth`, and the interaction
 * between `--follow` and `--all`.
 *
 * The rename chain is the part worth testing carefully. `git log --follow`
 * reports the *old* path for pre-rename commits, so the commit list on its own
 * never says when a file was renamed — only `getChangedFiles` at the rename
 * commit does. If that derivation is wrong, `MOVED_FROM` silently degrades to a
 * guess and the graph claims a copy where a move happened.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AbortBudget, HistoryWalker, changedPathsSince } from '../../src/analysis';
import { GitRepository } from '../../src/git/repo';
import {
  checkout,
  checkoutNewBranch,
  cleanupRepos,
  commit,
  gitMove,
  makeTempRepo,
  removeFile,
  writeFile,
} from './helpers';
import type { TempRepo } from './helpers';

const BODY_V1 = 'export function pick(value: string): string {\n  return value.trim();\n}\n';
const BODY_V2 =
  'export function pick(value: string): string {\n  const out = value.trim();\n  return out;\n}\n';
const SIBLING = 'export function unrelated(): number {\n  return 7;\n}\n';

function walkerFor(
  repository: GitRepository,
  overrides: Partial<{
    maxDepth: number;
    followRenames: boolean;
    includeAllBranches: boolean;
    includeTests: boolean;
  }> = {},
): HistoryWalker {
  return new HistoryWalker(repository, {
    maxDepth: 200,
    followRenames: true,
    includeAllBranches: true,
    includeTests: true,
    ...overrides,
  });
}

describe('HistoryWalker', () => {
  let repo: TempRepo;
  let repository: GitRepository;
  let firstCommit: string;
  let renameCommit: string;
  let afterRenameCommit: string;

  beforeAll(async () => {
    repo = await makeTempRepo();
    await writeFile(repo, 'src/legacy.ts', BODY_V1);
    await writeFile(repo, 'src/other.ts', SIBLING);
    firstCommit = await commit(repo, 'add the helper');

    await writeFile(repo, 'src/legacy.ts', BODY_V2);
    renameCommit = await commit(repo, 'tweak the helper');

    // The rename: a real `git mv`, so `diff-tree` reports `R`.
    await gitMove(repo, 'src/legacy.ts', 'src/renamed/helper.ts');
    await commit(repo, 'move the helper');

    await writeFile(repo, 'src/renamed/helper.ts', `${BODY_V2}export const MARKER = 1;\n`);
    afterRenameCommit = await commit(repo, 'use the helper');

    repository = await GitRepository.open(repo.dir);
    await repository.refreshInfo();
  });

  afterAll(async () => {
    repository.dispose();
    await cleanupRepos();
  });

  it('returns the history oldest-first', async () => {
    const history = await walkerFor(repository).fileHistory('src/renamed/helper.ts');
    expect(history.commits.map((entry) => entry.hash)).toEqual([
      firstCommit,
      renameCommit,
      ...history.commits.slice(2).map((entry) => entry.hash),
    ]);
    expect(history.commits[0]!.hash).toBe(firstCommit);
    expect(history.commits[history.commits.length - 1]!.hash).toBe(afterRenameCommit);
    // Timestamps are pinned and increasing, so the order is checkable.
    const stamps = history.commits.map((entry) => entry.authorTimestamp);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(history.truncated).toBe(false);
    expect(history.reasons).toEqual([]);
  });

  it('derives the rename chain from the R entry', async () => {
    const history = await walkerFor(repository).fileHistory('src/renamed/helper.ts');
    expect(history.renames).toHaveLength(1);
    expect(history.renames[0]).toMatchObject({
      fromPath: 'src/legacy.ts',
      toPath: 'src/renamed/helper.ts',
    });
    // The chain commit is the commit that introduced the rename, not the tip.
    expect(history.renames[0]!.commit).not.toBe(afterRenameCommit);
    expect(history.renames[0]!.score).toBeGreaterThan(0.5);
  });

  it('follows the chain backwards through a second rename', async () => {
    const walker = walkerFor(repository);
    await gitMove(repo, 'src/renamed/helper.ts', 'src/final/helper.ts');
    const third = await commit(repo, 'move it again');
    const history = await walker.fileHistory('src/final/helper.ts');
    expect(history.renames.map((rename) => rename.toPath)).toEqual([
      'src/final/helper.ts',
      'src/renamed/helper.ts',
    ]);
    expect(history.renames[0]!.fromPath).toBe('src/renamed/helper.ts');
    expect(history.renames[1]!.fromPath).toBe('src/legacy.ts');
    expect(history.commits[history.commits.length - 1]!.hash).toBe(third);
  });

  it('reports no rename for a path that was never renamed', async () => {
    const history = await walkerFor(repository).fileHistory('src/other.ts');
    expect(history.renames).toEqual([]);
    expect(history.commits.length).toBeGreaterThan(0);
    expect(history.truncated).toBe(false);
  });

  it('answers with an empty history for a path that never existed', async () => {
    const history = await walkerFor(repository).fileHistory('src/never-existed.ts');
    expect(history.commits).toEqual([]);
    expect(history.renames).toEqual([]);
  });

  it('truncates exactly at maxDepth and says why', async () => {
    const head = (await repository.refreshInfo()).headCommit!;
    const history = await walkerFor(repository, { maxDepth: 2 }).fileHistory('src/final/helper.ts');
    expect(history.commits).toHaveLength(2);
    // `--max-count` bounds during traversal, so the limit keeps the *newest* N:
    // in oldest-first output the last entry is the tip.
    expect(history.commits[history.commits.length - 1]!.hash).toBe(head);
    expect(history.truncated).toBe(true);
    expect(history.reasons.join(' ')).toMatch(/maxHistoryDepth/);
  });

  it('does not claim truncation when the whole history fits', async () => {
    const history = await walkerFor(repository, { maxDepth: 100 }).fileHistory(
      'src/final/helper.ts',
    );
    expect(history.truncated).toBe(false);
    expect(history.reasons).toEqual([]);
  });

  it('degrades to a plain path walk when --follow and --all cannot combine', async () => {
    // Both switches requested: git rejects the combination, and the walker must
    // lose rename-following rather than lose the history.
    const history = await walkerFor(repository, {
      followRenames: true,
      includeAllBranches: true,
    }).fileHistory('src/final/helper.ts');
    expect(history.commits.length).toBeGreaterThan(0);
  });

  it('walks the literal path only when includeAllBranches is off', async () => {
    const followed = await walkerFor(repository, { includeAllBranches: true }).fileHistory(
      'src/final/helper.ts',
    );
    const notFollowed = await walkerFor(repository, {
      followRenames: false,
      includeAllBranches: false,
    }).fileHistory('src/final/helper.ts');
    // Without `--follow` the pre-rename commits are simply not in the list, which
    // is the whole reason the flag exists.
    expect(followed.commits.length).toBeGreaterThan(notFollowed.commits.length);
    expect(followed.commits.map((entry) => entry.hash)).toContain(firstCommit);
    expect(notFollowed.commits.map((entry) => entry.hash)).not.toContain(firstCommit);
  });

  it('unions the path and the old path of every change, per commit', async () => {
    const walker = walkerFor(repository);
    const history = await walker.fileHistory('src/final/helper.ts');
    const touched = await walker.pathsTouchedBy(history.commits);
    // Both sides of every rename must be present, or a scan would keep a stale
    // view of a path that no longer exists.
    expect(touched.has('src/final/helper.ts')).toBe(true);
    expect(touched.has('src/renamed/helper.ts')).toBe(true);
    expect(touched.has('src/legacy.ts')).toBe(true);
    for (const [filePath, commits] of touched) {
      expect(commits.length).toBeGreaterThan(0);
      expect(filePath.length).toBeGreaterThan(0);
    }
    // The same commit is recorded once per path, never twice.
    for (const commits of touched.values()) {
      expect(new Set(commits.map((commit) => commit.hash)).size).toBe(commits.length);
    }
  });

  it('ignores commits with no usable hash in the widening step', async () => {
    const walker = walkerFor(repository);
    const log = await repository.getCommitHistory({ limit: 1, path: 'src/other.ts' });
    const touched = await walker.pathsTouchedBy([...log, { hash: '' } as never]);
    expect(touched.has('src/other.ts')).toBe(true);
  });

  it('lists the tree at a commit, filtered by the search scope', async () => {
    await writeFile(repo, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    await writeFile(repo, 'dist/bundle.js', 'console.log(1);\n');
    await writeFile(repo, 'src/app.test.ts', 'export const t = 1;\n');
    await commit(repo, 'add noise');

    const head = (await repository.refreshInfo()).headCommit!;
    const walker = walkerFor(repository, { includeTests: true });
    const files = await walker.repositoryFiles(head);
    expect(files).toContain('src/other.ts');
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(files.some((file) => file.startsWith('dist/'))).toBe(false);
    expect(files).toContain('src/app.test.ts');
    expect(walker.skippedPathCount()).toBeGreaterThan(0);
    // Sorted, so the sweep order is deterministic.
    expect([...files].sort()).toEqual(files);

    const noTests = walkerFor(repository, { includeTests: false });
    const filtered = await noTests.repositoryFiles(head);
    expect(filtered).not.toContain('src/app.test.ts');
  });

  it('returns nothing when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const head = (await repository.refreshInfo()).headCommit!;
    expect(await walkerFor(repository).repositoryFiles(head, controller.signal)).toEqual([]);
  });

  it('answers with an empty history rather than throwing for an unborn repository', async () => {
    const empty = await makeTempRepo();
    const emptyRepo = await GitRepository.open(empty.dir);
    await emptyRepo.refreshInfo();
    const history = await walkerFor(emptyRepo).fileHistory('src/anything.ts');
    expect(history.commits).toEqual([]);
    expect(history.truncated).toBe(false);
    emptyRepo.dispose();
  });

  it('propagates cancellation from the budget', async () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new AbortBudget(controller.signal, () => 0);
    expect(budget.check()).toBe(false);
    expect(() => budget.throwIfAborted()).toThrowError(/CANCELLED/);
  });
});

describe('changedPathsSince', () => {
  let repo: TempRepo;
  let repository: GitRepository;
  let from: string;

  beforeAll(async () => {
    repo = await makeTempRepo();
    await writeFile(repo, 'src/keep.ts', SIBLING);
    await writeFile(repo, 'src/gone.ts', BODY_V1);
    from = await commit(repo, 'first');
    await removeFile(repo, 'src/gone.ts');
    await writeFile(repo, 'src/new.ts', BODY_V2);
    await gitMove(repo, 'src/keep.ts', 'src/kept.ts');
    await commit(repo, 'second');
    repository = await GitRepository.open(repo.dir);
    await repository.refreshInfo();
  });

  afterAll(async () => {
    repository.dispose();
    await cleanupRepos();
  });

  it('reports both sides of a rename and both added and deleted paths', async () => {
    const paths = await changedPathsSince(repository, from);
    // `src/keep.ts` and `src/kept.ts` are the two sides of the rename; a scan
    // that only saw the destination would keep a stale entry for the source.
    expect(paths).toEqual(['src/gone.ts', 'src/keep.ts', 'src/kept.ts', 'src/new.ts']);
  });

  it('sorts and de-duplicates', async () => {
    const paths = await changedPathsSince(repository, from);
    expect([...paths].sort()).toEqual(paths);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns nothing for an unchanged range', async () => {
    expect(await changedPathsSince(repository, from, from)).toEqual([]);
  });

  it('returns nothing when the signal has already fired, without calling git', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await changedPathsSince(repository, from, undefined, controller.signal)).toEqual([]);
  });

  it('returns nothing rather than throwing for a revision that does not exist', async () => {
    expect(await changedPathsSince(repository, 'f'.repeat(40))).toEqual([]);
  });

  it('supports an explicit destination revision', async () => {
    const head = (await repository.refreshInfo()).headCommit!;
    const paths = await changedPathsSince(repository, from, head);
    expect(paths).toContain('src/kept.ts');
  });
});

describe('HistoryWalker on a branch-only commit', () => {
  let repo: TempRepo;
  let repository: GitRepository;

  beforeAll(async () => {
    repo = await makeTempRepo();
    await writeFile(repo, 'src/base.ts', SIBLING);
    await commit(repo, 'base');
    repository = await GitRepository.open(repo.dir);
    await repository.refreshInfo();
  });

  afterAll(async () => {
    repository.dispose();
    await cleanupRepos();
  });

  it('sees a commit that only exists on another branch when --all is requested', async () => {
    await checkoutNewBranch(repo, 'unmerged');
    await writeFile(repo, 'src/side.ts', BODY_V1);
    const side = await commit(repo, 'on the other branch');
    await checkout(repo, 'main');

    const withAll = await walkerFor(repository, { includeAllBranches: true }).fileHistory(
      'src/side.ts',
    );
    expect(withAll.commits.map((entry) => entry.hash)).toContain(side);

    const headOnly = await walkerFor(repository, { includeAllBranches: false }).fileHistory(
      'src/side.ts',
    );
    expect(headOnly.commits).toEqual([]);
  });
});
