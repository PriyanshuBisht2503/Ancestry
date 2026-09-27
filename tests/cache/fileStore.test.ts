/**
 * File-store specific behaviour, on top of the shared contract suite:
 * on-disk layout, per-key write serialisation, the `stats()` scan cache, and the
 * file-level corruption cases that the SQL backend cannot reproduce.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCacheStore,
  makeBlockCacheKey,
  makeRepoKey,
  sha256Hex,
  stableStringify,
} from '../../src/cache';
import type { ICacheStore } from '../../src/types';
import { CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../../src/types';
import {
  COMMIT_1,
  FILE_A,
  FIXED_NOW,
  REPO_A,
  describeStoreContract,
  makeBlock,
  makeNormalized,
  makeRepository,
  removeDir,
} from './suite';

/** Captures the diagnostics the store emits. */
function recordingLogger(): {
  logger: { debug(msg: string): void; warn(msg: string): void };
  warnings: string[];
  debugs: string[];
} {
  const warnings: string[] = [];
  const debugs: string[] = [];
  return {
    logger: {
      debug: (msg: string) => debugs.push(msg),
      warn: (msg: string) => warnings.push(msg),
    },
    warnings,
    debugs,
  };
}

describeStoreContract(
  'file store',
  (dir) => Promise.resolve(new FileCacheStore({ directory: dir, now: () => FIXED_NOW })),
  'file',
);

