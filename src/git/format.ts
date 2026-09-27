/**
 * Parsers for git's machine-readable output.
 *
 * Every format here uses control characters as delimiters rather than
 * whitespace, because Git is perfectly happy to put a newline, a tab or a quote
 * inside a commit subject, an author name or a file path. `%x1e` (record
 * separator) frames a commit, `%x1f` (unit separator) frames a field, and `-z`
 * makes Git terminate every token with NUL.
 *
 * All parsers are *tolerant* by design: a malformed record from one commit must
 * never abort a scan that has already produced useful results, so bad records
 * are skipped rather than thrown.
 */

import type { GitBlameLine, GitBlameResult, GitBranch, GitCommit, GitFileChange } from '../types';

/** Unit separator: separates fields inside one record. */
export const FIELD_SEPARATOR = '\u001f';

/**
 * Tab: the field separator used for `git for-each-ref`.
 *
 * Unlike `git log --pretty`, `for-each-ref` does **not** expand `%x1f` — it
 * emits the literal text. It does expand `%09`, and a tab is the one character
 * that `git check-ref-format` forbids in a ref name (it is an ASCII control
 * character), so a tab can never be confused with ref content. A space is the
 * only other candidate and it *is* legal inside a ref name, so it is unusable.
 */
export const REF_FIELD_SEPARATOR = '\t';

/** Record separator: separates records (commits) from each other. */
export const RECORD_SEPARATOR = '\u001e';

/**
 * Field count of one commit record. The body is last on purpose: it is the only
 * field a human can put arbitrary bytes into, so `parseCommits` slices it off
 * with a limit rather than a full split (a commit message may legitimately
 * contain `%x1f`).
 */
const COMMIT_FIELD_COUNT = 12;

/**
 * `--pretty=format:` string for `git log`, in field order:
 *
 * `hash`, `short hash`, `parents`, `author name`, `author e-mail`,
 * `author time (epoch seconds)`, `committer name`, `committer e-mail`,
 * `committer time`, `ref decoration`, `subject`, `body`.
 *
 * Each record is *prefixed* with `%x1e` rather than terminated, which makes the
 * parse independent of whatever separator Git chooses between records — with
 * or without `-z`, with or without CRLF translation.
 */
export const COMMIT_FORMAT = [
  '%x1e',
  '%H',
  '%x1f',
  '%h',
  '%x1f',
  '%P',
  '%x1f',
  '%an',
  '%x1f',
  '%ae',
  '%x1f',
  '%at',
  '%x1f',
  '%cn',
  '%x1f',
  '%ce',
  '%x1f',
  '%ct',
  '%x1f',
  '%D',
  '%x1f',
  '%s',
  '%x1f',
  '%b',
].join('');

/** `--pretty=` argument carrying {@link COMMIT_FORMAT}. */
export const COMMIT_FORMAT_ARG = `--pretty=format:${COMMIT_FORMAT}`;

/**
 * `--format=` string for `git for-each-ref`, in field order: full ref name,
 * short ref name, object name, upstream (short), and the HEAD marker.
 *
 * `%(HEAD)` is `*` on the checked-out branch and a single space otherwise, so it
 * must not be trimmed away before it is tested.
 */
export const REF_FORMAT = [
  '%(refname)',
  '%09',
  '%(refname:short)',
  '%09',
  '%(objectname)',
  '%09',
  '%(upstream:short)',
  '%09',
  '%(HEAD)',
].join('');

/** Fallback abbreviation length when git does not give us `%h`. */
const DEFAULT_SHORT_HASH_LENGTH = 7;

