/**
 * The process layer: the only place in Ancestry that starts a `git` child.
 *
 * Two properties matter more than anything else here.
 *
 * 1. **No shell, array arguments.** `spawn` is called with an *array* of
 *    arguments and `shell: false`. If we ever built a command line by joining
 *    strings and handed it to a shell, a path like `a;rm -rf ~` or `a$(id)` —
 *    both of which are legal on some file systems — would become code
 *    execution. With an argument array the child receives our bytes verbatim
 *    and there is no metacharacter to interpret.
 * 2. **A sanitised environment.** The child inherits a small allow-list of
 *    variables only. Git is steered entirely by `GIT_*` and `GIT_CONFIG*`
 *    environment variables, so a developer who once exported `GIT_DIR` in their
 *    shell profile would otherwise make Ancestry read a *different* repository
 *    than the one the user opened, with no error and no trace.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { AncestryError } from '../types';

/** Default wall-clock budget for a single git invocation (30 s). */
export const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Default cap on captured stdout (64 MiB). Generous enough for `git log` over a
 * very large repository, small enough that a runaway command cannot exhaust the
 * extension host's heap.
 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** stderr is only ever used for diagnostics, so a small tail is kept. */
const STDERR_TAIL_BYTES = 8 * 1024;

/** How long we are willing to spend probing for the git binary itself. */
const EXECUTABLE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Environment variables the child may inherit, matched case-insensitively
 * (Windows environment blocks are case-insensitive, POSIX ones are not).
 */
const INHERITED_ENV_KEYS: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'USERNAME',
  'USERDOMAIN',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/**
 * Repository-redirecting variables. These are dropped even though the allow-list
 * already excludes them: the list is the defence, this is the intent, and the
 * redundancy means a future edit to the allow-list cannot silently reintroduce
 * the bug.
 */
const BLOCKED_ENV_PATTERNS: readonly RegExp[] = [
  /^GIT_DIR$/i,
  /^GIT_WORK_TREE$/i,
  /^GIT_COMMON_DIR$/i,
  /^GIT_INDEX_FILE$/i,
  /^GIT_OBJECT_DIRECTORY$/i,
  /^GIT_ALTERNATE_OBJECT_DIRECTORIES$/i,
  /^GIT_CEILING_DIRECTORIES$/i,
  /^GIT_DISCOVERY_ACROSS_FILESYSTEM$/i,
  /^GIT_NAMESPACE$/i,
  /^GIT_REPLACE_REF_BASE$/i,
  /^GIT_CONFIG/,
];

/** Per-call knobs. All fields are optional; the defaults suit a read-only scan. */
export interface GitExecOptions {
  /** Working directory for the child. Defaults to the extension host's cwd. */
  cwd?: string;
  /** Kill the child after this many milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Cancel the child when the signal fires. Reported as `CANCELLED`. */
  signal?: AbortSignal;
  /** Cap on captured stdout. Output beyond it is dropped, not buffered. */
  maxBufferBytes?: number;
  /** Extra environment variables, merged last (so they can override the sanitised set). */
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve with the result instead of throwing when git exits non-zero. Used
   * for probes where "not found" is information, not failure. Timeouts and
   * cancellation still throw: they are not git opinions.
   */
  allowFailure?: boolean;
}

/** The outcome of one git invocation. */
export interface GitExecResult {
  /** UTF-8 decoded stdout, BOM stripped, possibly truncated at `maxBufferBytes`. */
  stdout: string;
  /** UTF-8 decoded stderr tail. */
  stderr: string;
  /** Process exit code; `-1` when the child died on a signal. */
  exitCode: number;
  /** True when stdout exceeded `maxBufferBytes` and was cut short. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * The injected command runner. `GitRepository` accepts one so tests (and future
 * caching layers) can substitute a different implementation.
 */
export type GitRunner = (args: string[], options?: GitExecOptions) => Promise<GitExecResult>;

/** Rendered command line, used in error details. Arguments are never redacted. */
function describeCommand(executable: string, args: string[]): string {
  return [executable, ...args].join(' ');
}

/**
 * A git failure. `detail` carries the command line, the stderr tail and the exit
 * code so a bug report contains everything needed to reproduce it.
 */
export class GitCommandError extends AncestryError {
  /** The full command line that failed. */
  public readonly command: string;
  /** Exit code, or `null` when the process was killed. */
  public readonly exitCode: number | null;
  /** Last bytes of stderr, trimmed. */
  public readonly stderrTail: string;
  /** Wall-clock duration in milliseconds. */
  public readonly durationMs: number;

