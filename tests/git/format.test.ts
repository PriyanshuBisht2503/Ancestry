import { describe, expect, it } from 'vitest';
import {
  COMMIT_FORMAT,
  parseBlamePorcelain,
  parseBranches,
  parseCommits,
  parseNameStatusZ,
} from '../../src/git/format';

const RS = '\u001e';
const US = '\u001f';

/**
 * Build one commit record exactly as `git log --pretty=format:` would emit it,
 * so the fixtures stay in step with the real format string.
 */
function record(fields: {
  hash: string;
  short?: string;
  parents?: string;
  author?: string;
  email?: string;
  time?: number;
  committer?: string;
  committerEmail?: string;
  commitTime?: number;
  refs?: string;
  subject?: string;
  body?: string;
}): string {
  const parts = [
    fields.hash,
    fields.short ?? fields.hash.slice(0, 7),
    fields.parents ?? '',
    fields.author ?? 'Ada Lovelace',
    fields.email ?? 'ada@example.com',
    String(fields.time ?? 1_600_000_000),
    fields.committer ?? 'Grace Hopper',
    fields.committerEmail ?? 'grace@example.com',
    String(fields.commitTime ?? 1_600_000_000),
    fields.refs ?? '',
    fields.subject ?? 'subject',
    fields.body ?? '',
  ];
  return RS + parts.join(US);
}

/** Simulate `git log -z`: every record is terminated with NUL. */
function asLogZ(records: string[]): string {
  return records.map((entry) => entry + '\u0000').join('');
}

describe('COMMIT_FORMAT', () => {
  it('frames records and fields with control characters git cannot emit in them', () => {
    expect(COMMIT_FORMAT.startsWith('%x1e')).toBe(true);
    expect(COMMIT_FORMAT).toContain('%x1f');
    expect(COMMIT_FORMAT.split('%x1f')).toHaveLength(12);
  });
});