/** Normalise line endings and drop a BOM before splitting records. */
function normaliseOutput(stdout: string): string {
  return stdout.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function field(fields: string[], index: number): string {
  const value = fields[index];
  return value === undefined ? '' : value;
}

/** Epoch seconds → epoch milliseconds, tolerating junk. */
function epochSecondsToMs(value: string): number {
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/**
 * Remove a ` (HEAD -> main, origin/main)` decoration from a subject line.
 *
 * Only the trailing parenthesised group is considered, and only when every
 * comma-separated entry inside it looks like a ref (`HEAD`, `tag:`, `origin/…`,
 * `refs/…`). A real commit message such as "fix parser (see docs)" must survive
 * untouched, which is why the check is this specific.
 */
function stripRefDecoration(subject: string): string {
  const match = /\s\(([^()]*)\)$/.exec(subject);
  if (!match) {
    return subject;
  }
  const inner = match[1];
  if (inner.length === 0) {
    return subject;
  }
  const entries = inner.split(',').map((entry) => entry.trim());
  const allRefs = entries.every(
    (entry) =>
      entry === 'HEAD' ||
      entry.startsWith('HEAD -> ') ||
      entry.startsWith('tag: ') ||
      entry.startsWith('refs/') ||
      entry.startsWith('origin/') ||
      /^[A-Za-z0-9._\-/]+$/.test(entry),
  );
  return allRefs ? subject.slice(0, match.index) : subject;
}

/** Split `%D` into ref names, dropping Git's `HEAD -> ` prefix. */
function parseRefDecoration(decoration: string): string[] {
  return decoration
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const arrow = entry.indexOf('-> ');
      return arrow >= 0 ? entry.slice(arrow + 3).trim() : entry;
    })
    .filter((entry) => entry.length > 0);
}

/**
 * Parse `git log` output produced with {@link COMMIT_FORMAT} and `-z`.
 *
 * Tolerates: empty output, a missing trailing record, missing fields, CRLF line
 * endings, tabs and newlines inside subjects and bodies, non-UTF-8 bytes (which
 * arrive as U+FFFD and are kept as-is), and a `refs` decoration glued onto the
 * subject.
 *
 * @param stdout Raw stdout from git; a BOM is tolerated.
 * @returns Commits in the order git produced them, malformed records dropped.
 */
export function parseCommits(stdout: string): GitCommit[] {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return [];
  }

  const commits: GitCommit[] = [];
  for (const rawChunk of normaliseOutput(stdout).split(RECORD_SEPARATOR)) {
    // Drop the record terminator (`\n` normally, `\0` under `-z`) that Git puts
    // between records; it lands at the end of the final field.
    const chunk = rawChunk.replace(/^[\n\0]+/, '').replace(/[\n\0]+$/, '');
    if (chunk.trim().length === 0) {
      continue;
    }

    // The body is the last field, so it keeps every remaining separator instead
    // of being split: a commit message may legitimately contain `%x1f`.
    const parts = chunk.split(FIELD_SEPARATOR);
    const fields = parts.slice(0, COMMIT_FIELD_COUNT - 1);
    fields.push(parts.slice(COMMIT_FIELD_COUNT - 1).join(FIELD_SEPARATOR));
    const hash = field(fields, 0).trim();
    if (hash.length === 0) {
      continue;
    }

    const parents = field(fields, 2)
      .split(' ')
      .map((parent) => parent.trim())
      .filter((parent) => parent.length > 0);

    const shortHash = field(fields, 1).trim() || hash.slice(0, DEFAULT_SHORT_HASH_LENGTH);

    commits.push({
      hash,
      shortHash,
      parents,
      author: { name: field(fields, 3), email: field(fields, 4) },
      committer: { name: field(fields, 6), email: field(fields, 7) },
      authorTimestamp: epochSecondsToMs(field(fields, 5)),
      commitTimestamp: epochSecondsToMs(field(fields, 8)),
      subject: stripRefDecoration(field(fields, 10)),
      body: field(fields, 11),
      refs: parseRefDecoration(field(fields, 9)),
      isMerge: parents.length > 1,
    });
  }

  return commits;
}

/** Status letter → the shared change-status union. */
function toChangeStatus(letter: string): GitFileChange['status'] {
  switch (letter) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return letter;
    default:
      // Unknown letters (X, B, …) are still real; report them as modifications
      // so downstream colouring never sees an out-of-union value.
      return 'M';
  }
}

/**
 * Parse `--name-status -z` output from `git diff-tree` / `git diff`.
 *
 * With `-z`, Git emits `status\0path\0` and, for renames and copies,
 * `status\0old\0new\0` — so paths are never quoted, never escaped, and may
 * contain spaces, tabs, quotes or newlines. Line-based output is also accepted
 * as a fallback, which keeps the parser usable against `git show --name-status`
 * and hand-written fixtures.
 *
 * `similarity` is normalised to 0..1 to match the rest of the domain model.
 * `additions`/`deletions` are 0 because `--name-status` does not report them;
 * callers that need line counts must ask for `--numstat`.
 */
