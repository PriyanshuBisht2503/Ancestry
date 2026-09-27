/**
 * SQLite cache backend, built on Node's built-in `node:sqlite`.
 *
 * Why `node:sqlite` and not `better-sqlite3`: Ancestry ships as a VSIX with no
 * native build step. A native addon would have to be rebuilt (or prebuilt and
 * code-signed) for every Electron ABI, which is a packaging and supply-chain
 * risk the extension does not need. `node:sqlite` is part of the runtime the
 * extension already embeds, and where it is missing the factory falls back to
 * {@link FileCacheStore}.
 *
 * The `node:sqlite` API is marked experimental, so the module is *dynamically*
 * imported: a static import would make this file unloadable on a runtime that
 * does not provide it, and would defeat the capability probe entirely.
 *
 * PRIVACY
 * `code_blocks.source` and `normalized_blocks.normalized_text` hold real source
 * code. They are written only to the user's own cache file, are never logged
 * (log messages carry error *codes* and row counts, never payloads) and are
 * never transmitted anywhere.
 *
 * SCHEMA FIDELITY
 * The table definitions below are the frozen plan's schema. Two of them cannot
 * express every field of the frozen `ICacheStore` payloads:
 *  - `code_blocks` has no column for the AST-level metadata a `CodeBlock` also
 *    carries (character offsets/columns, language, qualified name, signature,
 *    parent, container);
 *  - `normalized_blocks` has no column for the per-token `{kind, value,
 *    nodeType, depth}` stream.
 * Rather than silently dropping those fields — which would make a cache hit
 * return a *less* complete block than a cache miss, and would make the two
 * backends disagree — each text column carries a short, versioned header
 * followed by the raw text:
 * ```
 * <NUL>ancestry/1<NUL>{"range":{...},"language":"typescript",...}\n<raw text>
 * ```
 * The marker cannot occur in TypeScript/JavaScript source, the text stays at the
 * end of the column (so the file is still greppable with `strings`), and a value
 * without the marker is treated as a foreign/legacy row and reported as a miss
 * rather than being interpreted with invented data.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { AncestryError, CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../types';
import type {
  CachedBlock,
  CachedRepository,
  CacheBackendInfo,
  CacheStats,
  CodeBlockKind,
  ICacheStore,
  NormalizedBlock,
  NormalizedToken,
  NormalizedTokenKind,
  SimilarityResult,
  SourceRange,
  SupportedLanguage,
} from '../types';
import { removeWithRetries } from './atomic';
import type { CacheLogger } from './index';
import { makeBlockCacheKey, makeRepoKey, normalizeRepoPath, normalizeRepoRoot } from './keys';

/** File name of the database inside the cache directory. */
const DB_FILE_PREFIX = 'ancestry-index-v';

/** Marker that introduces the metadata header of a packed text column. */
const ENVELOPE_MARKER = '\u0000ancestry/1\u0000';

/** A `stats()` age query is reused for at most this long. */
const SCAN_TTL_MS = 30_000;

/** Number of block ids bound into one `IN (...)` lookup. */
const ID_CHUNK = 400;

const NOOP_LOGGER: CacheLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/** Languages a `NormalizedBlock`/`CachedBlock` may carry. */
const LANGUAGES: ReadonlySet<string> = new Set<SupportedLanguage>([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'unknown',
]);

/** Token kinds a normalised stream may contain. */
const TOKEN_KINDS: ReadonlySet<string> = new Set<NormalizedTokenKind>([
  'keyword',
  'operator',
  'literal',
  'identifier',
  'punct',
  'type',
  'property',
  'param',
]);

/**
 * The exact DDL of the local index. `IF NOT EXISTS` everywhere, so `init()` is
 * idempotent and a half-created database is completed rather than discarded.
 */
