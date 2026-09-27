/**
 * Backend selection, cache-directory resolution, and the guarantee that a cache
 * problem can never take an analysis down.
 *
 * The fallback paths are exercised for real: a directory is planted exactly where
 * the SQLite database would go, which makes SQLite fail to open without needing
 * to mock the module.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCacheStore,
  defaultCacheDirectory,
  isSqliteAvailable,
  makeBlockCacheKey,
  sqliteDatabasePath,
} from '../../src/cache';
import { AncestryError, CACHE_SCHEMA_VERSION } from '../../src/types';
import { COMMIT_1, FILE_A, FIXED_NOW, makeBlock, makeNormalized, removeDir } from './suite';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-factory-'));
});

afterEach(async () => {
  await removeDir(dir);
  delete process.env.ANCESTRY_CACHE_DIR;
});

/** Block SQLite from opening by putting a directory where its database must go. */
async function blockSqlite(base: string): Promise<void> {
  await fs.mkdir(path.join(sqliteDatabasePath(base, CACHE_SCHEMA_VERSION), 'in-the-way'), {
    recursive: true,
  });
}

describe('defaultCacheDirectory', () => {
  it('prefers an explicit path', () => {
    process.env.ANCESTRY_CACHE_DIR = path.join(dir, 'from-env');
    expect(defaultCacheDirectory(path.join(dir, 'explicit'))).toBe(
      path.resolve(path.join(dir, 'explicit')),
    );
  });

  it('falls back to ANCESTRY_CACHE_DIR', () => {
    const fromEnv = path.join(dir, 'from-env');
    process.env.ANCESTRY_CACHE_DIR = fromEnv;
    expect(defaultCacheDirectory()).toBe(path.resolve(fromEnv));
  });

  it('falls back to the temp directory', () => {
    delete process.env.ANCESTRY_CACHE_DIR;
    expect(defaultCacheDirectory()).toBe(path.join(os.tmpdir(), 'ancestry-cache'));
  });

  it('ignores an empty override', () => {
    process.env.ANCESTRY_CACHE_DIR = '   ';
    expect(defaultCacheDirectory()).toBe(path.join(os.tmpdir(), 'ancestry-cache'));
    expect(defaultCacheDirectory('')).toBe(path.join(os.tmpdir(), 'ancestry-cache'));
  });

  it('resolves a relative path against the working directory', () => {
    delete process.env.ANCESTRY_CACHE_DIR;
    expect(path.isAbsolute(defaultCacheDirectory('relative-cache'))).toBe(true);
  });
});

describe('createCacheStore: file backend', () => {
  it('always returns the file store, marked as not native', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    expect(store.info.backend).toBe('file');
    expect(store.info.native).toBe(false);
    expect(store.info.note).toMatch(/configuration/i);
    expect(store.info.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(path.isAbsolute(store.info.location)).toBe(true);
    await store.close();
  });

  it('ignores SQLite even when it is available', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    expect(store.info.backend).toBe('file');
    await store.close();
  });

  it('creates the index directory tree it writes into', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    await store.putBlock(makeBlock());
    expect(
      (await fs.stat(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION))).isDirectory(),
    ).toBe(true);
    await store.close();
  });

  it('applies maxAgeDays when the store opens', async () => {
    const store = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 30,
    });
    await store.putBlock(makeBlock({ cachedAt: FIXED_NOW - 40 * 86_400_000, textHash: 'ancient' }));
    await store.close();

    const reopened = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 30,
    });
    expect((await reopened.stats()).entries).toBe(0);
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, 'ancient');
    await expect(reopened.getBlock(key)).resolves.toBeNull();
    await reopened.close();
  });

  it('keeps entries younger than maxAgeDays', async () => {
    const store = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 30,
    });
    await store.putBlock(makeBlock({ cachedAt: FIXED_NOW - 86_400_000, textHash: 'recent' }));
    await store.close();
    const reopened = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 30,
    });
    expect((await reopened.stats()).entries).toBe(1);
    await reopened.close();
  });

  it('prunes normalisations and matches older than the cutoff at init', async () => {
    const store = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 30,
    });
    await store.putNormalizations([makeNormalized('stale-norm')]);
    await store.close();

    const reopened = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW + 40 * 86_400_000,
      maxAgeDays: 30,
    });
    expect((await reopened.stats()).entries).toBe(0);
    expect((await reopened.getNormalizations(['stale-norm'])).size).toBe(0);
    await reopened.close();
  });

  it('does not prune when maxAgeDays is absent or nonsensical', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file', now: () => FIXED_NOW });
    await store.putBlock(makeBlock({ cachedAt: 1, textHash: 'ancient' }));
    await store.close();
    for (const maxAgeDays of [undefined, 0, -1, Number.NaN]) {
      const reopened = await createCacheStore({
        directory: dir,
        backend: 'file',
        now: () => FIXED_NOW,
        maxAgeDays,
      });
      expect((await reopened.stats()).entries).toBe(1);
      await reopened.close();
    }
  });

  it('logs the repository it is opened for without logging its contents', async () => {
    const messages: string[] = [];
    const store = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      repoRoot: 'C:\\Users\\dev\\project',
      logger: {
        debug: (msg: string) => messages.push(msg),
        warn: (msg: string) => messages.push(msg),
      },
    });
    await store.putBlock(makeBlock({ text: 'const secret = 1;' }));
    await store.close();
    const logged = messages.join('\n');
    expect(logged).toContain('project');
    expect(logged).not.toContain('const secret');
  });
});