export function parseNameStatusZ(stdout: string): GitFileChange[] {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return [];
  }

  const text = normaliseOutput(stdout);
  const changes: GitFileChange[] = [];

  const push = (statusToken: string, first: string, second?: string): void => {
    const letter = statusToken.charAt(0);
    const status = toChangeStatus(letter);
    const percent = Number.parseInt(statusToken.slice(1), 10);
    const similarity = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : null;
    // R/C records carry both the source and the destination path.
    const isPair = (status === 'R' || status === 'C') && second !== undefined;
    changes.push({
      path: isPair ? second : first,
      oldPath: isPair ? first : null,
      status,
      additions: 0,
      deletions: 0,
      similarity: isPair ? similarity : null,
    });
  };

  if (text.includes('\u0000')) {
    const tokens = text.split('\u0000');
    for (let index = 0; index < tokens.length;) {
      const statusToken = tokens[index];
      index += 1;
      if (statusToken === undefined || statusToken.length === 0) {
        continue;
      }
      const first = tokens[index];
      index += 1;
      if (first === undefined) {
        break;
      }
      if (statusToken.charAt(0) === 'R' || statusToken.charAt(0) === 'C') {
        const second = tokens[index];
        index += 1;
        if (second === undefined) {
          break;
        }
        push(statusToken, first, second);
      } else {
        push(statusToken, first);
      }
    }
    return changes;
  }

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const parts = line.split('\t');
    const statusToken = parts[0];
    if (statusToken === undefined || parts.length < 2) {
      continue;
    }
    if (parts.length >= 3) {
      push(statusToken, parts[1] ?? '', parts[2] ?? '');
    } else {
      push(statusToken, parts[1] ?? '');
    }
  }

  return changes;
}

/**
 * Parse `git for-each-ref` output produced with {@link REF_FORMAT}.
 *
 * @param stdout Raw ref listing.
 * @param head Short name of the current branch, or `null` for a detached HEAD.
 *   Used as a second signal for `isHead` because a detached HEAD has no marker
 *   at all.
 */
export function parseBranches(stdout: string, head: string | null): GitBranch[] {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return [];
  }

  const branches: GitBranch[] = [];
  for (const line of normaliseOutput(stdout).split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const fields = line.split(REF_FIELD_SEPARATOR);
    const ref = field(fields, 0).trim();
    const name = field(fields, 1).trim();
    if (name.length === 0) {
      continue;
    }
    const upstream = field(fields, 3).trim();
    const isHead = field(fields, 4).trim() === '*' || (head !== null && name === head);
    branches.push({
      name,
      ref,
      isHead,
      isRemote: ref.startsWith('refs/remotes/'),
      upstream: upstream.length > 0 ? upstream : null,
      tip: field(fields, 2).trim(),
    });
  }

  return branches;
}

