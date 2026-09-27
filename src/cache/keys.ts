/**
 * Cache key derivation for the Ancestry local index.
 *
 * Every cache record is addressed by an opaque, filesystem-safe, lowercase hex
 * key. Keys are *pure functions* of the logical identity of a record, which is
 * what makes the index survive process restarts and lets two different
 * spellings of the same thing (a repository path typed two ways, a block pair
 * asked about in either order) address exactly one entry.
 *
 * PRIVACY: keys are SHA-256 digests of paths, commit hashes and content hashes
 * only. They never contain source text, so they are safe to write to a log.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** Hex characters kept from each digest. 128 bits is ample for a local index. */
const KEY_LENGTH = 32;

/** Guard against pathological nesting in {@link stableStringify}. */
const MAX_STABLE_DEPTH = 64;

/**
 * Lowercase hex SHA-256 of `input`.
 *
 * Exported because the file store must compute record checksums with *exactly*
 * the same primitive the keys are built from, so that a key and a checksum are
 * never produced by two subtly different hash implementations.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** True when the process runs on a case-insensitive filesystem (Windows). */
function isCaseInsensitivePlatform(): boolean {
  return process.platform === 'win32';
}

/**
 * Canonicalise an absolute repository root so that two spellings of the same
 * directory hash to the same key:
 *
 *  - backslashes become forward slashes,
 *  - `.`/`..` segments are resolved,
 *  - duplicate separators collapse (a leading `//` is preserved: it is a UNC
 *    share prefix, not a redundant separator),
 *  - trailing separators are removed, but a filesystem root stays a root,
 *  - **on Windows the whole path is lower-cased**, because NTFS is
 *    case-insensitive: `C:\Proj\app` and `c:/proj/app/` name the same
 *    directory. Case is *meaningful* on Linux and macOS, so it is preserved
 *    there — folding it there would merge two genuinely different checkouts.
 */
export function normalizeRepoRoot(repoRoot: string): string {
  const slashed = repoRoot.trim().replace(/\\/g, '/');
  if (slashed.length === 0) {
    return '';
  }
  const normalized = (
    isCaseInsensitivePlatform() ? path.win32.normalize(slashed) : path.posix.normalize(slashed)
  ).replace(/\\/g, '/');

  const isUnc = normalized.startsWith('//');
  const body = (isUnc ? normalized.slice(1) : normalized).replace(/\/{2,}/g, '/');
  let out = isUnc ? `/${body}` : body;

  const isFilesystemRoot = /^(?:[A-Za-z]:)?\/$/.test(out) || /^[A-Za-z]:$/.test(out);
  if (!isFilesystemRoot) {
    out = out.replace(/\/+$/, '');
  }
  return isCaseInsensitivePlatform() ? out.toLowerCase() : out;
}

/**
 * Canonicalise a repository-relative POSIX path. Windows-style separators and a
 * leading `./` are accepted so that a caller which did not normalise its input
 * still lands on the same record.
 */
export function normalizeRepoPath(filePath: string): string {
  let out = filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  if (out.length > 1) {
    out = out.replace(/\/+$/, '');
  }
  return out;
}

/** Concatenate identity parts with a separator that cannot occur in any of them. */
function joinIdentity(parts: readonly string[]): string {
  return parts.join('\u0000');
}

/**
 * Stable identity of a repository on this machine.
 *
 * Windows note: paths are case-folded because the filesystem is
 * case-insensitive, so `C:\Users\Me\Proj` and `c:/users/me/proj/` produce one
 * key. On case-sensitive platforms the spelling is significant and is kept
 * verbatim, so two distinct checkouts never share a cache.
 */
export function makeRepoKey(repoRoot: string): string {
  return sha256Hex(`repo\u0000${normalizeRepoRoot(repoRoot)}`).slice(0, KEY_LENGTH);
}

/**
 * Key of one cached code block: a block's text is uniquely identified by the
 * repository it came from, the commit it was seen at, the file it lived in and
 * the hash of its text. Including all four means the same function body at two
 * commits, or in two files, is stored (and invalidated) independently.
 */
export function makeBlockCacheKey(
  repoRoot: string,
  commit: string,
  filePath: string,
  textHash: string,
): string {
  return sha256Hex(
    joinIdentity(['blk', makeRepoKey(repoRoot), commit, normalizeRepoPath(filePath), textHash]),
  ).slice(0, KEY_LENGTH);
}

/**
 * Content-addressed key of a *normalisation payload*.
 *
 * The normalisation version is part of the hashed identity, so bumping
 * `NORMALIZATION_VERSION` changes every key and the previous generation of
 * entries becomes unreachable (and is reclaimed by `purgeOlderThan`) instead of
 * being silently reused.
 */
