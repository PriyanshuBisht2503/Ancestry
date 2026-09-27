/**
 * Input validation for the Git layer.
 *
 * Everything that reaches `child_process.spawn` originates from a user selection,
 * a configuration file, or a file parsed out of Git output. Ancestry treats all
 * three as untrusted: this module is the single choke point where a value is
 * proven to be a *path* or a *revision* before it can be handed to Git.
 *
 * The rules are intentionally stricter than Git's own. Git happily accepts a
 * relative path, a Windows path, or (dangerously) an argument that begins with a
 * dash and silently interprets it as an option. Being stricter costs us nothing
 * because real repository paths and revisions never need those shapes.
 */

import { AncestryError } from '../types';

/*
 * NUL and the C0/C7 control characters are rejected everywhere: a NUL byte is
 * the classic argv-terminator trick, and a newline inside a revision can inject
 * an entirely new record into `git log` output we are about to parse.
 */
/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/* eslint-enable no-control-regex */

/** `C:`, `c:` — a drive-qualified path, with or without a backslash. */
const DRIVE_QUALIFIED = /^[A-Za-z]:/;

/**
 * Revisions are restricted to characters Git itself documents for ref names plus
 * the range/ancestry operators (`^ ~ @ { } :` is covered by the set below minus
 * `:` on purpose, because a bare `:` is a pathspec magic prefix we do not need).
 */
const SAFE_REVISION_CHARACTERS = /^[A-Za-z0-9_./^~@{}-]+$/;

/**
 * Upper bound on a revision string. Real refs are far shorter; the limit exists
 * so a hostile input cannot make us build multi-kilobyte command lines.
 */
const MAX_REVISION_LENGTH = 1024;

function invalidPath(reason: string, value: unknown): AncestryError {
  return new AncestryError('INVALID_PATH', 'That file path cannot be read from Git.', {
    // JSON.stringify escapes NUL and newlines so the detail stays single-line
    // and log-safe; the value is a path, never file content.
    detail: `${reason}: ${JSON.stringify(value)}`,
  });
}

/**
 * Replace Windows separators with POSIX ones.
 *
 * Ancestry stores every path in the POSIX form mandated by `src/types.ts`, and
 * users (and other tools) hand us both spellings. Normalising first means a
 * single set of checks covers `a\b`, `a/b` and mixed forms identically.
 */
function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Validate a repository-relative file path and return its normalised POSIX form.
 *
 * Rejected: empty input, absolute POSIX paths (`/x`), drive-qualified or UNC
 * paths (`C:\x`, `\\server\share`), any `..` segment (path traversal out of the
 * repository), NUL and control characters, and — most importantly — any path
 * whose **first character is a dash**.
 *
 * The leading-dash rule is the option-injection guard. Git parses each argv
 * entry positionally unless it *begins* with `-`; a file named `-output=evil`
 * would otherwise be turned into the option `--output=evil` (or, for
 * `git log --format`, into an argument that changes what Git writes). Because
 * we always pass `-- <path>` after the options, Git would still treat it as an
 * option, so the only safe place to reject it is here.
 *
 * @param filePath Repo-relative path, in either separator style.
 * @returns The normalised POSIX path, with `.` segments collapsed.
 * @throws {AncestryError} with code `INVALID_PATH` when the path is unsafe.
 */
export function assertSafeRepoPath(filePath: string): string {
  if (typeof filePath !== 'string') {
    throw invalidPath('path must be a string', typeof filePath);
  }
  if (filePath.length === 0) {
    throw invalidPath('path is empty', filePath);
  }
  if (CONTROL_CHARACTERS.test(filePath)) {
    throw invalidPath('path contains NUL or control characters', filePath);
  }

  const posix = toPosix(filePath);

  if (posix.length === 0) {
    throw invalidPath('path is empty after normalisation', filePath);
  }
  if (posix.startsWith('/')) {
    throw invalidPath('path must be repository-relative, not absolute', filePath);
  }
  if (DRIVE_QUALIFIED.test(posix)) {
    throw invalidPath('path must be repository-relative, not drive-qualified', filePath);
  }
  if (posix.startsWith('-')) {
    throw invalidPath('path must not start with "-" (git would read it as an option)', filePath);
  }

  const segments: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '..') {
      throw invalidPath('path must not contain a ".." segment', filePath);
    }
    if (segment === '.' || segment === '') {
      // Collapses `.`, `a//b` and a trailing slash into the canonical form.
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw invalidPath('path resolves to nothing', filePath);
  }

  return segments.join('/');
}

/**
 * Validate a Git revision and return it unchanged.
 *
 * A revision reaches argv exactly like a path does, so it needs the same
 * option-injection defence plus a positive allow-list: only characters that can
 * legally appear in a ref name, an abbreviated object id, or Git's ancestry
 * operators (`^`, `~`, `@{...}`) are accepted. `..` ranges are permitted
 * because they are the idiomatic way to name a commit interval.
 *
 * @throws {AncestryError} with code `INVALID_PATH` when the revision is unsafe.
 */
export function assertSafeRevision(rev: string): string {
  if (typeof rev !== 'string') {
    throw invalidPath('revision must be a string', typeof rev);
  }
  if (rev.length === 0) {
    throw invalidPath('revision is empty', rev);
  }
  if (rev.length > MAX_REVISION_LENGTH) {
    throw invalidPath('revision is too long', rev);
  }
  if (CONTROL_CHARACTERS.test(rev)) {
    throw invalidPath('revision contains NUL or control characters', rev);
  }
  if (rev.startsWith('-')) {
    throw invalidPath('revision must not start with "-" (git would read it as an option)', rev);
  }
  if (!SAFE_REVISION_CHARACTERS.test(rev)) {
    throw invalidPath('revision contains characters that are not valid in a ref', rev);
  }
  return rev;
}

/**
 * Nullable variant of {@link assertSafeRepoPath}, for call sites where "no path"
 * is a legitimate answer (a deleted selection, a rename with no source path).
 *
 * @returns The normalised path, or `null` for `null`/`undefined`/empty input.
 * @throws {AncestryError} with code `INVALID_PATH` when a non-empty path is unsafe.
 */
export function assertSafeGitPathOrNull(filePath: string | null | undefined): string | null {
  if (filePath === null || filePath === undefined || filePath === '') {
    return null;
  }
  return assertSafeRepoPath(filePath);
}
