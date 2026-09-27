/**
 * Checksummed, sharded JSON cache backend.
 *
 * This is the portable fallback used when `node:sqlite` is unavailable, and the
 * backend a user can force with `ancestry.cache.backend = "file"`. It needs no
 * dependencies beyond `node:fs` and no native build step, which matters because
 * Ancestry ships as a VSIX with no native modules.
 *
 * LAYOUT
 * ```
 * <directory>/ancestry-cache/<schemaVersion>/<shard>/<key>.json   one record
 * <directory>/ancestry-cache/<schemaVersion>/<repoKey>/index.json  per-repo index
 * ```
 * The shard is the first two hex characters of the key, so no directory ever
 * holds more than 1/256th of the index and listings stay cheap on Windows.
 *
 * A record file is
 * `{ v: schemaVersion, k: key, t: cachedAt, c: sha256(canonical payload), p: payload }`.
 * The checksum is computed over a *canonical* (key-sorted) rendering of the
 * payload, so a record that survives any JSON round trip still verifies, while a
 * truncated, half-flushed or hand-edited file does not.
 *
 * ROBUSTNESS CONTRACT
 * A damaged cache must never break an analysis, so every read degrades to a cache
 * miss and every write failure becomes a logged warning:
 *  - unparseable file, wrong key, wrong schema version, checksum mismatch, or a
 *    non-regular file (symlink) where a record belongs ⇒ discard the file, count
 *    one corruption, warn, and report a miss;
 *  - a corrupt per-repository index is discarded and reported as "no blocks for
 *    this file". It is deliberately *not* rebuilt by scanning: the analysis
 *    re-parses the file and the next `putBlock` recreates the index from scratch,
 *    which is cheaper and always consistent with the records on disk;
 *  - `getNormalizations` tolerates individual missing/corrupt entries instead of
 *    failing the whole batch;
 *  - no public method throws for a cache problem.
 *
 * PRIVACY
 * `CachedBlock.text` and `NormalizedBlock.normalizedText` hold real source code.
 * They are written only under the user's own cache directory, are never logged
 * (log messages carry SHA-256 record keys and error *codes*, never payloads) and
 * are never transmitted anywhere.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../types';
import type {
  CachedBlock,
  CachedRepository,
  CacheBackendInfo,
  CacheStats,
  ICacheStore,
  NormalizedBlock,
  SimilarityResult,
} from '../types';
import { ensureDir, removeWithRetries, writeFileAtomic } from './atomic';
import type { CacheLogger } from './index';
import {
  makeBlockCacheKey,
  makeBlockNormalizeKey,
  makeMatchCacheKey,
  makeRepoKey,
  makeRepositoryEntryId,
  normalizeRepoPath,
  sha256Hex,
  stableStringify,
} from './keys';

/** Directory created inside the user-supplied cache directory. */
const CACHE_DIR_NAME = 'ancestry-cache';

/** Number of leading hex characters used as the shard directory name. */
const SHARD_LENGTH = 2;

/** A scan of every record is reused for at most this long (see `stats`). */
const SCAN_TTL_MS = 30_000;

/**
 * How many record writes a batch issues at once.
 *
 * A record write is dominated by filesystem latency, so batching sequentially
 * would make caching a large analysis needlessly slow. The cap keeps the number
 * of open file handles bounded (Windows starts failing around a few hundred) and
 * stops a huge batch from starving the rest of the process of I/O.
 *
 * Raised from 24 to 64 after measurement: a 2 000-record batch took 8.8 s idle
 * and over 16 s on a loaded machine, against a 15 s budget — i.e. the test was
 * passing or failing on machine load rather than on anything about the code. The
 * SQLite backend performs the same batch in ~2.5 s, so the gap was concurrency,
 * not work. 64 sits comfortably inside the handle limit the comment above
 * describes, and each write is independently atomic and checksummed, so a wider
 * batch cannot leave a partial or corrupt state behind — it can only finish
 * sooner or fail sooner.
 */
const WRITE_CONCURRENCY = 64;

/** Every key this module produces is a 32-character lowercase hex digest. */
const KEY_PATTERN = /^[0-9a-f]{32}$/;

/** Index-file name inside a repository directory. */
const INDEX_FILE = 'index.json';