const DDL: readonly string[] = [
  // Schema generation marker. A mismatch with the running code means the file
  // predates a breaking schema change and is rebuilt from scratch.
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // One row per repository ever indexed. `id` is `makeRepoKey(repo_root)`, a
  // SHA-256 digest: the absolute path is stored for display and for computing
  // cache keys, but the key is what every other table joins on.
  `CREATE TABLE IF NOT EXISTS repositories (
     id                   TEXT PRIMARY KEY,
     repo_root            TEXT NOT NULL,
     head_commit          TEXT,
     last_indexed_at      INTEGER NOT NULL,
     indexed_commit_count INTEGER NOT NULL
   )`,
  // Commit metadata, so a second analysis does not re-walk `git log`. The
  // ancestry timestamp is the author's epoch milliseconds.
  `CREATE TABLE IF NOT EXISTS commits (
     repo_id         TEXT NOT NULL,
     hash            TEXT NOT NULL,
     author_name     TEXT,
     author_email    TEXT,
     author_timestamp INTEGER,
     subject         TEXT,
     PRIMARY KEY (repo_id, hash)
   )`,
  // Per-commit file inventory, including the pre-rename path so a moved file is
  // followed without re-reading the diff.
  `CREATE TABLE IF NOT EXISTS files (
     repo_id    TEXT NOT NULL,
     commit_hash TEXT NOT NULL,
     path       TEXT NOT NULL,
     old_path   TEXT,
     size_bytes INTEGER,
     text_hash  TEXT,
     PRIMARY KEY (repo_id, commit_hash, path)
   )`,
  // Extracted code blocks. `source` holds the block payload (see SCHEMA
  // FIDELITY). The primary key is (repository, commit, block id), so the same
  // function in two commits is two rows and an analysis of one commit never
  // reads another's blocks. `block_id` is the whole of the block's identity
  // because the extractor guarantees it is unique within a file (it drops a
  // construct whose id would repeat), so re-caching a block is an upsert rather
  // than a second row. The file backend additionally hashes the block's text
  // into its record key, which is strictly finer and therefore agrees with this
  // on every set of blocks an analysis can actually produce.
  `CREATE TABLE IF NOT EXISTS code_blocks (
     repo_id     TEXT NOT NULL,
     commit_hash TEXT NOT NULL,
     block_id    TEXT NOT NULL,
     cache_key   TEXT NOT NULL DEFAULT '',
     repo_root   TEXT NOT NULL DEFAULT '',
     file_path   TEXT NOT NULL,
     kind        TEXT NOT NULL,
     name        TEXT,
     start_line  INTEGER NOT NULL,
     end_line    INTEGER NOT NULL,
     token_count INTEGER NOT NULL,
     text_hash   TEXT NOT NULL,
     source      TEXT NOT NULL,
     cached_at   INTEGER NOT NULL,
     PRIMARY KEY (repo_id, commit_hash, block_id)
   )`,
  // Single-key lookup. `ICacheStore.getBlock(key)` is addressed by one opaque
  // cache key, so the key is stored rather than recomputed from the identity
  // columns: a full-table scan plus an in-memory reverse map was correct only
  // while the process stayed alive, and cost a scan on the first lookup after
  // every restart.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_code_blocks_cache_key ON code_blocks (cache_key)`,
  // Normalised token streams, addressed by block id. `normalization_version` is a
  // data column so a version bump turns every existing row into a miss (and thus
  // into a rebuild) instead of silently reusing stale normalisation. Every other
  // column is NOT NULL so a partially written row is rejected by SQLite itself
  // rather than being discovered later as missing data.
  `CREATE TABLE IF NOT EXISTS normalized_blocks (
     block_id             TEXT PRIMARY KEY,
     normalization_version TEXT NOT NULL,
     token_hash           TEXT NOT NULL,
     simhash              TEXT NOT NULL,
     minhash              TEXT NOT NULL,
     shingles             TEXT NOT NULL,
     features             TEXT NOT NULL,
     ast_summary          TEXT NOT NULL,
     token_count          INTEGER NOT NULL,
     max_depth            INTEGER NOT NULL,
     normalized_text      TEXT NOT NULL,
     identifier_map       TEXT NOT NULL,
     cached_at            INTEGER NOT NULL
   )`,
  // Similarity results, so an unchanged history is never compared twice. The
  // pair is stored in sorted order because the cache key is symmetric, which
  // makes this a single row per unordered pair.
  `CREATE TABLE IF NOT EXISTS similarity_matches (
     source_id     TEXT NOT NULL,
     candidate_id  TEXT NOT NULL,
     similarity    REAL NOT NULL,
     classification TEXT NOT NULL,
     breakdown     TEXT NOT NULL,
     result        TEXT NOT NULL,
     cached_at     INTEGER NOT NULL,
     PRIMARY KEY (source_id, candidate_id)
   )`,
  // Persisted ancestry edges, so a replayed analysis can render the previous
  // graph without recomputing similarity.
  `CREATE TABLE IF NOT EXISTS graph_edges (
     graph_id   TEXT NOT NULL,
     edge_id    TEXT NOT NULL,
     from_node  TEXT NOT NULL,
     to_node    TEXT NOT NULL,
     edge_type  TEXT NOT NULL,
     similarity REAL,
     payload    TEXT,
     cached_at  INTEGER NOT NULL,
     PRIMARY KEY (graph_id, edge_id)
   )`, // Hot lookup paths. These add no tables and no columns; they only keep the
  // per-file read and the expiry sweep off a full table scan.
  `CREATE INDEX IF NOT EXISTS code_blocks_file ON code_blocks (repo_id, commit_hash, file_path)`,
  `CREATE INDEX IF NOT EXISTS code_blocks_cached_at ON code_blocks (cached_at)`,
  `CREATE INDEX IF NOT EXISTS normalized_blocks_cached_at ON normalized_blocks (cached_at)`,
  `CREATE INDEX IF NOT EXISTS normalized_blocks_version
     ON normalized_blocks (normalization_version, block_id)`,
  `CREATE INDEX IF NOT EXISTS similarity_matches_cached_at ON similarity_matches (cached_at)`,
];

/** Every table that holds cache records, in an order safe to drop. */
const DATA_TABLES: readonly string[] = [
  'graph_edges',
  'similarity_matches',
  'normalized_blocks',
  'code_blocks',
  'files',
  'commits',
  'repositories',
];

/** Configuration for {@link SqliteCacheStore}. */
export interface SqliteCacheStoreOptions {
  /** Absolute path of the `.sqlite` file. Its directory is created if needed. */
  filePath: string;
  schemaVersion?: string;
  normalizationVersion?: string;
  now?: () => number;
  logger?: CacheLogger;
  /**
   * Human-readable explanation for `info.note`, supplied by the factory (which is
   * where the backend decision is made). `null` when there is nothing to report.
   */
  note?: string | null;
  scanTtlMs?: number;
}

/** Constructor shape of `DatabaseSync`, as returned by {@link loadDatabaseSync}. */
type DatabaseSyncConstructor = new (
  filePath: string,
  options?: { readBigInts?: boolean },
) => DatabaseSync;

/** Cached oldest/newest timestamps, refreshed at most every `scanTtlMs`. */
interface AgeSnapshot {
  oldest: number | null;
  newest: number | null;
}

/** Metadata header packed in front of a text column. */
interface BlockMeta {
  language: SupportedLanguage;
  qualifiedName: string | null;
  signature: string | null;
  range: SourceRange;
  parentId: string | null;
  container: string | null;
}

/**
 * `ICacheStore` on `node:sqlite`.
 *
 * Every statement is prepared once and reused; batch writes run inside a
 * transaction. Reads are wrapped so that a damaged database (a truncated page,
 * garbage in a column, a missing table) degrades to a cache miss instead of
 * taking the analysis down with it: structural errors trigger a re-run of the
 * idempotent DDL, which restores the missing table on the next access.
 */
export class SqliteCacheStore implements ICacheStore {
  public readonly info: CacheBackendInfo;

  private readonly filePath: string;
  private readonly schemaVersion: string;
  private readonly normalizationVersion: string;
  private readonly now: () => number;
  private readonly logger: CacheLogger;
  private readonly scanTtlMs: number;

  private db: DatabaseSync | null;
  private readonly statements = new Map<string, StatementSync>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private corruptionCount = 0;
  private broken = false;

  /** `cache key → row identity`, hydrated lazily because it needs a full scan. */

  /** `repo id → absolute repo root`, needed to recompute block keys. */

  private age: AgeSnapshot | null = null;
  private ageAt = 0;

