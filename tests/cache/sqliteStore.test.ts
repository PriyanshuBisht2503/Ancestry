/**
 * SQLite backend specific behaviour, on top of the shared contract suite:
 * schema, pragmas, key resolution, and database-level corruption cases.
 *
 * The whole suite is skipped when the runtime does not provide `node:sqlite`, so
 * it stays green on runtimes where the backend cannot exist. The availability
 * predicate is resolved *synchronously* (`skipIf` runs at collection time, before
 * any hook, and the project compiles to CommonJS, where top-level `await` is not
 * allowed); a test below asserts that the synchronous answer agrees with the
 * exported async probe `isSqliteAvailable()`.
 */

import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// See tests/stubs/node-sqlite.ts: Vite's resolver strips the `node:` prefix and then
// fails to find a package called `sqlite`.
import { DatabaseSync } from '../stubs/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isSqliteAvailable,
  makeBlockCacheKey,
  sqliteDatabasePath,
  SqliteCacheStore,
} from '../../src/cache';
import { CACHE_SCHEMA_VERSION } from '../../src/types';
import {
  COMMIT_1,
  FILE_A,
  FIXED_NOW,
  REPO_A,
  describeStoreContract,
  makeBlock,
  makeMatch,
  makeNormalized,
  makeRepository,
  removeDir,
  sqliteAvailableSync,
} from './suite';

const SQLITE_AVAILABLE = sqliteAvailableSync();

