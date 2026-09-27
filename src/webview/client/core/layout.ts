/**
 * Graph → 3D layout.
 *
 * AXIS DECISION (this is the single most important design choice in the module)
 * ---------------------------------------------------------------------------
 *   **X = time**, **Y = branch**, **Z = module**.
 *
 * - **X (time)** is a strictly linear function of the node's author timestamp
 *   over the graph's timestamp range. "Monotonically non-decreasing in
 *   timestamp" is a property the tests assert, because a non-monotonic time
 *   axis is the fastest way to make a lineage graph a lie.
 * - **Y (branch)** is the branch *only* — one row per distinct branch name. An
 *   earlier draft grouped rows by author as a secondary dimension; that was
 *   dropped because a commit reachable from 3 branches would then occupy 3 rows
 *   (or an arbitrary one), and with a linear branch axis that turned a clean
 *   horizontal timeline into a tangle. Author is still shown as a node colour /
 *   filter dimension and in the detail panel, which is where it is actually
 *   read. A node with no branch refs lands in the dedicated `(detached)` row,
 *   sorted last.
 * - **Z (module)** is `moduleForPath()` — the top-level directory (or the first
 *   two segments), alphabetically ordered so the lanes are stable between runs.
 *
 * Grouping is a *set* on the domain model but a *single cell* in the layout:
 * a node's row is chosen from one canonical branch (the lexicographically
 * smallest name, with `(detached)` sorting last) so every node occupies exactly
 * one (time, row, lane) slot and the axis stays readable.
 *
 * DETERMINISM: the only entropy is a hash of the node id, never `Math.random`.
 * Two calls with the same graph produce byte-identical output, which is what
 * lets the webview keep the camera still when a filter is toggled off and on.
 */

import type { AncestryEdge, AncestryEdgeType, AncestryGraph, AncestryNode } from '../../../types';
import { moduleForPath } from '../../../types';
import { branchColor } from './colors';
import { DETACHED_BRANCH, sanitizeLabel } from './domain';
import { DEFAULT_TIME_TICK_COUNT, generateTimeTicks, type TimeTick } from './timeline';

/** A node and its resolved world-space position. */
export interface LayoutNode {
  /** The `AncestryNode.id` this position belongs to. */
  id: string;
  /** `[x, y, z]` in world units. */
  position: [number, number, number];
}

/** One labelled row on the Y (branch) axis. */
export interface AxisRow {
  /** Display label, e.g. `main` or `(detached)`. */
  label: string;
  /** World-unit Y coordinate of the row. */
  value: number;
  /** Palette colour for the row, from `schemeTableau10`. */
  color: string;
}

/** One labelled lane on the Z (module) axis. */
export interface AxisLane {
  /** Display label, e.g. `src/webview`. */
  label: string;
  /** World-unit Z coordinate of the lane. */
  value: number;
}

/** Everything the renderer needs to draw the axis furniture and the labels. */
export interface AxisSpec {
  xLabel: string;
  yLabel: string;
  zLabel: string;
  xTicks: TimeTick[];
  yRows: AxisRow[];
  zLanes: AxisLane[];
}

/** Tunable spacing. All values are in world units. */
export interface LayoutOptions {
  /** X spacing between consecutive commit positions. Default 4. */
  xGap?: number;
  /** Y spacing between branch rows. Default 3. */
  yGap?: number;
  /** Z spacing between module lanes. Default 3. */
  zGap?: number;
  /** Radius of the ring used to separate same-slot nodes. Default 1.1. */
  jitter?: number;
  /** Extra Y offset applied to the origin node so it never hides in a cluster. Default 1.6. */
  originIsolation?: number;
}

/** The result of {@link computeLayout}. */
export interface LayoutResult {
  nodes: LayoutNode[];
  axis: AxisSpec;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

const DEFAULTS: Required<LayoutOptions> = {
  xGap: 4,
  yGap: 3,
  zGap: 3,
  jitter: 1.1,
  originIsolation: 1.6,
};

/** A world-space polyline (a straight line, or a sampled quadratic Bézier). */
export type EdgePolyline = Array<[number, number, number]>;

/** A laid-out edge, ready to be turned into `TubeGeometry`. */
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  type: AncestryEdgeType;
  /** Sampled centre-line in world units, ordered from child to parent. */
  curve: EdgePolyline;
}

