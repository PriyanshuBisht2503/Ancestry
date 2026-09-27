/**
 * The React ↔ Three.js boundary.
 *
 * ============================ READ THIS FIRST ============================
 * THE RULE: **React must never re-render the 3D scene.**
 *
 * This is the mistake every React + Three.js project makes at least once, and
 * the symptoms are so specific that it is worth writing down:
 *
 *  1. "Let me put the nodes in state so the UI can react to them." → every
 *     camera frame now allocates, diffs and reconciles a 20 000-element array.
 *     The frame budget goes and the whole panel becomes unusable.
 *  2. "I'll just call `renderer.setGraph(...)` from the component body." → the
 *     renderer is rebuilt on every render, so a drag that re-renders (because a
 *     hover changed a status string) tears down the WebGL context mid-gesture.
 *  3. "I'll pass the graph down as props and let a `useEffect` handle it." →
 *     right, but with `[]` deps on the *mount* effect only; every other effect
 *     must be keyed on exactly the one prop it consumes, or it fires on every
 *     render and the scene thrashes.
 *
 * So this component is built the boring way, deliberately:
 *
 *  - the imperative {@link AncestryRenderer} is constructed **once**, in a
 *    `useEffect` with `[]` dependencies, and disposed on unmount;
 *  - the scene graph is never React state — it lives in the renderer's maps and
 *    in `core/layout.ts`;
 *  - each subsequent update is a **separate** effect keyed on exactly the props
 *    it reads, so a hover string changing cannot rebuild a single mesh;
 *  - the React tree below the stage (legend, filters, details, list) is free to
 *    re-render as often as it likes; none of it is in the frame loop.
 *
 * There is one further subtlety. The renderer runs its own `requestAnimationFrame`
 * loop and calls `onLabels` with freshly projected screen positions for every
 * visible node, on every frame the camera moves. Turning that into React state
 * would be 400 re-renders per frame during a drag, so the label layer is
 * *also* imperative: a `Map<string, HTMLDivElement>` owned by a ref, positioned
 * with `style.transform`, and reconciled by hand. It is the one piece of the
 * document React does not own, and it is a flat, append-only, unkeyed
 * collection of divs inside a container React renders with **no children** — so
 * React's reconciler never looks at them.
 * =======================================================================
 *
 * XSS POSTURE: the label text is written with `textContent`, exactly as the
 * pre-React `panel.ts` did. It is never concatenated into markup.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { AncestryGraph } from '../../../types';
import { emptyGraph } from '../core/protocol';
import { nodeById } from '../core/graph-stats';
import type { AxisSpec, LayoutNode } from '../core/layout';
import { AncestryRenderer, type ProjectedLabel } from '../renderer';
import type { FocusRequest } from './graphState';

/** An empty axis, used to clear the scene when the graph goes away. */
const EMPTY_AXIS: AxisSpec = {
  xLabel: 'Time',
  yLabel: 'Branch',
  zLabel: 'Module',
  xTicks: [],
  yRows: [],
  zLanes: [],
};

/** Shared empty sets, so an effect keyed on them does not fire every render. */
const EMPTY_NODE_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_EDGE_IDS: ReadonlySet<string> = new Set<string>();

/** Props for {@link GraphCanvas}. Every one of them drives exactly one effect. */
export interface GraphCanvasProps {
  /** The graph to draw, or `null` before the first payload arrives. */
  readonly graph: AncestryGraph | null;
  /** The laid-out node positions, from `core/layout.ts`. */
  readonly nodes: readonly LayoutNode[];
  /** The axis furniture, from `core/layout.ts`. */
  readonly axis: AxisSpec | null;
  /** Which nodes pass the current filter. */
  readonly visibleNodeIds: ReadonlySet<string> | null;
  /** Which edges pass the current filter. */
  readonly visibleEdgeIds: ReadonlySet<string> | null;
  /** The selected node, drawn with a ring. */
  readonly selectedId: string | null;
  /** Nodes the host asked to highlight. */
  readonly highlightIds: readonly string[];
  /** The `1` shortcut. */
  readonly labelsEnabled: boolean;
  /** The `2` shortcut. */
  readonly edgesEnabled: boolean;
  /** Bumped by the `f` shortcut and on a graph with no focus node. */
  readonly fitToken: number;
  /** A one-shot camera flight, from a `focus` message or a new graph. */
  readonly focusRequest: FocusRequest | null;
  /** Describes the scene to assistive technology. */
  readonly ariaLabel: string;
  /** A node was clicked, or the click hit empty space. */
  readonly onSelect: (nodeId: string | null) => void;
  /** The hovered node changed. */
  readonly onHover: (nodeId: string | null) => void;
  /** Overlays rendered inside the stage, above the canvas. */
  readonly children?: ReactNode;
}

/**
 * Mounts the imperative Three.js renderer and forwards prop changes to it.
 *
 * The component renders three elements and never re-renders them: the stage, the
 * container the renderer puts its canvas in, and the label layer.
 */
