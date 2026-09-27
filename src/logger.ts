/**
 * Logging for the extension host.
 *
 * Privacy rules enforced here, not merely documented:
 *  - Source code is NEVER written to the log unless the user has explicitly
 *    enabled `ancestry.privacy.logSourceCode`.
 *  - Absolute paths are scrubbed to `…/<basename>` so casual debugging does not
 *    disclose the user's directory layout.
 *  - `AncestryError` is unwrapped into `code` + `userMessage`, so a stack trace
 *    containing absolute paths never reaches the log by default.
 *
 * This module never touches `Object.prototype` or any other shared prototype.
 */
import * as vscode from 'vscode';
import { AncestryError, type AncestryErrorCode } from './types';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
});

/** Minimal surface of a VS Code output channel, so tests can substitute a fake. */
export interface LogSink {
  appendLine(value: string): void;
  dispose(): void;
}

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** Logs an error, unwrapping `AncestryError` to a safe form. */
  exception(err: unknown, context?: string): void;
  /** Derives a child logger that prefixes every line, e.g. per repository. */
  child(scope: string): Logger;
  dispose(): void;
}

export interface LoggerOptions {
  /** Supply a sink instead of creating a VS Code output channel. */
  sink?: LogSink;
  /** Whether source text may be written. Defaults to false. */
  allowSourceCode?: boolean;
  minLevel?: LogLevel;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Extra hook so tests can assert on emitted lines. */
  observer?: (level: LogLevel, line: string) => void;
}

export function createLogger(name = 'Ancestry', options: LoggerOptions = {}): Logger {
  const allowSourceCode = options.allowSourceCode === true;
  const minLevel = options.minLevel ?? 'info';
  const now = options.now ?? (() => new Date());
  // Only create a real output channel when one is actually needed; tests pass a sink.
  // `createOutputChannel(name)` (not the `{ log: true }` overload) because we do our
  // own level formatting, including the absolute-path scrubbing above.
  const sink: LogSink | null = options.sink ?? createOutputChannelSafely(name);

  const emit = (level: LogLevel, message: string, args: readonly unknown[]): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      return;
    }
    const stamp = now().toISOString();
    const rendered = args.length > 0 ? ` ${args.map(formatArg).join(' ')}` : '';
    const line = `[${stamp}] [${level.toUpperCase().padEnd(5)}] ${message}${rendered}`;
    try {
      options.observer?.(level, line);
      sink?.appendLine(line);
    } catch {
      // A disposed or failing output channel must never propagate into the
      // extension host. Losing a log line is strictly better than crashing.
    }
  };

  const redact = (text: string): string => (allowSourceCode ? text : scrubPaths(text));

  const logger: Logger = {
    trace: (m, ...a) => emit('trace', redact(m), a),
    debug: (m, ...a) => emit('debug', redact(m), a),
    info: (m, ...a) => emit('info', redact(m), a),
    warn: (m, ...a) => emit('warn', redact(m), a),
    error: (m, ...a) => emit('error', redact(m), a),
    exception(err, context) {
      const prefix = context ? `${context}: ` : '';
      if (err instanceof AncestryError) {
        emit('error', `${prefix}${describeError(err)}`, []);
        if (err.detail && allowSourceCode) {
          emit('debug', `${prefix}detail: ${err.detail}`, []);
        }
        if (err.cause instanceof Error) {
          emit('debug', `${prefix}cause: ${err.cause.message}`, []);
        }
        return;
      }
      if (err instanceof Error) {
        emit('error', `${prefix}${err.name}: ${redact(err.message)}`, []);
        if (allowSourceCode && err.stack) {
          emit('debug', `${prefix}${err.stack}`, []);
        }
        return;
      }
      emit('error', `${prefix}non-error thrown: ${redact(safeStringify(err))}`, []);
    },
    child(scope) {
      return prefixLogger(logger, scope);
    },
    dispose() {
      try {
        if (!options.sink) {
          sink?.dispose();
        }
      } catch {
        // ignore
      }
    },
  };

  return logger;
}

function createOutputChannelSafely(name: string): LogSink | null {
  try {
    return vscode.window.createOutputChannel(name);
  } catch {
    // Activation outside a real VS Code host (unit tests, CLI probing).
    return null;
  }
}

function prefixLogger(base: Logger, scope: string): Logger {
  return {
    trace: (m, ...a) => base.trace(`[${scope}] ${m}`, ...a),
    debug: (m, ...a) => base.debug(`[${scope}] ${m}`, ...a),
    info: (m, ...a) => base.info(`[${scope}] ${m}`, ...a),
    warn: (m, ...a) => base.warn(`[${scope}] ${m}`, ...a),
    error: (m, ...a) => base.error(`[${scope}] ${m}`, ...a),
    exception: (err, context) =>
      base.exception(err, context ? `[${scope}] ${context}` : `[${scope}]`),
    child: (child) => prefixLogger(base, `${scope}/${child}`),
    dispose: () => base.dispose(),
  };
}

/**
 * Replaces absolute paths with `…/<basename>` so the log does not disclose the
 * user's directory layout. Handles both Windows (`C:\a\b`) and POSIX (`/a/b`)
 * forms, and leaves URLs and single relative tokens alone.
 */
export function scrubPaths(text: string): string {
  return (
    text
      .replace(
        /[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]*/g,
        (m) => `…\\${basenameOf(m)}`,
      )
      // Inside a character class a `/` needs no escape — only a bare `/` in the
      // pattern body does, where it would otherwise close the literal.
      .replace(/(?<![\w.])\/(?:[^/\s"'<>|]+\/)*[^/\s"'<>|]+/g, (m) => `…/${basenameOf(m)}`)
  );
}

function basenameOf(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : pathLike;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return scrubPaths(arg);
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${scrubPaths(arg.message)}`;
  }
  if (arg === null || arg === undefined) {
    return String(arg);
  }
  return scrubPaths(safeStringify(arg));
}

export function describeError(err: AncestryError): string {
  return `${err.code} — ${err.userMessage}`;
}

export function errorCodeOf(err: unknown): AncestryErrorCode | 'UNKNOWN' {
  return err instanceof AncestryError ? err.code : 'UNKNOWN';
}

/** Maps an error code to an actionable, user-facing hint shown in notifications. */
export function hintForCode(code: AncestryErrorCode): string | undefined {
  switch (code) {
    case 'NO_GIT_REPOSITORY':
      return 'Ancestry needs a Git repository. Open a folder inside one, or run `git init`.';
    case 'GIT_NOT_FOUND':
      return 'Install Git and make sure `git` is on your PATH, then reload the window.';
    case 'SHALLOW_CLONE':
      return 'History is truncated. Run `git fetch --unshallow` for complete ancestry.';
    case 'REPOSITORY_TOO_LARGE':
      return 'Raise `ancestry.git.maxRepositorySizeBytes`, or analyse a repository with a smaller history.';
    case 'UNSUPPORTED_LANGUAGE':
      return 'Version 1 analyses JavaScript and TypeScript only. See docs/roadmap.md.';
    case 'CACHE_CORRUPT':
      return 'The local index was rebuilt automatically. Run "Ancestry: Clear Ancestry Index Cache" if it repeats.';
    case 'NO_MATCHES':
      return 'Nothing similar was found. Lower `ancestry.similarity.possibleThreshold`, or raise `ancestry.git.maxHistoryDepth`.';
    case 'FILE_TOO_LARGE':
      return 'Raise `ancestry.git.maxFileSizeBytes` if this file should be analysed.';
    case 'CANCELLED':
      return undefined;
    default:
      return undefined;
  }
}
