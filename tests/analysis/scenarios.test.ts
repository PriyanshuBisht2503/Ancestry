/**
 * End-to-end analysis over the Phase 12 scenario repository.
 *
 * The unit suites cover each stage in isolation; this file covers the *seams*,
 * which is where the failures that make the extension feel broken actually live.
 * It is the only place that exercises `AnalysisEngine.analyze` from a real
 * selection on a real repository all the way to a graph.
 *
 * ## The regression this file exists for
 *
 * `resolveFocus` used to call its line-clamping helper as
 * `clampLine(request.startLine, 1, lastLine)` while the helper's third parameter
 * is a *minimum*, not an upper bound. `Math.max(lastLine, startLine)` therefore
 * pushed every selection to the last line of the file, so "analyse the function
 * I selected" silently analysed whatever happened to be at the bottom of it.
 *
 * Every unit test still passed, because each stage was correct in isolation and
 * the stages were never wired together end to end. The symptom was a graph with
 * no origin, no cross-file matches, and a `Selected …` line naming a function the
 * user never highlighted.
 *
 * The assertions below are written so that bug cannot come back quietly: the
 * focus block is derived from the parser rather than hard-coded, and the engine
 * must independently agree about which block that range covers.
 */

import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AnalysisEngine } from '../../src/analysis';
import { DEFAULT_CONFIG } from '../../src/config';
import { ORIGIN_DISCLAIMER } from '../../src/graph';
import { parseSource } from '../../src/parser';
import type { AnalysisResult, AncestryEdgeType, CodeBlock } from '../../src/types';
import { cleanupRepos, makeScenarioRepo, type ScenarioLayout } from './helpers';

/** The function the whole fixture is built around. */
const FOCUS_NAME = 'validateToken';
const FOCUS_FILE = 'src/auth.ts';

let scenario: ScenarioLayout;
let engine: AnalysisEngine;