export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const graphRef = useRef<AncestryGraph | null>(null);
  const rendererRef = useRef<AncestryRenderer | null>(null);
  const onSelectRef = useRef(props.onSelect);
  const onHoverRef = useRef(props.onHover);

  // Keep the callbacks fresh without re-running the mount effect. Reading them
  // through a ref is what lets the renderer be built once and for all: a
  // `onSelect` prop that changed identity must not tear down the WebGL context.
  useEffect(() => {
    onSelectRef.current = props.onSelect;
  }, [props.onSelect]);
  useEffect(() => {
    onHoverRef.current = props.onHover;
  }, [props.onHover]);

  // --- mount once -----------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return undefined;
    }
    const renderer = new AncestryRenderer({
      container: host,
      onSelect: (nodeId) => onSelectRef.current(nodeId),
      onHover: (nodeId) => onHoverRef.current(nodeId),
      onLabels: (projected) => {
        paintLabels(projected, labelsRef.current, labelLayerRef.current, graphRef.current);
      },
    });
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
      renderer.dispose();
      for (const element of labelsRef.current.values()) {
        element.remove();
      }
      labelsRef.current.clear();
    };
  }, []);

  const { graph, nodes, axis, visibleNodeIds, visibleEdgeIds } = props;

  // --- a new graph means a full scene rebuild -------------------------------
  // Declared *before* the filter effect on purpose: React runs effects in
  // declaration order within a commit, so on the commit where both change, the
  // nodes exist before the filter tries to show a subset of them. A full
  // `rebuildNodes` is the expensive one (one mesh per node); it must not run for
  // a filter change, which is why it does not depend on the visible sets.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) {
      return;
    }
    graphRef.current = graph;
    if (graph === null || axis === null || nodes.length === 0) {
      renderer.setGraph(emptyGraph(), [], EMPTY_NODE_IDS, EMPTY_EDGE_IDS, EMPTY_AXIS);
      return;
    }
    // All nodes are built and then immediately narrowed by the filter effect
    // below; edges are left to the filter effect, which is the only thing that
    // ever changes them.
    renderer.setGraph(
      graph,
      nodes,
      new Set(graph.nodes.map((node) => node.id)),
      EMPTY_EDGE_IDS,
      axis,
    );
  }, [graph, nodes, axis]);

  // --- a filter change is a visibility toggle, not a rebuild -----------------
  useEffect(() => {
    rendererRef.current?.setFilter(
      visibleNodeIds ?? EMPTY_NODE_IDS,
      visibleEdgeIds ?? EMPTY_EDGE_IDS,
    );
  }, [visibleNodeIds, visibleEdgeIds]);

  useEffect(() => {
    rendererRef.current?.setSelected(props.selectedId);
  }, [props.selectedId]);

  useEffect(() => {
    rendererRef.current?.setHighlight(props.highlightIds);
  }, [props.highlightIds]);

  useEffect(() => {
    rendererRef.current?.setLabelsEnabled(props.labelsEnabled);
  }, [props.labelsEnabled]);

  useEffect(() => {
    rendererRef.current?.setEdgesEnabled(props.edgesEnabled);
  }, [props.edgesEnabled]);

  useEffect(() => {
    // Token 0 is the initial state, not a request: fitting before there is a
    // graph would be a no-op anyway, but the guard keeps the intent explicit.
    if (props.fitToken > 0) {
      rendererRef.current?.fitToGraph();
    }
  }, [props.fitToken]);

  useEffect(() => {
    if (props.focusRequest !== null) {
      rendererRef.current?.focusNode(props.focusRequest.nodeId);
    }
  }, [props.focusRequest]);

  // The label is the only part of the scene that is text, so it is the only part
  // whose content depends on the graph: keep the canvas's accessible name in
  // step with what is actually on screen.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) {
      return;
    }
    renderer.canvasElement.setAttribute('aria-label', props.ariaLabel);
  }, [props.ariaLabel]);

  return (
    <div className="stage">
      <div className="stage-canvas-host" ref={hostRef} />
      <div className="label-layer" aria-hidden="true" ref={labelLayerRef} />
      {props.children}
    </div>
  );
}

/**
 * Positions the absolutely-placed DOM labels for the projected nodes.
 *
 * Hand-rolled reconciliation rather than React: this runs inside the renderer's
 * animation frame, and creating or updating 400 elements through the reconciler
 * at 60fps is the difference between a smooth drag and a locked-up panel.
 *
 * Elements are created once per node and then only moved, so the common case is
 * a `transform` write and a `hidden` toggle. Text is set with `textContent` —
 * the only DOM text API this file is allowed to use.
 */
function paintLabels(
  projected: readonly ProjectedLabel[],
  labels: Map<string, HTMLDivElement>,
  layer: HTMLDivElement | null,
  graph: AncestryGraph | null,
): void {
  if (layer === null) {
    return;
  }
  const seen = new Set<string>();
  for (const label of projected) {
    if (!label.visible) {
      continue;
    }
    seen.add(label.nodeId);
    let element = labels.get(label.nodeId);
    if (element === undefined) {
      const node = graph === null ? null : nodeById(graph, label.nodeId);
      element = document.createElement('div');
      element.className = 'node-label';
      element.textContent = node?.blockName ?? node?.filePath ?? label.nodeId;
      if (node !== null && node.isFocus) {
        element.classList.add('is-focus');
      } else if (node !== null && node.isOrigin) {
        element.classList.add('is-origin');
      }
      labels.set(label.nodeId, element);
      layer.append(element);
    }
    element.style.transform = `translate(${Math.round(label.x)}px, ${Math.round(label.y)}px)`;
    element.hidden = false;
  }
  for (const [id, element] of labels) {
    if (!seen.has(id)) {
      element.hidden = true;
    }
  }
}
