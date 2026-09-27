/**
 * Accuracy measurement (plan phase 12).
 *
 * The other similarity tests assert *behaviour*: that a given pair scores in a
 * given range. This file asserts nothing about any individual score. It measures
 * precision, recall, F1, the false-positive rate and the false-negative rate of
 * the whole pipeline against a corpus with known ground truth, and it is where
 * the similarity thresholds get their evidence.
 *
 * ## Read the numbers, do not admire them
 *
 * The floors asserted below are **the currently measured values**, recorded so
 * that a change in engine behaviour shows up as a diff in this file and forces a
 * conscious decision. They are not targets, and several of them are poor. Two
 * independent things are wrong, and the harness is deliberately built so that it
 * shows both rather than hiding one behind the other:
 *
 *  1. **Recall is incomplete, for a calibration reason rather than a search one.**
 *     The cross-file sweep used to be skipped whenever the focus block's own
 *     history yielded more than `CROSS_FILE_TRIGGER` accepted candidates — and
 *     those candidates were all same-file versions, which is exactly backwards.
 *     That is fixed. The renamed copy is now found. The *modified* copy is still
 *     missing, because it scores 0.535, below the 0.60 ignore floor, so it is
 *     never reported at all. The remaining gap is the weights, not the search.
 *
 *  2. **The aggregate score is dragged down by Jaccard**, which carries the
 *     largest weight (0.5) and is the most brittle signal for renamed code: a
 *     4-token shingle shatters on any structural edit. SimHash and shape both
 *     score 0.95-1.00 on the very pairs Jaccard rejects.
 *
 * The plan is explicit that the thresholds "must be experimentally validated; they
 * are not universal constants". This file is the start of that validation, and it
 * is not a finished one. Do not raise a floor here to make a run look better —
 * raise it when the engine genuinely improves, and say so in `CHANGELOG.md`.
 *
 * ## Corpus
 *
 * Built by `scripts/make-demo-repo.mjs`, which plants seven scenarios and — more
 * usefully — two **decoys**: functions with the same control-flow *shape* as the
 * focus block and nothing whatsoever to do with it. A matcher keying on syntax
 * rather than meaning reports the decoys as strong matches, so the false-positive
 * rate here is a real measurement and not a formality.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AnalysisEngine } from '../../src/analysis';
import { DEFAULT_CONFIG } from '../../src/config';
import type { AnalysisResult } from '../../src/types';

/** Is a usable `git` on the PATH? The whole suite is skipped without one. */
const hasGit =
  spawnSync('git', ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;

const FOCUS_FILE = 'src/auth.ts';
const FOCUS_NAME = 'validateToken';

/**
 * Ground truth.
 *
 * `positive` blocks are genuinely the same logic as the focus block, so failing to
 * report one is a false negative. `negative` blocks share its shape but not its
 * meaning, so reporting one is a false positive. Everything else the engine
 * returns is counted as a false positive too — an unexpected match is a false
 * positive whether or not we anticipated it.
 */
const POSITIVE: ReadonlyArray<{ file: string; name: string; why: string }> = [
  { file: 'src/legacy/validate.js', name: 'checkToken', why: 'renamed copy, variables renamed' },
  { file: 'src/security/token.ts', name: 'evaluateToken', why: 'modified copy' },
];

const NEGATIVE: ReadonlyArray<{ file: string; name: string; why: string }> = [
  { file: 'src/db/migrate.ts', name: 'runMigrations', why: 'same shape, unrelated meaning' },
  { file: 'src/db/pool.ts', name: 'settleConnection', why: 'same shape, unrelated meaning' },
];

/** Bands that count as "the engine claims these are related". */
const REPORTED = new Set(['strong', 'possible']);

interface Metrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
}

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'scripts', 'make-demo-repo.mjs'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate the project root from ' + __dirname);
}

