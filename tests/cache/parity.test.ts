/**
 * Backend parity and a durability/throughput smoke test.
 *
 * Parity is the promise the rest of the extension relies on: after a schema
 * change, or a user who switches `ancestry.cache.backend`, the *same* analysis
 * must get the *same* answers out of the cache. Any divergence here is a bug that
 * would show up as "it only works on my machine".
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCacheStore,
  makeBlockCacheKey,
  sqliteDatabasePath,
  SqliteCacheStore,
} from '../../src/cache';
import { CACHE_SCHEMA_VERSION } from '../../src/types';
import type { CacheBackendName, ICacheStore } from '../../src/types';
import {
  COMMIT_1,
  COMMIT_2,
  FILE_A,
  FILE_B,
  FIXED_NOW,
  REPO_A,
  REPO_B,
  makeBlock,
  makeMatch,
  makeNormalized,
  makeRepository,
  removeDir,
  sqliteAvailableSync,
} from './suite';

const SQLITE_AVAILABLE = sqliteAvailableSync();

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-parity-'));
});

afterEach(async () => {
  await removeDir(dir);
});

/** Build a store of the requested backend in its own subdirectory. */
async function openStore(backend: CacheBackendName, name: string): Promise<ICacheStore> {
  const target = path.join(dir, name);
  if (backend === 'sqlite') {
    return new SqliteCacheStore({
      filePath: sqliteDatabasePath(target, CACHE_SCHEMA_VERSION),
      now: () => FIXED_NOW,
    });
  }
  return new FileCacheStore({ directory: target, now: () => FIXED_NOW });
}

/** One scenario's worth of writes, shared by both backends. */
async function seed(store: ICacheStore): Promise<void> {
  await store.putRepository(makeRepository());
  await store.putRepository(
    makeRepository({ repoRoot: REPO_B, headCommit: COMMIT_2, indexedCommitCount: 9 }),
  );
  await store.putBlock(
    makeBlock({ textHash: 'alpha', range: { ...makeBlock().range, startLine: 5 } }),
  );
  await store.putBlock(
    makeBlock({
      textHash: 'beta',
      filePath: FILE_B,
      range: { ...makeBlock().range, startLine: 12 },
    }),
  );
  await store.putBlock(makeBlock({ commit: COMMIT_2, textHash: 'gamma' }));
  await store.putNormalizations([
    makeNormalized('alpha'),
    makeNormalized('beta'),
    makeNormalized('not-stored'),
  ]);
  await store.putMatch(makeMatch('alpha', 'beta'));
  await store.putMatch(makeMatch('beta', 'alpha', { similarity: 0.42 }));
}