/** Fresh, unique scratch directory for one test. */
function scratchDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `ancestry-sqlite-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

if (SQLITE_AVAILABLE) {
  describeStoreContract(
    'sqlite store',
    (dir) =>
      Promise.resolve(
        new SqliteCacheStore({
          filePath: sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION),
          now: () => FIXED_NOW,
        }),
      ),
    'sqlite',
  );
}

describe.skipIf(!SQLITE_AVAILABLE)('SqliteCacheStore', () => {
  let dir: string;
  let store: SqliteCacheStore;

  beforeEach(() => {
    dir = scratchDir();
    store = new SqliteCacheStore({
      filePath: sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION),
      now: () => FIXED_NOW,
    });
  });

  afterEach(async () => {
    await store.close();
    await removeDir(dir);
  });

  /** Open the store's database file directly, for schema-level assertions. */
  function openRaw(): DatabaseSync {
    return new DatabaseSync(sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION));
  }

  it('agrees with the exported async capability probe', async () => {
    await expect(isSqliteAvailable()).resolves.toBe(SQLITE_AVAILABLE);
  });

  it('creates every planned table', () => {
    const db = openRaw();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    expect(tables).toEqual([
      'code_blocks',
      'commits',
      'files',
      'graph_edges',
      'normalized_blocks',
      'repositories',
      'schema_meta',
      'similarity_matches',
    ]);
    db.close();
  });

  it('records the schema version in schema_meta', () => {
    const db = openRaw();
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    expect(row?.value).toBe(CACHE_SCHEMA_VERSION);
    db.close();
  });

  it('uses WAL journalling', () => {
    const db = openRaw();
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(journal.journal_mode.toLowerCase()).toBe('wal');
    db.close();
  });

  it('declares the planned primary keys', () => {
    const db = openRaw();
    const keys = new Map<string, string[]>();
    for (const table of [
      'repositories',
      'commits',
      'files',
      'code_blocks',
      'normalized_blocks',
      'similarity_matches',
      'graph_edges',
    ]) {
      // `PRAGMA table_info` is the authority, and reading it is the only way to
      // see *both* spellings of a primary key. Scanning `sqlite_master.sql` for
      // `PRIMARY KEY (…)` — as this test used to — only finds the table-level
      // form and reports no key at all for the column-level one
      // (`id TEXT PRIMARY KEY`), i.e. a false "the table has no primary key".
      // `pk` is 0 for a column outside the key and a 1-based position in the
      // key otherwise, which is the ordering a composite key needs.
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      keys.set(
        table,
        columns
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => String(column.name)),
      );
    }
    expect(keys.get('repositories')).toEqual(['id']);
    expect(keys.get('commits')).toEqual(['repo_id', 'hash']);
    expect(keys.get('files')).toEqual(['repo_id', 'commit_hash', 'path']);
    expect(keys.get('code_blocks')).toEqual(['repo_id', 'commit_hash', 'block_id']);
    expect(keys.get('normalized_blocks')).toEqual(['block_id']);
    expect(keys.get('similarity_matches')).toEqual(['source_id', 'candidate_id']);
    expect(keys.get('graph_edges')).toEqual(['graph_id', 'edge_id']);
    db.close();
  });

  it('resolves a single block key through a unique index', () => {
    const db = openRaw();
    // `ICacheStore.getBlock(key)` is addressed by one opaque key, so the row
    // identity that key maps to has to be a declared uniqueness constraint.
    // Deriving it by scanning the table into an in-memory map was only correct
    // for the lifetime of the process.
    const unique = db
      .prepare('PRAGMA index_list(code_blocks)')
      .all()
      .filter((index) => Number(index.unique) === 1)
      .map((index) =>
        db
          .prepare(`PRAGMA index_info(${String(index.name)})`)
          .all()
          .map((column) => String(column.name)),
      );
    expect(unique).toContainEqual(['cache_key']);
    db.close();
  });

  it('reopens an existing database without recreating it', async () => {
    await store.putBlock(makeBlock());
    await store.close();
    const reopened = new SqliteCacheStore({
      filePath: sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION),
      now: () => FIXED_NOW,
    });
    expect(await reopened.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).toHaveLength(1);
    await reopened.init();
    // One repository row plus one block row.
    expect((await reopened.stats()).entries).toBe(2);
    await reopened.close();
  });

  it('rebuilds the schema when the stored version differs', async () => {
    const filePath = sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION);
    await store.putBlock(makeBlock());
    await store.close();
    const db = openRaw();
    db.prepare(
      "UPDATE schema_meta SET value = 'from-the-future' WHERE key = 'schema_version'",
    ).run();
    db.close();

    const upgraded = new SqliteCacheStore({ filePath, now: () => FIXED_NOW });
    expect((await upgraded.stats()).entries).toBe(0);
    const stored = openRaw();
    const row = stored
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    stored.close();
    expect(row.value).toBe(CACHE_SCHEMA_VERSION);
    await upgraded.close();
  });

  it('reports native: true and an absolute location', () => {
    expect(store.info.native).toBe(true);
    expect(path.isAbsolute(store.info.location)).toBe(true);
    expect(store.info.backend).toBe('sqlite');
  });

  it('resolves a block key after a restart', async () => {
    const filePath = sqliteDatabasePath(dir, CACHE_SCHEMA_VERSION);
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    await store.close();

    const reopened = new SqliteCacheStore({ filePath, now: () => FIXED_NOW });
    await expect(reopened.getBlock(key)).resolves.toEqual(block);
    await reopened.close();
  });

  it('returns a miss for a key it never issued', async () => {
    await expect(store.getBlock('0'.repeat(32))).resolves.toBeNull();
    await expect(store.getBlock('not-a-key')).resolves.toBeNull();
  });

  it('forgets a key whose row was purged', async () => {
    const block = makeBlock({ cachedAt: 1, textHash: 'purged' });
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    await store.purgeOlderThan(FIXED_NOW);
    await expect(store.getBlock(key)).resolves.toBeNull();
  });

  it('reports unusable rows as corruptions', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const db = openRaw();
    db.prepare('UPDATE code_blocks SET source = ?').run('not a packed column');
    db.close();
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(store.corruptions).toBe(1);
  });

  it('reports a damaged envelope header as a miss', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const db = openRaw();
    db.prepare('UPDATE code_blocks SET source = ?').run(
      '\u0000ancestry/1\u0000{"range":oops\nbody',
    );
    db.close();
    await expect(store.getBlock(key)).resolves.toBeNull();
  });

  it('keeps the raw text recoverable from the column', async () => {
    const block = makeBlock({ text: 'const secret = 1;' });
    await store.putBlock(block);
    const db = openRaw();
    const row = db.prepare('SELECT source FROM code_blocks').get() as { source: string };
    db.close();
    expect(row.source.endsWith('const secret = 1;')).toBe(true);
  });

  it('treats a dropped table as a miss, then repairs it', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const db = openRaw();
    db.exec('DROP TABLE code_blocks');
    db.close();

    await expect(store.getBlock(key)).resolves.toBeNull();
    await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);

    const repaired = makeBlock({ textHash: 'after-repair' });
    const repairedKey = makeBlockCacheKey(
      repaired.repoRoot,
      repaired.commit,
      repaired.filePath,
      repaired.textHash,
    );
    await store.putBlock(repaired);
    await expect(store.getBlock(repairedKey)).resolves.toEqual(repaired);

    const check = openRaw();
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'code_blocks'")
      .all();
    check.close();
    expect(tables).toHaveLength(1);
  });

  it('treats a dropped normalisation table as a miss', async () => {
    await store.putNormalizations([makeNormalized('gone')]);
    const db = openRaw();
    db.exec('DROP TABLE normalized_blocks');
    db.close();
    await expect(store.getNormalizations(['gone'])).resolves.toEqual(new Map());
  });

  it('never throws when a text column holds a number', async () => {
    await store.putRepository(makeRepository());
    const db = openRaw();
    db.prepare('UPDATE repositories SET repo_root = 42').run();
    db.close();
    await expect(store.getRepository(REPO_A)).resolves.toBeNull();
    expect(store.corruptions).toBe(1);
  });

  it('never throws when an integer column holds text', async () => {
    const block = makeBlock();
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await store.putBlock(block);
    const db = openRaw();
    db.prepare('UPDATE code_blocks SET start_line = ?').run('not-a-number');
    db.close();
    await expect(store.getBlock(key)).resolves.toBeNull();
    expect(store.corruptions).toBe(1);
  });

  it('skips a normalisation written by another version', async () => {
    await store.putNormalizations([makeNormalized('v0', { normalizationVersion: '0' })]);
    await expect(store.getNormalizations(['v0'])).resolves.toEqual(new Map());
    const db = openRaw();
    const count = db.prepare('SELECT COUNT(*) AS n FROM normalized_blocks').get() as { n: number };
    db.close();
    expect(Number(count.n)).toBe(0);
  });

  it('reads back a very large token count without losing digits', async () => {
    await store.putNormalizations([
      makeNormalized('big', { tokenCount: 2 ** 31 - 1, maxDepth: 999 }),
    ]);
    const found = await store.getNormalizations(['big']);
    expect(found.get('big')?.tokenCount).toBe(2 ** 31 - 1);
  });

  it('rejects a value outside the safe integer range', async () => {
    await store.putNormalizations([makeNormalized('unsafe')]);
    const db = openRaw();
    db.prepare('UPDATE normalized_blocks SET token_count = ?').run(2 ** 63 - 1);
    db.close();
    await expect(store.getNormalizations(['unsafe'])).resolves.toEqual(new Map());
  });

  it('stores a pair once however it is written', async () => {
    const db = openRaw();
    const result = makeMatch('aaa', 'bbb', {
      similarity: 0.5,
      breakdown: { jaccard: 0.1, simhash: 0.2, lcs: 0.3, shape: 0.4 },
      classification: 'possible',
      componentsUsed: ['lcs'],
    });
    await store.putMatch(result);
    await store.putMatch({ ...result, sourceBlockId: 'bbb', candidateBlockId: 'aaa' });
    const rows = db.prepare('SELECT source_id, candidate_id FROM similarity_matches').all();
    db.close();
    expect(rows).toEqual([{ source_id: 'aaa', candidate_id: 'bbb' }]);
  });

  it('degrades gracefully when the result document is damaged', async () => {
    const db = openRaw();
    await store.putMatch(
      makeMatch('a', 'b', {
        similarity: 0.75,
        breakdown: { jaccard: 0.1, simhash: 0.2, lcs: 0.3, shape: 0.4 },
        classification: 'possible',
        componentsUsed: [],
      }),
    );
    db.prepare('UPDATE similarity_matches SET result = ?').run('{ not json');
    db.close();
    // The queryable columns are intact, so the match survives the damage.
    const found = await store.getMatch('a', 'b');
    expect(found?.similarity).toBe(0.75);
    expect(found?.breakdown.lcs).toBe(0.3);
  });

  it('reports a match as a miss when both documents are damaged', async () => {
    const db = openRaw();
    await store.putMatch(
      makeMatch('a', 'b', {
        similarity: 0.75,
        breakdown: { jaccard: 0.1, simhash: 0.2, lcs: 0.3, shape: 0.4 },
        classification: 'possible',
        componentsUsed: [],
      }),
    );
    db.prepare('UPDATE similarity_matches SET result = ?, breakdown = ?').run('x', 'y');
    db.close();
    await expect(store.getMatch('a', 'b')).resolves.toBeNull();
  });

  it('counts bytes from the database file', async () => {
    await store.putBlock(makeBlock());
    expect((await store.stats()).bytes).toBeGreaterThan(0);
  });

  it('discards nothing when a table is simply empty', async () => {
    expect((await store.stats()).entries).toBe(0);
    expect(store.corruptions).toBe(0);
  });
});
