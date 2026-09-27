import { describe, expect, it } from 'vitest';
import { AncestryError } from '../../src/types';
import {
  assertSafeGitPathOrNull,
  assertSafeRepoPath,
  assertSafeRevision,
} from '../../src/git/safety';

function expectRejected(fn: () => unknown, fragment?: string): AncestryError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, 'expected the call to throw').toBe(true);
  expect(caught).toBeInstanceOf(AncestryError);
  const error = caught as AncestryError;
  expect(error.code).toBe('INVALID_PATH');
  expect(error.userMessage.length).toBeGreaterThan(0);
  if (fragment !== undefined) {
    expect(error.detail ?? '').toContain(fragment);
  }
  return error;
}

describe('assertSafeRepoPath', () => {
  it('accepts a plain repo-relative path', () => {
    expect(assertSafeRepoPath('src/git/exec.ts')).toBe('src/git/exec.ts');
  });

  it('normalises backslashes to POSIX separators', () => {
    expect(assertSafeRepoPath('a\\b')).toBe('a/b');
    expect(assertSafeRepoPath('src\\git\\repo.ts')).toBe('src/git/repo.ts');
  });

  it('collapses redundant separators and "." segments', () => {
    expect(assertSafeRepoPath('src//git/./exec.ts')).toBe('src/git/exec.ts');
    expect(assertSafeRepoPath('./src/exec.ts')).toBe('src/exec.ts');
    expect(assertSafeRepoPath('src/exec.ts/')).toBe('src/exec.ts');
  });

  it('rejects an empty path', () => {
    expectRejected(() => assertSafeRepoPath(''), 'empty');
  });

  it('rejects a parent-traversal segment', () => {
    expectRejected(() => assertSafeRepoPath('../x'), '".."');
    expectRejected(() => assertSafeRepoPath('a/../../x'), '".."');
    expectRejected(() => assertSafeRepoPath('a/..'), '".."');
  });

  it('rejects a backslash-form traversal', () => {
    expectRejected(() => assertSafeRepoPath('..\\x'), '".."');
  });

  it('rejects an absolute POSIX path', () => {
    expectRejected(() => assertSafeRepoPath('/abs'), 'absolute');
    expectRejected(() => assertSafeRepoPath('/etc/passwd'), 'absolute');
  });

  it('rejects a drive-qualified or UNC path', () => {
    expectRejected(() => assertSafeRepoPath('C:\\x'), 'drive-qualified');
    expectRejected(() => assertSafeRepoPath('c:/x'), 'drive-qualified');
    // Backslashes are normalised first, so a UNC path becomes //server/share.
    expectRejected(() => assertSafeRepoPath('\\\\server\\share\\x'), 'absolute');
  });

  it('rejects a leading dash (git option injection)', () => {
    const error = expectRejected(() => assertSafeRepoPath('-rf'), 'git would read it as an option');
    expect(error.detail).toContain('-rf');
  });

  it('rejects NUL and other control characters', () => {
    expectRejected(() => assertSafeRepoPath('a\u0000b'), 'control characters');
    expectRejected(() => assertSafeRepoPath('a\nb'), 'control characters');
    expectRejected(() => assertSafeRepoPath('a\u007fb'), 'control characters');
  });

  it('allows a dash that is not in first position', () => {
    expect(assertSafeRepoPath('src/-rf.ts')).toBe('src/-rf.ts');
  });

  it('rejects non-string input without leaking a raw TypeError', () => {
    expectRejected(() => assertSafeRepoPath(undefined as unknown as string), 'must be a string');
    expectRejected(() => assertSafeRepoPath(42 as unknown as string), 'must be a string');
  });

  it('rejects a path that normalises to nothing', () => {
    expectRejected(() => assertSafeRepoPath('.'), 'resolves to nothing');
    expectRejected(() => assertSafeRepoPath('./'), 'resolves to nothing');
  });

  it('keeps control characters out of the rendered detail', () => {
    const error = expectRejected(() => assertSafeRepoPath('a\u0000b'));
    expect(error.detail).not.toContain('\u0000');
  });
});

describe('assertSafeRevision', () => {
  it('accepts the shapes git documents', () => {
    for (const rev of [
      'HEAD',
      'main',
      'HEAD~3',
      'HEAD^2',
      '@{upstream}',
      'v1.0.0',
      'origin/main',
      'A..B',
      'a1b2c3d',
    ]) {
      expect(assertSafeRevision(rev)).toBe(rev);
    }
  });

  it('rejects an empty revision', () => {
    expectRejected(() => assertSafeRevision(''), 'empty');
  });

  it('rejects NUL, newline and other control characters', () => {
    expectRejected(() => assertSafeRevision('HEAD\n--all'), 'control characters');
    expectRejected(() => assertSafeRevision('HEAD\u0000'), 'control characters');
    expectRejected(() => assertSafeRevision('ma\u0000in'), 'control characters');
  });

  it('rejects a leading dash so git cannot read it as an option', () => {
    expectRejected(() => assertSafeRevision('--upload-pack=evil'), 'option');
    expectRejected(() => assertSafeRevision('-n'), 'option');
  });

  it('rejects characters that are not valid in a ref', () => {
    expectRejected(() => assertSafeRevision('main;rm -rf /'), 'not valid in a ref');
    expectRejected(() => assertSafeRevision('main|x'), 'not valid in a ref');
    expectRejected(() => assertSafeRevision('$(id)'), 'not valid in a ref');
    expectRejected(() => assertSafeRevision('main branch'), 'not valid in a ref');
    expectRejected(() => assertSafeRevision('back\\slash'), 'not valid in a ref');
  });

  it('rejects an absurdly long revision', () => {
    expectRejected(() => assertSafeRevision('a'.repeat(2048)), 'too long');
  });
});

describe('assertSafeGitPathOrNull', () => {
  it('returns null for absent input', () => {
    expect(assertSafeGitPathOrNull(null)).toBeNull();
    expect(assertSafeGitPathOrNull(undefined)).toBeNull();
    expect(assertSafeGitPathOrNull('')).toBeNull();
  });

  it('validates and normalises real paths', () => {
    expect(assertSafeGitPathOrNull('a\\b')).toBe('a/b');
  });

  it('still rejects an unsafe path', () => {
    expectRejected(() => assertSafeGitPathOrNull('../x'), '".."');
    expectRejected(() => assertSafeGitPathOrNull('-rf'), 'option');
  });
});