describe.skipIf(!SQLITE_AVAILABLE)('backend parity', () => {
  it('reports matching repository records', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    await expect(sqlite.getRepository(REPO_A)).resolves.toEqual(await file.getRepository(REPO_A));
    await expect(sqlite.getRepository(REPO_B)).resolves.toEqual(await file.getRepository(REPO_B));
    await file.close();
    await sqlite.close();
  });

  it('reports matching blocks for a file', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    await expect(sqlite.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual(
      await file.getBlocksForFile(REPO_A, FILE_A, COMMIT_1),
    );
    await expect(sqlite.getBlocksForFile(REPO_A, FILE_B, COMMIT_1)).resolves.toEqual(
      await file.getBlocksForFile(REPO_A, FILE_B, COMMIT_1),
    );
    await expect(sqlite.getBlocksForFile(REPO_A, FILE_A, COMMIT_2)).resolves.toEqual(
      await file.getBlocksForFile(REPO_A, FILE_A, COMMIT_2),
    );
    await file.close();
    await sqlite.close();
  });

  it('resolves a single block identically', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await file.putBlock(block);
    await sqlite.putBlock(block);
    await expect(sqlite.getBlock(key)).resolves.toEqual(await file.getBlock(key));
    // And a key neither store ever issued is a miss on both.
    await expect(sqlite.getBlock('0'.repeat(32))).resolves.toEqual(
      await file.getBlock('0'.repeat(32)),
    );
    await file.close();
    await sqlite.close();
  });

  it('reports matching normalisation batches', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    const request = ['alpha', 'beta', 'gamma', 'not-stored'];
    await expect(sqlite.getNormalizations(request)).resolves.toEqual(
      await file.getNormalizations(request),
    );
    await file.close();
    await sqlite.close();
  });

  it('reports matching matches in both directions', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    for (const pair of [
      ['alpha', 'beta'],
      ['beta', 'alpha'],
      ['alpha', 'gamma'],
    ] as const) {
      await expect(sqlite.getMatch(pair[0], pair[1])).resolves.toEqual(
        await file.getMatch(pair[0], pair[1]),
      );
    }
    await file.close();
    await sqlite.close();
  });

  it('agrees on entry counts', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    expect((await file.stats()).entries).toBe(0);
    expect((await sqlite.stats()).entries).toBe(0);
    await seed(file);
    await seed(sqlite);
    expect((await sqlite.stats()).entries).toBe((await file.stats()).entries);
    await file.close();
    await sqlite.close();
  });

  it('agrees on repository counts and non-zero size', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    const fileStats = await file.stats();
    const sqliteStats = await sqlite.stats();
    expect(sqliteStats.repositoryCount).toBe(fileStats.repositoryCount);
    expect(fileStats.bytes).toBeGreaterThan(0);
    expect(sqliteStats.bytes).toBeGreaterThan(0);
    await file.close();
    await sqlite.close();
  });

  it('agrees on what survives a purge', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    const cutoff = FIXED_NOW + 1;
    expect(await sqlite.purgeOlderThan(cutoff)).toBe(await file.purgeOlderThan(cutoff));
    // `.resolves` needs the *promise*, so this call must not be awaited before
    // it reaches `expect`: awaiting first hands `expect` a plain array.
    await expect(sqlite.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual(
      await file.getBlocksForFile(REPO_A, FILE_A, COMMIT_1),
    );
    await file.close();
    await sqlite.close();
  });

  it('agrees after clear()', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    await seed(file);
    await seed(sqlite);
    await file.clear();
    await sqlite.clear();
    expect((await sqlite.stats()).entries).toBe((await file.stats()).entries);
    await expect(sqlite.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual(
      await file.getBlocksForFile(REPO_A, FILE_A, COMMIT_1),
    );
    await file.close();
    await sqlite.close();
  });

  it('survives a store handover with the same data', async () => {
    const file = await openStore('file', 'file');
    const sqlite = await openStore('sqlite', 'sqlite');
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await file.putBlock(block);
    await file.close();
    // Same directory: a handover is "the extension restarts and reopens the
    // index", not "a different cache directory". Reopening `file-again` would
    // read an empty store and a miss would be the correct answer there.
    const reopened = await openStore('file', 'file');
    await expect(reopened.getBlock(key)).resolves.toEqual(block);
    await sqlite.close();
    await reopened.close();
  });
});

