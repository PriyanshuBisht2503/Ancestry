/**
 * The shared behavioural contract for every `ICacheStore` backend.
 *
 * Both backends are run through exactly this suite, so "the file store behaves
 * like the SQLite store" is an enforced property rather than a claim. Any
 * observable difference — a miss that one backend reports and the other hides, an
 * ordering that is stable in one and arbitrary in the other, a counter that moves
 * differently — is a bug in one of them.
 *
 * The suite is deliberately written against the *public* surface only: it builds
 * cache keys with the exported helpers and reads payloads back through
 * `ICacheStore`, exactly as `src/analysis` will.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBlockCacheKey } from '../../src/cache';
import { CACHE_SCHEMA_VERSION, NORMALIZATION_VERSION } from '../../src/types';
import type {
  CachedBlock,
  CachedRepository,
  CacheBackendName,
  ICacheStore,
  NormalizedBlock,
  NormalizedToken,
  SimilarityResult,
} from '../../src/types';

/** Frozen clock handed to both backends so timestamps are comparable. */
export const FIXED_NOW = 1_700_000_000_000;

export const REPO_A = 'C:\\Users\\dev\\project-alpha';
export const REPO_B = 'D:\\work\\project-beta';
export const COMMIT_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const COMMIT_2 = '11223344556677889900aabbccddeeff00112233';
export const FILE_A = 'src/service/auth.ts';
export const FILE_B = 'src/service/session.ts';

/** A repository record with a fixed age. */
export function makeRepository(overrides: Partial<CachedRepository> = {}): CachedRepository {
  return {
    repoRoot: REPO_A,
    headCommit: COMMIT_1,
    lastIndexedAt: FIXED_NOW - 60_000,
    indexedCommitCount: 42,
    ...overrides,
  };
}

/** A code block cache record. `line` varies the position so ids stay unique. */
export function makeBlock(overrides: Partial<CachedBlock> = {}): CachedBlock {
  const filePath = overrides.filePath ?? FILE_A;
  const line = overrides.range?.startLine ?? 10;
  const text =
    overrides.text ??
    'export function authenticate(token: string): boolean {\n  return token.length > 0;\n}';
  return {
    id: `${filePath}::function::authenticate::${line}`,
    kind: 'function',
    name: 'authenticate',
    qualifiedName: 'Service.authenticate',
    signature: 'authenticate(token: string): boolean',
    filePath,
    language: 'typescript',
    range: {
      startOffset: line * 40,
      endOffset: line * 40 + text.length,
      startLine: line,
      startColumn: 1,
      endLine: line + 2,
      endColumn: 40,
    },
    parentId: null,
    container: 'Service',
    text,
    textHash: `text-hash-${filePath}-${line}`,
    tokenCount: 24,
    repoRoot: REPO_A,
    commit: COMMIT_1,
    cachedAt: FIXED_NOW - 1_000,
    ...overrides,
  };
}

/**
 * `makeBlock` positioned at a distinct line, so its derived `id` is unique.
 *
 * `CodeBlock.id` is frozen at `file::kind::name::startLine`, and the extractor
 * guarantees that two blocks of one file never share it (a duplicate construct is
 * dropped, not emitted — see `src/parser/blocks.ts`). A cached block is therefore
 * identified by its position, and a fixture that varies only `textHash` describes
 * one block wearing three timestamps, not three blocks.
 */
export function makeBlockAt(startLine: number, overrides: Partial<CachedBlock> = {}): CachedBlock {
  return makeBlock({ range: { ...makeBlock().range, startLine }, ...overrides });
}

/** A normalisation record for `blockId`. */
export function makeNormalized(
  blockId: string,
  overrides: Partial<NormalizedBlock> = {},
): NormalizedBlock {
  const tokens: NormalizedToken[] = [
    { kind: 'keyword', value: 'id:1', nodeType: 'FunctionKeyword', depth: 0 },
    { kind: 'identifier', value: 'id:2', nodeType: 'Identifier', depth: 1 },
    { kind: 'punct', value: ':', nodeType: 'OpenParenToken', depth: 1 },
  ];
  return {
    blockId,
    language: 'typescript',
    tokens,
    normalizedText: 'id:1 id:2 :',
    tokenHash: `token-hash-${blockId}`,
    simhash: '0123456789abcdef',
    minhash: ['11', '22', '33', '44'],
    shingles: ['aa', 'bb', 'cc'],
    features: { params: 1, returns: 1, branches: 2 },
    astSummary: 'params:1 returns:1 branches:2',
    identifierMap: { token: 'id:2' },
    tokenCount: 3,
    maxDepth: 1,
    normalizationVersion: NORMALIZATION_VERSION,
    ...overrides,
  };
}

