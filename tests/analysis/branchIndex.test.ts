/**
 * Branch attribution: tips, ancestors, commits on no branch, the branch cap, and
 * — the load-bearing one — memoisation.
 *
 * The memoisation test drives a counting runner rather than a spy on the module,
 * because the invariant is about *git work done*: a second lookup of the same
 * commit must not spawn another child process, whatever the code path that got
 * there. Counting invocations is also what proves the cost bound documented on
 * `BranchIndex`: probes scale with the work list, never with the repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BranchIndex, isAncestryProbe } from '../../src/analysis';
import { runGit } from '../../src/git/exec';
import type { GitExecResult } from '../../src/git/exec';
import { GitRepository } from '../../src/git/repo';
import {
  branch,
  checkout,
  checkoutNewBranch,
  cleanupRepos,
  commit,
  makeTempRepo,
  out,
  writeFile,
} from './helpers';
import type { TempRepo } from './helpers';

/** A runner that counts invocations and classifies the ancestry probes among them. */
function countingRunner(): {
  run: (
    args: string[],
    options?: { cwd?: string; allowFailure?: boolean },
  ) => Promise<GitExecResult>;
  probes: () => number;
  total: () => number;
} {
  let probes = 0;
  let total = 0;
  return {
    run: (args, options) => {
      total += 1;
      if (isAncestryProbe(args)) {
        probes += 1;
      }
      return runGit(args, { cwd: options?.cwd, allowFailure: options?.allowFailure ?? false });
    },
    probes: () => probes,
    total: () => total,
  };
}

describe('BranchIndex', () => {
  let repo: TempRepo;
  let repository: GitRepository;
  let mainTip: string;
  let middleCommit: string;
  let featureTip: string;
  let orphanCommit: string;

  beforeAll(async () => {
    repo = await makeTempRepo();
    await writeFile(repo, 'src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
    await commit(repo, 'first');
    await writeFile(repo, 'src/b.ts', 'export function b(): number {\n  return 2;\n}\n');
    middleCommit = await commit(repo, 'second');

    await checkoutNewBranch(repo, 'feature/one');
    await writeFile(repo, 'src/c.ts', 'export function c(): number {\n  return 3;\n}\n');
    featureTip = await commit(repo, 'on the branch');

    await checkout(repo, 'main');
    for (let i = 0; i < 3; i += 1) {
      await writeFile(
        repo,
        `src/d${i}.ts`,
        `export function d${i}(): number {\n  return ${i};\n}\n`,
      );
      await commit(repo, `on main ${i}`);
    }
    mainTip = await out(repo, ['rev-parse', 'main']);

    // A commit that will end up on no branch at all.
    await checkoutNewBranch(repo, 'scratch');
    await writeFile(repo, 'src/scratch.ts', 'export function s(): number {\n  return 9;\n}\n');
    orphanCommit = await commit(repo, 'work that is thrown away');
    await checkout(repo, 'main');
    await out(repo, ['branch', '-D', 'scratch']);

    repository = await GitRepository.open(repo.dir);
    await repository.refreshInfo();
  });

  afterAll(async () => {
    repository.dispose();
    await cleanupRepos();
  });

  it('answers a branch tip with zero git probes', async () => {
    const runner = countingRunner();
    const index = new BranchIndex(repository, { runner: runner.run });
    const probed = await index.prime([mainTip, featureTip]);
    // Both are tips, so the pre-computed table answered both and nothing was
    // probed: `prime` reports how many commits actually needed a git call.
    expect(probed).toBe(0);
    expect(runner.probes()).toBe(0);
    expect(index.branchesFor(mainTip)).toEqual(['main']);
    expect(index.branchesFor(featureTip)).toEqual(['feature/one']);
    index.dispose();
  });

  it('attributes an ancestor to every branch that contains it', async () => {
    const index = new BranchIndex(repository);
    await index.prime([middleCommit]);
    expect(index.branchesFor(middleCommit).sort()).toEqual(['feature/one', 'main']);
    index.dispose();
  });

  it('reports the branches it is willing to probe', async () => {
    const index = new BranchIndex(repository);
    expect(index.listBranches()).toEqual([]);
    const tips = await index.branchTips();
    expect(tips.map((entry) => entry.branch)).toEqual(['feature/one', 'main']);
    expect(index.listBranches()).toEqual(['feature/one', 'main']);
    expect(index.tipOf('main')).toBe(mainTip);
    expect(index.tipOf('nope')).toBeNull();
    index.dispose();
  });

  it('returns an empty list for a commit on no branch, so the graph shows (detached)', async () => {
    const index = new BranchIndex(repository);
    await index.prime([orphanCommit]);
    expect(index.branchesFor(orphanCommit)).toEqual([]);
    index.dispose();
  });

  it('returns an empty list for a commit that was never primed', () => {
    const index = new BranchIndex(repository);
    expect(index.branchesFor('f'.repeat(40))).toEqual([]);
    expect(index.branchesFor('')).toEqual([]);
    index.dispose();
  });

  it('memoises: a repeated lookup issues no further git call', async () => {
    const runner = countingRunner();
    const index = new BranchIndex(repository, { runner: runner.run });

    await index.prime([middleCommit]);
    const afterFirst = runner.probes();
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) {
      expect(index.branchesFor(middleCommit).sort()).toEqual(['feature/one', 'main']);
    }
    expect(runner.probes()).toBe(afterFirst);

    // Re-priming the same commit is free too.
    await index.prime([middleCommit]);
    await index.prime([middleCommit, middleCommit]);
    expect(runner.probes()).toBe(afterFirst);
    expect(index.probeCount).toBe(afterFirst);
    index.dispose();
  });

  it('probes at most (work list × branches) times, never one call per history commit', async () => {
    const runner = countingRunner();
    const index = new BranchIndex(repository, { runner: runner.run });
    const many: string[] = [];
    const log = await repository.getCommitHistory({ limit: 50 });
    for (const commitish of log) {
      many.push(commitish.hash);
    }
    expect(many.length).toBeGreaterThan(4);

    await index.prime(many);
    const branchCount = index.listBranches().length;
    // One `for-each-ref` plus at most one probe per (unresolved commit, branch).
    expect(runner.probes()).toBeLessThanOrEqual(many.length * branchCount);
    expect(runner.total()).toBeLessThanOrEqual(1 + many.length * branchCount);
    index.dispose();
  });

  it('dispose() drops the memo but never throws', () => {
    const index = new BranchIndex(repository);
    index.dispose();
    expect(index.branchesFor('a'.repeat(40))).toEqual([]);
    expect(index.listBranches()).toEqual([]);
    expect(() => index.dispose()).not.toThrow();
  });
});

