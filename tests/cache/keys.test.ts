import { describe, expect, it } from 'vitest';
import {
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
} from '../../src/cache';

const IS_WINDOWS = process.platform === 'win32';

describe('normalizeRepoRoot', () => {
  it('collapses duplicate and trailing separators', () => {
    expect(normalizeRepoRoot('/home/dev/project/')).toBe('/home/dev/project');
    expect(normalizeRepoRoot('/home//dev///project')).toBe('/home/dev/project');
    expect(normalizeRepoRoot('/home/dev/project///')).toBe('/home/dev/project');
  });

  it('resolves . and .. segments', () => {
    expect(normalizeRepoRoot('/home/dev/other/../project')).toBe('/home/dev/project');
    expect(normalizeRepoRoot('/home/dev/./project')).toBe('/home/dev/project');
  });

  it('normalises backslashes to forward slashes', () => {
    expect(normalizeRepoRoot('C:\\Users\\dev\\project')).toBe(
      IS_WINDOWS ? 'c:/users/dev/project' : 'C:/Users/dev/project',
    );
  });

  it('keeps a filesystem root a root', () => {
    expect(normalizeRepoRoot('/')).toBe('/');
    expect(normalizeRepoRoot('C:\\')).toBe(IS_WINDOWS ? 'c:/' : 'c:/');
  });

  it('preserves a UNC share prefix', () => {
    expect(normalizeRepoRoot('\\\\server\\share\\project\\')).toBe(
      IS_WINDOWS ? '//server/share/project' : '//server/share/project',
    );
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeRepoRoot('  /home/dev/project  ')).toBe('/home/dev/project');
  });

  it('is empty for an empty input', () => {
    expect(normalizeRepoRoot('   ')).toBe('');
  });
});