  constructor(
    command: string,
    reason: string,
    stderrTail: string,
    exitCode: number | null,
    durationMs: number,
  ) {
    super('GIT_COMMAND_FAILED', 'Git could not complete the requested history query.', {
      detail: [
        command,
        `reason: ${reason}`,
        exitCode === null ? 'exit code: <killed>' : `exit code: ${exitCode}`,
        stderrTail ? `stderr: ${stderrTail}` : 'stderr: <empty>',
      ].join('\n'),
    });
    this.name = 'GitCommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.durationMs = durationMs;
  }
}

/** No usable `git` executable was found on PATH. */
export class GitBinaryMissingError extends AncestryError {
  constructor(detail?: string) {
    super('GIT_NOT_FOUND', 'Git is not installed, or is not available on the PATH for VS Code.', {
      detail: detail ?? 'spawn reported ENOENT for the git executable',
    });
    this.name = 'GitBinaryMissingError';
  }
}

/** Strip a UTF-8 BOM, which some Windows shells and pipes prepend to output. */
function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Build the child's environment from an allow-list of inherited variables plus
 * the caller's explicit overrides, minus every repository-redirecting variable.
 *
 * The blocklist applies to *inherited* values only (it is defence in depth
 * behind the allow-list, not the primary filter). An explicit override is
 * trusted: a caller that passes `GIT_DIR` — or `GIT_CONFIG_GLOBAL`, which tests
 * use to hide the developer's own git config — has said what it wants, and
 * silently dropping it would be a worse failure than honouring it.
 *
 * Exported for tests: the guarantees this function makes are not otherwise
 * observable, and "a stray GIT_DIR cannot redirect Ancestry" deserves a test.
 *
 * @param overrides Variables to merge last; these win.
 */
export function buildGitEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Index the inherited environment case-insensitively so the allow-list works
  // on both Windows (`Path`) and POSIX (`PATH`).
  const inherited = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      inherited.set(key.toLowerCase(), [key, value]);
    }
  }

  const env: NodeJS.ProcessEnv = {};
  for (const wanted of INHERITED_ENV_KEYS) {
    const hit = inherited.get(wanted.toLowerCase());
    if (hit && !BLOCKED_ENV_PATTERNS.some((pattern) => pattern.test(hit[0]))) {
      env[hit[0]] = hit[1];
    }
  }

  // Ancestry is a strictly read-only consumer of the user's repository: never
  // prompt for credentials (we never fetch) and never take the index lock.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  return env;
}

interface RawExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  spawnError: NodeJS.ErrnoException | null;
  command: string;
}

const EXECUTABLE_NAME = 'git';

let cachedExecutable: string | null = null;
let pendingProbe: Promise<string> | null = null;

/**
 * Spawn `git` and collect its output. Never throws for a non-zero exit: the
 * caller decides whether that is an error. Does throw nothing at all for spawn
 * failures either — they come back as `spawnError` so the wrapper can decide
 * between "git is missing" and "git failed".
 */
function execute(
  executable: string,
  args: string[],
  options: GitExecOptions,
): Promise<RawExecution> {
  const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  const maxBufferBytes = Math.max(1, options.maxBufferBytes ?? GIT_MAX_BUFFER_BYTES);
  const command = describeCommand(executable, args);
  const started = Date.now();

  return new Promise<RawExecution>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    const stdoutChunks: Buffer[] = [];
    let stderrBuffer: Buffer = Buffer.alloc(0);

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: buildGitEnv(options.env),
        // The two settings that together make argument injection impossible:
        // no shell interpretation, and no console window on Windows.
        shell: false,
        windowsHide: true,
        // stdin is closed: git must never block waiting for input from us.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: -1,
        truncated: false,
        durationMs: Date.now() - started,
        timedOut: false,
        aborted: false,
        spawnError: err as NodeJS.ErrnoException,
        command,
      });
      return;
    }

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: decodeUtf8(Buffer.concat(stdoutChunks)),
        stderr: decodeUtf8(stderrBuffer),
        exitCode: child.exitCode === null ? -1 : child.exitCode,
        truncated: stdoutTruncated,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        spawnError,
        command,
      });
    };

    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Do not hold the event loop open for a timer nobody is waiting on.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const signal = options.signal;
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        kill();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      // Always drain the pipe, even after the cap is reached: stopping the
      // reads would block the child on a full pipe and deadlock the timeout.
      if (stdoutBytes >= maxBufferBytes) {
        stdoutTruncated = true;
        return;
      }
      const room = maxBufferBytes - stdoutBytes;
      if (chunk.length <= room) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      // Keep the *head* of the output: `git log` is newest-first, so the head is
      // the part a truncated scan can still use.
      stdoutChunks.push(chunk.subarray(0, room));
      stdoutBytes = maxBufferBytes;
      stdoutTruncated = true;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
      if (stderrBuffer.length > STDERR_TAIL_BYTES) {
        stderrBuffer = stderrBuffer.subarray(stderrBuffer.length - STDERR_TAIL_BYTES);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      // `close` still fires after `error`; finishing here keeps the report prompt.
      finish();
    });

    child.on('close', () => {
      finish();
    });
  });
}

