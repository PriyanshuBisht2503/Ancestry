/**
 * Tests for the pre-filter and candidate index in `src/similarity/candidates`.
 *
 * This is the layer that decides whether Ancestry is tractable: without it a
 * 200 000-block repository is 200 000 full `compareBlocks` calls. The
 * performance test here is a real benchmark, not a smoke test, and the recall
 * test compares the index against an exhaustive sweep so the bucketing's
 * documented loss is measured rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import {
  bandBucketHits,
  bandMatchCount,
  buildCandidateIndex,
  CandidateIndex,
  DEFAULT_LENGTH_TOLERANCE,
  DEFAULT_MAX_HAMMING,
  DEFAULT_MIN_BAND_MATCHES,
  MIN_BUCKET_HITS,
  prefilter,
} from '../../src/similarity/candidates';
import { hammingDistance } from '../../src/similarity/hashing';
import { makeCandidateEntry, makeNormalized, makeRandom } from './fixtures';
import type { CandidateEntry } from '../../src/similarity/candidates';

const HEX = '0123456789abcdef';

/** Flip `count` random bits of a 16-character hex SimHash. */
function flipBits(simhash: string, count: number, random: () => number): string {
  const digits = [...simhash];
  for (let i = 0; i < count; i++) {
    const at = Math.floor(random() * 16);
    const value = Number.parseInt(digits[at], 16);
    const replacement = HEX[(value + 1 + Math.floor(random() * 15)) % 16]!;
    digits[at] = replacement;
  }
  return digits.join('');
}

/**
 * A SimHash at an *exact* Hamming distance from `origin`.
 *
 * `flipBits` above changes whole hex digits, so its distance is random and can
 * be up to `4 * count`. Tests that assert a specific distance need an exact one,
 * so this flips individual bits with an XOR mask: the low `bits` bits of
 * consecutive hex digits, starting at digit 4.
 *
 * Note the limitation this creates, which {@link simhashDifferingInEveryOctet}
 * exists to work around: the flips are confined to one contiguous region, so
 * every digit pair above it survives intact and only one octet ever changes.
 */
function simhashAtDistance(origin: string, bits: number): string {
  const digits = [...origin];
  // Digit 4 downwards, one nibble at a time. Starting at 4 rather than 0 keeps
  // the top 16 bits — the index's primary bucket key — intact, which is what the
  // override test above needs in order to isolate a distance threshold.
  let remaining = bits;
  for (let i = 4; i < digits.length && remaining > 0; i++) {
    const flip = Math.min(4, remaining);
    const mask = (1 << flip) - 1;
    digits[i] = HEX[(Number.parseInt(digits[i]!, 16) ^ mask) & 0xf]!;
    remaining -= flip;
  }
  return digits.join('');
}

/**
 * The eight octets of a SimHash, most significant first.
 *
 * `CandidateIndex` builds its probe tables from exactly these slices, plus the
 * top-16-bit prefix formed by octets 0 and 1, but keeps them private — so a
 * test reasoning about whether a probe can *reach* an entry has to derive them
 * the same way.
 */
function octetsOf(simhash: string): string[] {
  return simhash.match(/../g) ?? [];
}

/**
 * A SimHash differing from `origin` in `bitsPerOctet` bits of *every* octet, at
 * a total distance of `8 * bitsPerOctet`.
 *
 * This is the one shape the index genuinely cannot reach. Pigeonhole bounds how
 * far a found entry can be from the query — a pair at distance `d` differs in
 * at most `d` of the 8 octets, so anything the index surfaces it can also
 * *verify* against the full threshold. The blind spot is the mirror image: a
 * candidate that differs in all 8 octets at once while still sitting inside
 * `maxHamming`. {@link simhashAtDistance} cannot construct one, which is why
 * the mask is applied per octet rather than per digit.
 *
 * @param bitsPerOctet - Bits flipped per octet, `1..4`, since the mask is
 *   applied within a single hex digit.
 */
function simhashDifferingInEveryOctet(origin: string, bitsPerOctet: number): string {
  const digits = [...origin];
  const mask = (1 << bitsPerOctet) - 1;
  // Octet `j` is the digit pair `2j` and `2j + 1`, so an octet's low four bits
  // are the odd digit of its pair. A non-zero mask there always changes the
  // octet's value, whatever `origin` happens to hold.
  for (let j = 0; j < 8; j++) {
    const at = j * 2 + 1;
    digits[at] = HEX[Number.parseInt(digits[at]!, 16) ^ mask]!;
  }
  return digits.join('');
}