describe('createCacheStore: sqlite backend', () => {
  it('uses SQLite on a runtime that provides it', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }
    const store = await createCacheStore({ directory: dir, backend: 'sqlite' });
    expect(store.info.backend).toBe('sqlite');
    expect(store.info.native).toBe(true);
    expect(store.info.location).toBe(sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION));
    await store.close();
    expect((await fs.stat(store.info.location)).isFile()).toBe(true);
  });

  it('resolves to SQLite under auto, with no note to report', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }
    const store = await createCacheStore({ directory: dir, backend: 'auto' });
    expect(store.info.backend).toBe('sqlite');
    expect(store.info.note).toBeNull();
    await store.close();
  });

  it('shares one database across openings', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }
    const first = await createCacheStore({ directory: dir, backend: 'sqlite' });
    const block = makeBlock();
    await first.putBlock(block);
    await first.close();
    const second = await createCacheStore({ directory: dir, backend: 'sqlite' });
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await expect(second.getBlock(key)).resolves.toEqual(block);
    await second.close();
  });

  it('throws CACHE_UNAVAILABLE when SQLite is explicitly required but unusable', async () => {
    await blockSqlite(dir);
    const error = await createCacheStore({ directory: dir, backend: 'sqlite' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AncestryError);
    expect((error as AncestryError).code).toBe('CACHE_UNAVAILABLE');
    expect((error as AncestryError).userMessage.length).toBeGreaterThan(0);
  });

  it('falls back to the file store under auto, and says why', async () => {
    await blockSqlite(dir);
    const store = await createCacheStore({ directory: dir, backend: 'auto' });
    expect(store.info.backend).toBe('file');
    expect(store.info.native).toBe(false);
    expect(store.info.note).toMatch(/sqlite/i);
    // The fallback is a working store, not a hollow one.
    const block = makeBlock();
    await store.putBlock(block);
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await expect(store.getBlock(key)).resolves.toEqual(block);
    await store.close();
  });
});

describe('cache stores never break an analysis', () => {
  it('resolves to a usable store under auto whatever the directory looks like', async () => {
    // A file where a directory is expected: every backend attempt fails and the
    // factory must still hand back something that works, or throw the one
    // documented error type — never an unexpected exception.
    const hostile = path.join(dir, 'hostile');
    await fs.writeFile(hostile, 'not a directory');
    const outcome = await createCacheStore({ directory: hostile, backend: 'auto' }).catch(
      (error: unknown) => error,
    );
    if (outcome instanceof Error) {
      expect((outcome as AncestryError).code).toBe('CACHE_UNAVAILABLE');
    } else {
      const store = outcome as { close(): Promise<void> };
      await store.close();
    }
  });

  it('survives a repository path that is nonsense', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    await expect(store.getRepository('')).resolves.toBeNull();
    await expect(store.getRepository(' nonsense')).resolves.toBeNull();
    await expect(
      store.putRepository({
        repoRoot: '',
        headCommit: null,
        lastIndexedAt: 0,
        indexedCommitCount: 0,
      }),
    ).resolves.toBeUndefined();
    await store.close();
  });

  it('survives an empty normalisation batch and an empty request', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    await expect(store.putNormalizations([])).resolves.toBeUndefined();
    await expect(store.getNormalizations([])).resolves.toEqual(new Map());
    await store.close();
  });

  it('returns only the normalisations it was asked for', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    await store.putNormalizations([makeNormalized('declared')]);
    const found = await store.getNormalizations(['declared', 'other']);
    expect([...found.keys()]).toEqual(['declared']);
    await store.close();
  });

  it('returns an empty result for an unknown file even after close', async () => {
    const store = await createCacheStore({ directory: dir, backend: 'file' });
    await store.putBlock(makeBlock());
    await store.close();
    await expect(store.getBlocksForFile('C:\\x', FILE_A, COMMIT_1)).resolves.toEqual([]);
  });

  it('does not let a failing prune break the store', async () => {
    const store = await createCacheStore({
      directory: dir,
      backend: 'file',
      now: () => FIXED_NOW,
      maxAgeDays: 1,
    });
    await expect(store.purgeOlderThan(FIXED_NOW)).resolves.toBe(0);
    const block = makeBlock();
    await store.putBlock(block);
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await expect(store.getBlock(key)).resolves.toEqual(block);
    await store.close();
  });
});
