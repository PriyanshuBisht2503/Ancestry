import { afterEach, describe, expect, it } from 'vitest';
import { AncestryError } from '../../src/types';
import { GitRepository } from '../../src/git/repo';
import {
  branch,
  checkout,
  checkoutNewBranch,
  cleanup,
  commit,
  makeTempRepo,
  merge,
  OTHER_AUTHOR,
  readFile,
  rmFile,
  runIn,
  TEST_AUTHOR,
  writeFile,
} from './helpers';
import type { TempRepo } from './helpers';

afterEach(async () => {
  await cleanup();
});

/**
 * Six-line fixture with no blank lines, so blame attribution is unambiguous:
 * commit B changes line 5 (`  return 2;` → `  return 3;`) and nothing else.
 */
const ORIGINAL = [
  'export function alpha(): number {',
  '  return 1;',
  '}',
  'export function beta(): number {',
  '  return 2;',
  '}',
  '',
].join('\n');

/** Adds a second, unrelated function. */
const EXTENDED = [
  ...ORIGINAL.split('\n'),
  'export function gamma(): number {',
  '  return 9;',
  '}',
  '',
].join('\n');

/** The only change from ORIGINAL is on line 5. */
const CHANGED = ORIGINAL.replace('  return 2;', '  return 3;');

/** Commits A → B → C, where C renames a.ts to b.ts and then edits it. */
async function makeRenameRepo(): Promise<{
  repo: TempRepo;
  a: string;
  b: string;
  renameCommit: string;
}> {
  const repo = await makeTempRepo();
  await writeFile(repo, 'a.ts', ORIGINAL);
  const a = await commit(repo, 'A: add a.ts');

  await writeFile(repo, 'a.ts', EXTENDED);
  const b = await commit(repo, 'B: extend a.ts');

  await runIn(repo, ['mv', 'a.ts', 'b.ts']);
  const renameCommit = await commit(repo, 'C: rename a.ts to b.ts');

  return { repo, a, b, renameCommit };
}