/** Overwrite `count` random MinHash bands with fresh values. */
function perturbBands(minhash: readonly string[], count: number, random: () => number): string[] {
  const out = [...minhash];
  for (let i = 0; i < count; i++) {
    out[Math.floor(random() * out.length)] = String(Math.floor(random() * 65536));
  }
  return out;
}

const base = makeNormalized(
  `export function normalise(input: string, options: Options): Result {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const lowered = trimmed.toLowerCase();
  const parts = lowered.split(options.separator);
  for (const part of parts) {
    if (part.length > options.maxLength) {
      return { ok: false, reason: 'too-long' };
    }
  }
  return { ok: true, value: parts };
}`,
  { blockId: 'base' },
);

describe('prefilter defaults', () => {
  it('exposes the documented constants', () => {
    expect(DEFAULT_MAX_HAMMING).toBe(24);
    expect(DEFAULT_LENGTH_TOLERANCE).toBe(0.6);
    expect(DEFAULT_MIN_BAND_MATCHES).toBe(24);
    expect(MIN_BUCKET_HITS).toBe(3);
  });
});

describe('bandMatchCount / bandBucketHits', () => {
  it('counts agreeing positions against a hand-computed value', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const b = ['1', '9', '3', '9', '5', '9', '7', '9'];
    // Positions 0, 2, 4 and 6 agree.
    expect(bandMatchCount(a, b)).toBe(4);
    expect(bandMatchCount(a, a)).toBe(8);
    expect(bandMatchCount(a, [])).toBe(0);
    expect(bandMatchCount([], a)).toBe(0);
  });

  it('compares only the common prefix when the signatures differ in length', () => {
    expect(bandMatchCount(['1', '2', '3'], ['1', '2', '3', '4'])).toBe(3);
  });

  it('groups 128 bands into 16 buckets and counts hits', () => {
    const a = new Array<string>(128).fill('0');
    // `b` must differ from `a` everywhere except the three bands under test —
    // filling both with the same value would make 125 bands agree and prove
    // nothing about bucketing.
    const b = new Array<string>(128).fill('9');
    // One hit in bucket 0 (band 0), one in bucket 7 (band 56) and one in
    // bucket 15 (band 120): three buckets, three matching positions.
    b[0] = '0';
    b[56] = '0';
    b[120] = '0';
    expect(bandBucketHits(a, b)).toBe(3);
    expect(bandMatchCount(a, b)).toBe(3);
  });

  it('counts a bucket once no matter how many of its bands agree', () => {
    const a = new Array<string>(128).fill('0');
    const b = new Array<string>(128).fill('9');
    for (let i = 0; i < 8; i++) {
      b[i] = '0';
    }
    // All eight bands of bucket 0 agree, so the raw match count is 8 while the
    // bucket count is 1 — which is the entire reason the bucketed form exists:
    // 16 comparisons instead of 128.
    expect(bandMatchCount(a, b)).toBe(8);
    expect(bandBucketHits(a, b)).toBe(1);
  });

  it('handles empty and mismatched signatures', () => {
    expect(bandBucketHits([], [])).toBe(0);
    expect(bandBucketHits(['1'], [])).toBe(0);
  });
});

