/**
 * The safety rails: size limits, cancellation, search-scope filtering and the
 * soft repository warnings of specification §10.
 *
 * These functions are the difference between "the extension degraded gracefully"
 * and "the extension host hung", so they are tested on their exact wording as well
 * as on their behaviour: the messages name the setting to raise, and the skip
 * reasons are specific enough that a user can act on them.
 */

import { describe, expect, it } from 'vitest';

import {
  AbortBudget,
  clampHistoryLimit,
  enforceRepositorySizeLimit,
  repositoryWarnings,
  skipReasonForPath,
} from '../../src/analysis';
import { AncestryError } from '../../src/types';
import type { RepoInfo } from '../../src/types';

function info(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    root: '/repo',
    gitDir: '/repo/.git',
    isBare: false,
    isShallow: false,
    isDetachedHead: false,
    headCommit: 'a'.repeat(40),
    headBranch: 'main',
    branches: [],
    commitCount: 12,
    worktreeSizeBytes: 1024,
    remoteUrl: 'git@example.invalid:owner/repo.git',
    warnings: [],
    ...overrides,
  };
}

describe('enforceRepositorySizeLimit', () => {
  it('accepts a repository at or below the limit', () => {
    expect(() => enforceRepositorySizeLimit(info({ worktreeSizeBytes: 1000 }), 1000)).not.toThrow();
    expect(() => enforceRepositorySizeLimit(info({ worktreeSizeBytes: 999 }), 1000)).not.toThrow();
  });

  it('throws REPOSITORY_TOO_LARGE with the measured size and the setting', () => {
    const size = 6 * 1024 * 1024 * 1024;
    let thrown: unknown;
    try {
      enforceRepositorySizeLimit(info({ worktreeSizeBytes: size }), 5 * 1024 * 1024 * 1024);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AncestryError);
    const error = thrown as AncestryError;
    expect(error.code).toBe('REPOSITORY_TOO_LARGE');
    expect(error.userMessage).toContain('6.0 GiB');
    expect(error.userMessage).toContain('5.0 GiB');
    // The user has to be told which knob to turn, and which value they measured.
    expect(error.userMessage).toContain('Git Max Repository Size Bytes');
    expect(error.detail).toContain('worktreeSizeBytes=6442450944');
    expect(error.detail).toContain('git.maxRepositorySizeBytes=5368709120');
  });

  it('ignores a nonsensical limit rather than refusing to scan anything', () => {
    expect(() => enforceRepositorySizeLimit(info({ worktreeSizeBytes: 1e12 }), 0)).not.toThrow();
    expect(() => enforceRepositorySizeLimit(info({ worktreeSizeBytes: 1e12 }), -1)).not.toThrow();
    expect(() =>
      enforceRepositorySizeLimit(info({ worktreeSizeBytes: 1e12 }), Number.NaN),
    ).not.toThrow();
  });

  it('treats an unknown size as within the limit', () => {
    expect(() =>
      enforceRepositorySizeLimit(info({ worktreeSizeBytes: Number.NaN }), 1024),
    ).not.toThrow();
  });
});