describe('FileCacheStore layout', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-file-'));
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  function open(options: { now?: () => number; scanTtlMs?: number } = {}): FileCacheStore {
    return new FileCacheStore({ directory: dir, now: () => FIXED_NOW, ...options });
  }

  /** Absolute path of the record file for a key, derived from the public layout. */
  function recordPath(key: string): string {
    return path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, key.slice(0, 2), `${key}.json`);
  }

  it('locates records under ancestry-cache/<version>/<shard>/<key>.json', async () => {
    const store = open();
    await store.init();
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const raw = await fs.readFile(recordPath(key), 'utf8');
    const record = JSON.parse(raw) as { v: string; k: string; t: number; c: string };
    expect(record.v).toBe(CACHE_SCHEMA_VERSION);
    expect(record.k).toBe(key);
    expect(record.t).toBe(block.cachedAt);
    expect(record.c).toBe(sha256Hex(stableStringify(block)));
    await store.close();
  });

  it('shards by the first two hex characters', async () => {
    const store = open();
    await store.init();
    for (let index = 0; index < 40; index += 1) {
      const block = makeBlock({ textHash: `shard-${index}` });
      await store.putBlock(block);
    }
    const shards = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    const twoChar = shards.filter((name) => /^[0-9a-f]{2}$/.test(name));
    expect(twoChar.length).toBeGreaterThan(1);
    await store.close();
  });

  it('keeps a per-repository index alongside the records', async () => {
    const store = open();
    await store.init();
    await store.putBlock(makeBlock());
    const root = path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION);
    // The index lives in the repository's own directory, `<repoKey>/index.json`.
    // It is deliberately *not* sharded: shards spread records, and one directory
    // per repository keeps the per-file lookup a single open. Picking the path
    // from `readdir` (as this test used to) reads the record shard instead —
    // `readdir` orders `'69'` before `'ca9…'` — which asserts nothing about the
    // index at all.
    const repoDirs = await fs.readdir(root);
    expect(repoDirs).toContain(makeRepoKey(REPO_A));
    const index = await fs.readFile(path.join(root, makeRepoKey(REPO_A), 'index.json'), 'utf8');
    const parsed = JSON.parse(index) as { files: Record<string, string[]> };
    expect(Object.keys(parsed.files)).toContain(`${COMMIT_1}::${FILE_A}`);
    await store.close();
  });

  it('does not lose index entries when puts overlap', async () => {
    const store = open();
    await store.init();
    const blocks = Array.from({ length: 30 }, (_, index) =>
      makeBlock({ textHash: `concurrent-${index}` }),
    );
    await Promise.all(blocks.map((block) => store.putBlock(block)));
    const found = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
    expect(found).toHaveLength(30);
    await store.close();
  });

  it('does not lose index entries across different files', async () => {
    const store = open();
    await store.init();
    await Promise.all([
      store.putBlock(makeBlock()),
      store.putBlock(makeBlock({ filePath: 'src/other.ts', textHash: 'other' })),
      store.putBlock(makeBlock({ commit: 'deadbeef', textHash: 'other-commit' })),
    ]);
    expect(await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).toHaveLength(1);
    expect(await store.getBlocksForFile(REPO_A, 'src/other.ts', COMMIT_1)).toHaveLength(1);
    expect(await store.getBlocksForFile(REPO_A, FILE_A, 'deadbeef')).toHaveLength(1);
    await store.close();
  });

  it('reports a note supplied by the factory', () => {
    const store = new FileCacheStore({ directory: dir, note: 'forced by configuration' });
    expect(store.info.note).toBe('forced by configuration');
    expect(store.info.native).toBe(false);
  });

  it('has no note by default', () => {
    expect(new FileCacheStore({ directory: dir }).info.note).toBeNull();
  });

  it('reuses a stats() scan for the configured window', async () => {
    let clock = FIXED_NOW;
    const store = open({ now: () => clock, scanTtlMs: 30_000 });
    await store.init();
    await store.putRepository(makeRepository());
    expect((await store.stats()).entries).toBe(1);

    // Simulate another process writing directly into the cache directory: the
    // store cannot know, so the cached scan is served until the window expires.
    const shard = path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, 'ff');
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(
      path.join(shard, `${'f'.repeat(32)}.json`),
      JSON.stringify({ v: CACHE_SCHEMA_VERSION, k: 'f'.repeat(32), t: FIXED_NOW, c: 'x', p: {} }),
    );
    expect((await store.stats()).entries).toBe(1);

    clock += 30_001;
    expect((await store.stats()).entries).toBe(2);
    await store.close();
  });

  it('re-scans after a write invalidates the cache', async () => {
    const store = open();
    await store.init();
    expect((await store.stats()).entries).toBe(0);
    await store.putRepository(makeRepository());
    expect((await store.stats()).entries).toBe(1);
    await store.close();
  });

  it('refuses a key that could escape the cache root', async () => {
    const store = open();
    await store.init();
    for (const hostile of [
      '../../../etc/passwd',
      '..\\..\\windows\\system32\\config',
      '/absolute/path',
      'C:/absolute/path',
      'short',
      '',
    ]) {
      await expect(store.getBlock(hostile)).resolves.toBeNull();
    }
    await store.close();
  });

  it('ignores a symlink planted where a record belongs', async () => {
    const store = open();
    await store.init();
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const outside = path.join(dir, 'outside.json');
    await fs.writeFile(outside, await fs.readFile(recordPath(key), 'utf8'));
    await removeDir(recordPath(key));
    try {
      await fs.symlink(outside, recordPath(key));
    } catch {
      // Symlink creation needs a privilege on some Windows configurations; the
      // rest of the suite still covers the traversal defences.
      await store.close();
      return;
    }
    await expect(store.getBlock(key)).resolves.toBeNull();
    // The file outside the cache must survive.
    expect((await fs.stat(outside)).isFile()).toBe(true);
    await store.close();
  });

  it('does not follow a directory placed where a record belongs', async () => {
    const store = open();
    await store.init();
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await fs.mkdir(recordPath(key), { recursive: true });
    await expect(store.getBlock(key)).resolves.toBeNull();
    await store.close();
  });

  it('creates the cache root on init() even when nothing is written', async () => {
    const store = open();
    await store.init();
    expect(
      (await fs.stat(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION))).isDirectory(),
    ).toBe(true);
    await store.close();
  });

  it('keeps normalisations of a foreign version out of the store', async () => {
    const store = open();
    await store.init();
    await store.putNormalizations([
      makeNormalized('current', { normalizationVersion: NORMALIZATION_VERSION }),
      makeNormalized('future', { normalizationVersion: '999' }),
    ]);
    const found = await store.getNormalizations(['current', 'future']);
    expect([...found.keys()]).toEqual(['current']);
    expect((await store.stats()).entries).toBe(1);
    await store.close();
  });

  it('exposes the number of discarded records', async () => {
    const { logger, warnings } = recordingLogger();
    const store = new FileCacheStore({ directory: dir, now: () => FIXED_NOW, logger });
    await store.init();
    expect(store.corruptions).toBe(0);
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    await fs.writeFile(recordPath(key), '{"v":"1","k":"other","t":1,"c":"x","p":{}}');
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(store.corruptions).toBe(1);
    expect(warnings.join('\n')).toMatch(/corrupt record/i);
    await store.close();
  });

  it('logs nothing that contains source text', async () => {
    const { logger, warnings, debugs } = recordingLogger();
    const store = new FileCacheStore({ directory: dir, now: () => FIXED_NOW, logger });
    await store.init();
    const secret = 'const API_KEY = "super-secret-value";';
    const block = makeBlock({ text: secret, textHash: 'secret' });
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    await fs.writeFile(recordPath(key), `${secret} truncated garbage`);
    await expect(store.getBlock(key)).resolves.toBeNull();
    const logged = [...warnings, ...debugs].join('\n');
    expect(logged).not.toContain('super-secret-value');
    expect(logged).not.toContain(secret);
    await store.close();
  });

  it('survives an unreadable cache directory during purge', async () => {
    const store = open();
    await store.init();
    await store.putBlock(makeBlock({ cachedAt: 1, textHash: 'old' }));
    await removeDir(path.join(dir, 'ancestry-cache'));
    await expect(store.purgeOlderThan(FIXED_NOW)).resolves.toBe(0);
    // And it recovers: a later write recreates what it needs.
    const fresh = makeBlock({ textHash: 'fresh' });
    await store.putBlock(fresh);
    const key = makeBlockCacheKey(fresh.repoRoot, fresh.commit, fresh.filePath, fresh.textHash);
    await expect(store.getBlock(key)).resolves.toEqual(fresh);
    await store.close();
  });

  it('removes shard directories that become empty', async () => {
    const store = open();
    await store.init();
    await store.putBlock(makeBlock({ cachedAt: 1, textHash: 'old' }));
    await store.purgeOlderThan(FIXED_NOW);
    const shards = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    expect(shards.some((name) => /^[0-9a-f]{2}$/.test(name))).toBe(false);
    await store.close();
  });

  it('waits for queued writes before clearing', async () => {
    const store: ICacheStore = open();
    await store.init();
    const block = makeBlock();
    const writes = store.putBlock(block);
    await store.clear();
    await writes;
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    // clear() ran after the queued write, so the record is gone.
    await expect(store.getBlock(key)).resolves.toBeNull();
    await store.close();
  });
});