/** Locate a function in the corpus without hard-coding a line number. */
function blockRange(
  dir: string,
  file: string,
  name: string,
): { startLine: number; endLine: number } {
  const absolute = path.join(dir, ...file.split('/'));
  const text = fs.readFileSync(absolute, 'utf8');
  const needle = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b|\\b${name}\\s*\\(`);
  const lines = text.split('\n');
  const start = lines.findIndex((line) => needle.test(line));
  if (start === -1) {
    throw new Error(`corpus is missing ${name} in ${file}`);
  }
  // Brace-match from the declaration to find the real end, so a selection that
  // covers the whole function is what the engine is asked about.
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i] ?? '') {
      if (char === '{') {
        depth += 1;
        seen = true;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (seen && depth <= 0) {
      return { startLine: start + 1, endLine: i + 1 };
    }
  }
  return { startLine: start + 1, endLine: start + 1 };
}

let dir: string;
let result: AnalysisResult;
let metrics: Metrics;
/** Every block the engine reported, mapped to `file :: name` for the failure report. */
let reported: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-accuracy-'));
  const built = spawnSync(
    process.execPath,
    [path.join(repoRoot(), 'scripts', 'make-demo-repo.mjs'), dir, '--force'],
    { shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (built.status !== 0) {
    throw new Error(`demo repo generation failed: ${built.stderr || built.stdout}`);
  }

  const engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
  const range = blockRange(dir, FOCUS_FILE, FOCUS_NAME);
  result = await engine.analyze({
    filePath: path.join(dir, ...FOCUS_FILE.split('/')),
    startLine: range.startLine,
    endLine: range.endLine,
  });
  engine.dispose();

  // `matches[].candidateBlockId` is a *block* id, so resolve it through the nodes
  // rather than assuming it is a node id — they are not the same namespace.
  const byBlockId = new Map(result.graph.nodes.map((node) => [node.blockId, node]));
  const label = (blockId: string): string => {
    const node = byBlockId.get(blockId);
    return node ? `${node.filePath} :: ${node.blockName}` : blockId;
  };

  reported = result.matches
    .filter((match) => REPORTED.has(match.classification))
    .map((match) => label(match.candidateBlockId));

  // GROUND TRUTH, in two tiers — conflating them is what makes a harness lie.
  //
  // Tier 1, `sameFileHistory`: the focus block and its own earlier versions in the
  // focus file. These are *supposed* to be reported; they are what walking history
  // is for. Counting them as false positives — as a naive "anything not in the
  // cross-file list" model does — makes a healthy engine score 0.00 precision.
  //
  // Tier 2, `crossFilePositives`: the renamed and modified copies in *other* files.
  // These are the capability the cross-file sweep exists for, so they are what
  // recall is measured against.
  //
  // Everything else reported is a false positive, including matches nobody
  // anticipated: an unexpected match is a false positive whether or not we have a
  // name for it.
  const sameFileHistory = new Set(
    result.graph.nodes
      .filter((node) => node.filePath === FOCUS_FILE && node.blockName === FOCUS_NAME)
      .map((node) => `${node.filePath} :: ${node.blockName}`),
  );
  const crossFilePositives = new Set(POSITIVE.map((p) => `${p.file} :: ${p.name}`));
  const expected = new Set([...sameFileHistory, ...crossFilePositives]);

  const truePositive = reported.filter((r) => expected.has(r)).length;
  const falsePositive = reported.filter((r) => !expected.has(r)).length;
  // Recall is scoped to the cross-file tier on purpose: same-file history recall is
  // a different question and is reported separately, because averaging the two
  // would let a strong same-file result mask a total cross-file miss.
  //
  // Counted per DISTINCT positive, not per reported entry. One copy of a function
  // legitimately appears once per commit it existed in, so a positive that was
  // found at three points in history is one success, not three — counting entries
  // would let recall exceed 1 and would reward a function for having a longer
  // history.
  const crossFileFound = POSITIVE.filter((p) => reported.includes(`${p.file} :: ${p.name}`)).length;
  const falseNegative = POSITIVE.length - crossFileFound;
  const trueNegative = NEGATIVE.filter((n) => !reported.includes(`${n.file} :: ${n.name}`)).length;

  const precision =
    truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
  const recall = POSITIVE.length === 0 ? 1 : crossFileFound / POSITIVE.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const falsePositiveRate =
    trueNegative + falsePositive === 0 ? 0 : falsePositive / (falsePositive + trueNegative);

  metrics = {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1,
    falsePositiveRate,
  };
}, 300_000);

afterAll(() => {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `skipIf` rather than an options object: the suite needs a conditional skip that
// is still typed `boolean`, and `skip: !hasGit && 'reason'` is a string|boolean
// union that `describe` does not accept.
describe.skipIf(!hasGit)('accuracy against the labelled corpus', () => {
  it('reports the confusion matrix for the focus block', () => {
    // Printed unconditionally: this file exists to publish numbers, and a metric
    // nobody sees is a metric nobody trusts.
    console.log(
      [
        '',
        '  Ancestry accuracy — validateToken vs the labelled corpus',
        `    reported          ${reported.length}`,
        `    true positive     ${metrics.truePositive}  (focus block + its own history, or a known copy)`,
        `    false positive    ${metrics.falsePositive}`,
        `    false negative    ${metrics.falseNegative}  (cross-file copies not found)`,
        `    true negative     ${metrics.trueNegative}  (decoys correctly rejected)`,
        `    precision         ${metrics.precision.toFixed(3)}`,
        `    cross-file recall ${metrics.recall.toFixed(3)}`,
        `    f1                ${metrics.f1.toFixed(3)}`,
        `    fp rate           ${metrics.falsePositiveRate.toFixed(3)}`,
        `    reported as       ${reported.join(' | ') || '(nothing)'}`,
        '',
      ].join('\n'),
    );
    expect(metrics.truePositive + metrics.falsePositive).toBe(reported.length);
  });

  it('does not report the shape-alike decoys as related', () => {
    // The single most valuable property: a matcher keying on syntax rather than
    // meaning fails here, and this assertion is what makes that visible.
    for (const decoy of NEGATIVE) {
      expect(reported).not.toContain(`${decoy.file} :: ${decoy.name}`);
    }
    expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.25);
  });

  it('reports only legitimate matches', () => {
    // PROVISIONAL — see the file header. Raise only when the engine improves.
    // Every reported candidate is either the focus block's own history or a known
    // copy; nothing unanticipated appears.
    expect(metrics.precision).toBeGreaterThanOrEqual(1);
    expect(metrics.falsePositive).toBe(0);
  });

  it('records the cross-file recall shortfall rather than hiding it', () => {
    // PROVISIONAL. The renamed copy is found; the modified copy is not, because it
    // scores 0.535 — below the 0.60 ignore floor — so it is never reported at all.
    // That is a *calibration* question (Jaccard's weight), not a search question:
    // the sweep now runs and does reach the file. The remaining recall work is
    // therefore about the weights and thresholds, not about the trigger.
    //
    // This assertion pins the current number so that any change shows up as a
    // deliberate, visible edit to this line rather than as a surprise.
    expect(metrics.recall).toBeGreaterThanOrEqual(0.5);
    expect(metrics.trueNegative).toBe(NEGATIVE.length);
  });
});