describe('parseCommits', () => {
  it('parses a normal commit', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), time: 1_600_000_000, subject: 'Add parser' })]),
    );

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      parents: [],
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      committer: { name: 'Grace Hopper', email: 'grace@example.com' },
      authorTimestamp: 1_600_000_000_000,
      commitTimestamp: 1_600_000_000_000,
      subject: 'Add parser',
      body: '',
      refs: [],
      isMerge: false,
    });
  });

  it('parses several commits in the order git emitted them', () => {
    const commits = parseCommits(
      asLogZ([
        record({ hash: 'c'.repeat(40), subject: 'third' }),
        record({ hash: 'b'.repeat(40), parents: 'c'.repeat(40), subject: 'second' }),
        record({ hash: 'a'.repeat(40), subject: 'first' }),
      ]),
    );

    expect(commits.map((entry) => entry.subject)).toEqual(['third', 'second', 'first']);
    expect(commits[1]?.parents).toEqual(['c'.repeat(40)]);
  });

  it('flags a merge commit by its parent count', () => {
    const commits = parseCommits(
      asLogZ([
        record({
          hash: 'd'.repeat(40),
          parents: `${'b'.repeat(40)} ${'c'.repeat(40)}`,
          subject: 'merge',
        }),
      ]),
    );

    expect(commits[0]?.parents).toHaveLength(2);
    expect(commits[0]?.isMerge).toBe(true);
  });

  it('does not flag a single-parent commit as a merge', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), parents: 'b'.repeat(40) })]),
    );
    expect(commits[0]?.isMerge).toBe(false);
  });

  it('keeps newlines, quotes and tabs inside the subject and body', () => {
    const subject = 'Fix "parser" handling\twith tabs';
    const body = 'line one\nline two\n\n  indented "quoted" line';
    const commits = parseCommits(asLogZ([record({ hash: 'a'.repeat(40), subject, body })]));

    expect(commits[0]?.subject).toBe(subject);
    expect(commits[0]?.body).toBe(body);
  });

  it('parses CJK and emoji author names', () => {
    const commits = parseCommits(
      asLogZ([
        record({
          hash: 'a'.repeat(40),
          author: '张三',
          email: 'zhang@example.com',
          committer: '山田 太郎',
          committerEmail: 'yamada@example.com',
        }),
      ]),
    );

    expect(commits[0]?.author.name).toBe('张三');
    expect(commits[0]?.committer.name).toBe('山田 太郎');
  });

  it('keeps U+FFFD replacement characters from non-UTF-8 bytes', () => {
    const commits = parseCommits(
      asLogZ([
        record({ hash: 'a'.repeat(40), author: 'Ada\ufffd', subject: 'bad byte \ufffd here' }),
      ]),
    );

    expect(commits[0]?.author.name).toBe('Ada\ufffd');
    expect(commits[0]?.subject).toBe('bad byte \ufffd here');
  });

  it('tolerates CRLF output', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), subject: 'crlf' })]).replace(/\n/g, '\r\n'),
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('crlf');
  });

  it('tolerates CRLF inside a multi-line body', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), body: 'first\nsecond' })]).replace(/\n/g, '\r\n'),
    );
    expect(commits[0]?.body).toBe('first\nsecond');
  });

  it('returns an empty array for empty output', () => {
    expect(parseCommits('')).toEqual([]);
    expect(parseCommits('\u0000')).toEqual([]);
    expect(parseCommits('   \n  ')).toEqual([]);
  });

  it('parses the refs decoration and strips the HEAD arrow', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), refs: 'HEAD -> main, origin/main, tag: v1.0.0' })]),
    );

    expect(commits[0]?.refs).toEqual(['main', 'origin/main', 'tag: v1.0.0']);
  });

  it('strips a refs decoration that leaked into the subject', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), subject: 'Add parser (HEAD -> main, origin/main)' })]),
    );
    expect(commits[0]?.subject).toBe('Add parser');
  });

  it('keeps a parenthesised phrase that is not a ref decoration', () => {
    const commits = parseCommits(
      asLogZ([record({ hash: 'a'.repeat(40), subject: 'Fix parser (see docs/architecture.md)' })]),
    );
    expect(commits[0]?.subject).toBe('Fix parser (see docs/architecture.md)');
  });

  it('tolerates a record with a missing body field', () => {
    const truncated =
      RS + ['a'.repeat(40), 'aaaaaaa', '', 'Ada', 'ada@x.com', '1600000000'].join(US);
    const commits = parseCommits(truncated + '\u0000');

    expect(commits).toHaveLength(1);
    expect(commits[0]?.author.name).toBe('Ada');
    expect(commits[0]?.committer.name).toBe('');
    expect(commits[0]?.subject).toBe('');
    expect(commits[0]?.body).toBe('');
  });

  it('tolerates a record with no fields beyond the hash', () => {
    expect(parseCommits(RS + 'f'.repeat(40))).toHaveLength(1);
  });

  it('skips records with no hash instead of failing the whole scan', () => {
    const commits = parseCommits(asLogZ([record({ hash: '' }), record({ hash: 'a'.repeat(40) })]));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.hash).toBe('a'.repeat(40));
  });

  it('derives a 7-character short hash when git did not supply one', () => {
    const commits = parseCommits(
      RS + ['b'.repeat(40), '', '', 'A', 'a@x', '1'].join(US) + '\u0000',
    );
    expect(commits[0]?.shortHash).toBe('bbbbbbb');
  });

  it('honours a longer abbreviation from core.abbrev', () => {
    const commits = parseCommits(
      RS + ['b'.repeat(40), 'b'.repeat(12), '', 'A', 'a@x', '1'].join(US) + '\u0000',
    );
    expect(commits[0]?.shortHash).toBe('b'.repeat(12));
  });

  it('keeps a field separator that appears inside a body', () => {
    const body = `weird${US}body`;
    const commits = parseCommits(asLogZ([record({ hash: 'a'.repeat(40), body })]));
    expect(commits[0]?.body).toBe(body);
  });

  it('coerces a non-numeric timestamp to 0 instead of NaN', () => {
    const commits = parseCommits(
      RS + ['a'.repeat(40), 'aaaaaaa', '', 'A', 'a@x', 'not-a-date'].join(US) + '\u0000',
    );
    expect(commits[0]?.authorTimestamp).toBe(0);
  });
});