describe('makeRepoKey', () => {
  it('is 32 lowercase hex characters', () => {
    expect(makeRepoKey('/home/dev/project')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives one key to every spelling of the same path', () => {
    const canonical = makeRepoKey('/home/dev/project');
    expect(makeRepoKey('/home/dev/project/')).toBe(canonical);
    expect(makeRepoKey('/home//dev//project')).toBe(canonical);
    expect(makeRepoKey('/home/dev/other/../project')).toBe(canonical);
    expect(makeRepoKey('/home/dev/./project/')).toBe(canonical);
  });

  it('keeps a UNC path distinct from a local path', () => {
    // A leading `//` is a UNC share, not a redundant separator, so it must not
    // collapse onto the local spelling. Collapsing it would merge two different
    // repositories into one cache entry.
    expect(normalizeRepoRoot('//server/share/project')).toBe('//server/share/project');
    expect(makeRepoKey('//server/share/project')).not.toBe(makeRepoKey('/server/share/project'));
  });

  it('is stable across calls', () => {
    expect(makeRepoKey('/home/dev/project')).toBe(makeRepoKey('/home/dev/project'));
  });

  it('separates different paths', () => {
    expect(makeRepoKey('/home/dev/project')).not.toBe(makeRepoKey('/home/dev/project-two'));
    expect(makeRepoKey('/home/dev/a')).not.toBe(makeRepoKey('/home/dev/b'));
  });

  it('folds case only on case-insensitive platforms', () => {
    const lower = makeRepoKey('/home/dev/project');
    const upper = makeRepoKey('/HOME/DEV/PROJECT');
    if (IS_WINDOWS) {
      expect(upper).toBe(lower);
    } else {
      expect(upper).not.toBe(lower);
    }
  });

  it('never leaks the path it hashed', () => {
    expect(makeRepoKey('/home/dev/secret-project')).not.toContain('secret');
  });
});

describe('normalizeRepoPath', () => {
  it('accepts windows separators and a leading ./', () => {
    expect(normalizeRepoPath('src\\service\\auth.ts')).toBe('src/service/auth.ts');
    expect(normalizeRepoPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('src//a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('src/a.ts/')).toBe('src/a.ts');
  });

  it('leaves a bare name alone', () => {
    expect(normalizeRepoPath('a.ts')).toBe('a.ts');
  });
});

describe('makeBlockCacheKey', () => {
  const key = (repo: string, commit: string, file: string, hash: string): string =>
    makeBlockCacheKey(repo, commit, file, hash);

  it('changes with every identity component', () => {
    const base = key('/r', 'c1', 'a.ts', 'h1');
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(key('/r2', 'c1', 'a.ts', 'h1')).not.toBe(base);
    expect(key('/r', 'c2', 'a.ts', 'h1')).not.toBe(base);
    expect(key('/r', 'c1', 'b.ts', 'h1')).not.toBe(base);
    expect(key('/r', 'c1', 'a.ts', 'h2')).not.toBe(base);
  });

  it('is insensitive to path spelling but not to content', () => {
    const canonical = key('/home/dev/p', 'c1', 'src/a.ts', 'h1');
    expect(key('/home/dev/p/', 'c1', 'src\\a.ts', 'h1')).toBe(canonical);
    expect(key('/home/dev/p', 'c1', './src/a.ts', 'h1')).toBe(canonical);
  });

  it('does not let a separator inside one component imitate a split', () => {
    // 'c1' + 'src/a.ts' and 'c1src' + '/a.ts' must not collide.
    expect(key('/r', 'c1src', '/a.ts', 'h1')).not.toBe(key('/r', 'c1', 'src/a.ts', 'h1'));
  });
});

describe('makeNormalizeCacheKey', () => {
  it('changes when the normalisation version changes', () => {
    const first = makeNormalizeCacheKey('token-hash', '1');
    const second = makeNormalizeCacheKey('token-hash', '2');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same version and content', () => {
    expect(makeNormalizeCacheKey('token-hash', '1')).toBe(makeNormalizeCacheKey('token-hash', '1'));
  });

  it('changes with the token hash', () => {
    expect(makeNormalizeCacheKey('a', '1')).not.toBe(makeNormalizeCacheKey('b', '1'));
  });

  it('cannot be confused with a version-suffixed token hash', () => {
    expect(makeNormalizeCacheKey('a', '1')).not.toBe(makeNormalizeCacheKey('a1', ''));
  });
});

describe('makeBlockNormalizeKey', () => {
  it('is version-scoped like the content-addressed key', () => {
    expect(makeBlockNormalizeKey('block-1', '1')).not.toBe(makeBlockNormalizeKey('block-1', '2'));
    expect(makeBlockNormalizeKey('block-1', '1')).toBe(makeBlockNormalizeKey('block-1', '1'));
  });

  it('never collides with a content-addressed normalisation key', () => {
    expect(makeBlockNormalizeKey('x', '1')).not.toBe(makeNormalizeCacheKey('x', '1'));
  });
});

describe('makeMatchCacheKey', () => {
  it('is order independent', () => {
    expect(makeMatchCacheKey('a', 'b')).toBe(makeMatchCacheKey('b', 'a'));
    expect(makeMatchCacheKey('zzz', 'aaa')).toBe(makeMatchCacheKey('aaa', 'zzz'));
  });

  it('is stable for identical ids', () => {
    expect(makeMatchCacheKey('a', 'a')).toBe(makeMatchCacheKey('a', 'a'));
  });

  it('separates different pairs', () => {
    expect(makeMatchCacheKey('a', 'b')).not.toBe(makeMatchCacheKey('a', 'c'));
  });

  it('cannot be confused with a concatenated pair', () => {
    expect(makeMatchCacheKey('a', 'bc')).not.toBe(makeMatchCacheKey('ab', 'c'));
  });
});

describe('makeRepositoryEntryId', () => {
  it('is repository scoped', () => {
    expect(makeRepositoryEntryId('/r1')).not.toBe(makeRepositoryEntryId('/r2'));
  });

  it('is discriminable by kind', () => {
    expect(makeRepositoryEntryId('/r', 'repository')).not.toBe(makeRepositoryEntryId('/r', 'meta'));
  });

  it('is filesystem safe whatever the kind contains', () => {
    const hostile = makeRepositoryEntryId('/r', '../../escape/../..');
    expect(hostile).toMatch(/^[0-9a-f]{32}$/);
  });

  it('defaults to a single meta entry', () => {
    expect(makeRepositoryEntryId('/r')).toBe(makeRepositoryEntryId('/r', 'meta'));
  });
});

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe(stableStringify({ z: { x: 2, y: 1 } }));
  });

  it('preserves array order', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('sorts object keys, so the output does not depend on insertion order', () => {
    // Deliberately NOT `JSON.stringify`: that emits insertion order, which is
    // exactly the instability `stableStringify` exists to remove. Two objects
    // that are `deepStrictEqual` must serialise identically, because the result
    // is used as a cache checksum.
    expect(stableStringify({ z: 1, a: [1, 'two', null, true], nested: { k: 'v' } })).toBe(
      '{"a":[1,"two",null,true],"nested":{"k":"v"},"z":1}',
    );
    expect(stableStringify({ a: 1, z: 1, nested: { k: 'v' } })).toBe(
      stableStringify({ nested: { k: 'v' }, z: 1, a: 1 }),
    );
  });

  it('agrees with JSON.stringify when the keys are already sorted', () => {
    const value = { a: [1, 'two', null, true], nested: { k: 'v' }, z: 1 };
    expect(stableStringify(value)).toBe(JSON.stringify(value));
  });

  it('drops undefined-valued keys like JSON does', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe('[null,1]');
  });

  it('renders non-finite numbers as null, like JSON', () => {
    expect(stableStringify({ n: Number.NaN })).toBe('{"n":null}');
    expect(stableStringify({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}');
  });

  it('uses toJSON when present', () => {
    expect(stableStringify({ d: new Date('2024-01-02T03:04:05.000Z') })).toBe(
      '{"d":"2024-01-02T03:04:05.000Z"}',
    );
  });

  it('rejects a circular structure instead of verifying corrupt data', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/circular/i);
  });

  it('rejects unreasonable nesting', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 80; level += 1) {
      deep = { deep };
    }
    expect(() => stableStringify(deep)).toThrow(/nests deeper/i);
  });

  it('produces a value for a top-level undefined', () => {
    expect(typeof stableStringify(undefined)).toBe('string');
  });

  it('gives a different digest for a changed payload', () => {
    expect(sha256Hex(stableStringify({ a: 1 }))).not.toBe(sha256Hex(stableStringify({ a: 2 })));
  });
});