/**
 * Resolve (and memoise) the git executable.
 *
 * Node resolves `git` through PATH on every spawn, so the only thing worth
 * caching is the *fact* that it exists: probing once turns a stream of confusing
 * per-command ENOENT failures into a single, actionable `GIT_NOT_FOUND`.
 */
async function resolveGitExecutable(): Promise<string> {
  if (cachedExecutable) {
    return cachedExecutable;
  }
  if (!pendingProbe) {
    pendingProbe = (async () => {
      const probe = await execute(EXECUTABLE_NAME, ['--version'], {
        timeoutMs: EXECUTABLE_PROBE_TIMEOUT_MS,
      });
      if (probe.spawnError) {
        pendingProbe = null;
        if (probe.spawnError.code === 'ENOENT') {
          throw new GitBinaryMissingError(`spawn reported ENOENT for '${EXECUTABLE_NAME}'`);
        }
        throw new AncestryError(
          'GIT_NOT_FOUND',
          'Git is not installed, or is not available on the PATH for VS Code.',
          {
            detail: probe.spawnError.message,
            cause: probe.spawnError,
          },
        );
      }
      cachedExecutable = EXECUTABLE_NAME;
      pendingProbe = null;
      return cachedExecutable;
    })();
  }
  return pendingProbe;
}

/**
 * Run one git command and return its output.
 *
 * The command is never thrown or interpreted: `args` is passed straight through
 * as argv, so no caller can accidentally (or maliciously) turn a repository
 * path into shell syntax. Callers are expected to have validated paths and
 * revisions with `src/git/safety.ts` first.
 *
 * @param args Arguments *after* the executable, e.g. `['log', '--max-count=5']`.
 * @throws {GitBinaryMissingError} when git is not installed.
 * @throws {AncestryError} with code `CANCELLED` when `options.signal` fires.
 * @throws {GitCommandError} on timeout, spawn failure, or a non-zero exit
 *   (unless `options.allowFailure` is set).
 */
export async function runGit(args: string[], options: GitExecOptions = {}): Promise<GitExecResult> {
  if (!Array.isArray(args)) {
    throw new AncestryError('INTERNAL', 'git arguments must be supplied as an array.', {
      detail: `received ${typeof args}`,
    });
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\u0000')) {
      throw new AncestryError('INVALID_PATH', 'git arguments must be NUL-free strings.', {
        detail: `invalid argument ${JSON.stringify(arg)}`,
      });
    }
  }

  if (options.signal?.aborted) {
    throw new AncestryError('CANCELLED', 'Git history request was cancelled.', {
      detail: describeCommand(EXECUTABLE_NAME, args),
      cause: options.signal.reason,
    });
  }

  const executable = await resolveGitExecutable();
  const raw = await execute(executable, args, options);

  if (raw.spawnError) {
    if (raw.spawnError.code === 'ENOENT') {
      throw new GitBinaryMissingError(`spawn reported ENOENT for '${executable}'`);
    }
    throw new AncestryError('GIT_COMMAND_FAILED', 'Git could not be started.', {
      detail: `${raw.command}\n${raw.spawnError.message}`,
      cause: raw.spawnError,
    });
  }

  if (raw.aborted) {
    throw new AncestryError('CANCELLED', 'Git history request was cancelled.', {
      detail: raw.command,
      cause: options.signal?.reason,
    });
  }

  if (raw.timedOut) {
    throw new GitCommandError(raw.command, 'timed out', raw.stderr, null, raw.durationMs);
  }

  if (raw.exitCode !== 0 && !options.allowFailure) {
    throw new GitCommandError(
      raw.command,
      'exited non-zero',
      raw.stderr,
      raw.exitCode,
      raw.durationMs,
    );
  }

  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    truncated: raw.truncated,
    durationMs: raw.durationMs,
  };
}

/**
 * True when `err` represents a cancellation — either our own `CANCELLED`
 * `AncestryError` or a runtime `AbortError`. Callers use this to distinguish
 * "the user closed the panel" from "git broke".
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof AncestryError) {
    return err.code === 'CANCELLED';
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  return (err as { name?: unknown }).name === 'AbortError';
}