describe('BranchIndex branch cap', () => {
  let repo: TempRepo;
  let repository: GitRepository;
  let tip: string;

  const BRANCH_COUNT = 6;

  beforeAll(async () => {
    repo = await makeTempRepo();
    await writeFile(repo, 'src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
    await commit(repo, 'first');
    await writeFile(repo, 'src/b.ts', 'export function b(): number {\n  return 2;\n}\n');
    await commit(repo, 'second');
    await writeFile(repo, 'src/c.ts', 'export function c(): number {\n  return 3;\n}\n');
    tip = await commit(repo, 'third');
    await writeFile(repo, 'src/d.ts', 'export function d(): number {\n  return 4;\n}\n');
    await commit(repo, 'fourth');
    for (let i = 0; i < BRANCH_COUNT; i += 1) {
      await branch(repo, `topic/${String(i).padStart(2, '0')}`);
    }
    repository = await GitRepository.open(repo.dir);
    await repository.refreshInfo();
  });

  afterAll(async () => {
    repository.dispose();
    await cleanupRepos();
  });

  it('probes only the capped prefix and warns that the rest were ignored', async () => {
    const runner = countingRunner();
    const index = new BranchIndex(repository, { maxBranches: 3, runner: runner.run });
    await index.prime([tip]);

    // The tip of all six branches is answered from the pre-computed table, so
    // nothing is probed — but only the capped set of branches is even considered.
    // The cap keeps the first three in name order, and `main` sorts first.
    expect(index.listBranches()).toEqual(['main', 'topic/00', 'topic/01']);
    expect(index.branchesFor(tip)).toEqual(['main', 'topic/00', 'topic/01']);

    const warnings = index.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('7 branches');
    expect(warnings[0]).toContain('first 3');
    index.dispose();
  });

  it('does not warn when the cap is not reached', async () => {
    const index = new BranchIndex(repository, { maxBranches: 50 });
    await index.prime([tip]);
    expect(index.warnings()).toEqual([]);
    index.dispose();
  });

  it('caps the primed work list as well', async () => {
    const runner = countingRunner();
    const index = new BranchIndex(repository, {
      maxBranches: 50,
      maxPrimedCommits: 2,
      runner: runner.run,
    });
    const log = await repository.getCommitHistory({ limit: 20 });
    // Four commits, of which the last is a tip of every branch: three need work.
    expect(log.length).toBe(4);
    const primed = await index.prime(log.map((entry) => entry.hash));
    expect(primed).toBe(2);
    expect(runner.probes()).toBeLessThanOrEqual(2 * 7);
    expect(index.warnings().some((warning) => /first 2 of 3 commits/.test(warning))).toBe(true);
    // Exactly the two allowed commits were attributed; the third is reported as
    // unattributed rather than guessed at.
    const attributed = log.filter(
      (entry) => entry.hash !== tip && index.branchesFor(entry.hash).length > 0,
    );
    expect(attributed).toHaveLength(2);
    index.dispose();
  });
});