describe('getCommitHistory', () => {
  it('returns newest-first history by default', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');
    await writeFile(repo, 'c.ts', CHANGED);
    const c = await commit(repo, 'C');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory();

    expect(history.map((entry) => entry.hash)).toEqual([c, b, a]);
    expect(history.map((entry) => entry.subject)).toEqual(['C', 'B', 'A']);
    expect(history[0]?.parents).toEqual([b]);
    expect(history[0]?.isMerge).toBe(false);
    expect(history.every((entry) => entry.author.name === TEST_AUTHOR.name)).toBe(true);
  });

  it('honours limit', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');
    await writeFile(repo, 'c.ts', CHANGED);
    const c = await commit(repo, 'C');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ limit: 2 });

    expect(history.map((entry) => entry.hash)).toEqual([c, b]);
  });

  it('honours skip together with limit', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');
    await writeFile(repo, 'c.ts', CHANGED);
    await commit(repo, 'C');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ limit: 1, skip: 1 });

    expect(history.map((entry) => entry.hash)).toEqual([b]);
  });

  it('can emit oldest-first', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ reverse: true });

    expect(history.map((entry) => entry.hash)).toEqual([a, b]);
  });

  it('starts from an explicit revision and walks its ancestry', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');
    await writeFile(repo, 'c.ts', CHANGED);
    const c = await commit(repo, 'C');

    const opened = await GitRepository.open(repo.dir);
    // `since` replaces HEAD as the starting point of the walk, so descendants
    // of `b` are out of scope.
    const history = await opened.getCommitHistory({ since: b });

    expect(history.map((entry) => entry.hash)).toEqual([b, a]);
    expect(history.map((entry) => entry.hash)).not.toContain(c);
  });

  it('restricts to a path', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A: a');
    await writeFile(repo, 'b.ts', EXTENDED);
    await commit(repo, 'B: b');
    await writeFile(repo, 'a.ts', CHANGED);
    const c = await commit(repo, 'C: a again');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ path: 'a.ts' });

    expect(history.map((entry) => entry.hash)).toEqual([c, a]);
  });

  it('stops at the until predicate, excluding the matching commit', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');
    await writeFile(repo, 'c.ts', CHANGED);
    const c = await commit(repo, 'C');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ until: (entry) => entry.hash === b });

    expect(history.map((entry) => entry.hash)).toEqual([c]);
    expect(history.map((entry) => entry.hash)).not.toContain(a);
  });

  it('stops at the until predicate across pages', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const first = await commit(repo, 'commit 0');
    const hashes = [first];
    for (let index = 1; index < 12; index += 1) {
      await writeFile(repo, 'a.ts', `export const v${index} = ${index};\n`);
      hashes.push(await commit(repo, `commit ${index}`));
    }

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory({ until: (entry) => entry.hash === hashes[6] });

    // The predicate is exclusive: 5 newer commits survive, the 6th is the stop.
    expect(history).toHaveLength(5);
    expect(history.map((entry) => entry.hash)).not.toContain(hashes[6]);
  });

  it('supports cancellation through an AbortSignal', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    const opened = await GitRepository.open(repo.dir);

    const controller = new AbortController();
    controller.abort();
    await expect(opened.getCommitHistory({ signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('exposes the ref decoration of the current branch', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    const opened = await GitRepository.open(repo.dir);

    const history = await opened.getCommitHistory({ limit: 1 });
    expect(history[0]?.refs).toContain('main');
  });
});

describe('file content at a commit', () => {
  it('reads a file that exists at that commit', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'a.ts', CHANGED);
    await commit(repo, 'B');

    const opened = await GitRepository.open(repo.dir);
    expect(await opened.getFileAtCommit(a, 'a.ts')).toBe(ORIGINAL);
    expect(await opened.getFileAtCommit('HEAD', 'a.ts')).toBe(CHANGED);
  });

  it('returns null for a path that only appears later', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'later.ts', 'export const later = 1;\n');
    await commit(repo, 'B: add later.ts');

    const opened = await GitRepository.open(repo.dir);
    expect(await opened.getFileAtCommit(a, 'later.ts')).toBeNull();
    expect(await opened.getFileAtCommit('HEAD', 'later.ts')).toBe('export const later = 1;\n');
  });

  it('returns null for a path that has been deleted', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'gone.ts', 'export const gone = 1;\n');
    await commit(repo, 'A');
    await rmFile(repo, 'gone.ts');
    await commit(repo, 'B: delete gone.ts');

    const opened = await GitRepository.open(repo.dir);
    expect(await opened.getFileAtCommit('HEAD', 'gone.ts')).toBeNull();
    expect(await opened.getFileAtCommit('HEAD~1', 'gone.ts')).toBe('export const gone = 1;\n');
  });

  it('follows a rename when reading the new path at an old commit', async () => {
    const { repo, a } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getFileAtCommit('HEAD', 'b.ts')).toBe(EXTENDED);
    // a.ts no longer exists after the rename commit.
    expect(await opened.getFileAtCommit('HEAD', 'a.ts')).toBeNull();
    expect(await opened.getFileAtCommit(a, 'a.ts')).toBe(ORIGINAL);
  });

  it('getAllFilesAtCommit lists the tree at a commit', async () => {
    const { repo, a, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getAllFilesAtCommit(a)).toEqual(['a.ts']);
    expect(await opened.getAllFilesAtCommit(renameCommit)).toEqual(['b.ts']);
  });

  it('getObjectSize reports the blob size, or null when absent', async () => {
    const { repo, a } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getObjectSize(a, 'a.ts')).toBe(Buffer.byteLength(ORIGINAL, 'utf8'));
    expect(await opened.getObjectSize(a, 'nope.ts')).toBeNull();
  });

  it('getFileTextAtCommit refuses a file above the byte budget', async () => {
    const { repo, a } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    let caught: unknown;
    try {
      await opened.getFileTextAtCommit(a, 'a.ts', 4);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AncestryError);
    expect((caught as AncestryError).code).toBe('FILE_TOO_LARGE');
  });

  it('getFileTextAtCommit still reads a file within the byte budget', async () => {
    const { repo, a } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);
    expect(await opened.getFileTextAtCommit(a, 'a.ts', 4096)).toBe(ORIGINAL);
  });
});

