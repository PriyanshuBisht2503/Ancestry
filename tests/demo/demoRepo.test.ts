/**
 * Integration tests for `scripts/make-demo-repo.mjs`.
 *
 * The generator is the backbone of the whole test strategy: it produces the
 * labelled corpus that the accuracy harness measures against, and the fixture a
 * new user opens the extension on. If it stops producing a history with the
 * right shape, the accuracy numbers silently stop meaning anything.
 *
 * These tests therefore assert the *shape* of the history rather than the
 * contents of any individual commit:
 *
 *   - the repository exists and carries the generator's marker;
 *   - it has enough commits to be a history worth analysing;
 *   - it has several branches, at least one of which is never merged;
 *   - it has a real merge commit with two parents;
 *   - git detects the file rename;
 *   - the key source files are where the scenario map says they are;
 *   - the deleted-then-restored function is genuinely absent in between;
 *   - every commit has the pinned identity;
 *   - two runs produce the same HEAD sha (byte-for-byte reproducibility).
 *
 * Everything is driven through the real `git` binary with an argv array and no
 * shell, exactly like the extension's own Git layer. Every assertion is behind a
 * `git`-availability guard, so the suite skips cleanly on a machine without git
 * rather than failing for the wrong reason.
 *
 * This file is deliberately self-contained. It does not import from
 * `tests/git/helpers.ts`: the demo repository is a *product* artefact with its
 * own contract, and coupling its test to another module's test scaffolding would
 * make a change in that scaffolding look like a change in this one.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Is a usable `git` on the PATH? Everything below is skipped if not. */
const hasGit = ((): boolean => {
  const probe = spawnSync('git', ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return probe.status === 0;
})();

/**
 * Walk up from the working directory until `scripts/make-demo-repo.mjs` turns up.
 *
 * `import.meta.url` would be the obvious way to locate the script, but this
 * project compiles to CommonJS (`tsconfig.json` sets `module: commonjs`) and
 * `import.meta` is a hard compile error there. Walking up from `cwd` works both
 * under `tsc` and under Vitest, and it does not care which directory the test
 * runner was launched from.
 */
function findProjectRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, 'scripts', 'make-demo-repo.mjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('could not locate scripts/make-demo-repo.mjs above ' + process.cwd());
    }
    dir = parent;
  }
}

const SCRIPT_PATH = ((): string => {
  try {
    return path.join(findProjectRoot(), 'scripts', 'make-demo-repo.mjs');
  } catch {
    return path.resolve(process.cwd(), 'scripts', 'make-demo-repo.mjs');
  }
})();

/** Minimum history size. The narrative is 29 commits; 27 reach HEAD. */
const MIN_COMMITS_ON_HEAD = 20;

/** Identity the generator pins on every commit. */
const PINNED_AUTHOR = 'Ada Ancestry <ada@tokenwall.example>';

// ---------------------------------------------------------------------------
// Git plumbing for assertions
// ---------------------------------------------------------------------------

/** Directories this suite created, so they can be removed afterwards. */
const scratchDirs: string[] = [];

function track(dir: string): string {
  scratchDirs.push(dir);
  return dir;
}

/**
 * Run one git command in `repo` and return trimmed stdout.
 *
 * argv array, `shell: false`. The hermetic environment matches the generator's
 * so a developer's global config cannot change what these tests observe.
 */
