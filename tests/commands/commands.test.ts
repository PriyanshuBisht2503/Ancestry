/**
 * Tests for the pure helpers in the command layer.
 *
 * These are the parts of the command surface that can be tested without standing
 * up a VS Code host: display formatting, failure presentation, manifest
 * consistency, and the path-traversal defence. The parts that need an editor
 * (`analyzeSelectionCommand`, the webview round trip) are exercised through the
 * real `src/analysis` integration suite instead — a mocked `vscode` would only
 * assert that the mock was called.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
} from '../../src/commands/format';
import { describeFailure } from '../../src/commands/errors';
import {
  findUndeclaredCommands,
  findUnimplementedCommands,
  COMMAND_IDS,
} from '../../src/commands/registry';
import { resolveRepoFile } from '../../src/commands/graphCommands';
import { AncestryError } from '../../src/types';
import { scrubPaths, createLogger } from '../../src/logger';
import { readConfig, normalizeThresholds, DEFAULT_CONFIG } from '../../src/config';

describe('formatBytes', () => {
  it('renders byte counts without a fractional part', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up a unit at each power of 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('drops precision for large values of the same unit', () => {
    // 12.34 MB is noise at this magnitude; two significant digits is not.
    expect(formatBytes(12_884_901)).toBe('12 MB');
  });

  it('clamps to the largest known unit rather than inventing one', () => {
    expect(formatBytes(1024 ** 5)).toMatch(/TB$/);
  });

  it('treats negative, zero and non-finite input as zero', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('uses milliseconds below one second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('uses seconds with one decimal below one minute', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2400)).toBe('2.4s');
  });

  it('uses minutes and seconds above one minute', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(72_000)).toBe('1m 12s');
  });

  it('uses hours above one hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
  });

  it('rejects nonsense', () => {
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(Number.NaN)).toBe('0ms');
  });
});

describe('formatCount / formatTimestamp', () => {
  it('groups thousands', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1_000_000)).toBe('1,000,000');
  });

  it('rounds fractional counts and rejects non-finite ones', () => {
    expect(formatCount(1.6)).toBe('2');
    expect(formatCount(Number.NaN)).toBe('0');
  });

  it('formats a UTC timestamp and reports missing values as n/a', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01 00:00:00');
    expect(formatTimestamp(null)).toBe('n/a');
    expect(formatTimestamp(undefined)).toBe('n/a');
    expect(formatTimestamp(Number.NaN)).toBe('n/a');
  });
});

describe('describeFailure', () => {
  it('renders an AncestryError with its code-derived hint', () => {
    const err = new AncestryError('NO_GIT_REPOSITORY', 'No repository here');
    const presentation = describeFailure(err);
    expect(presentation.code).toBe('NO_GIT_REPOSITORY');
    expect(presentation.message).toBe('No repository here');
    expect(presentation.hint).toMatch(/git init/i);
    expect(presentation.cancelled).toBe(false);
  });

  it('treats cancellation as a non-error with no hint', () => {
    const presentation = describeFailure(new AncestryError('CANCELLED', 'Stopped'));
    expect(presentation.cancelled).toBe(true);
    expect(presentation.hint).toBeUndefined();
  });

  it('prefixes the message with the attempted action', () => {
    const presentation = describeFailure(
      new AncestryError('INTERNAL', 'Boom'),
      'analyse the selection',
    );
    expect(presentation.message).toBe('Could not analyse the selection. Boom');
  });

  it('falls back to err.detail when the code has no hint', () => {
    const presentation = describeFailure(
      new AncestryError('WEBSITE_FAILED', 'Panel failed', { detail: 'webview crashed' }),
    );
    expect(presentation.hint).toBe('webview crashed');
  });

  it('handles a plain Error and a non-Error throw', () => {
    expect(describeFailure(new TypeError('bad')).code).toBe('INTERNAL');
    expect(describeFailure('a string').code).toBe('INTERNAL');
    expect(describeFailure(undefined).message).toMatch(/unexpected/i);
  });
});

describe('findUndeclaredCommands', () => {
  it('returns nothing when the manifest declares every command', () => {
    const manifest = {
      contributes: {
        commands: Object.values(COMMAND_IDS).map((command) => ({ command })),
      },
    };
    expect(findUndeclaredCommands(manifest)).toEqual([]);
  });

  it('reports commands that are implemented but not in the manifest', () => {
    const manifest = { contributes: { commands: [{ command: COMMAND_IDS.analyzeSelection }] } };
    expect(findUndeclaredCommands(manifest)).toEqual([
      COMMAND_IDS.analyzeCurrentFile,
      COMMAND_IDS.replay,
      COMMAND_IDS.export,
      COMMAND_IDS.settings,
      COMMAND_IDS.clearCache,
      COMMAND_IDS.cacheStats,
      COMMAND_IDS.cancel,
    ]);
  });

  it('tolerates a manifest with no commands section at all', () => {
    expect(findUndeclaredCommands({})).toHaveLength(Object.keys(COMMAND_IDS).length);
  });

  it('reports manifest entries that are declared but never implemented', () => {
    const manifest = {
      contributes: {
        commands: [
          { command: COMMAND_IDS.analyzeSelection },
          { command: 'ancestry.somethingRemoved' },
        ],
      },
    };
    expect(findUnimplementedCommands(manifest)).toEqual(['ancestry.somethingRemoved']);
  });

  it('finds nothing unimplemented when the manifest matches the registry', () => {
    const manifest = {
      contributes: { commands: Object.values(COMMAND_IDS).map((command) => ({ command })) },
    };
    expect(findUnimplementedCommands(manifest)).toEqual([]);
  });
});

describe('resolveRepoFile (path-traversal defence)', () => {
  const root = path.resolve(path.sep === '\\' ? 'C:\\repo' : '/repo');

  it('joins a normal relative path onto the root', () => {
    expect(resolveRepoFile(root, 'src/auth.ts')).toBe(path.join(root, 'src', 'auth.ts'));
  });

  it('normalises backslashes to forward slashes', () => {
    expect(resolveRepoFile(root, 'src\\auth.ts')).toBe(path.join(root, 'src', 'auth.ts'));
  });

  it('refuses to escape the repository root', () => {
    expect(resolveRepoFile(root, '../secrets.txt')).toBeNull();
    expect(resolveRepoFile(root, 'src/../../secrets.txt')).toBeNull();
    expect(resolveRepoFile(root, '../../../../../../etc/passwd')).toBeNull();
  });

  it('refuses an absolute path', () => {
    expect(resolveRepoFile(root, '/etc/passwd')).toBeNull();
    expect(resolveRepoFile(root, 'C:\\Windows\\System32\\config')).toBeNull();
  });

  it('refuses empty, non-string and NUL-bearing input', () => {
    expect(resolveRepoFile(root, '')).toBeNull();
    expect(resolveRepoFile(root, 'a\0b.ts')).toBeNull();
    expect(resolveRepoFile(root, undefined as unknown as string)).toBeNull();
    expect(resolveRepoFile(root, 42 as unknown as string)).toBeNull();
  });

  it('allows the root itself', () => {
    expect(resolveRepoFile(root, '.')).toBe(root);
  });

  it('does not treat a sibling directory with a shared prefix as inside the root', () => {
    // `C:\repo-backup` must not pass a `startsWith('C:\repo')` check.
    const sibling = `${root}-backup`;
    expect(resolveRepoFile(root, path.relative(root, path.join(sibling, 'x.ts')))).toBeNull();
  });
});

describe('scrubPaths (log privacy)', () => {
  it('reduces a Windows path to its basename', () => {
    expect(scrubPaths('failed at C:\\Users\\alice\\secret\\project\\src\\auth.ts')).toBe(
      'failed at …\\auth.ts',
    );
  });

  it('reduces a POSIX path to its basename', () => {
    expect(scrubPaths('failed at /home/alice/secret/project/src/auth.ts')).toBe(
      'failed at …/auth.ts',
    );
  });

  it('leaves a bare filename alone', () => {
    expect(scrubPaths('auth.ts')).toBe('auth.ts');
  });

  it('never emits the parent directory names', () => {
    const scrubbed = scrubPaths('C:\\Users\\alice\\confidential\\repo\\index.ts');
    expect(scrubbed).not.toMatch(/alice|confidential|Users/);
  });
});

describe('createLogger', () => {
  function collect(
    allowSourceCode = false,
    minLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' = 'debug',
  ): { lines: string[]; logger: ReturnType<typeof createLogger> } {
    const lines: string[] = [];
    const logger = createLogger('Ancestry Test', {
      sink: { appendLine: (line) => lines.push(line), dispose: () => undefined },
      minLevel,
      allowSourceCode,
      now: () => new Date('2026-09-27T12:00:00.000Z'),
    });
    return { lines, logger };
  }

  it('writes a timestamped, levelled line', () => {
    const { lines, logger } = collect();
    logger.info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2026-09-27T12:00:00.000Z');
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('hello');
  });

  it('honours the minimum level', () => {
    const { lines, logger } = collect(false, 'info');
    logger.debug('hidden');
    logger.trace('also hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shown');
  });

  it('redacts absolute paths by default but not when source logging is on', () => {
    const redacted = collect(false);
    redacted.logger.info('at C:\\Users\\alice\\repo\\a.ts');
    expect(redacted.lines[0]).toContain('…\\a.ts');

    const allowed = collect(true);
    allowed.logger.info('at C:\\Users\\alice\\repo\\a.ts');
    expect(allowed.lines[0]).toContain('C:\\Users\\alice');
  });

  it('never lets a throwing sink escape into the host', () => {
    const logger = createLogger('Ancestry Test', {
      sink: {
        appendLine: () => {
          throw new Error('channel disposed');
        },
        dispose: () => undefined,
      },
    });
    expect(() => logger.info('still fine')).not.toThrow();
  });

  it('unwraps an AncestryError to code plus message, and keeps the stack out of the log', () => {
    const { lines, logger } = collect();
    logger.exception(
      new AncestryError('SHALLOW_CLONE', 'History is truncated', {
        detail: 'secret path C:\\x\\y',
      }),
    );
    expect(lines[0]).toContain('SHALLOW_CLONE');
    expect(lines[0]).toContain('History is truncated');
    expect(lines.join('\n')).not.toContain('C:\\x\\y');
  });

  it('prefixes child logger lines with the scope', () => {
    const { lines, logger } = collect();
    logger.child('analysis').child('git').info('nested');
    expect(lines[0]).toContain('[analysis/git] nested');
  });

  it('is safe to dispose twice', () => {
    const { logger } = collect();
    expect(() => {
      logger.dispose();
      logger.dispose();
    }).not.toThrow();
  });
});

describe('config defaults and threshold normalisation', () => {
  it('ships monotonic default thresholds', () => {
    expect(DEFAULT_CONFIG.ignore).toBeLessThan(DEFAULT_CONFIG.possible);
    expect(DEFAULT_CONFIG.possible).toBeLessThanOrEqual(DEFAULT_CONFIG.strong);
  });

  it('raises `strong` to `possible` when a user inverts them', () => {
    const thresholds = normalizeThresholds({ ...DEFAULT_CONFIG, strong: 0.5, possible: 0.9 });
    expect(thresholds.strong).toBe(thresholds.possible);
    expect(thresholds.possible).toBe(0.9);
  });

  it('lowers the derived ignore floor so the bands stay reachable', () => {
    const thresholds = normalizeThresholds({ ...DEFAULT_CONFIG, possible: 0.3 });
    expect(thresholds.ignore).toBeLessThan(0.3);
    expect(thresholds.ignore).toBeGreaterThanOrEqual(0);
  });

  it('clamps threshold values into [0, 1]', () => {
    const thresholds = normalizeThresholds({
      ...DEFAULT_CONFIG,
      strong: 5,
      possible: -3,
    });
    expect(thresholds.strong).toBeLessThanOrEqual(1);
    expect(thresholds.possible).toBeGreaterThanOrEqual(0);
  });

  it('falls back to defaults when VS Code configuration is unavailable', () => {
    // No VS Code host in the unit-test environment: readConfig must degrade
    // rather than throw, or importing the extension would break every test.
    expect(() => readConfig()).not.toThrow();
  });
});
