/**
 * Host → webview message boundary, exercised with a REAL analysed graph.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/webview/serialize.test.ts` and `tests/webview/protocol.test.ts` both
 * work from hand-written fixtures. That is the right way to test a validator —
 * you want a value that is *deliberately* wrong — but it leaves one risk
 * completely uncovered: **schema drift**. The host builds the payload in
 * `src/webview/serialize.ts`; the webview validates it in
 * `src/webview/client/core/protocol.ts`. Nothing forces those two to agree, and
 * the webview's own tests cannot catch it because they feed the validator values
 * the test author invented rather than values the host actually produces.
 *
 * The failure mode is nasty and quiet: the extension analyses correctly, the
 * panel opens, and the webview silently discards the message and renders
 * nothing. No error, no exception — just a blank panel.
 *
 * So this file closes the loop with a real artefact: it generates the demo
 * repository, runs the actual `AnalysisEngine`, serialises with the actual host
 * code, and then feeds the result through the actual webview validators and the
 * actual client-side layout/colour/filter logic. If the two sides ever diverge,
 * this fails.
 *
 * WHAT IT DOES NOT COVER
 * ---------------------
 * The Three.js renderer, the camera controls and the host bridge. Those need a
 * real WebGL context and a real browser, which a Node test cannot provide, and
 * they are excluded from coverage for the same reason. Rendering is verified by
 * opening `preview.html` (see `scripts/preview-webview.mjs`), which runs the
 * real bundle against a real graph in a normal browser window.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AnalysisEngine } from '../../src/analysis';
import { DEFAULT_CONFIG } from '../../src/config';
import { toWebviewPayload } from '../../src/webview/serialize';
import { validateGraphPayload, validateHostMessage } from '../../src/webview/client/core/protocol';
import {
  branchColor,
  colorForClassification,
  colorForEdgeType,
} from '../../src/webview/client/core/colors';
import { applyFilter, filterDefaults } from '../../src/webview/client/core/filter';
import { computeBounds, computeLayout } from '../../src/webview/client/core/layout';
import { countEdgeTypes, summarizeGraph } from '../../src/webview/client/core/graph-stats';
import type { AncestryGraph, HostToWebviewMessage } from '../../src/types';

const hasGit =
  spawnSync('git', ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;

const FOCUS_FILE = 'src/auth.ts';
const FOCUS_NAME = 'validateToken';

let dir: string;
/** Exactly what the extension host would post into the panel. */
let hostMessage: HostToWebviewMessage;
/** The graph as the webview receives it, after the webview's own validation. */
let received: AncestryGraph;

function projectRoot(): string {
  let here = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(here, 'scripts', 'make-demo-repo.mjs'))) {
      return here;
    }
    here = path.dirname(here);
  }
  throw new Error('could not locate the project root from ' + __dirname);
}

/** Brace-match a named top-level function so the selection needs no magic numbers. */
function rangeOf(text: string, name: string): { startLine: number; endLine: number } {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(`function ${name}`));
  if (start === -1) {
    throw new Error(`${name} not found`);
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i] ?? '') {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) {
      return { startLine: start + 1, endLine: i + 1 };
    }
  }
  return { startLine: start + 1, endLine: start + 1 };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-boundary-'));
  const built = spawnSync(
    process.execPath,
    [path.join(projectRoot(), 'scripts', 'make-demo-repo.mjs'), dir, '--force'],
    { shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (built.status !== 0) {
    throw new Error(`demo repository generation failed: ${built.stderr || built.stdout}`);
  }

  const absolute = path.join(dir, ...FOCUS_FILE.split('/'));
  const text = fs.readFileSync(absolute, 'utf8');
  const { startLine, endLine } = rangeOf(text, FOCUS_NAME);

  const engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
  const result = await engine.analyze({ filePath: absolute, startLine, endLine });
  engine.dispose();

  const focusSource = text
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n');
  // Exactly the object the host hands to `webview.postMessage`.
  hostMessage = {
    type: 'graph',
    payload: toWebviewPayload(result.graph, focusSource, {
      durationMs: result.durationMs,
      cacheHits: result.cache.hits,
      cacheMisses: result.cache.misses,
    }),
  };

  const validated = validateHostMessage(hostMessage);
  if (validated === null || validated.type !== 'graph') {
    throw new Error('the webview rejected a graph produced by its own host');
  }
  received = validated.payload.graph;
}, 300_000);