/** `author-time` value → epoch milliseconds. */
function blameTimeToMs(value: string): number {
  const seconds = Number.parseInt(value.trim(), 10);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/** Undo porcelain's `<>` wrapping of an e-mail address. */
function blameMail(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Parse `git blame --porcelain` output.
 *
 * The porcelain format is `<sha> <orig-line> <final-line> [<num-lines>]`
 * followed by `key value` metadata, then one TAB-prefixed content line per
 * blamed line. Three real-world quirks make the obvious implementation wrong:
 *
 *  - The metadata block is written **once per commit**, not once per hunk. A
 *    later hunk for a commit git has already described carries no metadata at
 *    all, and that is the common case rather than a corner case: any file whose
 *    first and last lines come from the same commit — the usual shape of a real
 *    source file — ends with a bare header. Attribution therefore has to be
 *    remembered *per commit hash*. Carrying the most recently seen author
 *    forward instead charges one author's lines to whoever was blamed just
 *    before, which is wrong for every file that alternates between two commits.
 *  - The `<num-lines>` field is only a hint. Git groups lines under one header
 *    and then re-issues a header for the next line of the same commit, so the
 *    declared count and the content lines that actually follow routinely
 *    disagree. Crediting the declared count double-counts; crediting the
 *    observed count can invent a line the file does not have. A hunk is
 *    credited with the declared count when it agrees with what followed, and
 *    with a single line otherwise — the only claim the output supports.
 *  - `boundary` marks a hunk that reached the edge of the requested range.
 *    Attribution is still recorded, but the caller must not read it as proof of
 *    provenance.
 *
 * The content line itself is skipped: Ancestry never logs or transports source
 * text, so a line's existence is all the parser needs to record.
 *
 * @param filePath Repo-relative path, echoed into the result for the caller.
 * @param commit The revision that was blamed, echoed into the result.
 */
export function parseBlamePorcelain(
  stdout: string,
  filePath: string,
  commit: string,
): GitBlameResult {
  const lines: GitBlameLine[] = [];
  const counts = new Map<string, number>();

  if (typeof stdout !== 'string' || stdout.length === 0) {
    return { filePath, commit, lines: [], authorLineCounts: [] };
  }

  interface Hunk {
    sha: string;
    startLine: number;
    declaredCount: number;
    contentLines: number;
    author: string;
    authorTimestamp: number;
  }
  let hunk: Hunk | null = null;

  /**
   * What git said about each commit it described, keyed by hash.
   *
   * Git emits a commit's metadata only on that commit's first appearance, so
   * this map is the only way to attribute a later, bare header to the right
   * author instead of to the previous hunk's.
   */
  const suspects = new Map<string, { author: string; authorTimestamp: number }>();

  const recordHunk = (): void => {
    if (hunk === null || hunk.contentLines === 0) {
      return;
    }
    // Trust the observed content lines; the declared count is only used when it
    // agrees, which is the documented grouped form.
    const count = hunk.declaredCount === hunk.contentLines ? hunk.declaredCount : 1;
    for (let offset = 0; offset < count; offset += 1) {
      const number = hunk.startLine + offset;
      lines.push({
        line: number,
        commit: hunk.sha,
        author: hunk.author,
        authorTimestamp: hunk.authorTimestamp,
      });
      counts.set(hunk.author, (counts.get(hunk.author) ?? 0) + 1);
    }
  };

  for (const rawLine of normaliseOutput(stdout).split('\n')) {
    // TAB-prefixed lines are file content: counted, never recorded.
    if (rawLine.startsWith('\t')) {
      if (hunk !== null) {
        hunk.contentLines += 1;
      }
      continue;
    }
    if (rawLine.length === 0) {
      continue;
    }

    const header = /^([0-9a-f]{7,64})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/.exec(rawLine);
    if (header) {
      recordHunk();
      const sha = header[1] ?? '';
      const declaredCount = header[4] === undefined ? 0 : Number.parseInt(header[4], 10);
      const described = suspects.get(sha);
      hunk = {
        sha,
        startLine: Number.parseInt(header[3] ?? '0', 10),
        declaredCount: Number.isFinite(declaredCount) ? declaredCount : 0,
        contentLines: 0,
        // Seed from what this run already learned about the commit: a header
        // with no metadata behind it means git described it further up.
        author: described?.author ?? '',
        authorTimestamp: described?.authorTimestamp ?? 0,
      };
      continue;
    }

    if (hunk === null) {
      // Metadata before any header: malformed, nothing to attribute it to.
      continue;
    }

    // `previous`, `filename` and `boundary` are recognised for completeness.
    // Ancestry re-derives rename provenance from the commit graph rather than
    // trusting the file name git saw, so their values are intentionally unused.
    const separator = rawLine.indexOf(' ');
    if (separator > 0) {
      const key = rawLine.slice(0, separator);
      const value = rawLine.slice(separator + 1);
      if (key === 'author') {
        hunk.author = value;
      } else if (key === 'author-time') {
        hunk.authorTimestamp = blameTimeToMs(value);
      } else if (key === 'author-mail' && hunk.author.length === 0) {
        hunk.author = blameMail(value);
      }
      // Remember it under the commit it describes: the same commit may own
      // another line further down the file, under a header with no metadata.
      suspects.set(hunk.sha, { author: hunk.author, authorTimestamp: hunk.authorTimestamp });
      continue;
    }
    // Bare markers: `boundary`.
  }

  recordHunk();

  const authorLineCounts = Array.from(counts.entries())
    .map(([name, count]) => ({ author: name, lines: count }))
    // Descending by line count, then alphabetical, so the summary view and its
    // tests are deterministic when two authors are tied.
    .sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author));

  return { filePath, commit, lines, authorLineCounts };
}