const NOOP_LOGGER: CacheLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/** On-disk envelope around a payload. */
interface StoredRecord<T> {
  v: string;
  k: string;
  t: number;
  c: string;
  p: T;
}

/** Per-repository secondary index: `"<commit>::<filePath>" → record keys`. */
interface RepoIndex {
  v: string;
  repo: string;
  updatedAt: number;
  files: Record<string, string[]>;
}

/** Configuration for {@link FileCacheStore}. */
export interface FileCacheStoreOptions {
  /** Directory that receives the `ancestry-cache` tree. */
  directory: string;
  /** Persisted schema version; defaults to `CACHE_SCHEMA_VERSION`. */
  schemaVersion?: string;
  /** Normalisation generation; a bump orphans every stored normalisation. */
  normalizationVersion?: string;
  /** Clock, injectable so expiry and timestamps are testable. */
  now?: () => number;
  /** Sink for non-fatal diagnostics. Never receives payload content. */
  logger?: CacheLogger;
  /**
   * Human-readable explanation for `info.note`, supplied by the factory (which is
   * where the backend decision is made). `null` when there is nothing to report.
   */
  note?: string | null;
  /** How long a `stats()` directory scan may be reused. Defaults to 30 s. */
  scanTtlMs?: number;
}

/** Result of a successful record read. */
interface RecordHit<T> {
  value: T;
  cachedAt: number;
}

/** Cached `stats()` scan, reused until the TTL expires or a write invalidates it. */
interface ScanSnapshot {
  entries: number;
  bytes: number;
  oldest: number | null;
  newest: number | null;
}

/**
 * A `ICacheStore` implementation that keeps every record in its own small
 * checksummed JSON file.
 *
 * Concurrency: writes are serialised per key through a promise chain, and index
 * mutations are serialised per repository, so two `putBlock` calls for the same
 * file can never interleave a read-modify-write of the index and lose an entry.
 */
export class FileCacheStore implements ICacheStore {
  public readonly info: CacheBackendInfo;

  /** Absolute path of `<directory>/ancestry-cache/<schemaVersion>`. */
  private readonly root: string;

  private readonly schemaVersion: string;
  private readonly normalizationVersion: string;
  private readonly now: () => number;
  private readonly logger: CacheLogger;
  private readonly scanTtlMs: number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private corruptionCount = 0;

  /** Serialisation chains, keyed by record key or by repository key. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  private scan: ScanSnapshot | null = null;
  private scanAt = 0;

  private closed = false;

  constructor(options: FileCacheStoreOptions) {
    this.schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
    this.normalizationVersion = options.normalizationVersion ?? NORMALIZATION_VERSION;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.scanTtlMs = options.scanTtlMs ?? SCAN_TTL_MS;
    this.root = path.join(path.resolve(options.directory), CACHE_DIR_NAME, this.schemaVersion);
    this.info = {
      backend: 'file',
      location: this.root,
      schemaVersion: this.schemaVersion,
      native: false,
      note: options.note ?? null,
    };
  }

  /**
   * Number of records discarded as unreadable or inconsistent since this store
   * was created. Surfaced for diagnostics; not part of `CacheStats`.
   */
  public get corruptions(): number {
    return this.corruptionCount;
  }

  public async init(): Promise<void> {
    await this.guard<void>('init', undefined, async () => {
      await ensureDir(this.root);
    });
  }