/** Tunables for {@link computeEdgeCurves}. */
export interface EdgeCurveOptions {
  /**
   * How far the curve's control point is pushed away from the straight line,
   * as a fraction of the endpoint distance. 0.18 keeps sibling edges
   * distinguishable without turning the scene into a bowl of spaghetti.
   */
  readonly curvature?: number;
  /** Number of segments sampled per curve. Default 14. */
  readonly segments?: number;
}

/**
 * Computes the world-space layout of a graph.
 *
 * Handles the degenerate cases explicitly: an empty graph yields an empty node
 * list with zero bounds, and a single node sits at the origin. Both are
 * reachable in practice (a repository with one matching commit), and both used
 * to be a source of `NaN` leaking into the renderer's matrices.
 */
export function computeLayout(graph: AncestryGraph, options?: LayoutOptions): LayoutResult {
  const settings: Required<LayoutOptions> = { ...DEFAULTS, ...(options ?? {}) };
  const xGap = positiveOr(settings.xGap, DEFAULTS.xGap);
  const yGap = positiveOr(settings.yGap, DEFAULTS.yGap);
  const zGap = positiveOr(settings.zGap, DEFAULTS.zGap);
  const jitter = Math.max(0, finiteOr(settings.jitter, DEFAULTS.jitter));
  const originIsolation = finiteOr(settings.originIsolation, DEFAULTS.originIsolation);

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (nodes.length === 0) {
    return {
      nodes: [],
      axis: {
        xLabel: 'Time',
        yLabel: 'Branch',
        zLabel: 'Module',
        xTicks: [],
        yRows: [],
        zLanes: [],
      },
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
  }

  // --- X: time -------------------------------------------------------------
  const ordered = [...nodes].sort(compareNodesForLayout);
  const timestamps = ordered.map((node) => finiteTimestamp(node.timestamp));
  const tMin = Math.min(...timestamps);
  const tMax = Math.max(...timestamps);
  const distinctTimestamps = new Set(timestamps).size;
  const span = tMax - tMin;
  const xSpan = xGap * Math.max(1, distinctTimestamps - 1);

  const baseX = (node: AncestryNode): number => {
    const ts = finiteTimestamp(node.timestamp);
    if (span <= 0) {
      // Every node is at the same commit: fan them out along X by their stable
      // index so they remain individually addressable.
      return xGap * ordered.indexOf(node);
    }
    return (xSpan * (ts - tMin)) / span;
  };

  // --- Y: branch -----------------------------------------------------------
  const branchNames = collectBranches(nodes);
  const rowOf = new Map<string, number>();
  branchNames.forEach((name, index) => rowOf.set(name, index));
  const yOffset = (yGap * (branchNames.length - 1)) / 2;
  const baseY = (node: AncestryNode): number =>
    yGap * (rowOf.get(primaryBranch(node)) ?? 0) - yOffset;

  // --- Z: module -----------------------------------------------------------
  const moduleNames = collectModules(nodes);
  const laneOf = new Map<string, number>();
  moduleNames.forEach((name, index) => laneOf.set(name, index));
  const zOffset = (zGap * (moduleNames.length - 1)) / 2;
  const baseZ = (node: AncestryNode): number => zGap * (laneOf.get(moduleOf(node)) ?? 0) - zOffset;

  // --- Collision spreading -------------------------------------------------
  // Nodes that share a (commit, branch, module) cell would render as a single
  // blob. Group them and fan them out on a deterministic ring seeded by the
  // node id hash, so the arrangement is stable across runs and reloads.
  const slots = new Map<string, AncestryNode[]>();
  for (const node of ordered) {
    const key = slotKey(node);
    const bucket = slots.get(key);
    if (bucket === undefined) {
      slots.set(key, [node]);
    } else {
      bucket.push(node);
    }
  }

  const layoutNodes: LayoutNode[] = [];
  for (const node of ordered) {
    const cell = slots.get(slotKey(node));
    const x = baseX(node);
    let y = baseY(node);
    let z = baseZ(node);
    if (cell !== undefined && cell.length > 1 && jitter > 0) {
      const memberIndex = cell.indexOf(node);
      const angle = (2 * Math.PI * memberIndex) / cell.length + hashUnit(node.id) * Math.PI * 2;
      const radius = jitter * (0.6 + 0.4 * (memberIndex / Math.max(1, cell.length - 1)));
      y += Math.cos(angle) * radius;
      z += Math.sin(angle) * radius;
    }
    if (node.isOrigin && originIsolation !== 0) {
      y += originIsolation;
    }
    layoutNodes.push({ id: node.id, position: [round3(x), round3(y), round3(z)] });
  }

  const axis: AxisSpec = {
    xLabel: 'Time',
    yLabel: 'Branch',
    zLabel: 'Module',
    xTicks: generateTimeTicks(tMin, tMax, DEFAULT_TIME_TICK_COUNT),
    yRows: branchNames.map((name, index) => ({
      label: name,
      value: round3(yGap * index - yOffset),
      color: branchColor(index),
    })),
    zLanes: moduleNames.map((name, index) => ({
      label: name,
      value: round3(zGap * index - zOffset),
    })),
  };

  return { nodes: layoutNodes, axis, bounds: computeBounds(layoutNodes) };
}

/**
 * Computes curved polylines for a set of edges.
 *
 * Edges whose endpoints are missing from `nodes` are skipped rather than
 * emitted with `NaN` coordinates — a `NaN` in a `BufferAttribute` poisons the
 * whole draw call in WebGL, taking the entire scene down, so this guard is
 * load-bearing and not merely cosmetic.
 *
 * The curve is a quadratic Bézier whose control point is offset *perpendicular*
 * to the straight line by a small fraction of the endpoint distance. The
 * perpendicular direction is derived from the node id hashes so that two edges
 * between the same pair of points bow in *opposite* directions and stay
 * individually visible.
 */
export function computeEdgeCurves(
  nodes: readonly LayoutNode[],
  edges: readonly AncestryEdge[],
  options?: EdgeCurveOptions,
): Map<string, EdgePolyline> {
  const curvature = clampNumber(finiteOr(options?.curvature, 0.18), 0, 2);
  const segments = Math.max(2, Math.trunc(finiteOr(options?.segments, 14)));
  const positionById = new Map<string, [number, number, number]>();
  for (const node of nodes) {
    positionById.set(node.id, node.position);
  }
  const out = new Map<string, EdgePolyline>();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = positionById.get(edge.from);
    const to = positionById.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    out.set(edge.id, bezier(from, to, curvature, segments, hashUnit(edge.id)));
  }
  return out;
}