  /**
   * Opens (creating if necessary) the database and installs the schema.
   *
   * Throws `AncestryError('CACHE_UNAVAILABLE')` after removing any partially
   * created files, so the factory can fall back to the file backend with a clean
   * directory rather than inheriting a half-built index.
   */
  constructor(options: SqliteCacheStoreOptions) {
    this.schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
    this.normalizationVersion = options.normalizationVersion ?? NORMALIZATION_VERSION;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.scanTtlMs = options.scanTtlMs ?? SCAN_TTL_MS;
    this.filePath = path.resolve(options.filePath);
    this.info = {
      backend: 'sqlite',
      location: this.filePath,
      schemaVersion: this.schemaVersion,
      native: true,
      note: options.note ?? null,
    };
    try {
      this.db = this.openDatabase();
    } catch (error) {
      void this.discardDatabaseFiles();
      throw new AncestryError(
        'CACHE_UNAVAILABLE',
        'The Ancestry index database could not be opened.',
        { detail: describeError(error), cause: error },
      );
    }
  }

  /** Number of unusable rows discarded since this store was created. */
  public get corruptions(): number {
    return this.corruptionCount;
  }

  public async init(): Promise<void> {
    await this.guard('init', undefined, () => {
      this.ensureSchema();
    });
  }

  public async getRepository(repoRoot: string): Promise<CachedRepository | null> {
    return this.guard('getRepository', null, () => {
      const repoId = makeRepoKey(repoRoot);
      const row = this.get(
        `SELECT repo_root, head_commit, last_indexed_at, indexed_commit_count
           FROM repositories WHERE id = ?`,
        repoId,
      );
      if (row === undefined) {
        this.misses += 1;
        return null;
      }
      const repoRootPath = readText(row, 'repo_root');
      const headCommit = readText(row, 'head_commit');
      const lastIndexedAt = readInteger(row, 'last_indexed_at');
      const indexedCommitCount = readInteger(row, 'indexed_commit_count');
      if (repoRootPath === null || lastIndexedAt === null || indexedCommitCount === null) {
        return this.countCorruption('repositories', repoId);
      }
      // The row has to be the record that was *asked for*. A TEXT column has
      // string affinity, so SQLite silently coerces a number written into
      // `repo_root` into text: the row stays readable and no per-column type
      // check can spot the confusion. The identity it carries is the one thing
      // that can — and a repository record naming a different root than the one
      // requested is a damaged row, not an answer. Compared normalised, because
      // the key that found the row (`makeRepoKey`) is derived from the
      // normalised path, so the two spellings of one directory must agree here
      // too.
      if (normalizeRepoRoot(repoRootPath) !== normalizeRepoRoot(repoRoot)) {
        return this.countCorruption('repositories', repoId);
      }
      this.hits += 1;
      return {
        repoRoot: repoRootPath,
        headCommit,
        lastIndexedAt,
        indexedCommitCount,
      };
    });
  }

  public async putRepository(repo: CachedRepository): Promise<void> {
    return this.guard('putRepository', undefined, () => {
      const repoId = makeRepoKey(repo.repoRoot);
      this.run(
        `INSERT INTO repositories (id, repo_root, head_commit, last_indexed_at, indexed_commit_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repo_root            = excluded.repo_root,
           head_commit          = excluded.head_commit,
           last_indexed_at      = excluded.last_indexed_at,
           indexed_commit_count = excluded.indexed_commit_count`,
        repoId,
        repo.repoRoot,
        repo.headCommit,
        repo.lastIndexedAt,
        repo.indexedCommitCount,
      );
      this.invalidateAge();
    });
  }