describe('prefilter', () => {
  const source = makeCandidateEntry(base, 'src/normalise.ts', 1000);

  it('accepts a renamed, reformatted, commented copy', () => {
    const copy = makeNormalized(
      `/** Normalise an input string. */
function canonicalise(raw: string, config: Options): Result {
  // Reject blank input early.
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const lowered = trimmed.toLowerCase();
  const pieces = lowered.split(config.separator);
  for (const piece of pieces) {
    if (piece.length > config.maxLength) {
      return { ok: false, reason: 'too-long' };
    }
  }
  return { ok: true, value: pieces };
}`,
      { blockId: 'copy' },
    );
    const entry = makeCandidateEntry(copy, 'lib/canonicalise.ts', 900);
    expect(hammingDistance(source.simhash, entry.simhash)).toBeLessThanOrEqual(DEFAULT_MAX_HAMMING);
    expect(prefilter(source, entry)).toBe(true);
  });

  it('rejects an unrelated block', () => {
    const unrelated = makeNormalized(
      `export class Scheduler {
  private queue: Job[] = [];
  private running = false;
  enqueue(job: Job): void {
    this.queue.push(job);
    if (!this.running) {
      void this.drain();
    }
  }
  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      await job.run();
    }
    this.running = false;
  }
}`,
      { blockId: 'unrelated' },
    );
    const entry = makeCandidateEntry(unrelated, 'src/scheduler.ts', 800);
    expect(prefilter(source, entry)).toBe(false);
  });

  it('rejects on Hamming distance alone', () => {
    const far: CandidateEntry = {
      ...makeCandidateEntry(base, 'src/x.ts', 1),
      blockId: 'far',
      simhash: flipBits(source.simhash, 32, makeRandom(11)),
    };
    expect(hammingDistance(source.simhash, far.simhash)).toBeGreaterThan(DEFAULT_MAX_HAMMING);
    expect(prefilter(source, far)).toBe(false);
  });

  it('rejects on token-count distance alone', () => {
    const big = makeNormalized(
      Array.from({ length: 40 }, (_, i) => `  const pad${i} = compute${i}(a, b, c);`).join('\n'),
      { blockId: 'big' },
    );
    const entry = makeCandidateEntry(big, 'src/big.ts', 1);
    const delta = Math.abs(entry.tokenCount - source.tokenCount);
    expect(delta).toBeGreaterThan(
      DEFAULT_LENGTH_TOLERANCE * Math.max(entry.tokenCount, source.tokenCount),
    );
    expect(prefilter(source, entry)).toBe(false);
  });

  it('rejects on band agreement alone', () => {
    const far: CandidateEntry = {
      ...makeCandidateEntry(base, 'src/x.ts', 1),
      blockId: 'banded',
      minhash: source.minhash.map((_, index) =>
        index % 2 === 0 ? String(index + 1) : String(index + 2),
      ),
    };
    expect(bandMatchCount(source.minhash, far.minhash)).toBeLessThan(DEFAULT_MIN_BAND_MATCHES);
    expect(prefilter(source, far)).toBe(false);
  });

  it('honours every option override', () => {
    const entry: CandidateEntry = {
      ...makeCandidateEntry(base, 'src/x.ts', 1),
      blockId: 'override',
      simhash: simhashAtDistance(source.simhash, 4),
    };
    expect(hammingDistance(source.simhash, entry.simhash)).toBe(4);
    expect(prefilter(source, entry, { maxHamming: 3 })).toBe(false);
    expect(prefilter(source, entry, { maxHamming: 4 })).toBe(true);
    expect(prefilter(source, entry, { minBandMatches: 200 })).toBe(false);
    // `ignore` above 1 cannot be satisfied by a similarity in [0, 1], so the
    // candidate is always rejected.
    expect(prefilter(source, entry, { ignore: 1.1 })).toBe(false);
    // Zero length tolerance admits only an exact token-count match, so a
    // candidate built from a *different* block must be rejected while the
    // identically-sized one is accepted.
    const longer: CandidateEntry = {
      ...makeCandidateEntry(
        makeNormalized(`function pad() {\n${'  const x = 1;\n'.repeat(6)}}`, { blockId: 'longer' }),
        'src/longer.ts',
        1,
      ),
    };
    expect(longer.tokenCount).not.toBe(source.tokenCount);
    expect(prefilter(source, longer, { lengthTolerance: 0 })).toBe(false);
    expect(prefilter(source, entry, { lengthTolerance: 0 })).toBe(true);
  });

  it('accepts on SimHash and length when neither side has a MinHash signature', () => {
    const entry: CandidateEntry = {
      ...makeCandidateEntry(base, 'src/x.ts', 1),
      blockId: 'no-bands',
      minhash: [],
    };
    expect(prefilter(source, entry)).toBe(true);
  });

  it('never throws on corrupt fingerprints', () => {
    for (const simhash of ['', 'zzzz', 'abc', '0'.repeat(40)]) {
      const entry: CandidateEntry = { ...source, blockId: 'corrupt', simhash };
      expect(typeof prefilter(source, entry)).toBe('boolean');
    }
  });
});