  public async getRepository(repoRoot: string): Promise<CachedRepository | null> {
    const key = makeRepositoryEntryId(repoRoot, 'repository');
    return this.guard('getRepository', null, async () => {
      const hit = await this.readRecord<CachedRepository>(key, isCachedRepository);
      if (hit === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return hit.value;
    });
  }

  public async putRepository(repo: CachedRepository): Promise<void> {
    const key = makeRepositoryEntryId(repo.repoRoot, 'repository');
    await this.guard('putRepository', undefined, async () => {
      await this.writeRecord(key, repo, repo.lastIndexedAt, isCachedRepository);
      // Materialise the repository directory so `stats().repositoryCount` and the
      // per-file index have a home even before any block is cached.
      await this.enqueue(makeRepoKey(repo.repoRoot), async () => {
        const index = await this.readIndex(makeRepoKey(repo.repoRoot));
        if (index !== null) {
          return;
        }
        await this.writeIndex(makeRepoKey(repo.repoRoot), {
          v: this.schemaVersion,
          repo: makeRepoKey(repo.repoRoot),
          updatedAt: this.now(),
          files: {},
        });
      });
      this.invalidateScan();
    });
  }

  public async getBlock(key: string): Promise<CachedBlock | null> {
    return this.guard('getBlock', null, async () => {
      const hit = await this.readRecord<CachedBlock>(key, isCachedBlock);
      if (hit === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return hit.value;
    });
  }

  public async putBlock(block: CachedBlock): Promise<void> {
    const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
    await this.guard('putBlock', undefined, async () => {
      await this.writeRecord(key, block, block.cachedAt, isCachedBlock);
      const repoKey = makeRepoKey(block.repoRoot);
      const entry = indexEntry(block.commit, block.filePath);
      await this.enqueue(repoKey, async () => {
        const index = (await this.readIndex(repoKey)) ?? {
          v: this.schemaVersion,
          repo: repoKey,
          updatedAt: this.now(),
          files: {},
        };
        const existing = index.files[entry];
        if (existing === undefined) {
          index.files[entry] = [key];
        } else if (!existing.includes(key)) {
          existing.push(key);
        }
        index.updatedAt = this.now();
        await this.writeIndex(repoKey, index);
      });
      this.invalidateScan();
    });
  }

  public async getBlocksForFile(
    repoRoot: string,
    filePath: string,
    commit: string,
  ): Promise<CachedBlock[]> {
    return this.guard('getBlocksForFile', [] as CachedBlock[], async () => {
      const repoKey = makeRepoKey(repoRoot);
      const index = await this.readIndex(repoKey);
      if (index === null) {
        this.misses += 1;
        return [];
      }
      const keys = index.files[indexEntry(commit, filePath)];
      if (keys === undefined) {
        this.misses += 1;
        return [];
      }
      this.hits += 1;
      const blocks: CachedBlock[] = [];
      for (const key of keys) {
        const hit = await this.readRecord<CachedBlock>(key, isCachedBlock);
        if (hit === null) {
          this.misses += 1;
          continue;
        }
        this.hits += 1;
        blocks.push(hit.value);
      }
      return sortBlocks(blocks);
    });
  }

  public async getNormalizations(blockIds: string[]): Promise<Map<string, NormalizedBlock>> {
    const found = new Map<string, NormalizedBlock>();
    if (blockIds.length === 0) {
      return found;
    }
    await this.guard('getNormalizations', undefined, async () => {
      // Deduplicated so a repeated id costs exactly one read, which keeps the
      // hit/miss counters identical to the SQL backend's chunked `IN` lookup.
      for (const blockId of new Set(blockIds)) {
        const key = makeBlockNormalizeKey(blockId, this.normalizationVersion);
        const hit = await this.readRecord<NormalizedBlock>(key, isNormalizedBlock);
        if (hit === null) {
          this.misses += 1;
          continue;
        }
        this.hits += 1;
        found.set(blockId, hit.value);
      }
    });
    return found;
  }

  public async putNormalizations(entries: NormalizedBlock[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const stamp = this.now();
    await this.guard('putNormalizations', undefined, async () => {
      // Each record is written independently and atomically, so the batch is
      // issued with bounded concurrency: a file write is latency-bound, not
      // CPU-bound, and one-at-a-time would make a 2 000-block analysis wait on
      // 2 000 sequential round trips. A failure part-way through still leaves
      // every already-written record valid, because each is individually
      // checksummed.
      await mapWithConcurrency(entries, WRITE_CONCURRENCY, async (entry) => {
        if (entry.normalizationVersion !== this.normalizationVersion) {
          // Written by a different normalisation generation: refuse rather than
          // store something this store would later reject.
          this.logger.warn(
            `ancestry cache: skipped normalisation ${shortId(entry.blockId)} written for ` +
              `version ${entry.normalizationVersion} (store is on ${this.normalizationVersion})`,
          );
          return;
        }
        const key = makeBlockNormalizeKey(entry.blockId, this.normalizationVersion);
        await this.writeRecord(key, entry, stamp, isNormalizedBlock);
      });
      this.invalidateScan();
    });
  }

  public async getMatch(sourceId: string, candidateId: string): Promise<SimilarityResult | null> {
    return this.guard('getMatch', null, async () => {
      const key = makeMatchCacheKey(sourceId, candidateId);
      const hit = await this.readRecord<SimilarityResult>(key, isSimilarityResult);
      if (hit === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return hit.value;
    });
  }

  public async putMatch(result: SimilarityResult): Promise<void> {
    const key = makeMatchCacheKey(result.sourceBlockId, result.candidateBlockId);
    await this.guard('putMatch', undefined, async () => {
      await this.writeRecord(key, result, this.now(), isSimilarityResult);
      this.invalidateScan();
    });
  }

  public async purgeOlderThan(epochMs: number): Promise<number> {
    return this.guard('purgeOlderThan', 0, async () => {
      let removed = 0;
      const shards = await this.listShardDirectories();
      for (const shard of shards) {
        const entries = await fs.readdir(shard, { withFileTypes: true });
        for (const entry of entries) {
          // `isFile()` is false for symlinks and directories, so neither a
          // symlink planted in the cache root nor a nested directory is followed.
          if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
          }
          const file = path.join(shard, entry.name);
          if (!isInsideRoot(this.root, file)) {
            continue;
          }
          const record = await this.readEnvelope(file);
          if (record === null) {
            // Unreadable on its own: `readEnvelope` already discarded it.
            continue;
          }
          if (record.t < epochMs && (await removeWithRetries(file))) {
            removed += 1;
          }
        }
        await this.removeDirIfEmpty(shard);
      }
      this.evictions += removed;
      this.invalidateScan();
      this.logger.debug(`ancestry cache: purged ${removed} expired record(s)`);
      return removed;
    });
  }

  public async stats(): Promise<CacheStats> {
    const snapshot = await this.guard<ScanSnapshot>('stats', emptySnapshot(), () =>
      this.snapshot(),
    );
    return {
      backend: this.info.backend,
      entries: snapshot.entries,
      bytes: snapshot.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      oldestEntryTimestamp: snapshot.oldest,
      newestEntryTimestamp: snapshot.newest,
      repositoryCount: await this.countRepositories(),
    };
  }

  public async clear(): Promise<void> {
    await this.guard('clear', undefined, async () => {
      await this.settle();
      await fs.rm(this.root, { recursive: true, force: true });
      this.scan = null;
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.settle();
  }

  // -------------------------------------------------------------------------
  // Record access
  // -------------------------------------------------------------------------

  /**
   * Read, verify and (on failure) discard one record.
   *
   * @returns the payload and its timestamp, or `null` for both "not present" and
   * "present but unusable" — the two are indistinguishable to the caller by
   * design, which is what makes a damaged cache behave like an empty one.
   */
  private async readRecord<T>(
    key: string,
    validate: (value: unknown) => value is T,
  ): Promise<RecordHit<T> | null> {
    const file = this.recordPath(key);
    if (file === null) {
      this.logger.debug(`ancestry cache: rejected malformed record key "${sanitizeKey(key)}"`);
      return null;
    }
    const raw = await this.readRegularFile(file);
    if (raw === null) {
      return null;
    }
    const envelope = parseEnvelope(raw);
    if (envelope === null || envelope.v !== this.schemaVersion || envelope.k !== key) {
      await this.discard(file, 'unreadable or foreign record');
      return null;
    }
    if (sha256Hex(stableStringify(envelope.p)) !== envelope.c) {
      await this.discard(file, 'checksum mismatch');
      return null;
    }
    if (!validate(envelope.p)) {
      await this.discard(file, 'unexpected payload shape');
      return null;
    }
    return { value: envelope.p, cachedAt: envelope.t };
  }

  /** Write one record atomically, serialised against other writes of the same key. */
  private async writeRecord<T>(
    key: string,
    payload: T,
    cachedAt: number,
    validate: (value: unknown) => value is T,
  ): Promise<void> {
    if (!validate(payload)) {
      throw new TypeError('ancestry cache: refusing to persist a malformed payload');
    }
    const file = this.recordPath(key);
    if (file === null) {
      throw new Error(`ancestry cache: refusing to persist under a malformed key "${key}"`);
    }
    const checksum = sha256Hex(stableStringify(payload));
    const body = JSON.stringify({
      v: this.schemaVersion,
      k: key,
      t: Math.trunc(cachedAt),
      c: checksum,
      p: payload,
    });
    await this.enqueue(key, async () => {
      await writeFileAtomic(file, body);
    });
  }

  /**
   * Absolute path of a record, or `null` when the key is not a digest this module
   * could have produced.
   *
   * Two independent defences stand between a caller-supplied key and the
   * filesystem: the key must match the exact 32-hex shape (so `..`, `/` and NUL
   * are rejected outright) and the resolved path must still be inside the cache
   * root. Keys arrive from outside the cache (a webview message, a stale graph
   * document), so this path-traversal check is load-bearing, not decorative.
   */
  private recordPath(key: string): string | null {
    if (!KEY_PATTERN.test(key)) {
      return null;
    }
    const file = path.resolve(this.root, key.slice(0, SHARD_LENGTH), `${key}.json`);
    return isInsideRoot(this.root, file) ? file : null;
  }

  /** Read a file that must be a regular file; `null` for missing or unsafe. */
  private async readRegularFile(file: string): Promise<string | null> {
    if (!isInsideRoot(this.root, file)) {
      return null;
    }
    try {
      const stat = await fs.lstat(file);
      // A symlink in place of a record is refused outright: following it would
      // read (and later delete) a file outside the cache root.
      if (!stat.isFile()) {
        await this.discard(file, 'not a regular file');
        return null;
      }
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return null;
      }
      this.logger.warn(`ancestry cache: cannot read record (${describeError(error)})`);
      return null;
    }
  }

  /** Parse just the header of a record file; used by the expiry sweep. */
  private async readEnvelope(file: string): Promise<StoredRecord<unknown> | null> {
    const raw = await this.readRegularFile(file);
    if (raw === null) {
      return null;
    }
    const envelope = parseEnvelope(raw);
    if (envelope === null || typeof envelope.t !== 'number') {
      await this.discard(file, 'unreadable or foreign record');
      return null;
    }
    return envelope;
  }

  /** Delete a damaged file and record the event. Never throws. */
  private async discard(file: string, reason: string): Promise<void> {
    this.corruptionCount += 1;
    this.logger.warn(
      `ancestry cache: discarded corrupt record ${path.basename(file)} (${reason}); ` +
        'the entry will be rebuilt on demand',
    );
    if (!(await removeWithRetries(file))) {
      this.logger.warn(
        `ancestry cache: corrupt record ${path.basename(file)} could not be removed ` +
          'and will be retried on the next access',
      );
    }
    this.invalidateScan();
  }

  // -------------------------------------------------------------------------
  // Per-repository secondary index
  // -------------------------------------------------------------------------

  private indexPath(repoKey: string): string | null {
    if (!KEY_PATTERN.test(repoKey)) {
      return null;
    }
    const file = path.resolve(this.root, repoKey, INDEX_FILE);
    return isInsideRoot(this.root, file) ? file : null;
  }

  private async readIndex(repoKey: string): Promise<RepoIndex | null> {
    const file = this.indexPath(repoKey);
    if (file === null) {
      return null;
    }
    const raw = await this.readRegularFile(file);
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.discardIndex(file);
      return null;
    }
    if (!isRepoIndex(parsed) || parsed.v !== this.schemaVersion) {
      await this.discardIndex(file);
      return null;
    }
    return parsed;
  }

  private async writeIndex(repoKey: string, index: RepoIndex): Promise<void> {
    const file = this.indexPath(repoKey);
    if (file === null) {
      return;
    }
    await writeFileAtomic(file, JSON.stringify(index));
  }

  private async discardIndex(file: string): Promise<void> {
    this.corruptionCount += 1;
    this.logger.warn(
      'ancestry cache: discarded corrupt repository index; blocks for affected files ' +
        'will be re-parsed and re-cached',
    );
    await removeWithRetries(file);
    this.invalidateScan();
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Every shard directory, validated to be a real directory inside the root. */
  private async listShardDirectories(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    }
    const shards: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.resolve(this.root, entry.name);
      if (isInsideRoot(this.root, dir) && SHARD_PATTERN.test(entry.name)) {
        shards.push(dir);
      }
    }
    return shards;
  }

  /** Count the repositories the store has seen, one directory each. */
  private async countRepositories(): Promise<number> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (entry.isDirectory() && KEY_PATTERN.test(entry.name)) {
          count += 1;
        }
      }
      return count;
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return 0;
      }
      this.logger.warn(`ancestry cache: cannot enumerate repositories (${describeError(error)})`);
      return 0;
    }
  }

  /**
   * Walk every record to count entries, bytes and the age range.
   *
   * This is O(files) syscalls, so the result is cached for `scanTtlMs` (30 s by
   * default) and invalidated eagerly by any write through this store. A stats
   * command that polls, or a `stats()` called on every keystroke, therefore
   * costs one walk per window, while ordinary write-then-stat usage stays exact.
   */
  private async snapshot(): Promise<ScanSnapshot> {
    const nowMs = this.now();
    if (this.scan !== null && nowMs - this.scanAt < this.scanTtlMs) {
      return this.scan;
    }
    let entries = 0;
    let bytes = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const shard of await this.listShardDirectories()) {
      const dirEntries = await fs.readdir(shard, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const file = path.join(shard, entry.name);
        if (!isInsideRoot(this.root, file)) {
          continue;
        }
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile()) {
            continue;
          }
          const raw = await fs.readFile(file, 'utf8');
          const envelope = parseEnvelope(raw);
          if (envelope === null || typeof envelope.t !== 'number') {
            continue;
          }
          entries += 1;
          bytes += stat.size;
          oldest = oldest === null ? envelope.t : Math.min(oldest, envelope.t);
          newest = newest === null ? envelope.t : Math.max(newest, envelope.t);
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT')) {
            this.logger.warn(`ancestry cache: stats skipped a record (${describeError(error)})`);
          }
        }
      }
    }
    this.scan = { entries, bytes, oldest, newest };
    this.scanAt = nowMs;
    return this.scan;
  }

  private async removeDirIfEmpty(dir: string): Promise<void> {
    try {
      const remaining = await fs.readdir(dir);
      if (remaining.length === 0) {
        await fs.rmdir(dir);
      }
    } catch {
      // A non-empty or already-removed directory is not a problem.
    }
  }

  private invalidateScan(): void {
    this.scan = null;
  }

  // -------------------------------------------------------------------------
  // Write serialisation + error containment
  // -------------------------------------------------------------------------

  /**
   * Run `task` after any previously queued task for `chainKey`.
   *
   * A rejected predecessor does not skip its successor (the cache is
   * best-effort), and the chain is dropped from the map once idle so a long
   * analysis does not accumulate one promise per record forever.
   */
  private enqueue(chainKey: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(chainKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(chainKey, settled);
    this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
      if (this.chains.get(chainKey) === settled) {
        this.chains.delete(chainKey);
      }
    });
    return next;
  }

  /** Wait for every queued write; used by `close` and `clear`. */
  private async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * Contain a cache failure.
   *
   * Cache problems are never allowed to propagate into the analysis pipeline, so
   * every public method routes through here and degrades to `fallback` with a
   * warning. Only the error *code* is logged, never its message, because a
   * `JSON.parse` message embeds a snippet of the file it choked on — which, for
   * this cache, is source code.
   *
   * A closed store also short-circuits here, so a caller that kept a reference
   * after `close()` sees the same "cache unavailable" behaviour as the SQL
   * backend instead of silently reading from disk behind the factory's back.
   */
  private async guard<T>(operation: string, fallback: T, task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return fallback;
    }
    try {
      return await task();
    } catch (error) {
      this.logger.warn(
        `ancestry cache: ${operation} failed (${describeError(error)}); continuing without it`,
      );
      return fallback;
    }
  }
}