  public async getBlock(key: string): Promise<CachedBlock | null> {
    return this.guard('getBlock', null, () => {
      // A direct indexed lookup. The previous implementation mapped the opaque key
      // back to `(repo_id, commit_hash, block_id)` using a full-table scan plus an
      // in-memory map, which was both slower and only correct within one process
      // lifetime.
      const row = this.get(`${BLOCK_SELECT} WHERE cache_key = ?`, key);
      if (row === undefined) {
        this.misses += 1;
        return null;
      }
      const block = this.hydrateBlock(row);
      if (block === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return block;
    });
  }

  public async putBlock(block: CachedBlock): Promise<void> {
    return this.guard('putBlock', undefined, () => {
      const repoId = makeRepoKey(block.repoRoot);
      const meta: BlockMeta = {
        language: block.language,
        qualifiedName: block.qualifiedName,
        signature: block.signature,
        range: block.range,
        parentId: block.parentId,
        container: block.container,
      };
      const cacheKey = makeBlockCacheKey(
        block.repoRoot,
        block.commit,
        block.filePath,
        block.textHash,
      );
      this.transaction(() => {
        // A block implies a repository was seen, even if `putRepository` has not
        // run yet: the key is derived from the path and the path must be
        // recoverable for hydration.
        this.run(
          `INSERT INTO repositories (id, repo_root, head_commit, last_indexed_at, indexed_commit_count)
           VALUES (?, ?, NULL, ?, 0)
           ON CONFLICT(id) DO NOTHING`,
          repoId,
          block.repoRoot,
          block.cachedAt,
        );
        this.run(
          `INSERT INTO code_blocks
             (repo_id, commit_hash, block_id, cache_key, repo_root, file_path, kind, name,
              start_line, end_line, token_count, text_hash, source, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_id, commit_hash, block_id) DO UPDATE SET
             cache_key   = excluded.cache_key,
             repo_root   = excluded.repo_root,
             file_path   = excluded.file_path,
             kind        = excluded.kind,
             name        = excluded.name,
             start_line  = excluded.start_line,
             end_line    = excluded.end_line,
             token_count = excluded.token_count,
             text_hash   = excluded.text_hash,
             source      = excluded.source,
             cached_at   = excluded.cached_at`,
          repoId,
          block.commit,
          block.id,
          cacheKey,
          block.repoRoot,
          block.filePath,
          block.kind,
          block.name,
          block.range.startLine,
          block.range.endLine,
          block.tokenCount,
          block.textHash,
          packColumn(meta, block.text),
          block.cachedAt,
        );
      });
      this.invalidateAge();
    });
  }

  public async getBlocksForFile(
    repoRoot: string,
    filePath: string,
    commit: string,
  ): Promise<CachedBlock[]> {
    return this.guard('getBlocksForFile', [] as CachedBlock[], () => {
      const rows = this.all(
        // Explicit source order. Without it SQLite is free to return rows in any
        // order it likes, which made the result depend on the query plan rather
        // than on the file.
        `${BLOCK_SELECT} WHERE repo_id = ? AND commit_hash = ? AND file_path = ?
         ORDER BY start_line, end_line, block_id`,
        makeRepoKey(repoRoot),
        commit,
        normalizeRepoPath(filePath),
      );
      if (rows.length === 0) {
        this.misses += 1;
        return [];
      }
      const blocks: CachedBlock[] = [];
      for (const row of rows) {
        const block = this.hydrateBlock(row);
        if (block === null) {
          this.misses += 1;
          continue;
        }
        this.hits += 1;
        blocks.push(block);
      }
      return blocks;
    });
  }

  public async getNormalizations(blockIds: string[]): Promise<Map<string, NormalizedBlock>> {
    const found = new Map<string, NormalizedBlock>();
    if (blockIds.length === 0) {
      return found;
    }
    return this.guard('getNormalizations', found, () => {
      // Chunked `IN` lookups: one prepared statement and one row set per 400
      // ids, instead of one statement-cache round trip per id.
      const requested = [...new Set(blockIds)];
      const outstanding = new Set(requested);
      for (let offset = 0; offset < requested.length; offset += ID_CHUNK) {
        const chunk = requested.slice(offset, offset + ID_CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = this.all(
          NORMALIZED_SELECT + ` WHERE block_id IN (${placeholders}) AND normalization_version = ?`,
          ...chunk,
          this.normalizationVersion,
        );
        for (const row of rows) {
          const blockId = readText(row, 'block_id');
          if (blockId === null) {
            this.countCorruption('normalized_blocks', '(unknown id)');
            continue;
          }
          const normalized = this.hydrateNormalized(row);
          if (normalized === null) {
            continue;
          }
          this.hits += 1;
          outstanding.delete(blockId);
          found.set(blockId, normalized);
        }
      }
      // Every requested id that produced no usable row is a miss. Usable rows
      // from a stale normalisation version simply do not exist for this store.
      this.misses += outstanding.size;
      return found;
    });
  }

  public async putNormalizations(entries: NormalizedBlock[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const stamp = this.now();
    return this.guard('putNormalizations', undefined, () => {
      const usable = entries.filter(
        (entry) => entry.normalizationVersion === this.normalizationVersion,
      );
      if (usable.length !== entries.length) {
        // Storing a foreign generation would be a silent correctness bug: it
        // would be re-read as valid the moment the version matched again.
        this.logger.warn(
          `ancestry cache: skipped ${entries.length - usable.length} normalisation(s) written for a ` +
            `different normalization version (store is on ${this.normalizationVersion})`,
        );
      }
      this.transaction(() => {
        for (const entry of usable) {
          this.run(
            `INSERT INTO normalized_blocks
               (block_id, normalization_version, token_hash, simhash, minhash, shingles, features,
                ast_summary, token_count, max_depth, normalized_text, identifier_map, cached_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(block_id) DO UPDATE SET
               normalization_version = excluded.normalization_version,
               token_hash           = excluded.token_hash,
               simhash              = excluded.simhash,
               minhash              = excluded.minhash,
               shingles             = excluded.shingles,
               features             = excluded.features,
               ast_summary          = excluded.ast_summary,
               token_count          = excluded.token_count,
               max_depth            = excluded.max_depth,
               normalized_text      = excluded.normalized_text,
               identifier_map       = excluded.identifier_map,
               cached_at            = excluded.cached_at`,
            entry.blockId,
            entry.normalizationVersion,
            entry.tokenHash,
            entry.simhash,
            jsonText(entry.minhash),
            jsonText(entry.shingles),
            jsonText(entry.features),
            entry.astSummary,
            entry.tokenCount,
            entry.maxDepth,
            packColumn({ language: entry.language, tokens: entry.tokens }, entry.normalizedText),
            jsonText(entry.identifierMap),
            stamp,
          );
        }
      });
      this.invalidateAge();
    });
  }

  public async getMatch(sourceId: string, candidateId: string): Promise<SimilarityResult | null> {
    return this.guard('getMatch', null, () => {
      const [first, second] = sortPair(sourceId, candidateId);
      const row = this.get(
        // `source_id`/`candidate_id` are selected because `hydrateMatch` falls
        // back to the queryable columns when the stored document is unusable,
        // and a pair that cannot name itself cannot be rebuilt.
        `SELECT source_id, candidate_id, result, similarity, classification, breakdown
            FROM similarity_matches
           WHERE source_id = ? AND candidate_id = ?`,
        first,
        second,
      );
      if (row === undefined) {
        this.misses += 1;
        return null;
      }
      const result = this.hydrateMatch(row);
      if (result === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return result;
    });
  }

  public async putMatch(result: SimilarityResult): Promise<void> {
    return this.guard('putMatch', undefined, () => {
      const [first, second] = sortPair(result.sourceBlockId, result.candidateBlockId);
      this.run(
        `INSERT INTO similarity_matches
           (source_id, candidate_id, similarity, classification, breakdown, result, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, candidate_id) DO UPDATE SET
           similarity    = excluded.similarity,
           classification = excluded.classification,
           breakdown     = excluded.breakdown,
           result        = excluded.result,
           cached_at     = excluded.cached_at`,
        first,
        second,
        result.similarity,
        result.classification,
        jsonText(result.breakdown),
        jsonText(result),
        this.now(),
      );
      this.invalidateAge();
    });
  }

  public async purgeOlderThan(epochMs: number): Promise<number> {
    return this.guard('purgeOlderThan', 0, () => {
      const removed = this.transaction(() => {
        let total = 0;
        total += this.run('DELETE FROM code_blocks WHERE cached_at < ?', epochMs).changes;
        total += this.run('DELETE FROM normalized_blocks WHERE cached_at < ?', epochMs).changes;
        total += this.run('DELETE FROM similarity_matches WHERE cached_at < ?', epochMs).changes;
        total += this.run('DELETE FROM graph_edges WHERE cached_at < ?', epochMs).changes;
        total += this.run('DELETE FROM repositories WHERE last_indexed_at < ?', epochMs).changes;
        return total;
      });
      this.evictions += removed;
      // Purged rows are gone; the in-memory key index must not outlive them.
      this.invalidateAge();
      this.logger.debug(`ancestry cache: purged ${removed} expired row(s)`);
      return removed;
    });
  }

  public async stats(): Promise<CacheStats> {
    const row = await this.guard('stats', null, () => ({
      entries:
        (this.scalar('SELECT COUNT(*) AS n FROM repositories') ?? 0) +
        (this.scalar('SELECT COUNT(*) AS n FROM code_blocks') ?? 0) +
        (this.scalar('SELECT COUNT(*) AS n FROM normalized_blocks') ?? 0) +
        (this.scalar('SELECT COUNT(*) AS n FROM similarity_matches') ?? 0),
      repositories: this.scalar('SELECT COUNT(*) AS n FROM repositories') ?? 0,
      pages: this.scalar('PRAGMA page_count') ?? 0,
      pageSize: this.scalar('PRAGMA page_size') ?? 0,
    }));
    const age = await this.guard('stats', null, () => this.ageSnapshot());
    const entries = row?.entries ?? 0;
    return {
      backend: this.info.backend,
      entries,
      // `bytes` means "bytes of cached data", not "bytes on disk". A freshly
      // created SQLite file already occupies several pages of schema and index
      // structures, so reporting `page_count * page_size` would claim ~90 KB of
      // cache for an empty store and break parity with the file backend. With no
      // entries there is no cached data, so the honest answer is zero.
      bytes: entries === 0 ? 0 : (row?.pages ?? 0) * (row?.pageSize ?? 0),
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      oldestEntryTimestamp: age?.oldest ?? null,
      newestEntryTimestamp: age?.newest ?? null,
      repositoryCount: row?.repositories ?? 0,
    };
  }

  public async clear(): Promise<void> {
    return this.guard('clear', undefined, () => {
      this.transaction(() => {
        for (const table of DATA_TABLES) {
          this.run(`DELETE FROM ${table}`);
        }
      });
      this.invalidateAge();
    });
  }

  public async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.statements.clear();
    closeDatabase(db);
  }

  // -------------------------------------------------------------------------
  // Database plumbing
  // -------------------------------------------------------------------------

  private openDatabase(): DatabaseSync {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const DatabaseSyncCtor = loadDatabaseSync();
    if (DatabaseSyncCtor === null) {
      throw new Error('ancestry cache: node:sqlite did not provide DatabaseSync');
    }
    const db = new DatabaseSyncCtor(this.filePath, { readBigInts: true });
    try {
      // WAL keeps a long analysis from blocking on readers; NORMAL sync is the
      // standard trade-off for a rebuildable cache (a lost tail after a power
      // cut costs one re-parse, not correctness).
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = OFF');
      this.db = db;
      this.ensureSchema();
    } catch (error) {
      this.db = null;
      closeDatabase(db);
      throw error;
    }
    return db;
  }

  /**
   * Install (or repair) the schema.
   *
   * The DDL runs first so `schema_meta` always exists — a brand-new file has no
   * tables at all, and asking it for the stored version first would fail. A
   * `schema_version` from another generation means the file predates a breaking
   * change, so every table is dropped and recreated: a cache is always
   * disposable, and migrating it would be more code than deleting it.
   */
  private ensureSchema(): void {
    if (this.broken) {
      throw new Error('ancestry cache: the SQLite index is unusable');
    }
    const db = this.requireDb();
    for (const statement of DDL) {
      db.exec(statement);
    }
    this.statements.clear();
    const storedRow = this.get('SELECT value FROM schema_meta WHERE key = ?', 'schema_version');
    const stored = storedRow === undefined ? null : readText(storedRow, 'value');
    if (stored !== null && stored !== this.schemaVersion) {
      for (const table of DATA_TABLES) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      for (const statement of DDL) {
        db.exec(statement);
      }
      this.statements.clear();
      this.logger.debug(
        `ancestry cache: index schema ${stored} replaced with ${this.schemaVersion}`,
      );
    }
    this.run(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'schema_version',
      this.schemaVersion,
    );
    this.run(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      'normalization_version',
      this.normalizationVersion,
    );
    this.addMissingColumns();
  }

  /**
   * Add any column a previous build's `code_blocks` table lacks.
   *
   * Guarded by a `PRAGMA table_info` probe so it is a no-op on a current
   * database, and wrapped per-column so one failure cannot prevent the others.
   */
  private addMissingColumns(): void {
    const db = this.requireDb();
    for (const addition of COLUMN_ADDITIONS) {
      try {
        const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as Array<
          Record<string, SQLOutputValue>
        >;
        const present = columns.some((row) => readText(row, 'name') === addition.column);
        if (present) {
          continue;
        }
        db.exec(
          `ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`,
        );
        this.statements.clear();
        this.logger.debug(
          `ancestry cache: added ${addition.table}.${addition.column} to an older index`,
        );
      } catch (error) {
        this.logger.warn(
          `ancestry cache: could not add ${addition.table}.${addition.column}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private requireDb(): DatabaseSync {
    const db = this.db;
    if (db === null) {
      throw new Error('ancestry cache: the store is closed');
    }
    return db;
  }

  /** Prepare-once statement lookup; the cache is cleared on every schema change. */
  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const prepared = this.requireDb().prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    return { changes: toSafeNumber(this.stmt(sql).run(...params).changes) ?? 0 };
  }

  private get(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined {
    return this.stmt(sql).get(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue>[] {
    return this.stmt(sql).all(...params);
  }

  private scalar(sql: string, ...params: SQLInputValue[]): number | null {
    const row = this.get(sql, ...params);
    if (row === undefined) {
      return null;
    }
    const first = Object.values(row)[0];
    return toSafeNumber(first ?? null);
  }

  /** Run `body` in a transaction, rolling back on any error. */
  private transaction<T>(body: () => T): T {
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A rollback failure means the transaction was already resolved; the
        // original error is the useful one.
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Row hydration
  // -------------------------------------------------------------------------

  private hydrateBlock(row: Record<string, SQLOutputValue>): CachedBlock | null {
    const id = readText(row, 'block_id');
    const filePath = readText(row, 'file_path');
    const kind = readText(row, 'kind');
    const textHash = readText(row, 'text_hash');
    const commit = readText(row, 'commit_hash');
    const source = readText(row, 'source');
    const startLine = readInteger(row, 'start_line');
    const endLine = readInteger(row, 'end_line');
    const tokenCount = readInteger(row, 'token_count');
    const cachedAt = readInteger(row, 'cached_at');
    const repoId = readText(row, 'repo_id');
    if (
      id === null ||
      filePath === null ||
      kind === null ||
      textHash === null ||
      commit === null ||
      source === null ||
      startLine === null ||
      endLine === null ||
      tokenCount === null ||
      cachedAt === null ||
      repoId === null
    ) {
      this.countCorruption('code_blocks', id ?? '(unknown id)');
      return null;
    }
    const packed = unpackColumn<Partial<BlockMeta>>(source);
    if (packed === null || !isBlockMeta(packed.meta)) {
      this.countCorruption('code_blocks', id);
      return null;
    }
    // `repo_root` is denormalised onto the row rather than joined from
    // `repositories`, so hydration needs no in-memory lookup table and therefore
    // behaves identically before and after a restart.
    const repoRoot = readText(row, 'repo_root');
    if (repoRoot === null || repoRoot.length === 0) {
      this.countCorruption('code_blocks', id);
      return null;
    }
    return {
      id,
      kind: kind as CodeBlockKind,
      name: readText(row, 'name'),
      qualifiedName: packed.meta.qualifiedName ?? null,
      signature: packed.meta.signature ?? null,
      filePath,
      language: packed.meta.language,
      range: packed.meta.range,
      parentId: packed.meta.parentId ?? null,
      container: packed.meta.container ?? null,
      text: packed.text,
      textHash,
      tokenCount,
      repoRoot,
      commit,
      cachedAt,
    };
  }

  private hydrateNormalized(row: Record<string, SQLOutputValue>): NormalizedBlock | null {
    const blockId = readText(row, 'block_id');
    const normalizedText = readText(row, 'normalized_text');
    const normalizationVersion = readText(row, 'normalization_version');
    if (
      blockId === null ||
      normalizedText === null ||
      normalizationVersion !== this.normalizationVersion
    ) {
      if (blockId !== null) {
        this.countCorruption('normalized_blocks', blockId);
      }
      return null;
    }
    const packed = unpackColumn<{ language?: unknown; tokens?: unknown }>(normalizedText);
    if (
      packed === null ||
      typeof packed.meta.language !== 'string' ||
      !LANGUAGES.has(packed.meta.language)
    ) {
      this.countCorruption('normalized_blocks', blockId);
      return null;
    }
    const tokens = readTokens(packed.meta.tokens);
    const minhash = readJsonStringArray(readText(row, 'minhash'));
    const shingles = readJsonStringArray(readText(row, 'shingles'));
    const features = readJsonNumberRecord(readText(row, 'features'));
    const identifierMap = readJsonStringRecord(readText(row, 'identifier_map'));
    const tokenHash = readText(row, 'token_hash');
    const simhash = readText(row, 'simhash');
    const astSummary = readText(row, 'ast_summary');
    const tokenCount = readInteger(row, 'token_count');
    const maxDepth = readInteger(row, 'max_depth');
    if (
      tokens === null ||
      minhash === null ||
      shingles === null ||
      features === null ||
      identifierMap === null ||
      tokenHash === null ||
      simhash === null ||
      astSummary === null ||
      tokenCount === null ||
      maxDepth === null
    ) {
      this.countCorruption('normalized_blocks', blockId);
      return null;
    }
    return {
      blockId,
      language: packed.meta.language as SupportedLanguage,
      tokens,
      normalizedText: packed.text,
      tokenHash,
      simhash,
      minhash,
      shingles,
      features,
      astSummary,
      identifierMap,
      tokenCount,
      maxDepth,
      normalizationVersion,
    };
  }

  /**
   * Prefer the stored `result` document (it is the whole `SimilarityResult`,
   * including `componentsUsed` and the original id order) and fall back to the
   * queryable columns if that document is unusable.
   */
  private hydrateMatch(row: Record<string, SQLOutputValue>): SimilarityResult | null {
    const stored = readText(row, 'result');
    if (stored !== null) {
      const parsed = parseJson<SimilarityResult>(stored);
      if (isSimilarityResult(parsed)) {
        return parsed;
      }
    }
    const sourceId = readText(row, 'source_id');
    const candidateId = readText(row, 'candidate_id');
    const similarity = readNumber(row, 'similarity');
    const breakdown = parseJson<SimilarityResult['breakdown']>(readText(row, 'breakdown'));
    if (sourceId === null || candidateId === null || similarity === null || breakdown === null) {
      this.countCorruption('similarity_matches', `${sourceId ?? '?'}~${candidateId ?? '?'}`);
      return null;
    }
    const classification = readText(row, 'classification');
    return {
      sourceBlockId: sourceId,
      candidateBlockId: candidateId,
      similarity,
      breakdown,
      classification: (classification ?? 'unrelated') as SimilarityResult['classification'],
      componentsUsed: [],
    };
  }

  private countCorruption(table: string, id: string): null {
    this.corruptionCount += 1;
    this.logger.warn(
      `ancestry cache: unusable row in ${table} for ${id.length <= 48 ? id : `${id.slice(0, 48)}…`}; ` +
        'the entry will be rebuilt on demand',
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Key ⇄ row resolution
  // -------------------------------------------------------------------------

  /**
   * Map an opaque block cache key back to its row.
   *
   * The frozen schema has no column for the cache key, so the mapping is
   * recomputed from the four identity columns and kept in memory. It is
   * hydrated once, lazily, because it costs one full scan of `code_blocks`;
   * after that every `put` keeps it current. Memory is one 32-char key plus a
   * three-field record per block, which is affordable for the small/medium
   * repositories v1 targets (see docs/architecture.md).
   */
  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Oldest/newest `cached_at` across the record tables.
   *
   * The derived table is a scan, so the answer is reused for `scanTtlMs` and
   * invalidated by any write through this store, exactly as in the file backend.
   */
  private ageSnapshot(): AgeSnapshot {
    const nowMs = this.now();
    if (this.age !== null && nowMs - this.ageAt < this.scanTtlMs) {
      return this.age;
    }
    const row = this.get(
      `SELECT MIN(t) AS oldest, MAX(t) AS newest FROM (
         SELECT cached_at AS t FROM code_blocks
         UNION ALL SELECT cached_at FROM normalized_blocks
         UNION ALL SELECT cached_at FROM similarity_matches
         UNION ALL SELECT last_indexed_at FROM repositories
       )`,
    );
    this.age = {
      oldest: row === undefined ? null : readInteger(row, 'oldest'),
      newest: row === undefined ? null : readInteger(row, 'newest'),
    };
    this.ageAt = nowMs;
    return this.age;
  }

  private invalidateAge(): void {
    this.age = null;
  }

  /** Remove a database that could not be opened, plus its WAL side files. */
  private async discardDatabaseFiles(): Promise<void> {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await removeWithRetries(`${this.filePath}${suffix}`);
    }
  }

  // -------------------------------------------------------------------------
  // Error containment
  // -------------------------------------------------------------------------

  /**
   * Contain a database failure.
   *
   * A cache problem must never propagate into the analysis pipeline, so every
   * public method routes through here and degrades to `fallback`. Structural
   * damage (a missing table, a schema change behind our back) additionally
   * triggers a re-run of the idempotent DDL, so the *next* access repairs the
   * database instead of failing forever. Only the error code is logged: a
   * `JSON.parse` message embeds a fragment of the text it choked on, and for this
   * database that text is source code.
   */
  private async guard<T>(operation: string, fallback: T, task: () => T | Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isStructuralError(error)) {
        this.recoverSchema();
      }
      this.logger.warn(
        `ancestry cache: ${operation} failed (${describeError(error)}); continuing without it`,
      );
      return fallback;
    }
  }

  private recoverSchema(): void {
    this.statements.clear();
    this.invalidateAge();
    try {
      this.ensureSchema();
      this.logger.debug('ancestry cache: index schema was rebuilt after a structural error');
    } catch (error) {
      this.broken = true;
      this.logger.warn(
        `ancestry cache: index schema could not be rebuilt (${describeError(error)}); ` +
          'the store is now read-only-empty until the extension restarts',
      );
    }
  }
}

/**
 * Idempotent column additions for an index created by an earlier build.
 *
 * `CREATE TABLE IF NOT EXISTS` will not add a column to a table that already
 * exists, so a development build that predates `cache_key`/`repo_root` would open
 * a database whose block queries reference columns that are not there. The
 * stored `schema_version` does not catch that case — the version is the same —
 * so the columns are added by inspection instead. A cache is disposable, but
 * making the user delete it to run a query is a poor trade for two `ALTER`s.
 */
const COLUMN_ADDITIONS: ReadonlyArray<{ table: string; column: string; definition: string }> =
  Object.freeze([
    { table: 'code_blocks', column: 'cache_key', definition: `TEXT NOT NULL DEFAULT ''` },
    { table: 'code_blocks', column: 'repo_root', definition: `TEXT NOT NULL DEFAULT ''` },
  ]);

/** Full column list of a `code_blocks` row, shared by every block query. */
const BLOCK_COLUMNS =
  'repo_id, commit_hash, block_id, cache_key, repo_root, file_path, kind, name, ' +
  'start_line, end_line, token_count, text_hash, source, cached_at';

/** Full column list of a `normalized_blocks` row. */
const NORMALIZED_COLUMNS =
  'block_id, normalization_version, token_hash, simhash, minhash, shingles, features, ' +
  'ast_summary, token_count, max_depth, normalized_text, identifier_map';

/** Column list plus a `WHERE` clause is appended by the caller. */
const BLOCK_SELECT = `SELECT ${BLOCK_COLUMNS} FROM code_blocks`;
const NORMALIZED_SELECT = `SELECT ${NORMALIZED_COLUMNS} FROM normalized_blocks`;

/**
 * Close a database, tolerating a double close.
 *
 * `DatabaseSync.close()` throws when the handle is already closed, which would
 * turn an ordinary `close()`-then-`close()` into a cache error. Pass `null` when
 * no handle was ever opened.
 */
export function closeDatabase(db: DatabaseSync | null): void {
  if (db === null) {
    return;
  }
  try {
    if (db.isOpen) {
      db.close();
    }
  } catch {
    // Already closed, or the handle is gone; nothing left to release.
  }
}

/**
 * Capability probe for `node:sqlite`.
 *
 * The module is experimental and absent from older runtimes (and from runtimes
 * started without SQLite support), so it is imported dynamically and *any*
 * failure — missing module, blocked at build time, throwing at load — is reported
 * as "not available". The factory uses this to choose a backend.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  // Deliberately routed through `loadDatabaseSync` rather than a direct
  // `await import('node:sqlite')`. The probe and the store MUST agree: if the
  // probe loaded the module by a different mechanism than the constructor, then
  // on any runtime or bundler where only one of the two works, the probe would
  // report "unavailable" for a module the store can in fact open — and the
  // extension would silently downgrade to the file backend for no reason.
  // Sharing one loader makes disagreement impossible by construction.
  return loadDatabaseSync() !== null;
}

/**
 * Resolve the `DatabaseSync` binding for a constructor that cannot await.
 *
 * `node:sqlite` must never be a static import here: that would make this module
 * unloadable on a runtime without SQLite and defeat the factory's fallback. The
 * async probe above uses `import()`, but a constructor is synchronous, so the
 * binding is loaded through `createRequire` instead. Returns `null` when the
 * module is absent, which the constructor turns into a `CACHE_UNAVAILABLE`
 * `AncestryError` for the factory to handle.
 */
function loadDatabaseSync(): DatabaseSyncConstructor | null {
  try {
    const nodeRequire = createRequire(__filename);
    const sqlite = nodeRequire('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function'
      ? (sqlite.DatabaseSync as DatabaseSyncConstructor)
      : null;
  } catch {
    return null;
  }
}

/** Order-independent pair, so `(a, b)` and `(b, a)` are one row and one key. */
function sortPair(first: string, second: string): [string, string] {
  return first <= second ? [first, second] : [second, first];
}

/**
 * `NUL` + `ancestry/1` + `NUL`. A TypeScript/JavaScript source file cannot
 * contain this byte sequence, so the presence of the marker is unambiguous even
 * though the text follows it verbatim.
 */
function packColumn(meta: object, text: string): string {
  return `${ENVELOPE_MARKER}${JSON.stringify(meta)}\n${text}`;
}

/**
 * Split a packed text column.
 *
 * @returns the metadata header and the text, or `null` when the marker is
 * present but the header is not valid JSON (a damaged row). A value *without* the
 * marker is returned as text with empty metadata; the caller then rejects it
 * rather than inventing fields.
 */
function unpackColumn<T>(value: string): { meta: T; text: string } | null {
  if (!value.startsWith(ENVELOPE_MARKER)) {
    return { meta: {} as T, text: value };
  }
  const body = value.slice(ENVELOPE_MARKER.length);
  const separator = body.indexOf('\n');
  if (separator < 0) {
    return null;
  }
  const header = body.slice(0, separator);
  try {
    const parsed: unknown = JSON.parse(header);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return { meta: parsed as T, text: body.slice(separator + 1) };
  } catch {
    return null;
  }
}

/** `true` when the block metadata header is complete enough to rebuild a range. */
function isBlockMeta(meta: Partial<BlockMeta>): meta is BlockMeta {
  if (typeof meta.language !== 'string' || !LANGUAGES.has(meta.language)) {
    return false;
  }
  if (!isSourceRange(meta.range)) {
    return false;
  }
  return (
    isOptionalString(meta.qualifiedName) &&
    isOptionalString(meta.signature) &&
    isOptionalString(meta.parentId) &&
    isOptionalString(meta.container)
  );
}

/** `null`, absent, or a string — the three states of every optional text field. */
function isOptionalString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string';
}

function isSourceRange(value: unknown): value is SourceRange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const range = value as Partial<SourceRange>;
  const fields = [
    range.startOffset,
    range.endOffset,
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  ];
  return fields.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/** Read a token stream back out of a column header. */
function readTokens(value: unknown): NormalizedToken[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tokens: NormalizedToken[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const token = entry as Partial<NormalizedToken>;
    if (
      typeof token.kind !== 'string' ||
      !TOKEN_KINDS.has(token.kind) ||
      typeof token.value !== 'string' ||
      typeof token.nodeType !== 'string' ||
      typeof token.depth !== 'number'
    ) {
      return null;
    }
    tokens.push({
      kind: token.kind as NormalizedTokenKind,
      value: token.value,
      nodeType: token.nodeType,
      depth: token.depth,
    });
  }
  return tokens;
}

/** JSON column holding an array of strings. */
function readJsonStringArray(value: string | null): string[] | null {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.every((entry) => typeof entry === 'string') ? (parsed as string[]) : null;
}

/** JSON column holding a `string → number` map (`NormalizedBlock.features`). */
function readJsonNumberRecord(value: string | null): Record<string, number> | null {
  const parsed = parseJson<unknown>(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'number') {
      return null;
    }
  }
  return record as Record<string, number>;
}

/** JSON column holding a `string → string` map (`identifierMap`). */
function readJsonStringRecord(value: string | null): Record<string, string> | null {
  const parsed = parseJson<unknown>(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'string') {
      return null;
    }
  }
  return record as Record<string, string>;
}

/** Parse a JSON column, reporting an absent or damaged value as `null`. */
function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isSimilarityResult(value: unknown): value is SimilarityResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Partial<SimilarityResult>;
  return (
    typeof result.sourceBlockId === 'string' &&
    typeof result.candidateBlockId === 'string' &&
    typeof result.similarity === 'number' &&
    typeof result.classification === 'string' &&
    typeof result.breakdown === 'object' &&
    result.breakdown !== null
  );
}

/** Serialise a value for a JSON column; only scalars and arrays reach SQLite. */
function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** TEXT column value, or `null` when the column is absent or not text. */
function readText(row: Record<string, SQLOutputValue>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/** REAL column value, or `null`. */
function readNumber(row: Record<string, SQLOutputValue>, column: string): number | null {
  const value = row[column];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** INTEGER column value, or `null` when it is not a safe integer. */
function readInteger(row: Record<string, SQLOutputValue>, column: string): number | null {
  return toSafeNumber(row[column] ?? null);
}

/**
 * Convert a SQLite value to a JavaScript number without silently losing
 * precision.
 *
 * The connection is opened with `readBigInts: true`, so every `INTEGER` arrives as
 * a `bigint`. Anything outside the safe-integer range cannot be represented
 * exactly, and none of the columns in this schema legitimately holds such a
 * value — so a value that big means the row is damaged, and `null` (which callers
 * treat as a corrupt row) is returned instead of a rounded approximation.
 */
function toSafeNumber(value: SQLOutputValue | undefined | null): number | null {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

/** Messages that mean "the database itself is wrong", not "this row is odd". */
function isStructuralError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|no such column|no such index|SQLITE_SCHEMA|malformed|not a database/i.test(
    message,
  );
}

/**
 * Describe an error *without* its message.
 *
 * Messages can embed fragments of the data being read — a `JSON.parse` message
 * quotes the offending text, which here is source code — so only the class name
 * and the `errno` code are ever logged.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    const label = typeof name === 'string' && name.length <= 40 ? name : 'Error';
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${label}(${code})` : label;
  }
  return typeof error;
}

/**
 * Absolute path of the database file for a cache directory and schema version.
 *
 * The file name embeds the schema version so two generations never share a file
 * and a rollback to an older Ancestry build still finds its own index.
 */
export function sqliteDatabasePath(directory: string, schemaVersion: string): string {
  return path.join(path.resolve(directory), `${DB_FILE_PREFIX}${schemaVersion}.sqlite`);
}
