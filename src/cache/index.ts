/**
 * Cache backend selection and cache-directory resolution.
 *
 * This module is the only entry point the rest of the extension needs:
 *
 * ```ts
 * const store = await createCacheStore({ directory: context.globalStorageUri.fsPath, backend: 'auto' });
 * ```
 *
 * Backend policy
 *  - `auto`   — use `node:sqlite` when the runtime provides it, otherwise the
 *               checksummed JSON store. If SQLite is present but cannot be opened
 *               (read-only storage, a damaged file, a locked directory) the file
 *               store takes over and `info.note` explains why.
 *  - `sqlite` — SQLite or a `CACHE_UNAVAILABLE` `AncestryError`. A user who asked
 *               for SQLite by name deserves to be told, not silently redirected.
 *  - `file`   — always the JSON store, `native: false`, noted as forced by
 *               configuration. Used by tests and by users debugging the index.
 *
 * A cache is an optimisation, so a cache problem must never take an analysis
 * down: `createCacheStore` returns a working store or throws exactly one error
 * type, `CACHE_UNAVAILABLE`, which the caller is expected to catch and continue
 * from.
 *
 * PRIVACY
 * The index contains source text (`CachedBlock.text`, `NormalizedBlock
 * .normalizedText`). It is written only under the storage directory this module
 * resolves — the user's own machine, inside their own user-data directory, or a
 * temp directory the OS cleans up. It is never logged, never printed, and never
 * sent anywhere: Ancestry has no network code and no telemetry backend. Log
 * messages passed to {@link CacheLogger} carry paths, error codes and counts
 * only, never payloads.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { AncestryError, CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../types';
import type { ICacheStore } from '../types';
import { removeWithRetries } from './atomic';
import { FileCacheStore } from './fileStore';
import { isSqliteAvailable, sqliteDatabasePath, SqliteCacheStore } from './sqliteStore';
/** Directory name used inside the user's storage directory. */
const CACHE_DIR_NAME = 'ancestry-cache';

/** Environment variable that overrides the cache location (tests, CLI use). */
const DIRECTORY_ENV_VAR = 'ANCESTRY_CACHE_DIR';

/** Milliseconds in a day, used to turn `maxAgeDays` into a cutoff. */
const MS_PER_DAY = 86_400_000;

/**
 * Minimal logging surface the cache may use.
 *
 * Implementations must never be given source text: the cache deliberately logs
 * only counts, record keys (SHA-256 digests) and error codes.
 */
export interface CacheLogger {
  debug(msg: string): void;
  warn(msg: string): void;
}

/** Options for {@link createCacheStore}. */
export interface CacheFactoryOptions {
  /**
   * Explicit storage directory. The VS Code integration passes
   * `context.globalStorageUri.fsPath`; when omitted the directory is resolved by
   * {@link defaultCacheDirectory}.
   */
  directory: string;
  /** Backend preference. Defaults to `auto`. */
  backend?: 'auto' | 'sqlite' | 'file';
  /** Persisted schema version; defaults to `CACHE_SCHEMA_VERSION`. */
  schemaVersion?: string;
  /** Entries older than this are evicted when the store is initialised. */
  maxAgeDays?: number;
  /** Clock, injectable so expiry is testable. */
  now?: () => number;
  logger?: CacheLogger;
  /**
   * Repository the caller is about to analyse.
   *
   * Recorded for diagnostics only: one store is shared by every repository the
   * extension opens, and every record is keyed by repository.
   */
  repoRoot?: string;
}

/** Logger used when the caller supplies none. */
const NOOP_LOGGER: CacheLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * Resolve the directory that holds the cache.
 *
 * Precedence:
 *  1. the explicit argument (the VS Code integration always passes its
 *     `globalStorageUri`),
 *  2. the `ANCESTRY_CACHE_DIR` environment variable (tests and CLI runs),
 *  3. `os.tmpdir()/ancestry-cache`.
 *
 * The third option exists for tests and headless CLI use only: the OS may clear a
 * temp directory at any time, which costs a rebuild but is never incorrect. The
 * extension itself always passes its own user-data directory, so a user's index
 * is not at the mercy of a temp sweep.
 */
export function defaultCacheDirectory(explicit?: string): string {
  const candidate = explicit ?? process.env[DIRECTORY_ENV_VAR] ?? '';
  if (candidate.trim().length > 0) {
    return path.resolve(candidate);
  }
  return path.join(os.tmpdir(), CACHE_DIR_NAME);
}

/**
 * Create and initialise the best available cache backend.
 *
 * After `init()`, `maxAgeDays` is applied by purging everything older than
 * `now() - maxAgeDays * 86_400_000`, so a stale index shrinks on the first run
 * after the setting changes rather than growing forever.
 *
 * @throws {AncestryError} with code `CACHE_UNAVAILABLE` only when the caller
 * explicitly requested `sqlite` and it could not be provided. Every other
 * configuration yields a working store.
 */
