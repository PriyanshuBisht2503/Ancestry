/**
 * Colour and size decisions for the 3D scene.
 *
 * WHY A DEDICATED MODULE: every colour in the visualisation is a *semantic*
 * promise to the reader — "warm means this block was duplicated", "white means
 * this is the block you selected". Scattering those hex literals through the
 * renderer would make the legend and the scene drift apart, so the mapping
 * lives here, is pure, and is unit tested.
 *
 * The palette is chosen for the VS Code dark theme first (the default for a
 * visualisation of this density) but every colour is also legible against the
 * light theme, because all of them sit on the editor background which follows
 * the user's theme.
 */

import { schemeTableau10 } from 'd3-scale-chromatic';
import type { AncestryEdgeType, AncestryNode, MatchClassification } from '../../../types';

/**
 * Edge colours.
 *
 * Rationale, documented so nobody "tidies" them into an arbitrary order:
 *  - `EVOLVED_FROM` — blue. The overwhelmingly common case: the same construct
 *    refined over time. Cool and recessive so the *shape* of the lineage reads
 *    first and a wall of blue does not shout.
 *  - `MODIFIED_FROM` — cool grey. A sibling of "evolved" but deliberately
 *    desaturated: a modification is a weaker claim about identity than a clean
 *    evolution, so it should not compete with it.
 *  - `MOVED_FROM` — green. "This did not change, it changed address." Green is
 *    reserved for relocation, which is the one event where the file/module
 *    dimension (Z) changes without the code changing.
 *  - `COPIED_FROM` — orange. Duplication is a *fork*: two lineages from one
 *    point. Warm hues read as "branching out" and orange is maximally far from
 *    the cool pair above in hue.
 *  - `MERGED_FROM` — violet. Convergence is the opposite of a fork, so it gets
 *    the hue the two forks do not: distinct from blue, grey, green and orange
 *    even for the most common forms of colour-vision deficiency, because it
 *    differs in hue *and* saturation from all four.
 */
const EDGE_COLORS: Readonly<Record<AncestryEdgeType, string>> = Object.freeze({
  EVOLVED_FROM: '#4d8bf5',
  MODIFIED_FROM: '#9aa7b8',
  MOVED_FROM: '#3fb950',
  COPIED_FROM: '#e0662e',
  MERGED_FROM: '#a371f7',
});

/**
 * The focus node's colour: **pure white** (`#ffffff`).
 *
 * It is the only pure-white element in the scene, so it is unmistakable even
 * when it is behind twenty other nodes or inside a dense cluster. The renderer
 * additionally draws a pulsing ring around it, so colour is never the only cue.
 */
const FOCUS_COLOR = '#ffffff';

/**
 * The origin node's colour: **aqua** (`#00ffc8`).
 *
 * Chosen to be a maximum-luminance aqua so it is unmistakable against the
 * blue `EVOLVED_FROM` edges (which it is frequently attached to) and against
 * the green `MOVED_FROM` edges, and it is paired with a distinct wireframe
 * cage in the renderer so the two "special" nodes are separable in a
 * greyscale screenshot.
 */
const ORIGIN_COLOR = '#00ffc8';

/**
 * Fallback node colour for a node that is neither focus nor origin: derived
 * from its match classification, so the *bulk* of the scene still carries
 * information (how confident the analysis was) without needing a label.
 */
const CLASSIFICATION_COLORS: Readonly<Record<MatchClassification, string>> = Object.freeze({
  strong: '#2ecc71',
  possible: '#f1c40f',
  weak: '#e67e22',
  unrelated: '#7f8c8d',
});

/** Smallest node radius, in world units. */
const MIN_NODE_SCALE = 0.18;

/** Largest node radius, in world units. */
const MAX_NODE_SCALE = 1.6;

/**
 * Per-kind radius multiplier. A whole class is drawn larger than a method,
 * because "this class appeared" is a bigger event than "this method moved
 * between methods", and the eye reads size as importance.
 */
const KIND_SCALE: Readonly<Record<AncestryNode['blockKind'], number>> = Object.freeze({
  class: 1.25,
  namespace: 1.2,
  interface: 1.15,
  enum: 1.12,
  type: 1.1,
  'type-alias': 1.1,
  constructor: 1.08,
  function: 1,
  'arrow-function': 0.95,
  method: 0.95,
  variable: 0.9,
  'object-literal': 0.9,
  block: 0.85,
  unknown: 1,
});

/** Valid `#rgb` / `#rrggbb` shapes, lowercased by the caller. */
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** The categorical branch palette (Tableau 10), frozen for determinism. */
const BRANCH_PALETTE: readonly string[] = Object.freeze([...schemeTableau10]);

/**
 * Returns the colour for an edge type.
 *
 * Exhaustive by construction: `AncestryEdgeType` has exactly five members and
 * the record is keyed by all five, so adding a sixth to the frozen model is a
 * compile error here rather than an undefined colour at runtime.
 */
export function colorForEdgeType(type: AncestryEdgeType): string {
  return EDGE_COLORS[type];
}

/** Returns the colour for a match classification. */
export function colorForClassification(c: MatchClassification): string {
  return CLASSIFICATION_COLORS[c];
}

