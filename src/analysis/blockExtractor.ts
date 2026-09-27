/**
 * Block extraction from a file, at a commit or in the working tree.
 *
 * This is the only stage that reads file *bytes*, and it is where the pipeline
 * is most exposed to the repository's variety: a PNG, a two-megabyte generated
 * bundle, a file that does not parse, a file that did not exist yet. The
 * contract is therefore unusually strict, and every clause of it is
 * specification §10's "one unanalysable file or commit must never abort an
 * analysis":
 *
 *  - **Nothing here throws for a bad file.** `BINARY_FILE`, `FILE_TOO_LARGE`,
 *    `PARSE_FAILED`, `UNSUPPORTED_LANGUAGE`, `INVALID_PATH` and a failing
 *    `git show` all become an entry in `unparsed` with a human-readable reason
 *    and an empty block list. Cancellation is the single exception, and it
 *    propagates.
 *  - **A file that did not exist is not a failure.** `getFileTextAtCommit`
 *    returning `null` means the block was introduced later or deleted earlier;
 *    that is data, and it produces an empty result with *no* `unparsed` entry,
 *    because there is nothing wrong with the repository.
 *  - **A cache miss is indistinguishable from a cold read.** The cached path
 *    returns exactly the `CodeBlock`s the parser would have produced, in the
 *    same order, and the miss path writes exactly what the parser produced.
 *
 * ## Cache keying
 *
 * Blocks are stored under `makeBlockCacheKey(repoRoot, commit, filePath,
 * textHash)` and read back in one batch with `getBlocksForFile`, which is the
 * only batched block read in `ICacheStore`. For a commit, `(repo, path, commit)`
 * determines the content exactly, so a non-empty batch result is complete and
 * the answer is final. The working tree has no such guarantee — the same path
 * holds different bytes over time — so it is addressed under a *synthetic*
 * commit label derived from the SHA-1 of the current file text. Two different
 * working-tree states of one path therefore live in two different cache
 * partitions, and a stale batch can never be mistaken for a current one.
 *
 * @module analysis/blockExtractor
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { makeBlockCacheKey } from '../cache';
import type { GitRepository } from '../git';
import { isAbortError } from '../git';
import type { Logger } from '../logger';
import { parseSourceFromBuffer } from '../parser';
import { sha1Hex } from '../similarity';
import type { CodeBlock, ICacheStore } from '../types';
import { AncestryError } from '../types';

/** Limits and collaborators for one extraction. */
export interface ExtractorOptions {
  /** `ancestry.analysis.maxBlocksPerFile`. */
  maxBlocksPerFile: number;
  /** `ancestry.git.maxFileSizeBytes`. */
  maxBytes: number;
  /** Absolute working-tree root; part of every cache key. */
  repoRoot: string;
  /** Local index, or `null` to run without a cache. */
  cache?: ICacheStore | null;
  /** Optional logger. Only paths, counts and codes are ever written to it. */
  logger?: Logger;
  /** Injectable clock, so cached timestamps are deterministic in tests. */
  now?: () => number;
  /**
   * Wall-clock budget for a single file, in milliseconds. Exceeding it stops the
   * work in progress and reports `truncated`. Defaults to 5 000 ms.
   */
  fileBudgetMs?: number;
  /**
   * Skip the cache for files larger than this many bytes. Parsing is linear but
   * a two-megabyte generated file is not worth an index entry.
   * Defaults to 256 KiB.
   */
  cacheMaxBytes?: number;
}

/** What one extraction produced. */
export interface ExtractionOutcome {
  /** Blocks in source order. Never `null`, possibly empty. */
  blocks: CodeBlock[];
  /** Files that could not be analysed, each with a reason. */
  unparsed: Array<{ filePath: string; reason: string }>;
  /** Blocks served from the local index. */
  cacheHits: number;
  /** Blocks that had to be parsed (and, if small enough, stored). */
  cacheMisses: number;
  /** True when a limit stopped the work: file size, block count, or deadline. */
  truncated: boolean;
}

/** Default per-file wall-clock budget. */
const DEFAULT_FILE_BUDGET_MS = 5_000;

/** Files above this size are parsed but not indexed. */
const DEFAULT_CACHE_MAX_BYTES = 256 * 1024;

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Reads files — from the working tree or from a commit — and turns them into
 * `CodeBlock`s, with every failure contained and every result cacheable.
 */