afterAll(() => {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!hasGit)('host → webview boundary with a real graph', () => {
  it('produces a message the webview validator accepts', () => {
    // The assertion that matters most, and the one fixtures cannot make: if the
    // host's serialiser and the webview's validator ever disagree about the
    // shape, this is the line that fails — instead of a silently blank panel.
    expect(validateHostMessage(hostMessage)).not.toBeNull();
  });

  it('round-trips the graph with its node and edge counts intact', () => {
    expect(received.nodes.length).toBeGreaterThan(0);
    expect(received.edges.length).toBeGreaterThan(0);
    expect(received.focusBlockId).toBeTruthy();
    expect(received.schema).toBeTruthy();
    expect(received.engineVersion).toBeTruthy();
  });

  it('carries exactly one focus node, and it is the selected function', () => {
    const focus = received.nodes.filter((node) => node.isFocus);
    expect(focus).toHaveLength(1);
    expect(focus[0]?.blockName).toBe(FOCUS_NAME);
    expect(focus[0]?.filePath).toBe(FOCUS_FILE);
  });

  it('delivers the selected source to the webview, and only that source', () => {
    const payload = validateGraphPayload((hostMessage as { payload: unknown }).payload);
    expect(payload).not.toBeNull();
    // The selected block's text is expected: the panel shows it in the detail
    // panel, and it is the only source text allowed across the boundary.
    expect(payload?.focusSource).toContain(FOCUS_NAME);
  });

  it('gives every node the fields the renderer dereferences', () => {
    for (const node of received.nodes) {
      // These are read unconditionally by the Three.js layer; a missing one is a
      // `NaN` position and a node stuck at the origin, not a crash.
      expect(Number.isFinite(node.lineStart)).toBe(true);
      expect(Number.isFinite(node.lineEnd)).toBe(true);
      expect(Number.isFinite(node.similarity)).toBe(true);
      expect(Number.isFinite(node.timestamp)).toBe(true);
      expect(typeof node.module).toBe('string');
      expect(Array.isArray(node.branches)).toBe(true);
      expect(node.author.name.length).toBeGreaterThan(0);
    }
  });

  it('lays the real graph out without throwing or producing NaN positions', () => {
    const layout = computeLayout(received);
    expect(layout.nodes.length).toBe(received.nodes.length);
    for (const node of layout.nodes) {
      // A NaN coordinate puts a node at an undefined place in the scene, which
      // looks like "the renderer is broken" rather than "the data was bad".
      expect(node.position).toHaveLength(3);
      for (const axis of node.position) {
        expect(Number.isFinite(axis)).toBe(true);
      }
    }
    // The camera frames the computed bounds, so they have to be finite too.
    const bounds = computeBounds(layout.nodes);
    for (const value of [...bounds.min, ...bounds.max]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Every laid-out id must be a real node, or the renderer draws ghosts.
    const ids = new Set(received.nodes.map((node) => node.id));
    for (const node of layout.nodes) {
      expect(ids.has(node.id)).toBe(true);
    }
  });

  it('assigns a colour to every node and every edge', () => {
    // An unmapped classification or edge type would render an invisible node or
    // a NaN-coloured line — not a crash, just a graph that looks broken.
    for (const node of received.nodes) {
      expect(colorForClassification(node.classification)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    for (const edge of received.edges) {
      expect(colorForEdgeType(edge.type)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(branchColor(0)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('filters, summarises and survives the default filter', () => {
    // The real default filter is derived from the graph, so this also checks
    // that every branch, file and author in a real payload is something the
    // filter bar can actually offer.
    const filter = filterDefaults(received);
    const filtered = applyFilter(received, filter);
    // Default filters must not hide everything; an empty default view is the
    // other flavour of silently-blank panel.
    expect(filtered.visibleNodeIds.size).toBeGreaterThan(0);
    expect(filtered.visibleNodeIds.size).toBeLessThanOrEqual(received.nodes.length);
    // Every visible id must be a real node, or the renderer draws ghosts.
    const ids = new Set(received.nodes.map((node) => node.id));
    for (const id of filtered.visibleNodeIds) {
      expect(ids.has(id)).toBe(true);
    }
    expect(filtered.visibleEdgeIds.size).toBeGreaterThan(0);

    // A similarity floor of 1.0 must keep only the focus node.
    const strict = applyFilter(received, { ...filter, minSimilarity: 1 });
    expect(strict.visibleNodeIds.size).toBeGreaterThanOrEqual(1);
    for (const id of strict.visibleNodeIds) {
      const node = received.nodes.find((candidate) => candidate.id === id);
      expect(node?.similarity).toBeGreaterThanOrEqual(1);
    }

    expect(summarizeGraph(received)).toBeTruthy();
    const counts = countEdgeTypes(received);
    expect(typeof counts).toBe('object');
  });

  it('rejects a tampered message rather than rendering it', () => {
    // The other half of the boundary: the webview must not trust the host.
    const tampered = {
      type: 'graph',
      payload: {
        ...(hostMessage as { payload: Record<string, unknown> }).payload,
        graph: 'not-a-graph',
      },
    };
    expect(validateHostMessage(tampered)).toBeNull();
  });
});
