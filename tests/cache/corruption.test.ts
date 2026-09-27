/**
 * The "corrupted cache" error case from the plan (Phase 14).
 *
 * The rule under test: a damaged index may cost time, never correctness, and must
 * never break an analysis. Every case here damages the store from the outside —
 * truncation, a wrong checksum, a foreign payload, a deleted index — and then
 * asserts three things: the read degrades to a miss, the problem is reported
 * through the logger, and the store still works afterwards.
 *
 * The logger assertions also double as a privacy test: a diagnostic must identify
 * the broken record without ever quoting the code that was cached.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCacheStore,
  makeBlockCacheKey,
  makeBlockNormalizeKey,
  sha256Hex,
  stableStringify,
} from '../../src/cache';
import { CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../../src/types';
import { COMMIT_1, FILE_A, FIXED_NOW, REPO_A, makeBlock, makeNormalized, removeDir } from './suite';

/** One captured diagnostic. */
interface Recorder {
  logger: { debug(msg: string): void; warn(msg: string): void };
  warnings: string[];
  debugs: string[];
  all(): string;
}

function recorder(): Recorder {
  const warnings: string[] = [];
  const debugs: string[] = [];
  return {
    logger: {
      debug: (msg: string) => debugs.push(msg),
      warn: (msg: string) => warnings.push(msg),
    },
    warnings,
    debugs,
    all: () => [...warnings, ...debugs].join('\n'),
  };
}

let dir: string;
let log: Recorder;
let store: FileCacheStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-corrupt-'));
  log = recorder();
  store = new FileCacheStore({ directory: dir, now: () => FIXED_NOW, logger: log.logger });
  await store.init();
});

afterEach(async () => {
  await store.close();
  await removeDir(dir);
});

/** Path of a record file, derived from the documented on-disk layout. */
function recordPath(key: string): string {
  return path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, key.slice(0, 2), `${key}.json`);
}

/** Put one block and return its cache key. */
async function seedBlock(): Promise<string> {
  const block = makeBlock({ text: 'const apiKey = "hunter2";' });
  const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
  await store.putBlock(block);
  return key;
}

/** Path of a stored normalisation, addressed through the public key helper. */
function normalizationPath(blockId: string): string {
  const key = makeBlockNormalizeKey(blockId, NORMALIZATION_VERSION);
  return recordPath(key);
}

describe('file store: corrupted records', () => {
  it('treats a truncated record as a miss, warns, and discards the file', async () => {
    const key = await seedBlock();
    await fs.writeFile(recordPath(key), '{"v":"1","k":"trun');
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/corrupt record/i);
    expect(store.corruptions).toBe(1);
    // The unusable file is removed, not left to fail again on every read.
    await expect(fs.stat(recordPath(key))).rejects.toThrow();
  });

  it('treats a record truncated to ten bytes as a miss', async () => {
    const key = await seedBlock();
    const raw = await fs.readFile(recordPath(key), 'utf8');
    await fs.writeFile(recordPath(key), raw.slice(0, 10));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.length).toBeGreaterThan(0);
  });

  it('treats a wrong checksum as a miss', async () => {
    const key = await seedBlock();
    const raw = JSON.parse(await fs.readFile(recordPath(key), 'utf8')) as Record<string, unknown>;
    raw.c = sha256Hex('something else entirely');
    await fs.writeFile(recordPath(key), JSON.stringify(raw));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/checksum mismatch/i);
  });

  it('treats a silently edited payload as a miss', async () => {
    const key = await seedBlock();
    const raw = JSON.parse(await fs.readFile(recordPath(key), 'utf8')) as {
      p: { text: string };
    };
    raw.p.text = 'function exfiltrate() { fetch("https://example.com"); }';
    await fs.writeFile(recordPath(key), JSON.stringify(raw));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/checksum mismatch/i);
  });

  it('treats a record whose key does not match its location as a miss', async () => {
    const key = await seedBlock();
    const raw = JSON.parse(await fs.readFile(recordPath(key), 'utf8')) as Record<string, unknown>;
    raw.k = '0'.repeat(32);
    // Re-checksum so only the key/identity check can catch it.
    raw.c = sha256Hex(stableStringify(raw.p));
    await fs.writeFile(recordPath(key), JSON.stringify(raw));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/foreign record/i);
  });

  it('treats invalid JSON as a miss', async () => {
    const key = await seedBlock();
    await fs.writeFile(recordPath(key), 'not json at all, just prose');
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.length).toBeGreaterThan(0);
  });

  it('treats a well-formed but unrelated payload as a miss', async () => {
    const key = await seedBlock();
    const payload = { hello: 'world' };
    const record = {
      v: CACHE_SCHEMA_VERSION,
      k: key,
      t: FIXED_NOW,
      c: sha256Hex(stableStringify(payload)),
      p: payload,
    };
    await fs.writeFile(recordPath(key), JSON.stringify(record));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/unexpected payload shape/i);
  });

  it('treats a record from another schema version as a miss', async () => {
    const key = await seedBlock();
    const raw = JSON.parse(await fs.readFile(recordPath(key), 'utf8')) as Record<string, unknown>;
    raw.v = 'from-the-future';
    await fs.writeFile(recordPath(key), JSON.stringify(raw));
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(log.warnings.join('\n')).toMatch(/foreign record/i);
  });

  it('survives a corrupt record and keeps serving the healthy ones', async () => {
    const good = makeBlock({ textHash: 'healthy' });
    const bad = makeBlock({
      textHash: 'broken',
      range: { ...makeBlock().range, startLine: 77 },
    });
    await store.putBlock(good);
    await store.putBlock(bad);
    const badKey = makeBlockCacheKey(bad.repoRoot, bad.commit, bad.filePath, bad.textHash);
    const goodKey = makeBlockCacheKey(good.repoRoot, good.commit, good.filePath, good.textHash);
    await fs.writeFile(recordPath(badKey), '{{{');

    await expect(store.getBlock(goodKey)).resolves.toEqual(good);
    await expect(store.getBlock(badKey)).resolves.toBeNull();
    const blocks = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
    expect(blocks.map((block) => block.textHash)).toEqual(['healthy']);
  });

  it('rebuilds a discarded record on the next put', async () => {
    const key = await seedBlock();
    await fs.writeFile(recordPath(key), 'garbage');
    await expect(store.getBlock(key)).resolves.toBeNull();
    const replacement = makeBlock();
    await store.putBlock(replacement);
    await expect(store.getBlock(key)).resolves.toEqual(replacement);
  });

  it('never quotes cached source text in a diagnostic', async () => {
    const key = await seedBlock();
    await fs.writeFile(recordPath(key), '{"v":"1","k":"x","t":1,"c":"x","p":{"text":"apiKey');
    await expect(store.getBlock(key)).resolves.toBeNull();
    const logged = log.all();
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('apiKey');
    expect(logged).toMatch(/[0-9a-f]{32}\.json/);
  });
});