export class BlockExtractor {
  private readonly repo: GitRepository;
  private readonly options: ExtractorOptions;
  private readonly maxBlocksPerFile: number;
  private readonly maxBytes: number;
  private readonly cache: ICacheStore | null;
  private readonly now: () => number;
  private readonly fileBudgetMs: number;
  private readonly cacheMaxBytes: number;

  /**
   * @param repo - Repository, used to read blobs at a commit.
   * @param options - Limits, cache, logger and clock.
   */
  constructor(repo: GitRepository, options: ExtractorOptions) {
    this.repo = repo;
    this.options = options;
    this.maxBlocksPerFile = positive(options.maxBlocksPerFile, 500);
    this.maxBytes = positive(options.maxBytes, 2 * 1024 * 1024);
    this.cache = options.cache ?? null;
    this.now = options.now ?? Date.now;
    this.fileBudgetMs = positive(options.fileBudgetMs, DEFAULT_FILE_BUDGET_MS);
    this.cacheMaxBytes = positive(options.cacheMaxBytes, DEFAULT_CACHE_MAX_BYTES);
  }

  /**
   * Parse the working-tree copy of `relPath`.
   *
   * `relPath` is repository-relative and POSIX-normalised, because that is the
   * form every `CodeBlock.filePath` must take for git and the graph to work; the
   * absolute path is derived from the repository root rather than from the
   * caller's filesystem root, so a path traversal cannot escape the repository.
   *
   * Never throws for a bad file (see the module comment); cancellation
   * propagates.
   *
   * @param relPath - Repository-relative POSIX path.
   * @param signal - Cancellation signal, checked before the read and after the parse.
   * @returns The blocks, the reasons nothing was produced, and cache accounting.
   */
  async fromWorkingTree(relPath: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
    const outcome = emptyOutcome();
    if (isCancelled(signal)) {
      throw cancelled();
    }
    const startedAt = Date.now();
    const absolute = this.safeAbsolutePath(relPath, outcome);
    if (absolute === null) {
      return outcome;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolute);
    } catch (error) {
      outcome.unparsed.push({ filePath: relPath, reason: unreadableReason(error) });
      return outcome;
    }
    if (isCancelled(signal)) {
      throw cancelled();
    }
    if (bytes.length > this.maxBytes) {
      outcome.unparsed.push({
        filePath: relPath,
        reason: tooLargeReason(bytes.length, this.maxBytes),
      });
      outcome.truncated = true;
      return outcome;
    }
    if (bytes.length === 0) {
      // An empty file is a valid input with no blocks; not a failure.
      return outcome;
    }