describe('repositoryWarnings', () => {
  it('warns about a shallow clone without failing', () => {
    const warnings = repositoryWarnings(info({ isShallow: true }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/shallow/i);
    // §10: a warning, not a failure.
    expect(() => repositoryWarnings(info({ isShallow: true }))).not.toThrow();
  });

  it('warns about a detached HEAD', () => {
    const warnings = repositoryWarnings(info({ isDetachedHead: true, headBranch: null }));
    expect(warnings.some((warning) => /detached/i.test(warning))).toBe(true);
  });

  it('warns about an unborn HEAD', () => {
    const warnings = repositoryWarnings(info({ headCommit: null, headBranch: null }));
    expect(warnings.some((warning) => /no commits yet/i.test(warning))).toBe(true);
  });

  it('warns about a missing origin and forwards git-level warnings', () => {
    const warnings = repositoryWarnings(
      info({
        remoteUrl: null,
        warnings: ['git user.name and/or user.email are not configured for this repository.'],
      }),
    );
    expect(warnings.some((warning) => /origin/i.test(warning))).toBe(true);
    expect(warnings.some((warning) => /user\.name/.test(warning))).toBe(true);
  });

  it('stays quiet for a healthy repository with a remote, and de-duplicates', () => {
    expect(repositoryWarnings(info())).toEqual([]);
    const repeated = repositoryWarnings(
      info({
        isShallow: true,
        warnings: [
          'git user.name and/or user.email are not configured for this repository.',
          'git user.name and/or user.email are not configured for this repository.',
        ],
      }),
    );
    expect(new Set(repeated).size).toBe(repeated.length);
    expect(repeated.filter((warning) => /user\.name/.test(warning))).toHaveLength(1);
  });
});

describe('clampHistoryLimit', () => {
  it('reports no truncation when the whole history fits', () => {
    expect(clampHistoryLimit(100, 40)).toEqual({ limit: 40, truncated: false });
  });

  it('reports truncation when the ceiling bound the scan', () => {
    expect(clampHistoryLimit(40, 100)).toEqual({ limit: 40, truncated: true });
  });

  it('is exact at the boundary', () => {
    expect(clampHistoryLimit(40, 40)).toEqual({ limit: 40, truncated: false });
  });

  it('degrades sanely for zero and non-finite inputs', () => {
    expect(clampHistoryLimit(0, 0)).toEqual({ limit: 0, truncated: false });
    expect(clampHistoryLimit(0, 25)).toEqual({ limit: 25, truncated: false });
    expect(clampHistoryLimit(25, 0)).toEqual({ limit: 25, truncated: false });
    expect(clampHistoryLimit(Number.NaN, 25)).toEqual({ limit: 25, truncated: false });
  });
});

describe('skipReasonForPath', () => {
  const keep = 'src/app/service.ts';
  it('keeps an ordinary source file', () => {
    expect(skipReasonForPath(keep, true)).toBeNull();
    expect(skipReasonForPath(keep, false)).toBeNull();
  });

  it.each([
    ['.git/config', /git/i],
    ['.git/objects/ab/cdef', /git/i],
    ['node_modules/left-pad/index.js', /dependency/i],
    ['dist/bundle.js', /build output/i],
    ['out/build.js', /build output/i],
    ['build/main.js', /build output/i],
    ['coverage/lcov-report/index.html', /build output/i],
    ['vendor/lib/x.go', /vendored/i],
    ['target/debug/x.rs', /target/i],
    ['a/b/node_modules/deep/x.js', /dependency/i],
  ])('skips %s with a specific reason', (candidate, pattern) => {
    const reason = skipReasonForPath(candidate, true);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(pattern);
  });

  it.each([
    ['public/app.min.js', /minified bundle/i],
    ['public/vendor.min.mjs', /minified bundle/i],
    ['public/app.min.css', null],
    ['package-lock.json', /lockfile/i],
    ['yarn.lock', /lockfile/i],
    ['pnpm-lock.yaml', /lockfile/i],
    ['packages/app/package-lock.json', /lockfile/i],
    ['tests/__snapshots__/render.snap', /snapshot/i],
  ])('skips the generated file %s', (candidate, pattern) => {
    const reason = skipReasonForPath(candidate, true);
    if (pattern === null) {
      // `.min.css` is not in the skip list: Ancestry only refuses the JS bundles
      // it is likely to be handed as if they were source.
      expect(reason).toBeNull();
      return;
    }
    expect(reason).toMatch(pattern);
  });

  it('skips test paths only when includeTests is off', () => {
    expect(skipReasonForPath('src/service.test.ts', true)).toBeNull();
    expect(skipReasonForPath('src/service.test.ts', false)).toMatch(/test or spec/i);
    expect(skipReasonForPath('tests/helper.ts', false)).toMatch(/test or spec/i);
    expect(skipReasonForPath('__tests__/thing.js', false)).toMatch(/test or spec/i);
    expect(skipReasonForPath('src/spec/thing.ts', false)).toMatch(/test or spec/i);
  });

  it('does not mistake a source file for build output', () => {
    expect(skipReasonForPath('src/builders/parse.ts', true)).toBeNull();
    expect(skipReasonForPath('src/distribution/index.ts', true)).toBeNull();
    expect(skipReasonForPath('src/targeting/plan.ts', true)).toBeNull();
  });

  it('normalises Windows separators', () => {
    expect(skipReasonForPath('node_modules\\left-pad\\index.js', true)).toMatch(/dependency/i);
  });

  it('rejects a path that is not a path at all', () => {
    expect(skipReasonForPath('', true)).not.toBeNull();
    expect(skipReasonForPath('   ', true)).not.toBeNull();
  });
});

describe('AbortBudget', () => {
  it('reports elapsed time from the injected clock', () => {
    let now = 1_000;
    const budget = new AbortBudget(undefined, () => now);
    expect(budget.elapsedMs()).toBe(0);
    now = 1_250;
    expect(budget.elapsedMs()).toBe(250);
    now = 500;
    expect(budget.elapsedMs()).toBe(0);
  });

  it('is usable with no signal at all', () => {
    const budget = new AbortBudget();
    expect(budget.check()).toBe(true);
    expect(budget.aborted).toBe(false);
    expect(() => budget.throwIfAborted()).not.toThrow();
    expect(budget.cancellation).toBeUndefined();
  });

  it('throws CANCELLED once the signal fires, and check() goes false', () => {
    const controller = new AbortController();
    const budget = new AbortBudget(controller.signal, () => 0);
    expect(budget.check()).toBe(true);
    controller.abort();
    expect(budget.check()).toBe(false);
    expect(budget.aborted).toBe(true);
    let thrown: unknown;
    try {
      budget.throwIfAborted();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AncestryError);
    expect((thrown as AncestryError).code).toBe('CANCELLED');
  });

  it('fails fast on a signal that already fired', () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new AbortBudget(controller.signal, () => 0);
    expect(() => budget.throwIfAborted()).toThrowError(AncestryError);
  });

  it('enforces a wall-clock ceiling independently of the signal', () => {
    let now = 0;
    const budget = new AbortBudget(undefined, () => now);
    now = 900;
    expect(() => budget.throwIfElapsed(1_000)).not.toThrow();
    now = 1_500;
    expect(() => budget.throwIfElapsed(1_000)).toThrowError(AncestryError);
  });
});