/** A similarity result with a fully populated breakdown. */
export function makeMatch(
  sourceBlockId: string,
  candidateBlockId: string,
  overrides: Partial<SimilarityResult> = {},
): SimilarityResult {
  return {
    sourceBlockId,
    candidateBlockId,
    similarity: 0.8125,
    breakdown: {
      jaccard: 0.75,
      simhash: 0.9375,
      lcs: 0.8,
      shape: 0.625,
    },
    classification: 'strong',
    componentsUsed: ['jaccard', 'simhash', 'lcs', 'shape'] as Array<
      keyof SimilarityResult['breakdown']
    >,
    ...overrides,
  };
}

/** Recursively remove a directory, ignoring anything already gone. */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Synchronous mirror of the exported `isSqliteAvailable()` probe.
 *
 * `skipIf` is evaluated while the suite is being collected — before any hook
 * runs — and the project compiles to CommonJS, where a top-level `await` is not
 * allowed. Tests use this to gate, and cross-check it against the async probe.
 */
export function sqliteAvailableSync(): boolean {
  try {
    const sqlite = createRequire(__filename)('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

/**
 * Run the full `ICacheStore` contract against one backend.
 *
 * @param name Human-readable backend name, used in the `describe` title.
 * @param createStore Builds a fresh, uninitialised store rooted at `dir`. Each
 * test gets its own directory, so no test can be influenced by another's state.
 * @param expectedBackend Backend name the factory is required to produce.
 */
export function describeStoreContract(
  name: string,
  createStore: (dir: string) => Promise<ICacheStore>,
  expectedBackend: CacheBackendName,
): void {
  describe(`${name}: ICacheStore contract`, () => {
    let dir: string;
    let store: ICacheStore;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-cache-contract-'));
      store = await createStore(dir);
      await store.init();
    });

    afterEach(async () => {
      await store.close().catch(() => undefined);
      await removeDir(dir);
    });

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    it('reports a coherent backend description', () => {
      expect(store.info.backend).toBe(expectedBackend);
      expect(path.isAbsolute(store.info.location)).toBe(true);
      expect(store.info.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
      expect(typeof store.info.native).toBe('boolean');
    });

    it('can be initialised more than once', async () => {
      await expect(store.init()).resolves.toBeUndefined();
      await expect(store.init()).resolves.toBeUndefined();
    });

    it('closes idempotently and degrades to misses afterwards', async () => {
      await store.putBlock(makeBlock());
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
      // A closed store must never throw: the analysis pipeline may hold one.
      await expect(
        store.getBlock(
          makeBlockCacheKey(REPO_A, COMMIT_1, FILE_A, 'text-hash-src/service/auth.ts-10'),
        ),
      ).resolves.toBeNull();
    });

    // -----------------------------------------------------------------------
    // Repositories
    // -----------------------------------------------------------------------

    it('returns null for an unknown repository', async () => {
      await expect(store.getRepository('C:\\nowhere\\never-indexed')).resolves.toBeNull();
    });

    it('round-trips a repository record', async () => {
      const repo = makeRepository();
      await store.putRepository(repo);
      await expect(store.getRepository(REPO_A)).resolves.toEqual(repo);
    });

    it('keeps repositories independent', async () => {
      const a = makeRepository();
      const b = makeRepository({ repoRoot: REPO_B, headCommit: null, indexedCommitCount: 7 });
      await store.putRepository(a);
      await store.putRepository(b);
      await expect(store.getRepository(REPO_A)).resolves.toEqual(a);
      await expect(store.getRepository(REPO_B)).resolves.toEqual(b);
    });

    it('overwrites a repository record in place', async () => {
      await store.putRepository(makeRepository());
      const updated = makeRepository({ indexedCommitCount: 43, lastIndexedAt: FIXED_NOW });
      await store.putRepository(updated);
      await expect(store.getRepository(REPO_A)).resolves.toEqual(updated);
    });

    // -----------------------------------------------------------------------
    // Blocks
    // -----------------------------------------------------------------------

    it('returns null for an unknown or malformed block key', async () => {
      await expect(store.getBlock('0'.repeat(32))).resolves.toBeNull();
      // A key that tries to escape the cache must be rejected, not resolved.
      await expect(store.getBlock('../../../etc/passwd')).resolves.toBeNull();
      await expect(store.getBlock('')).resolves.toBeNull();
      await expect(store.getBlock('zz')).resolves.toBeNull();
    });

    it('round-trips a block record', async () => {
      const block = makeBlock();
      const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
      await store.putBlock(block);
      await expect(store.getBlock(key)).resolves.toEqual(block);
    });

    it('returns exactly the blocks of one commit and one file', async () => {
      const target = [makeBlock(), makeBlock({ range: { ...makeBlock().range, startLine: 40 } })];
      const otherFile = makeBlock({ filePath: FILE_B, textHash: 'text-hash-b-10' });
      const otherCommit = makeBlock({ commit: COMMIT_2, textHash: 'text-hash-c-10' });
      for (const block of [...target, otherFile, otherCommit]) {
        await store.putBlock(block);
      }
      const found = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
      expect(found.map((block) => block.textHash).sort()).toEqual(
        target.map((block) => block.textHash).sort(),
      );
      expect(found.every((block) => block.commit === COMMIT_1)).toBe(true);
      expect(found.every((block) => block.filePath === FILE_A)).toBe(true);
    });

    it('returns an empty array for a file it has never seen', async () => {
      await store.putBlock(makeBlock());
      await expect(store.getBlocksForFile(REPO_A, 'src/never/seen.ts', COMMIT_1)).resolves.toEqual(
        [],
      );
      await expect(store.getBlocksForFile(REPO_B, FILE_A, COMMIT_1)).resolves.toEqual([]);
      await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_2)).resolves.toEqual([]);
    });

    it('returns blocks in source order', async () => {
      const third = makeBlock({ range: { ...makeBlock().range, startLine: 90 }, textHash: 'h3' });
      const first = makeBlock({ textHash: 'h1' });
      const second = makeBlock({ range: { ...makeBlock().range, startLine: 40 }, textHash: 'h2' });
      await store.putBlock(third);
      await store.putBlock(first);
      await store.putBlock(second);
      const found = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
      expect(found.map((block) => block.textHash)).toEqual(['h1', 'h2', 'h3']);
    });

    it('normalises a windows-style repository path on read', async () => {
      await store.putBlock(makeBlock());
      const found = await store.getBlocksForFile('c:/users/dev/project-alpha/', FILE_A, COMMIT_1);
      expect(found).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Normalisations
    // -----------------------------------------------------------------------

    it('returns every stored normalisation and tolerates unknown ids', async () => {
      const stored = Array.from({ length: 50 }, (_, index) => makeNormalized(`block-${index}`));
      await store.putNormalizations(stored);
      const requested = [
        ...stored.map((entry) => entry.blockId),
        ...Array.from({ length: 50 }, (_, index) => `absent-${index}`),
      ];
      const found = await store.getNormalizations(requested);
      expect(found.size).toBe(50);
      for (const entry of stored) {
        expect(found.get(entry.blockId)).toEqual(entry);
      }
      for (let index = 0; index < 50; index += 1) {
        expect(found.has(`absent-${index}`)).toBe(false);
      }
    });

    it('round-trips the full normalised token stream', async () => {
      const entry = makeNormalized('block-round-trip', {
        tokens: [
          { kind: 'literal', value: 'lit:str:7', nodeType: 'StringLiteral', depth: 2 },
          { kind: 'type', value: 'id:3', nodeType: 'TypeReference', depth: 3 },
        ],
        features: { 'IfStatement:2': 1, while: 0 },
        identifierMap: { alpha: 'id:1', beta: 'id:2' },
      });
      await store.putNormalizations([entry]);
      const found = await store.getNormalizations(['block-round-trip']);
      expect(found.get('block-round-trip')).toEqual(entry);
    });

    it('returns an empty map for an empty request', async () => {
      const found = await store.getNormalizations([]);
      expect(found.size).toBe(0);
    });

    it('deduplicates repeated ids in one request', async () => {
      await store.putNormalizations([makeNormalized('dup')]);
      const found = await store.getNormalizations(['dup', 'dup', 'dup']);
      expect(found.size).toBe(1);
    });

    it('treats a foreign normalisation version as a miss', async () => {
      await store.putNormalizations([
        makeNormalized('stale', { normalizationVersion: `${Number(NORMALIZATION_VERSION) - 1}` }),
      ]);
      // Stored under a different key generation, so this store can neither read
      // it back nor be confused by it.
      const found = await store.getNormalizations(['stale']);
      expect(found.size).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Similarity results
    // -----------------------------------------------------------------------

    it('returns null for an unknown pair', async () => {
      await expect(store.getMatch('nope-1', 'nope-2')).resolves.toBeNull();
    });

    it('round-trips a match including its breakdown', async () => {
      const result = makeMatch('src-block', 'cand-block');
      await store.putMatch(result);
      await expect(store.getMatch('src-block', 'cand-block')).resolves.toEqual(result);
    });

    it('looks a pair up in either direction', async () => {
      const result = makeMatch('aaa', 'zzz');
      await store.putMatch(result);
      await expect(store.getMatch('zzz', 'aaa')).resolves.toEqual(result);
      // Writing the mirrored pair must not create a second, conflicting record.
      await store.putMatch({ ...result, sourceBlockId: 'zzz', candidateBlockId: 'aaa' });
      const stats = await store.stats();
      expect(stats.entries).toBe(1);
    });

    it('does not confuse two different pairs', async () => {
      await store.putMatch(makeMatch('a', 'b'));
      await store.putMatch(makeMatch('a', 'c', { similarity: 0.1 }));
      await expect(store.getMatch('a', 'b')).resolves.toMatchObject({ similarity: 0.8125 });
      await expect(store.getMatch('a', 'c')).resolves.toMatchObject({ similarity: 0.1 });
    });

    // -----------------------------------------------------------------------
    // Expiry
    // -----------------------------------------------------------------------

    it('purges only entries older than the cutoff and counts them', async () => {
      const cutoff = FIXED_NOW;
      const oldRepo = makeRepository({ lastIndexedAt: cutoff - 10_000 });
      // Three *distinct* blocks, i.e. three positions in the file. The old
      // version of this fixture varied only `textHash`, which — see
      // `makeBlockAt` — is three timestamps for one block id. The file backend
      // survives that because its record key also hashes the text; the SQL
      // backend keys `code_blocks` on (repository, commit, block id) and
      // correctly keeps one row, so the two backends disagreed on a state the
      // parser cannot produce. The cutoff semantics under test are unaffected.
      const oldBlock = makeBlockAt(20, { cachedAt: cutoff - 10_000, textHash: 'old' });
      const olderBlock = makeBlockAt(30, { cachedAt: cutoff - 20_000, textHash: 'older' });
      const freshBlock = makeBlockAt(40, { cachedAt: cutoff + 10_000, textHash: 'fresh' });
      await store.putRepository(oldRepo);
      await store.putBlock(oldBlock);
      await store.putBlock(olderBlock);
      await store.putBlock(freshBlock);

      const removed = await store.purgeOlderThan(cutoff);
      expect(removed).toBe(3);
      const survivors = await store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1);
      expect(survivors.map((block) => block.textHash)).toEqual(['fresh']);
      await expect(store.getRepository(REPO_A)).resolves.toBeNull();

      // A later sweep with no live records removes nothing more.
      await expect(store.purgeOlderThan(cutoff)).resolves.toBe(0);
    });

    it('purges normalisations and matches stamped by the store clock', async () => {
      await store.putNormalizations([makeNormalized('old-norm')]);
      await store.putMatch(makeMatch('a', 'b'));
      const removed = await store.purgeOlderThan(FIXED_NOW + 60_000);
      expect(removed).toBe(2);
      const found = await store.getNormalizations(['old-norm']);
      expect(found.size).toBe(0);
    });

    it('counts purged entries as evictions', async () => {
      await store.putBlock(makeBlock({ cachedAt: 1, textHash: 'ancient' }));
      await store.purgeOlderThan(FIXED_NOW);
      const stats = await store.stats();
      expect(stats.evictions).toBeGreaterThanOrEqual(1);
    });

    // -----------------------------------------------------------------------
    // Statistics
    // -----------------------------------------------------------------------

    it('counts one entry per stored record', async () => {
      expect((await store.stats()).entries).toBe(0);
      await store.putRepository(makeRepository());
      expect((await store.stats()).entries).toBe(1);
      await store.putBlock(makeBlock());
      expect((await store.stats()).entries).toBe(2);
      await store.putNormalizations([makeNormalized('n1'), makeNormalized('n2')]);
      expect((await store.stats()).entries).toBe(4);
      await store.putMatch(makeMatch('a', 'b'));
      expect((await store.stats()).entries).toBe(5);
    });

    it('reports the oldest and newest record timestamps', async () => {
      await store.putBlock(makeBlock({ cachedAt: 1_000, textHash: 'old' }));
      await store.putBlock(
        makeBlock({
          range: { ...makeBlock().range, startLine: 40 },
          cachedAt: 9_000,
          textHash: 'new',
        }),
      );
      const stats = await store.stats();
      expect(stats.oldestEntryTimestamp).toBe(1_000);
      expect(stats.newestEntryTimestamp).toBe(9_000);
    });

    it('reports null timestamps for an empty store', async () => {
      const stats = await store.stats();
      expect(stats.oldestEntryTimestamp).toBeNull();
      expect(stats.newestEntryTimestamp).toBeNull();
      expect(stats.bytes).toBe(0);
      expect(stats.repositoryCount).toBe(0);
    });

    it('counts the repositories it has seen', async () => {
      await store.putRepository(makeRepository());
      await store.putRepository(makeRepository({ repoRoot: REPO_B }));
      expect((await store.stats()).repositoryCount).toBe(2);
    });

    it('increments hits and misses once per record lookup', async () => {
      const block = makeBlock();
      const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
      const start = await store.stats();
      expect(start.hits).toBe(0);
      expect(start.misses).toBe(0);

      await store.getBlock(key);
      const afterMiss = await store.stats();
      expect(afterMiss.misses - start.misses).toBe(1);
      expect(afterMiss.hits - start.hits).toBe(0);

      await store.getBlock(key);
      const afterSecondMiss = await store.stats();
      expect(afterSecondMiss.misses - afterMiss.misses).toBe(1);

      await store.putBlock(block);
      await store.getBlock(key);
      const afterHit = await store.stats();
      expect(afterHit.hits - afterSecondMiss.hits).toBe(1);
      expect(afterHit.misses - afterSecondMiss.misses).toBe(0);

      await store.getBlock(key);
      const afterSecondHit = await store.stats();
      expect(afterSecondHit.hits - afterHit.hits).toBe(1);
    });

    it('keeps hit and miss counters cumulative across operations', async () => {
      await store.putRepository(makeRepository());
      await store.getRepository(REPO_A);
      await store.getRepository('C:\\missing');
      const stats = await store.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('empties the store on clear()', async () => {
      await store.putRepository(makeRepository());
      await store.putBlock(makeBlock());
      await store.putNormalizations([makeNormalized('n1')]);
      await store.putMatch(makeMatch('a', 'b'));
      await store.clear();

      const stats = await store.stats();
      expect(stats.entries).toBe(0);
      await expect(store.getRepository(REPO_A)).resolves.toBeNull();
      await expect(store.getBlocksForFile(REPO_A, FILE_A, COMMIT_1)).resolves.toEqual([]);
      const found = await store.getNormalizations(['n1']);
      expect(found.size).toBe(0);
      await expect(store.getMatch('a', 'b')).resolves.toBeNull();
    });

    it('stays usable after clear()', async () => {
      await store.putBlock(makeBlock());
      await store.clear();
      const block = makeBlock({ textHash: 'after-clear' });
      await store.putBlock(block);
      const key = makeBlockCacheKey(block.repoRoot, block.commit, block.filePath, block.textHash);
      await expect(store.getBlock(key)).resolves.toEqual(block);
    });
  });
}