    const textHash = sha1Hex(bytes.toString('utf8'));
    const partition = `wt:${textHash.slice(0, 32)}`;
    const cached = await this.readBatch(relPath, partition, outcome);
    if (cached !== null) {
      return cached;
    }
    return this.parseAndStore(relPath, partition, bytes, startedAt, outcome, signal);
  }

  /**
   * Parse `relPath` as it existed at `commit`.
   *
   * @param commit - Full commit hash.
   * @param relPath - Repository-relative POSIX path.
   * @param signal - Cancellation signal.
   * @returns The blocks at that commit; empty and error-free when the path did
   *   not exist there.
   */
  async fromCommit(
    commit: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<ExtractionOutcome> {
    const outcome = emptyOutcome();
    if (isCancelled(signal)) {
      throw cancelled();
    }
    const startedAt = Date.now();
    let text: string | null;
    try {
      text = await this.repo.getFileTextAtCommit(commit, relPath, this.maxBytes);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof AncestryError && error.code === 'FILE_TOO_LARGE') {
        outcome.unparsed.push({ filePath: relPath, reason: describeError(error) });
        outcome.truncated = true;
        return outcome;
      }
      outcome.unparsed.push({
        filePath: relPath,
        reason: `could not be read at ${commit.slice(0, 12)} (${describeError(error)})`,
      });
      return outcome;
    }
    if (text === null) {
      // The file did not exist at this commit. Data, not a problem.
      return outcome;
    }
    if (isCancelled(signal)) {
      throw cancelled();
    }
    if (text.length === 0) {
      return outcome;
    }

    const cached = await this.readBatch(relPath, commit, outcome);
    if (cached !== null) {
      return cached;
    }
    return this.parseAndStore(
      relPath,
      commit,
      Buffer.from(text, 'utf8'),
      startedAt,
      outcome,
      signal,
    );
  }

  /**
   * Batched cache read. `null` means "not cached, parse it"; a non-`null` result
   * is the finished outcome.
   *
   * A cache that throws is treated as a miss: an index is an optimisation and
   * must never be able to fail an analysis (specification §8.5).
   */
  private async readBatch(
    relPath: string,
    partition: string,
    outcome: ExtractionOutcome,
  ): Promise<ExtractionOutcome | null> {
    if (this.cache === null) {
      return null;
    }
    let records: CachedBlockLike[];
    try {
      records = await this.cache.getBlocksForFile(this.options.repoRoot, relPath, partition);
    } catch (error) {
      this.options.logger?.warn(
        `ancestry analysis: block cache read failed for ${relPath} (${describeError(error)}); ` +
          'the file will be parsed',
      );
      return null;
    }
    if (records.length === 0) {
      return null;
    }
    const blocks = records
      .map((record) => toCodeBlock(record))
      .filter((block): block is CodeBlock => block !== null)
      .sort(byStartLine);
    outcome.cacheHits += blocks.length;
    outcome.blocks = blocks;
    return outcome;
  }

  /**
   * Parse, cap, and (when small enough) store.
   *
   * `parseSourceFromBuffer` runs first because it is the only thing that can
   * decide "this is not source code" without having decoded the whole file; for a
   * blob that came out of `git show` the bytes have already been decoded to text
   * by the git layer, so the buffer round trip is free of cost and keeps one code
   * path for both entry points.
   */
  private async parseAndStore(
    relPath: string,
    partition: string,
    bytes: Buffer,
    startedAt: number,
    outcome: ExtractionOutcome,
    signal: AbortSignal | undefined,
  ): Promise<ExtractionOutcome> {
    let parsed: CodeBlock[];
    try {
      const result = parseSourceFromBuffer(relPath, bytes, {
        maxBlocks: this.maxBlocksPerFile,
        maxBytes: this.maxBytes,
      });
      parsed = result.blocks;
      if (parsed.length >= this.maxBlocksPerFile) {
        outcome.truncated = true;
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      outcome.unparsed.push({ filePath: relPath, reason: describeError(error) });
      return outcome;
    }
    if (isCancelled(signal)) {
      throw cancelled();
    }
    if (Date.now() - startedAt > this.fileBudgetMs) {
      // The deadline is a backstop against a pathological file. The real
      // protections are `maxBytes` (O(1), before any decoding) and
      // `maxBlocksPerFile`; the deadline exists so that a file which is legal but
      // pathological — megabytes of deeply nested expressions — cannot hold the
      // whole run hostage.
      outcome.blocks = parsed.slice(0, this.maxBlocksPerFile);
      outcome.truncated = true;
      return outcome;
    }
    outcome.blocks = parsed;
    outcome.cacheMisses += 1;
    await this.store(relPath, partition, bytes.length, parsed);
    return outcome;
  }

  /**
   * Write the parsed blocks to the index. Never throws.
   *
   * A file larger than `cacheMaxBytes` is parsed but not indexed: caching it would
   * put a large source text into a store whose whole point is to be *small and
   * local*, and re-reading it costs one `git show` anyway.
   */
  private async store(
    relPath: string,
    partition: string,
    byteLength: number,
    blocks: CodeBlock[],
  ): Promise<void> {
    if (this.cache === null || blocks.length === 0 || byteLength > this.cacheMaxBytes) {
      return;
    }
    const cachedAt = this.now();
    for (const block of blocks) {
      try {
        await this.cache.putBlock({
          ...block,
          repoRoot: this.options.repoRoot,
          commit: partition,
          cachedAt,
        });
      } catch (error) {
        this.options.logger?.debug(
          `ancestry analysis: block cache write skipped for ${relPath} (${describeError(error)})`,
        );
        return;
      }
    }
    this.options.logger?.debug(
      `ancestry analysis: indexed ${blocks.length} block(s) of ${relPath} under ${makeBlockCacheKey(
        this.options.repoRoot,
        partition,
        relPath,
        blocks[0]?.textHash ?? '',
      )}`,
    );
  }

  /**
   * Absolute path of a repository-relative file, or `null` when the path is not
   * usable.
   *
   * The result is always inside the repository root: a `..` segment is rejected
   * outright rather than resolved, which also means the value can never reach git
   * as a traversal (`src/git`'s `assertSafeRepoPath` enforces the same rule on
   * the other side). A refusal is recorded as `unparsed` rather than thrown,
   * because a bad path is one input among many and must not abort the run.
   */
  private safeAbsolutePath(relPath: string, outcome: ExtractionOutcome): string | null {
    const segments = relPath.replace(/\\/g, '/').split('/');
    for (const segment of segments) {
      if (segment === '..' || segment.length === 0) {
        outcome.unparsed.push({
          filePath: relPath,
          reason: 'the path is not a usable repository-relative file path',
        });
        return null;
      }
    }
    return path.join(this.options.repoRoot, ...segments);
  }
}