/** A world-space AABB around a set of laid-out nodes. */
export function computeBounds(nodes: readonly LayoutNode[]): {
  min: [number, number, number];
  max: [number, number, number];
} {
  if (nodes.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = node.position[axis];
      if (value < min[axis]!) {
        min[axis] = value;
      }
      if (value > max[axis]!) {
        max[axis] = value;
      }
    }
  }
  // A graph whose nodes are all on one plane (single branch) has zero extent
  // on one axis; nudge it by a hair so `fitToGraph` never divides by zero.
  for (let axis = 0; axis < 3; axis += 1) {
    if (min[axis]! === max[axis]!) {
      min[axis] = min[axis]! - 0.5;
      max[axis] = max[axis]! + 0.5;
    }
  }
  return { min, max };
}

/** The size of a bounding box, safe for a zero-extent input. */
export function boundsSize(bounds: {
  min: [number, number, number];
  max: [number, number, number];
}): [number, number, number] {
  return [
    Math.max(0.001, bounds.max[0] - bounds.min[0]),
    Math.max(0.001, bounds.max[1] - bounds.min[1]),
    Math.max(0.001, bounds.max[2] - bounds.min[2]),
  ];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** The branch rows, sorted, with `(detached)` forced last. */
function collectBranches(nodes: readonly AncestryNode[]): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const branch of node.branches) {
      if (branch.length > 0) {
        seen.add(sanitizeLabel(branch) || DETACHED_BRANCH);
      }
    }
    if (node.branches.length === 0) {
      seen.add(DETACHED_BRANCH);
    }
  }
  return [...seen].sort(compareRowLabels);
}

