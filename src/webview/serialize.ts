/**
 * Graph → webview payload serialisation. **This is the security boundary.**
 *
 * WHY A DEDICATED, EXHAUSTIVE SANITISER
 * -------------------------------------
 * The webview is the only part of the extension that loads third-party bundled
 * code (a minified Three.js IIFE) and renders untrusted-shaped data. The CSP
 * stops it fetching anything and loading remote code, but it cannot stop a
 * malformed graph from producing a `NaN` coordinate, a 200 000-node scene that
 * freezes the panel, or a 10 MB string that has to be `textContent`-ed into the
 * DOM. `sanitizeGraph` is where all of that is stopped, once, for every entry
 * point (live analysis, JSON export, and the replay command reading a file
 * back off disk).
 *
 * Documented transformations, and why each one exists:
 *
 *  1. **Node/edge `id` must be a non-empty string.** `id` is the map key for the
 *     layout, the raycaster and every `Set` in the filter; a number, `null` or
 *     `undefined` there silently collapses distinct nodes into one. Nodes
 *     without a usable id are *dropped*, because there is nothing to display
 *     them by.
 *  2. **`filePath` must be a non-empty string.** The Z lane, the file filter and
 *     the breadcrumb all need it; a node with no path is not renderable.
 *  3. **`similarity`, `confidence` are clamped to [0, 1].** The domain model
 *     promises this range, but the value arrives from floating-point similarity
 *     maths and from disk. A value of `1.0000000004` would push a
 *     `toFixed`-free percentage label over 100% and, worse, break the
 *     `nodeScaleForSize` bounds the renderer relies on.
 *  4. **Non-finite numbers are dropped (replaced with 0 / null).** A single
 *     `NaN` timestamp poisons an entire `Math.min(...)` spread in the layout,
 *     producing `NaN` positions — and a `NaN` in a `BufferAttribute` makes
 *     WebGL drop the whole draw call, taking the entire scene with it.
 *  5. **Every string is length-capped.** Untrusted text reaches
 *     `textContent`; an uncapped string is a memory and layout hazard and lets a
 *     hostile graph push megabytes of text into the panel.
 *  6. **`classification`, `blockKind`, `language`, `edge.type` are whitelisted.**
 *     They index colour/size tables in `core/colors.ts`; an unknown value would
 *     be `undefined` and reach `new Color(undefined)`.
 *  7. **Node and edge counts are capped** (20 000 / 60 000) and the truncation
 *     is recorded in `graph.warnings`, so the user is told the picture is
 *     partial instead of silently believing it is complete.
 *  8. **Duplicate ids are dropped, dangling edges are dropped.** Ids must be
 *     unique for the layout map, and an edge whose endpoint is missing is
 *     unrenderable.
 *  9. **`author.name` / `author.email` are coerced to strings.** Commit metadata
 *     is genuinely allowed to be missing, so this coerces rather than drops.
 * 10. **Control characters are stripped from labels.** They are invisible in the
 *     DOM but can corrupt a single-line status bar or an axis tick.
 *
 * The function is total: for `null`, `undefined`, a string, a number, an array
 * or a cyclic object it returns a valid, empty `AncestryGraph` instead of
 * throwing. The host must never crash because a graph was odd.
 */

import type { AncestryGraph, WebviewGraphPayload } from '../types';
import { SCHEMA_URI } from '../types';
import { MAX_EDGES, MAX_FOCUS_SOURCE_LENGTH, MAX_NODES } from './client/core/domain';
import { validateGraph } from './client/core/protocol';

/** Engine statistics reported alongside the graph in the panel header. */
export interface RunStats {
  durationMs: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Coerces an arbitrary value into a valid, fully-populated `AncestryGraph`.
 *
 * Never throws. See the module comment for the full list of transformations.
 */
export function sanitizeGraph(graph: AncestryGraph): AncestryGraph {
  const warnings: string[] = [];
  const result = validateGraph(graph, { warnings, maxNodes: MAX_NODES, maxEdges: MAX_EDGES });
  // Fold the sanitiser's own diagnostics into the graph's warning list so a
  // user inspecting an exported file can see exactly what was dropped.
  const merged = [...result.graph.warnings, ...warnings].slice(0, 100);
  return { ...result.graph, warnings: merged };
}

/**
 * Builds the payload posted to the webview.
 *
 * `focusSource` is the *only* source text that ever crosses the boundary, and
 * only for the block the user explicitly selected. It is length-capped here as
 * well as in the validator: this function is the host's own code path, and
 * defence in depth costs nothing.
 */
export function toWebviewPayload(
  graph: AncestryGraph,
  focusSource: string,
  stats: RunStats,
): WebviewGraphPayload {
  const sanitized = sanitizeGraph(graph);
  return {
    graph: sanitized,
    focusSource: capText(focusSource, MAX_FOCUS_SOURCE_LENGTH),
    engineVersion: sanitized.engineVersion,
    stats: {
      durationMs: nonNegative(stats?.durationMs),
      cacheHits: nonNegative(stats?.cacheHits),
      cacheMisses: nonNegative(stats?.cacheMisses),
    },
  };
}

/**
 * Stable, pretty-printed JSON for the export command.
 *
 * "Stable" means: the sanitiser rebuilds every object with a fixed key order, so
 * exporting the same graph twice produces byte-identical files and the output
 * diffs cleanly in review. Two-space indentation is used because that is what
 * every code review tool and every "open in editor" path expects.
 */
export function graphToJson(graph: AncestryGraph): string {
  return JSON.stringify(sanitizeGraph(graph), null, 2);
}

/**
 * Parses a previously exported graph, for the replay command.
 *
 * Returns `null` — never throws, never returns a partially trusted object —
 * when the text is not JSON, when the parsed value is not an object, or when
 * `schema` is not {@link SCHEMA_URI}. A successful parse is still passed
 * through {@link sanitizeGraph}, so a hand-edited file cannot smuggle
 * unbounded or mistyped data into the webview.
 */
export function parseGraphJson(text: string): AncestryGraph | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (typeof schema !== 'string' || schema !== SCHEMA_URI) {
    return null;
  }
  return sanitizeGraph(parsed as AncestryGraph);
}

function capText(value: string, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/** Re-exported so callers can describe the payload's caps without a deep import. */
export { MAX_EDGES, MAX_NODES };