/** The minimum a cached record must expose for {@link toCodeBlock} to use it. */
type CachedBlockLike = CachedBlockShape;

interface CachedBlockShape {
  id: string;
  kind: CodeBlock['kind'];
  name: string | null;
  qualifiedName: string | null;
  signature: string | null;
  filePath: string;
  language: CodeBlock['language'];
  range: CodeBlock['range'];
  parentId: string | null;
  container: string | null;
  text: string;
  textHash: string;
  tokenCount: number;
}

/**
 * Project a cached record onto a `CodeBlock`.
 *
 * The record carries three extra fields (`repoRoot`, `commit`, `cachedAt`) that
 * the in-memory pipeline has no use for; returning them would leak the synthetic
 * commit label into `VersionCandidate`s and make a cached run's blocks
 * distinguishable from a cold run's — which would break the "a cache miss is
 * behaviourally indistinguishable" guarantee in a way only a comparison would
 * reveal.
 */
function toCodeBlock(record: CachedBlockLike): CodeBlock | null {
  if (
    typeof record?.id !== 'string' ||
    typeof record.textHash !== 'string' ||
    typeof record.filePath !== 'string' ||
    !record.range ||
    typeof record.range.startLine !== 'number'
  ) {
    return null;
  }
  return {
    id: record.id,
    kind: record.kind,
    name: record.name ?? null,
    qualifiedName: record.qualifiedName ?? null,
    signature: record.signature ?? null,
    filePath: record.filePath,
    language: record.language,
    range: record.range,
    parentId: record.parentId ?? null,
    container: record.container ?? null,
    text: record.text,
    textHash: record.textHash,
    tokenCount: typeof record.tokenCount === 'number' ? record.tokenCount : 0,
  };
}

function byStartLine(left: CodeBlock, right: CodeBlock): number {
  if (left.range.startLine !== right.range.startLine) {
    return left.range.startLine - right.range.startLine;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function emptyOutcome(): ExtractionOutcome {
  return { blocks: [], unparsed: [], cacheHits: 0, cacheMisses: 0, truncated: false };
}

/**
 * True when `signal` has fired.
 *
 * A named helper rather than `signal?.aborted === true` at each site: TypeScript
 * narrows a repeated readonly property access, so the second identical comparison
 * in a function is reported as unreachable, and the three call sites in
 * {@link BlockExtractor} each need their own check.
 */
function isCancelled(signal?: AbortSignal): boolean {
  return signal !== undefined && signal.aborted;
}

function cancelled(): AncestryError {
  return new AncestryError('CANCELLED', 'The ancestry analysis was cancelled.', {
    detail: 'an AbortSignal fired while blocks were being extracted',
  });
}

function tooLargeReason(bytes: number, limit: number): string {
  return `${bytes} bytes exceeds the configured ancestry.git.maxFileSizeBytes of ${limit}; the file was not parsed`;
}

function unreadableReason(error: unknown): string {
  if (error instanceof AncestryError) {
    return describeError(error);
  }
  if (error instanceof Error) {
    return `the file could not be read from the working tree (${error.name})`;
  }
  return 'the file could not be read from the working tree';
}

function describeError(error: unknown): string {
  if (error instanceof AncestryError) {
    return `${error.code}: ${error.userMessage}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