describe('parseNameStatusZ', () => {
  it('parses add, modify and delete records', () => {
    const changes = parseNameStatusZ('A\u0000new.ts\u0000M\u0000old.ts\u0000D\u0000gone.ts\u0000');

    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatchObject({
      status: 'A',
      path: 'new.ts',
      oldPath: null,
      similarity: null,
    });
    expect(changes[1]).toMatchObject({ status: 'M', path: 'old.ts' });
    expect(changes[2]).toMatchObject({ status: 'D', path: 'gone.ts' });
  });

  it('parses the three-field rename record and normalises similarity to 0..1', () => {
    const changes = parseNameStatusZ('R100\u0000a.ts\u0000b.ts\u0000');

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'R', oldPath: 'a.ts', path: 'b.ts' });
    expect(changes[0]?.similarity).toBeCloseTo(1, 10);
  });

  it('parses the three-field copy record', () => {
    const changes = parseNameStatusZ('C75\u0000src/orig.ts\u0000src/copy.ts\u0000');

    expect(changes[0]).toMatchObject({ status: 'C', oldPath: 'src/orig.ts', path: 'src/copy.ts' });
    expect(changes[0]?.similarity).toBeCloseTo(0.75, 10);
  });

  it('keeps spaces and unicode in paths', () => {
    const changes = parseNameStatusZ(
      'M\u0000src/my file.ts\u0000R090\u0000docs/文档 空间.md\u0000docs/文档 空间 (copy).md\u0000',
    );

    expect(changes[0]?.path).toBe('src/my file.ts');
    expect(changes[1]?.oldPath).toBe('docs/文档 空间.md');
    expect(changes[1]?.path).toBe('docs/文档 空间 (copy).md');
    expect(changes[1]?.similarity).toBeCloseTo(0.9, 10);
  });

  it('keeps a newline inside a path, which is why -z exists', () => {
    const changes = parseNameStatusZ('A\u0000weird\nname.ts\u0000');
    expect(changes[0]?.path).toBe('weird\nname.ts');
  });

  it('parses a type change', () => {
    const changes = parseNameStatusZ('T\u0000link.ts\u0000');
    expect(changes[0]?.status).toBe('T');
  });

  it('falls back to M for a status letter outside the shared union', () => {
    const changes = parseNameStatusZ('X\u0000mystery.ts\u0000');
    expect(changes[0]?.status).toBe('M');
  });

  it('returns an empty array for empty output', () => {
    expect(parseNameStatusZ('')).toEqual([]);
    expect(parseNameStatusZ('\u0000\u0000')).toEqual([]);
  });

  it('reports zero additions and deletions, which --name-status cannot know', () => {
    const changes = parseNameStatusZ('M\u0000a.ts\u0000');
    expect(changes[0]?.additions).toBe(0);
    expect(changes[0]?.deletions).toBe(0);
  });

  it('parses the tab-separated line form as a fallback', () => {
    const changes = parseNameStatusZ('M\ta.ts\nR100\tb.ts\tc.ts\n');
    expect(changes[0]).toMatchObject({ status: 'M', path: 'a.ts' });
    expect(changes[1]).toMatchObject({ status: 'R', oldPath: 'b.ts', path: 'c.ts', similarity: 1 });
  });
});

describe('parseBranches', () => {
  it('marks the current branch with the HEAD marker', () => {
    const stdout = [
      `refs/heads/feature\tfeature\t1111111111111111111111111111111111111111\t\t `,
      `refs/heads/main\tmain\t2222222222222222222222222222222222222222\torigin/main\t*`,
      '',
    ].join('\n');

    const branches = parseBranches(stdout, 'main');

    expect(branches).toHaveLength(2);
    expect(branches[0]).toEqual({
      name: 'feature',
      ref: 'refs/heads/feature',
      isHead: false,
      isRemote: false,
      upstream: null,
      tip: '1111111111111111111111111111111111111111',
    });
    expect(branches[1]).toMatchObject({ name: 'main', isHead: true, upstream: 'origin/main' });
  });

  it('identifies remote-tracking branches', () => {
    const stdout = `refs/remotes/origin/main\torigin/main\t3333333333333333333333333333333333333333\t\t*\n`;
    const branches = parseBranches(stdout, null);

    expect(branches[0]?.isRemote).toBe(true);
    expect(branches[0]?.name).toBe('origin/main');
  });

  it('reports no head branch for a detached HEAD', () => {
    const stdout = `refs/heads/main\tmain\t4444444444444444444444444444444444444444\t\t \n`;
    const branches = parseBranches(stdout, null);

    expect(branches[0]?.isHead).toBe(false);
  });

  it('falls back to the head name when the marker column is unavailable', () => {
    const stdout = `refs/heads/main\tmain\t5555555555555555555555555555555555555555\t\t \n`;
    expect(parseBranches(stdout, 'main')[0]?.isHead).toBe(true);
  });

  it('handles CRLF output', () => {
    const stdout = `refs/heads/main\tmain\t6666666666666666666666666666666666666666\t\t*\r\nrefs/heads/x\tx\t7777777777777777777777777777777777777777\t\t \r\n`;
    const branches = parseBranches(stdout, 'main');

    expect(branches).toHaveLength(2);
    expect(branches[0]?.isHead).toBe(true);
    expect(branches[0]?.name).toBe('main');
    expect(branches[1]?.tip).toBe('7777777777777777777777777777777777777777');
  });

  it('returns an empty array for empty output', () => {
    expect(parseBranches('', null)).toEqual([]);
    expect(parseBranches('\n\n', null)).toEqual([]);
  });

  it('skips a record with no short name', () => {
    expect(parseBranches('\t\t\n', null)).toEqual([]);
  });
});

