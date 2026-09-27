/**
 * Durable, atomic file primitives for the file-backed cache.
 *
 * The cache is written while the extension host is alive, so a crash, a
 * concurrent VS Code window or a virus scanner on Windows can interrupt a write
 * at any instruction. Every write therefore goes to a uniquely named temporary
 * file in the *same directory* and is then renamed over the target, which is the
 * only way POSIX and Windows both guarantee "all of it, or none of it".
 *
 * PRIVACY: these helpers move bytes. They never log, print or inspect content.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Monotonic suffix so two temp names in the same process never collide. */
let tempCounter = 0;

/** Windows rename failures that mean "someone else holds the file", not "never". */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** First backoff step; doubles each attempt up to {@link RENAME_ATTEMPTS}. */
const RENAME_BASE_DELAY_MS = 8;
const RENAME_ATTEMPTS = 6;

/** `true` when `error` is a Node `SystemError` carrying one of `codes`. */
function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && codes.has(code);
}

/** `true` when the path does not exist (a benign outcome for cleanup code). */
function isMissing(error: unknown): boolean {
  return hasCode(error, new Set(['ENOENT']));
}

/**
 * Create `dir` and any missing parents.
 *
 * Idempotent: an existing directory is not an error, which is what lets `init()`
 * and every write path call this defensively.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Delete a file, retrying transient Windows sharing violations.
 *
 * @param attempts Total attempts, including the first. Defaults to 3.
 * @returns `true` when the file is gone (deleted, or never existed) and `false`
 * when every attempt was refused. Never throws: callers use it while handling
 * other errors and must not have those masked.
 */
export async function removeWithRetries(filePath: string, attempts = 3): Promise<boolean> {
  const total = Math.max(1, Math.floor(attempts));
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return true;
      }
      if (attempt + 1 < total) {
        await delay(RENAME_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }
  return false;
}

/**
 * Write `data` to `filePath` atomically.
 *
 * Sequence: create the parent directory, write a uniquely named
 * `<filePath>.tmp-<pid>-<n>` sibling, then `rename` it over the target. The
 * temporary file lives in the target's own directory so the rename never crosses
 * a filesystem boundary (which is the one case where rename is not atomic).
 *
 * On failure the temporary file is removed and the original error is rethrown, so
 * a failed write leaves the cache exactly as it was: an old record or no record,
 * never a truncated one.
 *
 * `rename` can fail transiently on Windows with `EPERM`/`EBUSY` while an indexer
 * or virus scanner holds the destination open, so it is retried with exponential
 * backoff before giving up.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${tempCounter++}`;
  try {
    await fs.writeFile(tempPath, data);
    await renameWithRetries(tempPath, filePath);
  } catch (error) {
    // Best effort: the caller is already handling a failure, and a leftover temp
    // file must not be allowed to become the reason the error is swallowed.
    await removeWithRetries(tempPath, 2);
    throw error;
  }
}

/** `rename` with exponential backoff for transient Windows sharing violations. */
async function renameWithRetries(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const retryable = hasCode(error, TRANSIENT_RENAME_CODES);
      if (!retryable || attempt + 1 >= RENAME_ATTEMPTS) {
        throw error;
      }
      await delay(RENAME_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

/** Promise-based sleep that keeps a failed cleanup from escalating. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