export async function createCacheStore(options: CacheFactoryOptions): Promise<ICacheStore> {
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? Date.now;
  const schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const preference = options.backend ?? 'auto';
  const directory = defaultCacheDirectory(options.directory);
  const wantSqlite = preference !== 'file';

  if (options.repoRoot !== undefined) {
    logger.debug(`ancestry cache: opening a shared index for ${options.repoRoot}`);
  }

  let store: ICacheStore | null = null;
  let note: string | null = null;

  if (wantSqlite) {
    const available = await isSqliteAvailable();
    if (!available) {
      if (preference === 'sqlite') {
        throw new AncestryError(
          'CACHE_UNAVAILABLE',
          'This Node runtime does not provide node:sqlite, which the configured cache backend requires.',
          {
            detail: 'Set ancestry.cache.backend to "auto" or "file" to use the local index anyway.',
          },
        );
      }
      note =
        `node:sqlite is not available on ${process.version}; using the checksummed JSON store instead. ` +
        'The index is slower but has identical behaviour.';
    } else {
      try {
        store = await openSqliteStore(directory, schemaVersion, now, logger);
      } catch (error) {
        if (preference === 'sqlite') {
          throw error instanceof AncestryError
            ? error
            : new AncestryError(
                'CACHE_UNAVAILABLE',
                'The Ancestry index database could not be opened.',
                {
                  detail: error instanceof Error ? error.name : typeof error,
                  cause: error,
                },
              );
        }
        note =
          `The SQLite index could not be opened (${error instanceof Error ? error.name : 'unknown error'})` +
          `; using the checksummed JSON store instead, located at ${path.join(directory, CACHE_DIR_NAME)}.`;
        logger.warn(`ancestry cache: SQLite unavailable, falling back to the file store (${note})`);
      }
    }
  }

  if (store === null) {
    store = await openFileStore(directory, schemaVersion, now, logger, note, preference);
  }

  try {
    await store.init();
  } catch (error) {
    logger.warn(
      `ancestry cache: initialisation failed (${
        error instanceof Error ? error.name : typeof error
      }); continuing without an index`,
    );
    const replacement = await openFileStore(
      directory,
      schemaVersion,
      now,
      logger,
      `the ${store.info.backend} backend failed to initialise; using the checksummed JSON store instead`,
      preference,
    );
    await replacement.init().catch(() => undefined);
    return prune(replacement, options, now, logger);
  }

  return prune(store, options, now, logger);
}

/** Apply the age policy, then hand the store back. Never throws. */
async function prune(
  store: ICacheStore,
  options: CacheFactoryOptions,
  now: () => number,
  logger: CacheLogger,
): Promise<ICacheStore> {
  const maxAgeDays = options.maxAgeDays;
  if (typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
    const cutoff = now() - maxAgeDays * MS_PER_DAY;
    try {
      const removed = await store.purgeOlderThan(cutoff);
      logger.debug(`ancestry cache: pruned ${removed} entr(ies) older than ${maxAgeDays} day(s)`);
    } catch (error) {
      logger.warn(
        `ancestry cache: pruning old entries failed (${
          error instanceof Error ? error.name : typeof error
        }); the index is still usable`,
      );
    }
  }
  return store;
}

/** Construct the SQLite backend, discarding its files if initialisation fails. */
async function openSqliteStore(
  directory: string,
  schemaVersion: string,
  now: () => number,
  logger: CacheLogger,
): Promise<ICacheStore> {
  const filePath = sqliteDatabasePath(directory, schemaVersion);
  try {
    return new SqliteCacheStore({
      filePath,
      schemaVersion,
      normalizationVersion: NORMALIZATION_VERSION,
      now,
      logger,
    });
  } catch (error) {
    // The constructor could not finish: remove whatever it managed to create so
    // the next run starts from a clean directory instead of inheriting a
    // half-built index.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await removeWithRetries(`${filePath}${suffix}`);
    }
    throw error;
  }
}

/** Construct the file backend with an explanation of why it was chosen. */
function openFileStore(
  directory: string,
  schemaVersion: string,
  now: () => number,
  logger: CacheLogger,
  note: string | null,
  preference: 'auto' | 'sqlite' | 'file',
): ICacheStore {
  return new FileCacheStore({
    directory,
    schemaVersion,
    normalizationVersion: NORMALIZATION_VERSION,
    now,
    logger,
    note:
      note ??
      (preference === 'file'
        ? 'the file store was selected by configuration (ancestry.cache.backend = "file")'
        : null),
  });
}

export { FileCacheStore, isSqliteAvailable, sqliteDatabasePath, SqliteCacheStore };
export { ensureDir, removeWithRetries, writeFileAtomic } from './atomic';
export {
  makeBlockCacheKey,
  makeBlockNormalizeKey,
  makeMatchCacheKey,
  makeNormalizeCacheKey,
  makeRepoKey,
  makeRepositoryEntryId,
  normalizeRepoPath,
  normalizeRepoRoot,
  sha256Hex,
  stableStringify,
} from './keys';
export type { FileCacheStoreOptions } from './fileStore';
export type { SqliteCacheStoreOptions } from './sqliteStore';
export { closeDatabase } from './sqliteStore';