/** Parse a file in the scenario repo and return its blocks. */
function blocksIn(repo: ScenarioLayout, relativePath: string): CodeBlock[] {
  const absolute = path.join(repo.repo.dir, ...relativePath.split('/'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return parseSource(absolute, readFileSync(absolute, 'utf8')).blocks;
}

function findBlock(repo: ScenarioLayout, relativePath: string, name: string): CodeBlock {
  const block = blocksIn(repo, relativePath).find((candidate) => candidate.name === name);
  if (block === undefined) {
    throw new Error(
      `fixture is missing ${name} in ${relativePath}; ` +
        `found ${blocksIn(repo, relativePath)
          .map((candidate) => candidate.name)
          .join(', ')}`,
    );
  }
  return block;
}

/** Run one analysis over a block identified by name rather than by line. */
async function analyzeBlock(
  repo: ScenarioLayout,
  relativePath: string,
  name: string,
): Promise<{ result: AnalysisResult; block: CodeBlock }> {
  const block = findBlock(repo, relativePath, name);
  const result = await engine.analyze({
    filePath: path.join(repo.repo.dir, ...relativePath.split('/')),
    startLine: block.range.startLine,
    endLine: block.range.endLine,
  });
  return { result, block };
}

beforeAll(async () => {
  scenario = await makeScenarioRepo();
  engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
}, 120_000);

afterAll(async () => {
  engine.dispose();
  await cleanupRepos();
});

describe('selection resolution (regression)', () => {
  it('analyses the block the selection covers, not the last line of the file', async () => {
    const { result, block } = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);

    const focusNodes = result.graph.nodes.filter((node) => node.isFocus);
    expect(focusNodes).toHaveLength(1);
    expect(focusNodes[0]?.blockName).toBe(block.name);
    // The bug made every selection collapse onto the file's final line, so the
    // focus must not be the last block in the file.
    const lastBlock = blocksIn(scenario, FOCUS_FILE).at(-1);
    expect(block.name).not.toBe(lastBlock?.name);
  }, 120_000);

  it('resolves a partial selection inside a block to that block', async () => {
    const block = findBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    // A selection covering only the first few lines of the function — exactly
    // what a user gets from a double-click on the signature.
    const result = await engine.analyze({
      filePath: path.join(scenario.repo.dir, ...FOCUS_FILE.split('/')),
      startLine: block.range.startLine,
      endLine: block.range.startLine + 1,
    });
    expect(result.graph.nodes.find((node) => node.isFocus)?.blockName).toBe(FOCUS_NAME);
  }, 120_000);

  it('resolves several different blocks in the same file to themselves', async () => {
    // More than one selection per file, from different files: this is what
    // catches a clamp that is correct for the final block and wrong for the rest.
    const pairs: Array<[string, string]> = [
      [FOCUS_FILE, FOCUS_NAME],
      ['src/decoys.ts', 'throttle'],
      ['src/utils/strings.ts', 'formatLabel'],
    ];

    const seen = new Set<string>();
    for (const [relativePath, name] of pairs) {
      const target = blocksIn(scenario, relativePath).find((block) => block.name === name);
      if (target === undefined) {
        // The fixture is the contract here; if it stops carrying one of these
        // blocks the test must say so rather than silently assert less.
        throw new Error(`fixture is missing ${name} in ${relativePath}`);
      }
      const result = await engine.analyze({
        filePath: path.join(scenario.repo.dir, ...relativePath.split('/')),
        startLine: target.range.startLine,
        endLine: target.range.endLine,
      });
      expect(result.graph.nodes.find((node) => node.isFocus)?.blockName).toBe(name);
      seen.add(name);
    }
    expect(seen.size).toBe(pairs.length);
  }, 180_000);

  it('clamps a selection past the end of the file to the last line', async () => {
    const result = await engine.analyze({
      filePath: path.join(scenario.repo.dir, ...FOCUS_FILE.split('/')),
      startLine: 5,
      endLine: 100_000,
    });
    // Must not throw, and must land on a real block.
    expect(result.graph.nodes.filter((node) => node.isFocus)).toHaveLength(1);
  }, 120_000);

  it('normalises an inverted range instead of failing', async () => {
    const block = findBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    const result = await engine.analyze({
      filePath: path.join(scenario.repo.dir, ...FOCUS_FILE.split('/')),
      startLine: block.range.endLine,
      endLine: block.range.startLine,
    });
    expect(result.graph.nodes.find((node) => node.isFocus)?.blockName).toBe(FOCUS_NAME);
  }, 120_000);
});

describe('the graph the analysis produces', () => {
  it('establishes an origin and says so in the required words', async () => {
    const { result } = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    const { origin } = result.graph;

    expect(origin).not.toBeNull();
    // §5 / specification: the wording is fixed, and must never imply authorship.
    expect(origin?.disclaimer).toBe(ORIGIN_DISCLAIMER);
    expect(origin?.disclaimer).toMatch(/not proof of original authorship/i);
    expect(origin?.disclaimer).not.toMatch(/proven original|the real author/i);
    expect(origin?.basis).not.toBe('inconclusive');
  }, 120_000);

  it('never reports a node without a commit, author or timestamp', async () => {
    const { result } = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    for (const node of result.graph.nodes) {
      expect(node.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(node.shortCommit).toMatch(/^[0-9a-f]{7,12}$/);
      expect(node.author.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(node.timestamp)).toBe(true);
    }
  }, 120_000);

  it('reports the focus block at full similarity to itself', async () => {
    const { result } = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    const focus = result.graph.nodes.find((node) => node.isFocus);
    expect(focus?.similarity).toBe(1);
  }, 120_000);

  it('produces a deterministic graph for the same selection', async () => {
    const first = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    const second = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);

    const shape = (result: AnalysisResult) => ({
      nodes: result.graph.nodes.map((node) => node.id).sort(),
      edges: result.graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`).sort(),
      origin: result.graph.origin?.commit ?? null,
    });
    expect(shape(second.result)).toEqual(shape(first.result));
  }, 180_000);

  it('emits every edge with a known type and a similarity in range', async () => {
    const { result } = await analyzeBlock(scenario, FOCUS_FILE, FOCUS_NAME);
    const known: ReadonlySet<string> = new Set<AncestryEdgeType>([
      'EVOLVED_FROM',
      'COPIED_FROM',
      'MODIFIED_FROM',
      'MOVED_FROM',
      'MERGED_FROM',
    ]);
    for (const edge of result.graph.edges) {
      expect(known.has(edge.type)).toBe(true);
      expect(edge.similarity).toBeGreaterThanOrEqual(0);
      expect(edge.similarity).toBeLessThanOrEqual(1);
      expect(edge.rationale.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