describe('parseBlamePorcelain', () => {
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);

  it('attributes one author per hunk and counts lines', () => {
    const stdout = [
      `${sha1} 1 1 1`,
      'author Ada Lovelace',
      'author-mail <ada@example.com>',
      'author-time 1600000000',
      'author-tz +0000',
      'committer Ada Lovelace',
      'committer-mail <ada@example.com>',
      'committer-time 1600000000',
      'committer-tz +0000',
      'summary add file',
      'boundary',
      'filename a.ts',
      '\texport function alpha() {',
      `${sha2} 2 2 1`,
      'author Grace Hopper',
      'author-mail <grace@example.com>',
      'author-time 1600000100',
      'committer Grace Hopper',
      'previous ' + sha1 + ' a.ts',
      'filename a.ts',
      '\treturn 1;',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.filePath).toBe('a.ts');
    expect(blame.commit).toBe('HEAD');
    expect(blame.lines).toEqual([
      { line: 1, commit: sha1, author: 'Ada Lovelace', authorTimestamp: 1_600_000_000_000 },
      { line: 2, commit: sha2, author: 'Grace Hopper', authorTimestamp: 1_600_000_100_000 },
    ]);
    expect(blame.authorLineCounts).toEqual([
      { author: 'Ada Lovelace', lines: 1 },
      { author: 'Grace Hopper', lines: 1 },
    ]);
  });

  it('carries metadata forward when git repeats a header without any', () => {
    const stdout = [
      `${sha1} 1 1 1`,
      'author Ada Lovelace',
      'author-time 1600000000',
      'boundary',
      'filename a.ts',
      '\tline one',
      `${sha1} 2 2`,
      '\tline two',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.lines.map((line) => line.line)).toEqual([1, 2]);
    expect(blame.lines[1]?.author).toBe('Ada Lovelace');
    expect(blame.authorLineCounts).toEqual([{ author: 'Ada Lovelace', lines: 2 }]);
  });

  it('honours a declared group when the content lines agree with it', () => {
    const stdout = [
      `${sha1} 1 1 3`,
      'author Ada Lovelace',
      'author-time 1600000000',
      'filename a.ts',
      '\tone',
      '\ttwo',
      '\tthree',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.lines.map((line) => line.line)).toEqual([1, 2, 3]);
    expect(blame.authorLineCounts).toEqual([{ author: 'Ada Lovelace', lines: 3 }]);
  });

  it('does not double count when a declared group is larger than the content lines', () => {
    // This is what git actually emits: a 2-line group, then its own header.
    const stdout = [
      `${sha1} 5 5 2`,
      'author Ada Lovelace',
      'author-time 1600000000',
      'filename a.ts',
      '\tfive',
      `${sha1} 6 6`,
      '\tsix',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.lines.map((line) => line.line)).toEqual([5, 6]);
    expect(blame.authorLineCounts).toEqual([{ author: 'Ada Lovelace', lines: 2 }]);
  });

  it('sorts authorLineCounts by line count descending', () => {
    const stdout = [
      `${sha1} 1 1 2`,
      'author Ada Lovelace',
      'author-time 1600000000',
      '\tone',
      '\ttwo',
      `${sha2} 3 3`,
      'author Grace Hopper',
      'author-time 1600000100',
      'previous ' + sha1 + ' a.ts',
      '\tthree',
      `${sha2} 4 4`,
      '\tfour',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.authorLineCounts).toEqual([
      { author: 'Ada Lovelace', lines: 2 },
      { author: 'Grace Hopper', lines: 2 },
    ]);
  });

  it('breaks a line-count tie alphabetically so the order is deterministic', () => {
    const stdout = [
      `${sha1} 1 1`,
      'author Zoe',
      'author-time 1',
      '\tone',
      `${sha2} 2 2`,
      'author Adam',
      'author-time 1',
      '\ttwo',
      '',
    ].join('\n');

    expect(parseBlamePorcelain(stdout, 'a.ts', 'HEAD').authorLineCounts).toEqual([
      { author: 'Adam', lines: 1 },
      { author: 'Zoe', lines: 1 },
    ]);
  });

  it('never records file content', () => {
    const stdout = [
      `${sha1} 1 1 1`,
      'author Ada',
      'author-time 1',
      'filename a.ts',
      '\tSECRET_VALUE',
      '',
    ].join('\n');
    expect(JSON.stringify(parseBlamePorcelain(stdout, 'a.ts', 'HEAD'))).not.toContain(
      'SECRET_VALUE',
    );
  });

  it('handles several hunks scattered through the file', () => {
    // Git writes a commit's metadata only on that commit's first appearance, so
    // a real third hunk like this one arrives bare. Re-emitting the block anyway
    // is tolerated: it can only repeat what the parser already recorded.
    const stdout = [
      `${sha1} 1 1 1`,
      'author Ada',
      'author-time 1',
      '\tone',
      `${sha2} 2 2 1`,
      'author Grace',
      'author-time 2',
      '\ttwo',
      `${sha1} 3 3`,
      'author Ada',
      'author-time 1',
      'previous ' + sha2 + ' a.ts',
      '\tthree',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    expect(blame.lines).toEqual([
      { line: 1, commit: sha1, author: 'Ada', authorTimestamp: 1000 },
      { line: 2, commit: sha2, author: 'Grace', authorTimestamp: 2000 },
      { line: 3, commit: sha1, author: 'Ada', authorTimestamp: 1000 },
    ]);
  });

  it('reuses the author it already saw when a commit returns without metadata', () => {
    // Exactly what git prints when the same commit owns two separated lines: the
    // metadata is written once, on the commit's first appearance.
    const stdout = [
      `${sha1} 1 1 1`,
      'author Ada',
      'author-time 1',
      '\tone',
      `${sha2} 2 2 1`,
      'author Grace',
      'author-time 2',
      '\ttwo',
      `${sha1} 3 3`,
      '\tthree',
      '',
    ].join('\n');

    const blame = parseBlamePorcelain(stdout, 'a.ts', 'HEAD');

    // Carrying the *last seen* author forward would be wrong: the commit hash
    // on the header identifies the author, and git already said who that was
    // for this exact hash. Attributing line 3 to Grace would also corrupt the
    // summary counts, so this is the difference between a right answer and a
    // plausible-looking wrong one.
    expect(blame.lines[2]).toEqual({ line: 3, commit: sha1, author: 'Ada', authorTimestamp: 1000 });
    expect(blame.authorLineCounts).toEqual([
      { author: 'Ada', lines: 2 },
      { author: 'Grace', lines: 1 },
    ]);
  });

  it('returns an empty result for empty output', () => {
    expect(parseBlamePorcelain('', 'a.ts', 'HEAD')).toEqual({
      filePath: 'a.ts',
      commit: 'HEAD',
      lines: [],
      authorLineCounts: [],
    });
  });

  it('falls back to the e-mail when the author name is missing', () => {
    const stdout = [
      `${sha1} 1 1`,
      'author-mail <solo@example.com>',
      'author-time 1',
      '\tone',
      '',
    ].join('\n');
    expect(parseBlamePorcelain(stdout, 'a.ts', 'HEAD').authorLineCounts).toEqual([
      { author: 'solo@example.com', lines: 1 },
    ]);
  });

  it('tolerates a header with no content line following it', () => {
    const stdout = [`${sha1} 1 1 2`, 'author Ada', 'author-time 1', ''].join('\n');
    expect(parseBlamePorcelain(stdout, 'a.ts', 'HEAD').lines).toEqual([]);
  });
});