describe('file store: corrupted index', () => {
  it('treats a deleted index as "no blocks for this file" and rebuilds it', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const repoDir = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    const repoKey = repoDir.find((name) => /^[0-9a-f]{32}$/.test(name));
    expect(repoKey).toBeDefined();
    const indexFile = path.join(
      dir,
      'ancestry-cache',
      CACHE_SCHEMA_VERSION,
      repoKey ?? '',
      'index.json',
    );
    await fs.rm(indexFile);

    await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);

    // The record itself is untouched, so a later put re-creates the index and the
    // blocks become visible again.
    await store.putBlock(block);
    const recovered = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
    expect(recovered.map((entry) => entry.id)).toEqual([block.id]);
    await expect(store.getBlock(key)).resolves.toEqual(block);
  });

  it('treats a corrupt index as a miss, warns, and keeps the records', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const repoDir = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    const repoKey = repoDir.find((name) => /^[0-9a-f]{32}$/.test(name)) ?? '';
    const indexFile = path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, repoKey, 'index.json');
    await fs.writeFile(indexFile, '{{{ broken');

    await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);
    expect(log.warnings.join('\n')).toMatch(/repository index/i);
    await expect(fs.stat(indexFile)).rejects.toThrow();
    // The record is still on disk: an analysis that asks for it directly is fine.
    await expect(store.getBlock(key)).resolves.toEqual(block);
  });

  it('treats an index holding the wrong shape as a miss', async () => {
    await store.putBlock(makeBlock());
    const repoDir = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    const repoKey = repoDir.find((name) => /^[0-9a-f]{32}$/.test(name)) ?? '';
    const indexFile = path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, repoKey, 'index.json');
    await fs.writeFile(indexFile, JSON.stringify({ v: CACHE_SCHEMA_VERSION, files: 'nope' }));
    await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);
  });

  it('treats an index with unusable key lists as a miss', async () => {
    await store.putBlock(makeBlock());
    const repoDir = await fs.readdir(path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION));
    const repoKey = repoDir.find((name) => /^[0-9a-f]{32}$/.test(name)) ?? '';
    const indexFile = path.join(dir, 'ancestry-cache', CACHE_SCHEMA_VERSION, repoKey, 'index.json');
    await fs.writeFile(
      indexFile,
      JSON.stringify({
        v: CACHE_SCHEMA_VERSION,
        repo: repoKey,
        updatedAt: FIXED_NOW,
        files: { [`${COMMIT_1}::${FILE_A}`]: [42] },
      }),
    );
    await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);
  });
});

describe('file store: corrupt normalisations', () => {
  it('skips one unusable entry without failing the batch', async () => {
    const entries = [
      makeNormalized('batch-1'),
      makeNormalized('batch-2'),
      makeNormalized('batch-3'),
    ];
    await store.putNormalizations(entries);
    // Damage exactly one record, addressed through the public key helper.
    await fs.writeFile(normalizationPath('batch-2'), 'truncated');

    const result = await store.getNormalizations(['batch-1', 'batch-2', 'batch-3', 'never-cached']);
    expect([...result.keys()].sort()).toEqual(['batch-1', 'batch-3']);
    expect(result.get('batch-1')).toEqual(entries[0]);
    expect(result.get('batch-3')).toEqual(entries[2]);
    expect(log.warnings.length).toBeGreaterThan(0);
  });

  it('rebuilds a discarded normalisation on the next put', async () => {
    const entry = makeNormalized('rebuild-me');
    await store.putNormalizations([entry]);
    await fs.writeFile(normalizationPath('rebuild-me'), '{"v":"1","k":"x"');
    expect((await store.getNormalizations(['rebuild-me'])).size).toBe(0);
    await store.putNormalizations([entry]);
    await expect(store.getNormalizations(['rebuild-me'])).resolves.toEqual(
      new Map([['rebuild-me', entry]]),
    );
  });

  it('rejects a normalisation whose checksum no longer matches', async () => {
    const entry = makeNormalized('tampered');
    await store.putNormalizations([entry]);
    const file = normalizationPath('tampered');
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as {
      p: { normalizedText: string };
    };
    record.p.normalizedText = 'id:9 id:9 id:9';
    await fs.writeFile(file, JSON.stringify(record));
    expect((await store.getNormalizations(['tampered'])).size).toBe(0);
  });
});