describe('CandidateIndex', () => {
  /**
   * A synthetic corpus shaped like a real history scan: 40 families of
   * near-duplicates (one exact copy plus progressively perturbed versions) and
   * 400 unrelated fingerprints.
   */
  const buildCorpus = (): { entries: CandidateEntry[]; query: CandidateEntry } => {
    const random = makeRandom(0x5150);
    const entries: CandidateEntry[] = [];
    const families = 40;
    const perFamily = 40;
    const familyBases: Array<{ simhash: string; minhash: string[] }> = [];
    for (let f = 0; f < families; f++) {
      const simhash = flipBits('0123456789abcdef', 0, () => 0);
      const randomHex = Array.from({ length: 16 }, () => HEX[Math.floor(random() * 16)]).join('');
      const minhash = Array.from({ length: 128 }, () => String(Math.floor(random() * 65536)));
      familyBases.push({ simhash: simhash === randomHex ? simhash : randomHex, minhash });
    }
    for (let f = 0; f < families; f++) {
      for (let i = 0; i < perFamily; i++) {
        const baseEntry = familyBases[f]!;
        entries.push({
          blockId: `family-${f}-${i}`,
          filePath: `src/f${f}/block${i}.ts`,
          simhash: i === 0 ? baseEntry.simhash : flipBits(baseEntry.simhash, i % 4, random),
          minhash: i === 0 ? baseEntry.minhash : perturbBands(baseEntry.minhash, i % 9, random),
          tokenCount: 40 + (i % 7) * 5,
          tokenHash: `hash-${f}-${i}`,
          timestamp: 1_000_000 + i,
        });
      }
    }
    for (let i = 0; i < 400; i++) {
      entries.push({
        blockId: `noise-${i}`,
        filePath: `src/noise/block${i}.ts`,
        simhash: Array.from({ length: 16 }, () => HEX[Math.floor(random() * 16)]).join(''),
        minhash: Array.from({ length: 128 }, () => String(Math.floor(random() * 65536))),
        tokenCount: 20 + Math.floor(random() * 80),
        tokenHash: `noise-hash-${i}`,
        timestamp: 1_000_000 + i,
      });
    }
    return { entries, query: entries[0]! };
  };

  const corpus = buildCorpus();

  it('reports its size and a live view of its entries', () => {
    const index = new CandidateIndex();
    expect(index.size).toBe(0);
    index.addAll(corpus.entries);
    expect(index.size).toBe(corpus.entries.length);
    expect(index.entries).toHaveLength(corpus.entries.length);
  });

  it('replaces an entry with the same blockId rather than duplicating it', () => {
    const index = new CandidateIndex();
    index.add(corpus.entries[0]!);
    index.add({ ...corpus.entries[0]!, filePath: 'other.ts' });
    expect(index.size).toBe(1);
    expect(index.entries[0]!.filePath).toBe('other.ts');
  });

  it('removes every entry of a path', () => {
    const index = buildCandidateIndex(corpus.entries);
    const removed = index.removeByFile('src/f0/block0.ts');
    expect(removed).toBe(1);
    expect(index.size).toBe(corpus.entries.length - 1);
    expect(index.query(corpus.query).some((entry) => entry.filePath === 'src/f0/block0.ts')).toBe(
      false,
    );
    expect(index.removeByFile('src/does-not-exist.ts')).toBe(0);
  });

  it('clears everything', () => {
    const index = buildCandidateIndex(corpus.entries);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.entries).toHaveLength(0);
    expect(index.query(corpus.query)).toEqual([]);
  });

  it('finds the known near-duplicates in the corpus', () => {
    const index = buildCandidateIndex(corpus.entries);
    const found = index.query(corpus.query);
    const ids = new Set(found.map((entry) => entry.blockId));
    // Every member of family 0 survives the pre-filter, so the index must find
    // at least the 8 nearest perturbations plus the query itself.
    for (let i = 0; i < 8; i++) {
      expect(ids.has(`family-0-${i}`)).toBe(true);
    }
  });

  it('answers within the 250 ms performance budget', () => {
    const index = buildCandidateIndex(corpus.entries);
    expect(index.size).toBe(2000);
    // Warm up so the measurement is not dominated by JIT compilation.
    index.query(corpus.query);
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      index.query({ ...corpus.query, blockId: `q${i}` });
    }
    const perQuery = (Date.now() - started) / 20;
    expect(perQuery).toBeLessThan(250);
  });

  it('is sublinear: a query inspects far fewer entries than the corpus holds', () => {
    const index = buildCandidateIndex(corpus.entries);
    // The octet probe tables touch ~8/256 of a uniform corpus, so a single query
    // cannot possibly pre-filter 2000 entries.
    const candidates = index.query(corpus.query);
    expect(candidates.length).toBeLessThan(corpus.entries.length / 4);
  });

  it('has recall of at least 0.95 against a brute-force sweep', () => {
    const index = buildCandidateIndex(corpus.entries);
    const sources = [corpus.query, corpus.entries[1]!, corpus.entries[2]!, corpus.entries[1000]!];
    let expected = 0;
    let found = 0;
    for (const source of sources) {
      const truth = new Set(
        corpus.entries.filter((entry) => prefilter(source, entry)).map((entry) => entry.blockId),
      );
      const got = new Set(index.query(source).map((entry) => entry.blockId));
      expected += truth.size;
      for (const id of truth) {
        if (got.has(id)) {
          found++;
        }
      }
    }
    expect(expected).toBeGreaterThan(0);
    expect(found / expected).toBeGreaterThanOrEqual(0.95);
  });

  it('documents its recall limit for far-but-passing candidates', () => {
    // A candidate that differs in 24 bits — inside `maxHamming` — but in three
    // bits of *every* octet, so it shares no octet with the source and no probe
    // key the index can compute matches it. This is the documented recall/cost
    // trade-off, asserted so that it stays documented rather than discovered in
    // production.
    const source: CandidateEntry = { ...corpus.query, blockId: 'far-source' };
    const scrambled: CandidateEntry = {
      ...corpus.query,
      blockId: 'far-candidate',
      simhash: simhashDifferingInEveryOctet(source.simhash, 3),
    };
    expect(hammingDistance(source.simhash, scrambled.simhash)).toBe(DEFAULT_MAX_HAMMING);
    expect(bandMatchCount(source.minhash, scrambled.minhash)).toBeGreaterThanOrEqual(
      DEFAULT_MIN_BAND_MATCHES,
    );
    // Assert the reachability premise directly. Scrambling only the top 16 bits
    // is not enough: that misses the prefix bucket but leaves five octets
    // shared, and the octet tables reach the entry anyway.
    const sourceOctets = octetsOf(source.simhash);
    const scrambledOctets = octetsOf(scrambled.simhash);
    expect(sourceOctets.filter((octet, i) => octet === scrambledOctets[i])).toEqual([]);
    // The linear sweep finds it...
    expect(prefilter(source, scrambled)).toBe(true);
    // ...and the bucketed index does not, because every probe key differs.
    const index = buildCandidateIndex([scrambled]);
    expect(index.query(source)).toEqual([]);
  });

  it('honours the limit argument', () => {
    const index = buildCandidateIndex(corpus.entries);
    expect(index.query(corpus.query, 3)).toHaveLength(3);
    expect(index.query(corpus.query, 0)).toEqual([]);
    expect(index.query(corpus.query, -1)).toEqual([]);
  });

  it('orders results by band agreement, then Hamming distance, then recency', () => {
    const index = buildCandidateIndex(corpus.entries);
    const found = index.query(corpus.query);
    for (let i = 1; i < found.length; i++) {
      const previous = bandMatchCount(corpus.query.minhash, found[i - 1]!.minhash);
      const current = bandMatchCount(corpus.query.minhash, found[i]!.minhash);
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  });

  it('falls back to an exhaustive sweep when the query SimHash is unusable', () => {
    const index = buildCandidateIndex(corpus.entries);
    // A malformed SimHash makes every bucket key meaningless, so the query must
    // degrade to a sweep rather than silently returning nothing.
    const broken: CandidateEntry = { ...corpus.query, blockId: 'broken', simhash: 'zzzz' };
    const results = index.query(broken);
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns nothing for an empty index', () => {
    expect(new CandidateIndex().query(corpus.query)).toEqual([]);
  });
});