export function makeNormalizeCacheKey(tokenHash: string, normalizationVersion: string): string {
  return sha256Hex(joinIdentity(['nrm', normalizationVersion, tokenHash])).slice(0, KEY_LENGTH);
}

/**
 * Lookup key of a stored normalisation, derived from the *block id* rather than
 * from the content hash.
 *
 * Why both this and {@link makeNormalizeCacheKey} exist: `ICacheStore
 * .getNormalizations` receives bare block ids, so a batch read of N ids must be
 * able to address N records with zero extra index round-trips. Content-addressed
 * keys would require a `blockId → key` indirection, i.e. an extra read per
 * batch. Addressing by block id keeps the batch O(N) file reads with no
 * indirection, while the version stays part of the key so a bump still
 * invalidates everything.
 */
export function makeBlockNormalizeKey(blockId: string, normalizationVersion: string): string {
  return sha256Hex(joinIdentity(['bnm', normalizationVersion, blockId])).slice(0, KEY_LENGTH);
}

/**
 * Key of a similarity result. The two block ids are sorted first, so the key is
 * *symmetric*: asking for the match between A and B, or between B and A, hits
 * the same record and therefore the same cache entry.
 */
export function makeMatchCacheKey(sourceId: string, candidateId: string): string {
  const [first, second] =
    sourceId < candidateId ? [sourceId, candidateId] : [candidateId, sourceId];
  return sha256Hex(joinIdentity(['sim', first, second])).slice(0, KEY_LENGTH);
}

/**
 * Repository-scoped entry id, used for the per-repository secondary index file
 * and for any future repository-level record.
 *
 * `kind` discriminates several records that belong to the same repository. It is
 * sanitised to `[A-Za-z0-9._-]` because the value is used as a path segment, and
 * a caller-supplied kind containing a separator must not be able to escape the
 * cache root.
 */
export function makeRepositoryEntryId(repoRoot: string, kind = 'meta'): string {
  const safeKind = kind.replace(/[^A-Za-z0-9._-]/g, '-');
  return sha256Hex(joinIdentity(['rpo', makeRepoKey(repoRoot), safeKind])).slice(0, KEY_LENGTH);
}

/** `true` when the value may be rendered as a JSON object key. */
function isJsonKey(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Render a value as JSON with deterministic key order (object keys sorted by
 * code unit), so the same logical value always produces byte-identical output
 * regardless of how the object was built.
 *
 * This is what makes the file store's record checksums meaningful: the checksum
 * is computed over this canonical form on write and recomputed over the parsed
 * form on read, so a record that merely re-ordered its keys on a round trip
 * still verifies, while a genuinely altered payload does not.
 *
 * Throws on circular structures and on nesting deeper than 64 levels: a
 * checksum that silently collapsed a cycle would verify corrupt data.
 */
export function stableStringify(value: unknown): string {
  // A top-level value JSON drops (`undefined`, a function) has no textual form;
  // `null` is the deterministic stand-in, so a checksum always exists.
  return renderStable(value, new Set<object>(), 0) ?? 'null';
}

/**
 * @returns the rendered JSON, or `undefined` for a value JSON drops
 * (`undefined`, functions, symbols) so object writers can omit the key exactly
 * like `JSON.stringify` does.
 */
function renderStable(value: unknown, seen: Set<object>, depth: number): string | undefined {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      // Beyond 2^53 a JSON number cannot round-trip, so a bigint is rendered as
      // its decimal text. Timestamps and sizes never reach this branch.
      return value.toString(10);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  if (depth >= MAX_STABLE_DEPTH) {
    throw new Error(`stableStringify: value nests deeper than ${MAX_STABLE_DEPTH} levels`);
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new Error('stableStringify: value contains a circular reference');
  }
  seen.add(object);
  try {
    const withToJson = value as { toJSON?: (key?: string) => unknown };
    if (typeof withToJson.toJSON === 'function') {
      const replaced = withToJson.toJSON();
      if (replaced !== value) {
        return renderStable(replaced, seen, depth + 1) ?? 'null';
      }
    }
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (const item of object) {
        parts.push(renderStable(item, seen, depth + 1) ?? 'null');
      }
      return `[${parts.join(',')}]`;
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).filter(isJsonKey).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const rendered = renderStable(record[key], seen, depth + 1);
      if (rendered !== undefined) {
        parts.push(`${JSON.stringify(key)}:${rendered}`);
      }
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}