/**
 * Returns the colour for a node.
 *
 * Precedence is focus > origin > classification. The focus node is what the
 * user explicitly asked about and the origin is the most surprising finding
 * (the earliest ancestor), so those two must survive any re-classification the
 * engine performs.
 */
export function colorForNode(node: AncestryNode): string {
  if (node.isFocus) {
    return FOCUS_COLOR;
  }
  if (node.isOrigin) {
    return ORIGIN_COLOR;
  }
  return colorForClassification(node.classification);
}

/**
 * Deterministic cyclic palette lookup for a branch row index.
 *
 * Uses d3's `schemeTableau10` rather than a hand-rolled list so that the branch
 * colours are perceptually spaced and remain distinguishable past ten branches
 * (the palette wraps, which is documented in the legend as "colour repeats when
 * there are more than ten branches").
 */
export function branchColor(index: number): string {
  if (!Number.isFinite(index) || BRANCH_PALETTE.length === 0) {
    return BRANCH_PALETTE[0] ?? '#7f7f7f';
  }
  const wrapped = Math.trunc(index) % BRANCH_PALETTE.length;
  return BRANCH_PALETTE[wrapped < 0 ? wrapped + BRANCH_PALETTE.length : wrapped] ?? '#7f7f7f';
}

/** The number of distinct colours in the branch palette. */
export const BRANCH_PALETTE_SIZE = BRANCH_PALETTE.length;

/**
 * Computes a node's radius in world units.
 *
 * Three factors, in order of importance:
 *  1. `isFocus` (×1.3) and `isOrigin` (×1.2) so the two anchor nodes stay
 *     clickable when the scene is zoomed out to the whole repository;
 *  2. the block kind, so a class reads as a bigger event than a method;
 *  3. similarity to the focus block, compressed to `[0.8, 1.25]` so the size
 *     cue helps without the low-similarity tail collapsing into invisibility.
 *
 * Always positive and always ≤ {@link MAX_NODE_SCALE}: the renderer sizes
 * instanced geometry from this and a zero or negative radius would silently
 * drop the node from the scene.
 */
export function nodeScaleForSize(node: AncestryNode): number {
  const similarity = Number.isFinite(node.similarity) ? node.similarity : 0;
  const similarityScale = 0.8 + 0.45 * Math.min(1, Math.max(0, similarity));
  const kindScale = KIND_SCALE[node.blockKind] ?? 1;
  const anchorScale = node.isFocus ? 1.3 : node.isOrigin ? 1.2 : 1;
  const raw = 0.35 * similarityScale * kindScale * anchorScale;
  const bounded = Math.min(MAX_NODE_SCALE, Math.max(MIN_NODE_SCALE, raw));
  return round3(bounded);
}

/**
 * Line opacity for an edge, from its endpoint similarity.
 *
 * A near-zero-similarity edge is a *guess*; drawing it as opaque would assert
 * a relationship the engine is not sure about. Mapping `[0,1] → [0.2,1]` keeps
 * even a weak guess visible (the user asked to see the whole lineage) while
 * making the confident edges visually dominant.
 */
export function edgeOpacityFor(similarity: number): number {
  const value = Number.isFinite(similarity) ? Math.min(1, Math.max(0, similarity)) : 0;
  return round3(0.2 + 0.8 * value);
}

/**
 * Converts a hex colour to `rgba()` with a clamped alpha.
 *
 * Throws on malformed input rather than silently substituting a colour: this
 * function is only ever called with literals from this module or with values
 * already produced by {@link colorForEdgeType}, so a failure here is a
 * programming error that must surface loudly instead of quietly producing an
 * invisible edge.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (typeof hex !== 'string' || !HEX_PATTERN.test(hex.toLowerCase())) {
    throw new TypeError(`withAlpha: expected #rgb or #rrggbb, received "${String(hex)}"`);
  }
  const normalized = hex.toLowerCase();
  const full =
    normalized.length === 4
      ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
      : normalized;
  const red = Number.parseInt(full.slice(1, 3), 16);
  const green = Number.parseInt(full.slice(3, 5), 16);
  const blue = Number.parseInt(full.slice(5, 7), 16);
  const safeAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  return `rgba(${red}, ${green}, ${blue}, ${round3(safeAlpha)})`;
}

/** True when `value` is a `#rgb` or `#rrggbb` string. */
export function isHexColor(value: string): boolean {
  return typeof value === 'string' && HEX_PATTERN.test(value.toLowerCase());
}

/** Rounds to three decimals — keeps generated DOM/CSS free of float noise. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** All five edge colours, keyed by type; handy for legends and tests. */
export const EDGE_COLOR_TABLE: Readonly<Record<AncestryEdgeType, string>> = EDGE_COLORS;

/** All four classification colours, keyed by classification. */
export const CLASSIFICATION_COLOR_TABLE: Readonly<Record<MatchClassification, string>> =
  CLASSIFICATION_COLORS;

/** The exact focus-node colour, exported so the legend can state it. */
export const FOCUS_NODE_COLOR = FOCUS_COLOR;

/** The exact origin-node colour, exported so the legend can state it. */
export const ORIGIN_NODE_COLOR = ORIGIN_COLOR;