describe.skipIf(!SQLITE_AVAILABLE)('durability and throughput', () => {
  const WORK = 2_000;
  const SMALL_WORK = 250;
  const CONCURRENCY = 24;

  /**
   * Absolute ceilings, deliberately loose.
   *
   * These exist to catch an order-of-magnitude regression, nothing finer. Vitest
   * runs test *files* in parallel, so a wall-clock assertion here is measuring how
   * busy the machine is: this same batch measured ~4 s alone and ~19 s while the
   * other 51 files ran. A tight budget therefore fails on CI load while saying
   * nothing about the code, which is the worst kind of test.
   */
  const CEILING_MS = { file: 60_000, sqlite: 30_000 } as const;

  /**
   * How much slower an 8x larger batch may be, on the **same** backend.
   *
   * This replaced a cross-backend ratio (file time / SQLite time), which looked
   * clever and was wrong: the two backends do not degrade under load in the same
   * way, because they are not bounded by the same thing. The file store is
   * filesystem-latency bound, so contention inflates it hard; SQLite is not, so it
   * barely moves. The ratio therefore *grew* under load — 3.7x when idle, 6.6x on a
   * moderately busy machine, 14.8x on a busy one — which is the opposite of
   * load-invariant. Dividing two differently-bottlenecked measurements does not
   * cancel the load out; it weights it.
   *
   * Scaling the *same* backend against itself does cancel it: both measurements
   * share one bottleneck and are taken back to back, so contention inflates both.
   * An O(n) implementation costs ~8x for 8x the records; an accidental O(n^2)
   * costs ~64x. The ceiling sits between the two with room for a noisy machine.
   */
  const MAX_GROWTH_FACTOR = 20;

  interface BatchOutcome {
    found: number;
    elapsed: number;
  }

  const outcomes: Partial<Record<'file' | 'sqlite', BatchOutcome>> = {};
  let smallFileBatch = 0;

  /** Run the batch on one backend and return how long it took. */
  async function runBatch(backend: 'file' | 'sqlite', work = WORK): Promise<BatchOutcome> {
    // The suffix keeps the scaling batches in separate directories, so the small
    // run cannot warm the large one's shards (or collide with them).
    const name = work === WORK ? backend : `${backend}-small`;
    const store = await openStore(backend, name);
    await store.init();

    const normalizations = Array.from({ length: work }, (_, index) =>
      makeNormalized(`perf-norm-${index}`),
    );
    // Each file lives in its own repository so the per-repository index stays
    // small: the point of this test is the per-record cost, not index growth.
    const blocks = Array.from({ length: work }, (_, index) =>
      makeBlock({
        repoRoot: `C:\\perf\\repo-${index}`,
        filePath: `src/perf-${index}.ts`,
        textHash: `perf-hash-${index}`,
        range: { ...makeBlock().range, startLine: index + 1 },
      }),
    );

    // An analysis caches blocks as it parses them, so it issues these
    // concurrently; this mirrors that with a bounded number in flight.
    const started = Date.now();
    await store.putNormalizations(normalizations);
    await forEachBounded(blocks, CONCURRENCY, (block) => store.putBlock(block));
    let found = 0;
    await forEachBounded(blocks, CONCURRENCY, async (block) => {
      // The accumulator must be updated *after* the await returns.
      // `found += (await …).length` reads the current total before the
      // right-hand side is evaluated and writes it back after the resumption,
      // so every in-flight worker would clobber the others' increments and the
      // total would come out a small fraction of the real one — a lost update
      // in the measurement, not in the store.
      const blocksForFile = await store.getBlocksForFile(
        block.repoRoot,
        block.filePath,
        block.commit,
      );
      found += blocksForFile.length;
    });
    const elapsed = Date.now() - started;

    // Correctness, and still-consistent-afterwards: every normalisation is
    // retrievable and the block lookup by key agrees with the per-file lookup.
    expect(found).toBe(work);
    const sample = normalizations.slice(0, 50).map((entry) => entry.blockId);
    const map = await store.getNormalizations(sample);
    expect(map.size).toBe(sample.length);
    const first = blocks[0];
    const key = makeBlockCacheKey(
      first?.repoRoot ?? '',
      first?.commit ?? '',
      first?.filePath ?? '',
      first?.textHash ?? '',
    );
    await expect(store.getBlock(key)).resolves.toEqual(first);
    await store.close();

    return { found, elapsed };
  }

  beforeAll(async () => {
    // The two scaling batches run back to back on the same backend, so they share
    // one bottleneck and one machine load; only the problem size differs.
    smallFileBatch = (await runBatch('file', SMALL_WORK)).elapsed;
    outcomes.sqlite = await runBatch('sqlite');
    outcomes.file = await runBatch('file');
  }, 300_000);

  for (const backend of ['file', 'sqlite'] as const) {
    it(`${backend}: handles ${WORK} normalisations and ${WORK} per-file reads`, () => {
      const outcome = outcomes[backend];
      expect(outcome?.found).toBe(WORK);
      expect(outcome?.elapsed).toBeLessThan(CEILING_MS[backend]);
    });
  }

  it(`scales sub-quadratically from ${SMALL_WORK} to ${WORK} records`, () => {
    const large = outcomes.file?.elapsed ?? Number.POSITIVE_INFINITY;
    const growth = large / Math.max(1, smallFileBatch);
    const sizeRatio = WORK / SMALL_WORK;
    // Printed so a slow or super-linear run is visible in CI output rather than
    // silently tolerated.
    console.log(
      `  file backend: ${smallFileBatch} ms at ${SMALL_WORK} records -> ${large} ms at ${WORK} ` +
        `(${growth.toFixed(1)}x for ${sizeRatio}x the work; O(n) ~${sizeRatio}x, ` +
        `O(n^2) ~${sizeRatio ** 2}x; ceiling ${MAX_GROWTH_FACTOR}x)`,
    );
    // O(n) predicts ~8x. Anything approaching 64x is a quadratic regression, and
    // the ceiling sits well below that while tolerating a noisy machine.
    expect(growth).toBeLessThan(MAX_GROWTH_FACTOR);
  });
});

/** Apply `task` to every item with at most `limit` calls in flight. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = cursor++; index < items.length; index = cursor++) {
        await task(items[index] as T);
      }
    }),
  );
}