/** The module lanes, sorted alphabetically (code-unit order, locale-free). */
function collectModules(nodes: readonly AncestryNode[]): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(moduleOf(node));
  }
  return [...seen].sort(compareRowLabels);
}

/**
 * The single branch a node is assigned to.
 *
 * The domain model exposes a *set* of branches; a linear axis needs one cell.
 * The lexicographically smallest name wins (with `(detached)` last) so the
 * choice is stable no matter what order git reports refs in.
 */
function primaryBranch(node: AncestryNode): string {
  let best: string | null = null;
  for (const branch of node.branches) {
    const label = sanitizeLabel(branch);
    if (label.length === 0) {
      continue;
    }
    if (best === null || compareRowLabels(label, best) < 0) {
      best = label;
    }
  }
  return best ?? DETACHED_BRANCH;
}

/** The Z-axis lane a node is assigned to. */
function moduleOf(node: AncestryNode): string {
  const fromPath = node.filePath.length > 0 ? moduleForPath(node.filePath) : '';
  if (fromPath.length > 0 && fromPath !== '<root>') {
    return fromPath;
  }
  if (node.module.length > 0) {
    return sanitizeLabel(node.module);
  }
  return fromPath.length > 0 ? fromPath : '<root>';
}

/**
 * The (commit, branch, module) cell a node occupies.
 *
 * The parts are joined with U+001F (the ASCII unit separator) rather than a
 * space or a slash: branch names and paths are user data and may legitimately
 * contain either, and a collision here would merge two unrelated cells and
 * jitter the wrong pair of nodes apart.
 */
function slotKey(node: AncestryNode): string {
  return `${finiteTimestamp(node.timestamp)}\u001f${primaryBranch(node)}\u001f${moduleOf(node)}`;
}

/**
 * Stable ordering for node positions: timestamp, then commit, then id. Only
 * used where the layout needs a deterministic sequence (the same-commit fan
 * out and the jitter ring), never for rendering order.
 */
function compareNodesForLayout(a: AncestryNode, b: AncestryNode): number {
  const byTime = finiteTimestamp(a.timestamp) - finiteTimestamp(b.timestamp);
  if (byTime !== 0) {
    return byTime;
  }
  const byCommit = compareText(a.commit, b.commit);
  if (byCommit !== 0) {
    return byCommit;
  }
  return compareText(a.id, b.id);
}

/**
 * Sorts row/lane labels: code-unit order, but `(detached)` always last so the
 * "no branch" row never floats to the top of the axis.
 */
function compareRowLabels(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === DETACHED_BRANCH) {
    return 1;
  }
  if (b === DETACHED_BRANCH) {
    return -1;
  }
  return a < b ? -1 : 1;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * A deterministic value in `[0, 1)` derived from a string (FNV-1a).
 *
 * Used to seed jitter angles and curve bowing. `Math.random()` is forbidden
 * here: a re-render with the same graph must place the nodes identically.
 */
function hashUnit(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // 2^32 → [0, 1)
  return (hash >>> 0) / 0x100000000;
}

function bezier(
  from: [number, number, number],
  to: [number, number, number],
  curvature: number,
  segments: number,
  seed: number,
): EdgePolyline {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(distance > 0)) {
    // Coincident endpoints: a straight, zero-length segment is still a valid
    // renderable geometry and avoids dividing by zero below.
    return [from.slice() as [number, number, number], to.slice() as [number, number, number]];
  }
  // A stable perpendicular direction: rotate the segment vector 90° about the
  // time axis. Rotating about X keeps the bow inside the (Y, Z) plane, which is
  // where the branch and module dimensions live — exactly where the edges need
  // to be separated from each other.
  const bow = curvature * distance;
  const sign = seed < 0.5 ? -1 : 1;
  const control: [number, number, number] = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2 + sign * bow,
    (from[2] + to[2]) / 2 + sign * bow * 0.5,
  ];
  const points: EdgePolyline = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const inv = 1 - t;
    points.push([
      inv * inv * from[0] + 2 * inv * t * control[0] + t * t * to[0],
      inv * inv * from[1] + 2 * inv * t * control[1] + t * t * to[1],
      inv * inv * from[2] + 2 * inv * t * control[2] + t * t * to[2],
    ]);
  }
  return points;
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