describe('getChangedFiles and findRenames', () => {
  it('reports the files a commit changed', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    await writeFile(repo, 'b.ts', EXTENDED);
    const b = await commit(repo, 'B');

    const opened = await GitRepository.open(repo.dir);
    const changes = await opened.getChangedFiles(b);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'A', path: 'b.ts', oldPath: null });
  });

  it('reports a rename as R with a similarity near 1', async () => {
    const { repo, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const changes = await opened.getChangedFiles(renameCommit);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe('R');
    expect(changes[0]?.oldPath).toBe('a.ts');
    expect(changes[0]?.path).toBe('b.ts');
    expect(changes[0]?.similarity).toBeGreaterThan(0.9);
    expect(changes[0]?.similarity).toBeLessThanOrEqual(1);
  });

  it('findRenames agrees on the same rename', async () => {
    const { repo, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const changes = await opened.findRenames(renameCommit);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe('R');
    expect(changes[0]?.oldPath).toBe('a.ts');
    expect(changes[0]?.path).toBe('b.ts');
  });

  it('reports the whole tree for the first commit in a repository', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await writeFile(repo, 'b.ts', EXTENDED);
    const a = await commit(repo, 'A: initial');

    const opened = await GitRepository.open(repo.dir);
    const changes = await opened.getChangedFiles(a);

    expect(changes.map((change) => change.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('reports a deletion', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await writeFile(repo, 'b.ts', EXTENDED);
    await commit(repo, 'A');
    await rmFile(repo, 'b.ts');
    const b = await commit(repo, 'B: delete b.ts');

    const opened = await GitRepository.open(repo.dir);
    const changes = await opened.getChangedFiles(b);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'D', path: 'b.ts' });
  });

  it('handles a path with spaces and unicode', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');
    await writeFile(repo, '文档/my file.ts', 'export const cjk = 1;\n');
    const b = await commit(repo, 'B: unicode path');

    const opened = await GitRepository.open(repo.dir);
    const changes = await opened.getChangedFiles(b);

    expect(changes[0]?.path).toBe('文档/my file.ts');
    expect(await opened.getFileAtCommit(b, '文档/my file.ts')).toBe('export const cjk = 1;\n');
  });
});

describe('getBlame', () => {
  it('attributes lines to two authors with correct 1-based numbers', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A: original', { author: TEST_AUTHOR });
    await writeFile(repo, 'a.ts', CHANGED);
    const b = await commit(repo, 'B: change beta', { author: OTHER_AUTHOR });

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame('HEAD', 'a.ts');

    expect(blame.filePath).toBe('a.ts');
    expect(blame.lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5, 6]);

    const changedLines = blame.lines.filter((line) => line.commit === b);
    expect(changedLines.map((line) => line.line)).toEqual([5]);
    expect(changedLines[0]?.author).toBe(OTHER_AUTHOR.name);

    const originalLines = blame.lines.filter((line) => line.commit === a);
    expect(originalLines.map((line) => line.line)).toEqual([1, 2, 3, 4, 6]);
    expect(originalLines[0]?.author).toBe(TEST_AUTHOR.name);

    expect(blame.authorLineCounts).toEqual([
      { author: TEST_AUTHOR.name, lines: 5 },
      { author: OTHER_AUTHOR.name, lines: 1 },
    ]);
  });

  it('blames a line range', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'a.ts', CHANGED);
    const b = await commit(repo, 'B');

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame('HEAD', 'a.ts', 1, 2);

    expect(blame.lines.map((line) => line.line)).toEqual([1, 2]);
    expect(blame.lines.every((line) => line.commit === a)).toBe(true);

    const mixed = await opened.getBlame('HEAD', 'a.ts', 5, 6);
    expect(mixed.lines.map((line) => line.line)).toEqual([5, 6]);
    expect(mixed.lines.map((line) => line.commit)).toEqual([b, a]);
  });

  it('clamps a range that runs past the end of the file', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame('HEAD', 'a.ts', 1, 9999);

    expect(blame.lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('clamps a range that starts before the first line', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    await commit(repo, 'A');

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame('HEAD', 'a.ts', -5, 2);

    expect(blame.lines.map((line) => line.line)).toEqual([1, 2]);
  });

  it('returns an empty result for a path that does not exist at that commit', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    await writeFile(repo, 'later.ts', 'export const later = 1;\n');
    await commit(repo, 'B');

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame(a, 'later.ts');

    expect(blame).toEqual({ filePath: 'later.ts', commit: a, lines: [], authorLineCounts: [] });
  });

  it('blames through a rename', async () => {
    const { repo, a, b, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const blame = await opened.getBlame(renameCommit, 'b.ts');
    expect(blame.filePath).toBe('b.ts');
    // EXTENDED is ten lines, not nine: the six original lines, the blank
    // separator the fixture inserts, and the three lines of `gamma`. Git numbers
    // its final hunk `10 10`, so ten is what a correct parser must report.
    expect(blame.lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The point of the test: blame reaches *through* the rename commit to the
    // commits that wrote the content, instead of pinning every line to the
    // commit that merely moved the file.
    expect(blame.lines.map((line) => line.commit)).toEqual([a, a, a, a, a, a, b, b, b, b]);
  });

  it('returns an empty result for an empty file', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'empty.ts', '');
    await commit(repo, 'A: empty');

    const opened = await GitRepository.open(repo.dir);
    const blame = await opened.getBlame('HEAD', 'empty.ts');
    expect(blame.lines).toEqual([]);
  });
});