function gitIn(repo: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(repo, '.ancestry-test-empty-gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function gitLinesIn(repo: string, args: string[]): string[] {
  const out = gitIn(repo, args);
  return out.length === 0 ? [] : out.split('\n');
}

/**
 * Invoke the generator, returning its stdout.
 *
 * Throws on a non-zero exit so every caller gets the generator's own diagnostics
 * rather than an opaque assertion failure.
 */
function runGenerator(target: string): string {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, target], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `make-demo-repo.mjs exited with ${result.status}:\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

/** Run the generator into a fresh, tracked directory and assert it succeeded. */
function buildDemoRepo(): string {
  const target = track(fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-demo-test-')));
  runGenerator(target);
  return target;
}

/** The sha of the single commit whose subject matches `subject`, literally. */
function revOf(repo: string, subject: string): string {
  const sha = gitIn(repo, [
    'log',
    '--format=%H',
    '--fixed-strings',
    '--grep',
    subject,
    '-n',
    '1',
    'main',
  ]);
  expect(sha, `no commit titled "${subject}" on main`).not.toBe('');
  return sha;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit)('scripts/make-demo-repo.mjs', () => {
  let repo: string;

  beforeAll(() => {
    repo = buildDemoRepo();
  });

  afterAll(() => {
    for (const dir of scratchDirs.splice(0, scratchDirs.length)) {
      // Git object files are read-only, so `force` (and a couple of retries) are
      // needed on Windows.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  describe('the generated repository', () => {
    it('exists on disk as a git working tree', () => {
      expect(fs.existsSync(repo)).toBe(true);
      expect(fs.statSync(repo).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.git', 'HEAD'))).toBe(true);
    });

    it('carries the generator marker so a re-run is recognised', () => {
      const marker = path.join(repo, '.git', 'ancestry-demo.json');
      expect(fs.existsSync(marker)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { marker?: string };
      expect(parsed.marker).toBe('ancestry-demo-repository');
    });

    it('has at least 20 commits reachable from HEAD', () => {
      const count = Number(gitIn(repo, ['rev-list', '--count', 'HEAD']));
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(MIN_COMMITS_ON_HEAD);
    });

    it('has more commits across all refs than on HEAD alone', () => {
      // The difference is the unmerged experiment branch. If this ever becomes
      // equal, scenario 5 has silently stopped being a divergence.
      const onHead = Number(gitIn(repo, ['rev-list', '--count', 'HEAD']));
      const onAll = Number(gitIn(repo, ['rev-list', '--count', '--all']));
      expect(onAll).toBeGreaterThan(onHead);
    });

    it('is not in a detached HEAD state', () => {
      const head = gitIn(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      expect(head).toBe('main');
    });

    it('pins one author and committer on every commit', () => {
      const identities = new Set(
        gitLinesIn(repo, ['log', '--all', '--format=%an <%ae>|%cn <%ce>']),
      );
      expect(identities.size).toBe(1);
      expect([...identities]).toEqual([`${PINNED_AUTHOR}|${PINNED_AUTHOR}`]);
    });
  });

  describe('scenario 5 — branch divergence', () => {
    it('has at least two branches, including the hardening branch', () => {
      const branches = gitLinesIn(repo, ['branch', '--format=%(refname:short)']);
      expect(branches.length).toBeGreaterThanOrEqual(2);
      expect(branches).toContain('main');
      expect(branches).toContain('feature/hardening');
    });

    it('keeps the absolute-expiry experiment unmerged', () => {
      const branches = gitLinesIn(repo, ['branch', '--format=%(refname:short)']);
      expect(branches).toContain('experiment/absolute-expiry');

      const merged = gitIn(repo, ['branch', '--merged', 'main', '--format=%(refname:short)']);
      expect(merged).not.toContain('experiment/absolute-expiry');
      expect(merged).toContain('feature/hardening');
    });

    it('has each branch modify the same function independently', () => {
      // The last main commit *before* the merge is the right baseline for "what
      // main did not have": after the merge, main legitimately contains the
      // hardening branch's work too.
      const preMerge = revOf(repo, 'chore: bump the service version');
      const mainBeforeMerge = gitIn(repo, ['show', `${preMerge}:src/auth.ts`]);
      const hardened = gitIn(repo, ['show', 'feature/hardening:src/auth.ts']);
      const experiment = gitIn(repo, ['show', 'experiment/absolute-expiry:src/auth.ts']);

      // All three define the function under study...
      for (const [label, source] of [
        ['main', mainBeforeMerge],
        ['feature/hardening', hardened],
        ['experiment/absolute-expiry', experiment],
      ] as const) {
        expect(source, label).toContain('export function validateToken');
      }

      // ...and each side changed it in its own way.
      expect(hardened).toContain('EXPECTED_ISSUER');
      expect(mainBeforeMerge).not.toContain('EXPECTED_ISSUER');
      expect(mainBeforeMerge).toContain('export function hasScope');
      expect(hardened).not.toContain('export function hasScope');
      expect(experiment).toContain('export const CLOCK_SKEW_SECONDS = 0;');
      expect(hardened).toContain('export const CLOCK_SKEW_SECONDS = 30;');
    });
  });

  describe('scenario 6 — merge commit', () => {
    it('contains a merge commit with two parents', () => {
      const merges = gitLinesIn(repo, ['log', '--merges', '--format=%H %P']);
      expect(merges.length).toBeGreaterThanOrEqual(1);

      const parents = merges[0]!.trim().split(/\s+/).slice(1);
      expect(parents).toHaveLength(2);
      expect(new Set(parents).size).toBe(2);
    });

    it('merged the hardening branch into main', () => {
      const message = gitIn(repo, ['log', '--merges', '-1', '--format=%s']);
      expect(message).toContain('feature/hardening');

      // The merged result contains both sides' work.
      const merged = gitIn(repo, ['show', 'main:src/auth.ts']);
      expect(merged).toContain('EXPECTED_ISSUER');
      expect(merged).toContain('export function hasScope');
    });
  });

  describe('scenario 4 — moved function', () => {
    it('is detected by git as a rename of the whole file', () => {
      const renames = gitIn(repo, ['log', '--diff-filter=R', '-M', '--name-status', '--format=']);
      expect(renames).toMatch(/R\d*\s+src\/utils\/format\.ts\s+src\/utils\/strings\.ts/);
    });

    it('follows the file across the rename', () => {
      const followed = gitIn(repo, [
        'log',
        '--follow',
        '--name-status',
        '--format=%s',
        'main',
        '--',
        'src/utils/strings.ts',
      ]);
      expect(followed).toContain('refactor(utils): rename format.ts to strings.ts');
    });

    it('leaves the old path absent at HEAD and the new path present', () => {
      const tracked = gitLinesIn(repo, ['ls-files']);
      expect(tracked).toContain('src/utils/strings.ts');
      expect(tracked).not.toContain('src/utils/format.ts');
    });
  });

  describe('scenario 7 — deleted and re-introduced code', () => {
    it('is genuinely absent at the commit that deleted it', () => {
      const before = revOf(repo, 'docs(utils): point the notes at the renamed module');
      const deleted = revOf(repo, 'refactor(utils): remove the user agent formatter');

      expect(gitIn(repo, ['show', `${before}:src/utils/strings.ts`])).toContain('formatUserAgent');
      expect(gitIn(repo, ['show', `${deleted}:src/utils/strings.ts`])).not.toContain(
        'formatUserAgent',
      );
    });

    it('is back at HEAD after the restore commit', () => {
      const restored = revOf(repo, 'feat(utils): restore the user agent formatter');
      const atRestored = gitIn(repo, ['show', `${restored}:src/utils/strings.ts`]);
      const atHead = gitIn(repo, ['show', 'HEAD:src/utils/strings.ts']);

      expect(atRestored).toContain('formatUserAgent');
      expect(atHead).toContain('formatUserAgent');
    });
  });

  describe('the key source files', () => {
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['src/auth.ts', ['validateToken', 'TokenClaims', 'CLOCK_SKEW_SECONDS']],
      ['src/legacy/validate.js', ['checkToken', 'CLOCK_SKEW_SECONDS']],
      ['src/security/token.ts', ['evaluateToken', 'TokenVerdict']],
      ['src/security/hardening.ts', ['DEFAULT_POLICY', 'explain', 'lifetimeSeconds']],
      ['src/utils/strings.ts', ['formatUserAgent', 'chunkArray', 'truncateMiddle']],
      ['src/db/migrate.ts', ['runMigrations']],
      ['src/db/pool.ts', ['settleConnection']],
      ['README.md', ['synthetic demonstration fixture']],
    ];

    it.each(expectations)('%s contains the expected declarations', (file, needles) => {
      const contents = gitIn(repo, ['show', `HEAD:${file}`]);
      expect(contents.length).toBeGreaterThan(0);
      for (const needle of needles) {
        expect(contents, `${file} should mention ${needle}`).toContain(needle);
      }
    });

    it('keeps the two copies textually distinct but structurally parallel', () => {
      const original = gitIn(repo, ['show', 'HEAD:src/auth.ts']);
      const copy = gitIn(repo, ['show', 'HEAD:src/legacy/validate.js']);

      // Renamed identifiers — this is the whole point of scenario 2. The port
      // mentions the original only in its deprecation comment, never as a
      // declaration, so the assertion is on the declaration.
      expect(original).toContain('export function validateToken');
      expect(original).toContain('const parts = trimmed.split');
      expect(original).toContain('claims.exp');
      expect(copy).toContain('export function checkToken');
      expect(copy).toContain('const segments = trimmed.split');
      expect(copy).toContain('decoded.exp');
      expect(copy).not.toContain('export function validateToken');

      // Same structure underneath: three-segment split, base64url decode, and
      // the same clock-skew allowance. A normaliser that erases identifiers and
      // formatting should land these two very close together.
      for (const source of [original, copy]) {
        expect(source).toContain("split('.')");
        expect(source).toContain("replace(/-/g, '+')");
        expect(source).toContain('+ CLOCK_SKEW_SECONDS <');
      }
    });

    it('ships decoys that look similar but are unrelated', () => {
      const migrate = gitIn(repo, ['show', 'HEAD:src/db/migrate.ts']);
      const pool = gitIn(repo, ['show', 'HEAD:src/db/pool.ts']);

      // The decoys borrow the validator's shape — an early-return ladder, a
      // try/catch in the middle, a collection accumulated at the end — so that
      // a false positive has something to be measured against. Neither uses any
      // of the vocabulary of the code under study.
      for (const decoy of [migrate, pool]) {
        expect(decoy).toContain('try {');
        expect(decoy).toContain('catch');
        expect(decoy).toContain('return {');
        expect(decoy.toLowerCase()).not.toContain('token');
        expect(decoy).not.toContain('base64');
      }
    });

    it('stores every tracked file with LF line endings', () => {
      const tracked = gitLinesIn(repo, ['ls-files']);
      expect(tracked.length).toBeGreaterThan(10);
      for (const file of tracked) {
        // Reading the blob back through git applies no working-tree conversion.
        const blob = spawnSync('git', ['-C', repo, 'show', `HEAD:${file}`], {
          encoding: 'buffer',
          shell: false,
          windowsHide: true,
          maxBuffer: 8 << 20,
        });
        if (blob.status !== 0 || !blob.stdout) {
          continue; // Binary or absent; none of the fixture's files are.
        }
        expect(
          blob.stdout.includes(0x0d),
          `${file} should not contain CR — a CRLF checkout would change the SHAs`,
        ).toBe(false);
      }
    });
  });

  describe('determinism and idempotence', () => {
    it('produces the same history on a second, independent run', () => {
      const second = buildDemoRepo();
      try {
        // Comparing the full `%H %T %P` list proves the whole history matches,
        // not just the tip: same trees, same parents, same commits.
        expect(gitIn(second, ['log', '--all', '--format=%H %T %P'])).toBe(
          gitIn(repo, ['log', '--all', '--format=%H %T %P']),
        );
        expect(gitIn(second, ['rev-parse', 'HEAD'])).toBe(gitIn(repo, ['rev-parse', 'HEAD']));
        expect(gitIn(second, ['rev-list', '--count', '--all'])).toBe(
          gitIn(repo, ['rev-list', '--count', '--all']),
        );
      } finally {
        fs.rmSync(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('rebuilds over its own output without accumulating history', () => {
      // The generator recognises its marker and starts again from scratch, so
      // running it a second time over the same path must not append commits,
      // duplicate refs, or fail.
      const expectedBranches = ['experiment/absolute-expiry', 'feature/hardening', 'main'];
      const before = gitIn(repo, ['log', '--all', '--format=%H %T %P']);

      const summary = runGenerator(repo);

      expect(summary).toContain('Ancestry demonstration repository');
      expect(gitIn(repo, ['log', '--all', '--format=%H %T %P'])).toBe(before);
      expect(gitIn(repo, ['branch', '--format=%(refname:short)']).split('\n').sort()).toEqual(
        expectedBranches,
      );
      expect(gitIn(repo, ['status', '--porcelain'])).toBe('');
    });
  });
});