/** A shard directory is exactly two lowercase hex characters. */
const SHARD_PATTERN = /^[0-9a-f]{2}$/;

/**
 * Apply `task` to every item with at most `limit` in flight.
 *
 * Rejects as soon as one task rejects, but the remaining tasks are still awaited
 * so no write is left dangling — the caller must be able to reason about the
 * store's state after a failure.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      await task(items[index] as T);
    }
  });
  await Promise.all(workers);
}

/** Index entry key: the 40-hex commit keeps `::` unambiguous inside a file path. */
function indexEntry(commit: string, filePath: string): string {
  return `${commit}::${normalizeRepoPath(filePath)}`;
}

/** Deterministic block order so both backends return identical arrays. */
function sortBlocks(blocks: CachedBlock[]): CachedBlock[] {
  return blocks.sort((a, b) => {
    if (a.range.startLine !== b.range.startLine) {
      return a.range.startLine - b.range.startLine;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function emptySnapshot(): ScanSnapshot {
  return { entries: 0, bytes: 0, oldest: null, newest: null };
}

/**
 * Parse a record envelope.
 *
 * The `JSON.parse` error is deliberately swallowed without inspecting it: Node
 * embeds a fragment of the offending text in that message, and this file holds
 * source code.
 */
function parseEnvelope(raw: string): StoredRecord<unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const { v, k, t, c, p } = parsed as Partial<StoredRecord<unknown>>;
  if (typeof v !== 'string' || typeof k !== 'string' || typeof c !== 'string') {
    return null;
  }
  if (typeof t !== 'number' || !Number.isFinite(t) || p === undefined) {
    return null;
  }
  return { v, k, t, c, p };
}

/** Truncate an untrusted key before it reaches a log line. */
function sanitizeKey(key: string): string {
  return key.length <= 40 ? key.replace(/[^\w-]/g, '?') : `${key.slice(0, 8)}…`;
}

/** Short, non-reversible form of a block id for log messages. */
function shortId(blockId: string): string {
  return blockId.length <= 48 ? blockId : `${blockId.slice(0, 48)}…`;
}

/** `true` when `candidate` is strictly inside `root`. */
function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '' || path.isAbsolute(relative)) {
    return false;
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** `true` when the value is a non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `true` when the error is an `ErrnoException` with the given code. */
function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Describe an error *without* its message.
 *
 * Messages from `JSON.parse` contain a snippet of the input and messages from
 * other libraries can contain anything they were handed, so only the error class
 * and the `errno` code — both attacker- and content-independent — are logged.
 */
function describeError(error: unknown): string {
  if (isObject(error)) {
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const code = typeof error.code === 'string' ? error.code : undefined;
    return code === undefined ? name : `${name}(${code})`;
  }
  return typeof error;
}

// ---------------------------------------------------------------------------
// Payload shape guards
//
// These are corruption tripwires, not type assertions: they check the few fields
// the store itself relies on, so a record that was overwritten with unrelated
// JSON is reported as a miss instead of being handed to the parser as if it were
// a CodeBlock.
// ---------------------------------------------------------------------------

function isCachedRepository(value: unknown): value is CachedRepository {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.repoRoot === 'string' &&
    (value.headCommit === null || typeof value.headCommit === 'string') &&
    isNumber(value.lastIndexedAt) &&
    isNumber(value.indexedCommitCount)
  );
}

function isCachedBlock(value: unknown): value is CachedBlock {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.repoRoot === 'string' &&
    typeof value.commit === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.text === 'string' &&
    typeof value.textHash === 'string' &&
    typeof value.kind === 'string' &&
    isObject(value.range) &&
    isNumber(value.cachedAt)
  );
}

function isNormalizedBlock(value: unknown): value is NormalizedBlock {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.blockId === 'string' &&
    typeof value.normalizedText === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.normalizationVersion === 'string' &&
    Array.isArray(value.minhash) &&
    Array.isArray(value.shingles) &&
    Array.isArray(value.tokens)
  );
}

function isSimilarityResult(value: unknown): value is SimilarityResult {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.sourceBlockId === 'string' &&
    typeof value.candidateBlockId === 'string' &&
    isNumber(value.similarity) &&
    isObject(value.breakdown) &&
    typeof value.classification === 'string'
  );
}

function isRepoIndex(value: unknown): value is RepoIndex {
  if (!isObject(value) || !isObject(value.files)) {
    return false;
  }
  for (const entry of Object.values(value.files)) {
    if (!Array.isArray(entry) || entry.some((key) => typeof key !== 'string')) {
      return false;
    }
  }
  return typeof value.repo === 'string' && isNumber(value.updatedAt);
}