describe('getFileHistory', () => {
  it('follows a rename from a.ts to b.ts', async () => {
    const { repo, a, b, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const history = await opened.getFileHistory('b.ts', { followRenames: true });

    expect(history.map((entry) => entry.hash)).toEqual([renameCommit, b, a]);
  });

  it('stops at the rename when renames are not followed', async () => {
    const { repo, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const history = await opened.getFileHistory('b.ts', { followRenames: false });

    expect(history.map((entry) => entry.hash)).toEqual([renameCommit]);
  });

  it('accepts an options object as well as a path', async () => {
    const { repo, a, b, renameCommit } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const history = await opened.getFileHistory({ path: 'b.ts', followRenames: true });

    expect(history.map((entry) => entry.hash)).toEqual([renameCommit, b, a]);
  });
});

describe('branches, divergence and merges', () => {
  it('sees both sides of a divergence with includeAllBranches', async () => {
    const { repo, a } = await makeRenameRepo();
    await checkoutNewBranch(repo, 'feature');
    await writeFile(repo, 'feature.ts', 'export const feature = 1;\n');
    const featureTip = await commit(repo, 'feature work', { author: OTHER_AUTHOR });
    await checkout(repo, 'main');

    const opened = await GitRepository.open(repo.dir);
    const mainOnly = await opened.getCommitHistory();
    const all = await opened.getCommitHistory({ includeAllBranches: true });

    expect(mainOnly.map((entry) => entry.hash)).not.toContain(featureTip);
    expect(all.map((entry) => entry.hash)).toContain(featureTip);
    expect(all.length).toBeGreaterThan(mainOnly.length);
    expect(all.map((entry) => entry.hash)).toContain(a);
  });

  it('finds the fork point as the merge base of main and feature', async () => {
    const { repo, renameCommit } = await makeRenameRepo();
    await checkoutNewBranch(repo, 'feature');
    await writeFile(repo, 'feature.ts', 'export const feature = 1;\n');
    await commit(repo, 'feature work');
    await checkout(repo, 'main');

    const opened = await GitRepository.open(repo.dir);
    // The branch forked from HEAD at the time it was created, so the fork point
    // is the rename commit, not the first commit in the repository.
    expect(await opened.getMergeBase('main', 'feature')).toBe(renameCommit);
    expect(await opened.getFirstParent(renameCommit)).not.toBeNull();
  });

  it('parses a merge commit with two parents and reports what it brought in', async () => {
    const { repo } = await makeRenameRepo();
    await checkoutNewBranch(repo, 'feature');
    await writeFile(repo, 'feature.ts', 'export const feature = 1;\n');
    const featureTip = await commit(repo, 'feature work', { author: OTHER_AUTHOR });
    await checkout(repo, 'main');
    const mergeCommit = await merge(repo, 'merge feature', 'feature');

    const opened = await GitRepository.open(repo.dir);
    const parsed = await opened.getCommit(mergeCommit);

    expect(parsed.isMerge).toBe(true);
    expect(parsed.parents).toHaveLength(2);
    expect(parsed.parents).toContain(featureTip);

    const changed = await opened.getChangedFiles(mergeCommit);
    expect(changed.map((change) => change.path)).toContain('feature.ts');
  });

  it('lists the merge commit in the history of main', async () => {
    const { repo } = await makeRenameRepo();
    await checkoutNewBranch(repo, 'feature');
    await writeFile(repo, 'feature.ts', 'export const feature = 1;\n');
    await commit(repo, 'feature work');
    await checkout(repo, 'main');
    const mergeCommit = await merge(repo, 'merge feature', 'feature');

    const opened = await GitRepository.open(repo.dir);
    const history = await opened.getCommitHistory();

    expect(history[0]?.hash).toBe(mergeCommit);
    expect(history[0]?.isMerge).toBe(true);
  });

  it('findRenames sees a rename that arrived through a merge', async () => {
    const { repo, renameCommit } = await makeRenameRepo();
    await checkoutNewBranch(repo, 'renamer');
    await runIn(repo, ['mv', 'b.ts', 'c.ts']);
    const renameOnBranch = await commit(repo, 'rename b.ts to c.ts');
    await checkout(repo, 'main');
    const mergeCommit = await merge(repo, 'merge renamer', 'renamer');

    const opened = await GitRepository.open(repo.dir);
    const changes = await opened.findRenames(renameOnBranch);

    expect(changes[0]?.status).toBe('R');
    expect(changes[0]?.oldPath).toBe('b.ts');
    expect(changes[0]?.path).toBe('c.ts');
    // The merge base is the fork point *on the branch side*, and merging moved
    // it: before the merge, main and renamer diverged at the rename commit;
    // afterwards renamer's tip is an ancestor of main, so it is itself the best
    // common ancestor. The merge commit can never be the answer — it is not an
    // ancestor of the branch it merged.
    expect(await opened.getMergeBase(`${mergeCommit}^1`, 'renamer')).toBe(renameCommit);
    expect(await opened.getMergeBase('main', 'renamer')).toBe(renameOnBranch);
    expect(renameCommit).not.toBe(mergeCommit);
  });
});

describe('getChangedFilesSince', () => {
  it('lists only the paths touched between two commits', async () => {
    const { repo, a, b } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const since = await opened.getChangedFilesSince(a, b);
    expect(since).toEqual(['a.ts']);

    const afterRename = await opened.getChangedFilesSince(b, 'HEAD');
    // A rename must contribute *both* paths, or an incremental scan keeps a
    // stale entry for the file that no longer exists.
    expect(afterRename.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('returns an empty array when nothing changed', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', ORIGINAL);
    const a = await commit(repo, 'A');
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getChangedFilesSince(a, a)).toEqual([]);
  });

  it('defaults the upper bound to HEAD', async () => {
    const { repo, a } = await makeRenameRepo();
    const opened = await GitRepository.open(repo.dir);

    const since = await opened.getChangedFilesSince(a);
    expect(since.sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('working tree and history stay in sync', () => {
  it('sees an uncommitted edit as dirty but leaves the history alone', async () => {
    const { repo } = await makeRenameRepo();
    await writeFile(repo, 'b.ts', `${EXTENDED}// local edit\n`);

    const opened = await GitRepository.open(repo.dir);
    expect(await opened.isDirty('b.ts')).toBe(true);
    expect(await opened.getFileAtCommit('HEAD', 'b.ts')).toBe(EXTENDED);
    expect(await readFile(repo, 'b.ts')).toContain('// local edit');
  });

  it('keeps branch bookkeeping consistent after creating branches', async () => {
    const { repo } = await makeRenameRepo();
    await branch(repo, 'side');

    const opened = await GitRepository.open(repo.dir);
    const branches = await opened.getBranches();

    expect(branches.map((entry) => entry.name).sort()).toEqual(['main', 'side']);
    expect(branches.every((entry) => entry.tip.length === 40)).toBe(true);
  });
});
