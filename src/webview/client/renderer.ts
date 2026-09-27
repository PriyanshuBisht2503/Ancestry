/**
 * The Three.js scene graph: node spheres, curved ancestry edges, axis furniture
 * and picking.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * The renderer owns no policy. Colours come from `core/colors.ts`, positions
 * from `core/layout.ts`, and the visible set from `core/filter.ts`; it is handed
 * a `Scene` state and told what to show. That separation is what lets the
 * interesting logic be unit tested in Node while this file — which needs a real
 * WebGL context and is therefore the least-tested code in the module — stays a
 * thin translation layer.
 *
 * LABEL STRATEGY
 * --------------
 * Text is *not* drawn with `CSS2DRenderer` (an addon, so not importable here)
 * and not with a canvas texture atlas. Instead the renderer projects each
 * labelled node's world position to screen space and exposes it through the
 * `onLabels` callback; `GraphCanvas.tsx` owns a plain DOM layer and positions
 * the labels. That keeps text crisp, selectable by the OS, and themed by the
 * stylesheet, and it means the renderer never touches the DOM *other than* the
 * one `<canvas>` it creates.
 *
 * REACT INTEROP
 * -------------
 * This class is deliberately still imperative and still owns no policy. React
 * mounts it once and pushes updates in through narrow methods (`setGraph`,
 * `setFilter`, `setSelected`, …); see the long comment in
 * `components/GraphCanvas.tsx` for why the scene graph must never be React
 * state.
 *
 * RESOURCE DISCIPLINE
 * -------------------
 * A 20 000-node graph rebuilt on every filter change would leak geometries and
 * materials within a minute. Every rebuild therefore disposes the previous
 * group's geometries and materials explicitly, and `dispose()` walks the scene.
 */

import * as THREE from 'three';
import {
  colorForEdgeType,
  colorForNode,
  edgeOpacityFor,
  nodeScaleForSize,
  withAlpha,
} from './core/colors';
import { computeEdgeCurves, type AxisSpec, type LayoutNode } from './core/layout';
import { OrbitCamera } from './camera';
import type { AncestryEdge, AncestryGraph, AncestryNode } from '../../types';

/** A node's projected label, in CSS pixels relative to the canvas. */
export interface ProjectedLabel {
  nodeId: string;
  x: number;
  y: number;
  depth: number;
  visible: boolean;
}

/** Tunables, grouped so `GraphCanvas.tsx` can pass a single object. */
export interface RendererOptions {
  /**
   * The element the `<canvas>` lives in. The renderer creates and owns the
   * canvas; React only owns the container.
   */
  readonly container: HTMLElement;
  /**
   * `aria-label` describing what the scene shows, applied to the canvas.
   * A canvas is not navigable by a screen reader, so this is the only thing a
   * non-sighted user gets from the 3D view — say what it *is*, not what it is
   * doing ("code ancestry graph, 12 versions" beats "3D viewer").
   */
  readonly ariaLabel?: string;
  /** Called whenever a node is clicked; `null` when the click missed. */
  readonly onSelect?: (nodeId: string | null) => void;
  /** Called when the hovered node changes. */
  readonly onHover?: (nodeId: string | null) => void;
  /** Called every frame after the camera has moved, for label projection. */
  readonly onLabels?: (labels: ProjectedLabel[]) => void;
}

/** Hard cap on `devicePixelRatio`: a 3x display makes a 4K panel unusable. */
const MAX_PIXEL_RATIO = 2;

/** Raycasts per second while the pointer moves. Throttled to keep 60fps. */
const HOVER_INTERVAL_MS = 45;

/** The minimum event surface `pick` needs, so pointer and mouse events share it. */
interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

export class AncestryRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly webgl: THREE.WebGLRenderer;
  private readonly orbit: OrbitCamera;
  private readonly options: RendererOptions;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly disposable: THREE.BufferGeometry[] = [];
  private readonly disposableMaterials: THREE.Material[] = [];
  private readonly nodeMeshes = new Map<string, THREE.Mesh>();
  private readonly nodeById = new Map<string, AncestryNode>();
  private readonly positionById = new Map<string, THREE.Vector3>();

  private edgeGroup = new THREE.Group();
  private nodeGroup = new THREE.Group();
  private axisGroup = new THREE.Group();
  private highlightGroup = new THREE.Group();

  private resizeObserver: ResizeObserver | null = null;
  private frameHandle: number | null = null;
  private lastFrameTime = 0;
  private lastHoverTime = 0;
  private hoveredId: string | null = null;
  private visibleNodeIds: Set<string> = new Set();
  private edgeIds: Set<string> = new Set();
  private graphRef: AncestryGraph | null = null;
  private highlightIds: Set<string> = new Set();
  private labelsEnabled = true;
  private edgesEnabled = true;
  private selectedId: string | null = null;
  private disposed = false;
  private needsLabels = true;

  constructor(options: RendererOptions) {
    this.options = options;
    this.canvas = resolveCanvas(options.container, options.ariaLabel);

    this.scene.background = null;
    this.scene.add(this.edgeGroup, this.nodeGroup, this.axisGroup, this.highlightGroup);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 4000);
    this.camera.position.set(28, 26, 44);

    this.webgl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      // The webview is not a "trusted" surface, so keep the context to the
      // minimum: no stencil buffer, no preserved drawing buffer.
      alpha: true,
      stencil: false,
      depth: true,
    });
    this.webgl.setPixelRatio(Math.min(MAX_PIXEL_RATIO, globalThis.devicePixelRatio || 1));
    this.webgl.setClearColor(0x000000, 0);

    // Ambient + one directional + one fill: enough to read a sphere's shading
    // without three lights' worth of per-fragment cost on a dense graph.
    const ambient = new THREE.AmbientLight(0xffffff, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(40, 60, 30);
    const fill = new THREE.DirectionalLight(0x8899bb, 0.5);
    fill.position.set(-50, -20, -40);
    this.scene.add(ambient, key, fill);

    this.orbit = new OrbitCamera({
      domElement: this.canvas,
      camera: this.camera,
      initialRadius: 70,
      minRadius: 3,
      maxRadius: 900,
      onChange: () => {
        this.needsLabels = true;
      },
    });

    this.attachEvents();
    this.observeResize();
    this.start();
  }

  /** The live camera, so `GraphCanvas.tsx` can read the position for a `viewport` message. */
  public get orbitCamera(): OrbitCamera {
    return this.orbit;
  }

  /**
   * The canvas this renderer owns.
   *
   * Exposed so the React wrapper can keep its `aria-label` in sync with the
   * graph it is showing. The wrapper never re-parents or re-styles the node —
   * Three.js and React both writing to one element is the failure mode this
   * whole arrangement exists to avoid.
   */
  public get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Replaces the scene contents with the visible subset of a graph. */
  public setGraph(
    graph: AncestryGraph,
    nodes: readonly LayoutNode[],
    visibleNodeIds: ReadonlySet<string>,
    visibleEdgeIds: ReadonlySet<string>,
    axis: AxisSpec,
  ): void {
    if (this.disposed) {
      return;
    }
    this.rebuildNodes(graph, nodes, visibleNodeIds);
    this.rebuildEdges(graph, visibleEdgeIds);
    this.rebuildAxes(axis);
    this.applyVisibility();
    this.needsLabels = true;
  }

  /**
   * Updates the visible sets — used when a filter changes.
   *
   * Edges are rebuilt (rather than toggled) whenever the *edge* set actually
   * changed: a filtered-out edge has to leave the scene, and a filtered-in one
   * has to come back with the right colour and opacity. Node meshes are only
   * toggled, which is why this stays cheap on a 20 000-node graph.
   */
  public setFilter(visibleNodeIds: ReadonlySet<string>, visibleEdgeIds: ReadonlySet<string>): void {
    this.visibleNodeIds = new Set(visibleNodeIds);
    if (this.graphRef !== null && !sameSet(this.edgeIds, visibleEdgeIds)) {
      this.rebuildEdges(this.graphRef, visibleEdgeIds);
    }
    this.applyVisibility();
    this.needsLabels = true;
  }

  /** Highlights a set of node ids with a pulsing aura. */
  public setHighlight(nodeIds: readonly string[]): void {
    this.highlightIds = new Set(nodeIds);
    this.rebuildHighlight();
  }

  /** Flies the camera to a node. Unknown ids are ignored, not thrown on. */
  public focusNode(nodeId: string): void {
    const position = this.positionById.get(nodeId);
    if (position === undefined) {
      return;
    }
    this.selectedId = nodeId;
    this.orbit.flyTo(position, Math.max(6, this.orbit.getRadius() * 0.55), 700);
    this.needsLabels = true;
  }

  /** Frames the whole visible graph. */
  public fitToGraph(): void {
    if (this.positionById.size === 0) {
      return;
    }
    const box = new THREE.Box3();
    for (const id of this.visibleNodeIds) {
      const position = this.positionById.get(id);
      if (position !== undefined) {
        box.expandByPoint(position);
      }
    }
    if (box.isEmpty()) {
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const distance = Math.max(12, (size * 0.9) / Math.tan((this.camera.fov * Math.PI) / 360));
    this.orbit.flyTo(center, distance, 600);
    this.needsLabels = true;
  }

  /** Marks a node as selected, so it keeps a distinct treatment. */
  public setSelected(nodeId: string | null): void {
    this.selectedId = nodeId;
    this.rebuildHighlight();
  }

  /** Toggles the DOM label layer (the `1` shortcut). */
  public setLabelsEnabled(enabled: boolean): void {
    this.labelsEnabled = enabled;
    this.needsLabels = true;
  }

  /** Toggles edge rendering (the `2` shortcut). */
  public setEdgesEnabled(enabled: boolean): void {
    this.edgesEnabled = enabled;
    this.edgeGroup.visible = enabled;
    this.needsLabels = true;
  }

  /** True when the DOM label layer is currently enabled. */
  public get areLabelsEnabled(): boolean {
    return this.labelsEnabled;
  }

  /** True when edges are currently drawn. */
  public get areEdgesEnabled(): boolean {
    return this.edgesEnabled;
  }

  /** Projects the labelled nodes to CSS pixels for the DOM label layer. */
  public getLabelPositions(limit = 400): ProjectedLabel[] {
    const out: ProjectedLabel[] = [];
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const vector = new THREE.Vector3();
    for (const [nodeId, position] of this.positionById) {
      if (out.length >= limit) {
        break;
      }
      if (!this.visibleNodeIds.has(nodeId)) {
        continue;
      }
      const node = this.nodeById.get(nodeId);
      if (node !== undefined && !node.isFocus && !node.isOrigin && !this.labelsEnabled) {
        continue;
      }
      vector.copy(position);
      vector.project(this.camera);
      const depth = vector.z;
      out.push({
        nodeId,
        x: (vector.x * 0.5 + 0.5) * width,
        y: (-vector.y * 0.5 + 0.5) * height,
        depth,
        // `z` outside [-1, 1] is behind the camera or past the far plane.
        visible: depth > -1 && depth < 1,
      });
    }
    out.sort((a, b) => a.depth - b.depth);
    return out;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.orbit.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachEvents();
    this.disposeGroup(this.edgeGroup);
    this.disposeGroup(this.nodeGroup);
    this.disposeGroup(this.axisGroup);
    this.disposeGroup(this.highlightGroup);
    for (const geometry of this.disposable.splice(0)) {
      geometry.dispose();
    }
    for (const material of this.disposableMaterials.splice(0)) {
      material.dispose();
    }
    this.webgl.dispose();
  }

  // -----------------------------------------------------------------------
  // scene construction
  // -----------------------------------------------------------------------

  private rebuildNodes(
    graph: AncestryGraph,
    nodes: readonly LayoutNode[],
    visibleNodeIds: ReadonlySet<string>,
  ): void {
    this.disposeGroup(this.nodeGroup);
    this.nodeGroup.clear();
    this.nodeMeshes.clear();
    this.nodeById.clear();
    this.positionById.clear();

    const sphere = new THREE.SphereGeometry(1, 18, 12);
    this.disposable.push(sphere);

    for (const node of graph.nodes) {
      this.nodeById.set(node.id, node);
    }
    for (const layout of nodes) {
      const node = this.nodeById.get(layout.id);
      if (node === undefined) {
        continue;
      }
      const radius = nodeScaleForSize(node);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colorForNode(node)),
        roughness: 0.55,
        metalness: 0.08,
        // Deleted blocks are still real history; they are drawn translucent so
        // the surviving code reads as "solid" against them.
        transparent: node.isDeleted,
        opacity: node.isDeleted ? 0.35 : 1,
        emissive: new THREE.Color(node.isFocus ? '#404040' : '#000000'),
        emissiveIntensity: node.isFocus ? 0.9 : 0,
      });
      const mesh = new THREE.Mesh(sphere, material);
      mesh.position.set(layout.position[0], layout.position[1], layout.position[2]);
      mesh.scale.setScalar(radius);
      mesh.userData = { nodeId: node.id, radius };
      mesh.name = node.id;
      this.nodeMeshes.set(node.id, mesh);
      this.positionById.set(node.id, mesh.position.clone());
      this.disposableMaterials.push(material);
      this.nodeGroup.add(mesh);
    }
    this.visibleNodeIds = new Set(visibleNodeIds);
  }

  private rebuildEdges(graph: AncestryGraph, visibleEdgeIds: ReadonlySet<string>): void {
    this.graphRef = graph;
    this.edgeIds = new Set(visibleEdgeIds);
    this.disposeGroup(this.edgeGroup);
    this.edgeGroup.clear();

    const layout: LayoutNode[] = [...this.positionById.entries()].map(([id, position]) => ({
      id,
      position: [position.x, position.y, position.z] as [number, number, number],
    }));
    const edges: AncestryEdge[] = graph.edges.filter((edge) => visibleEdgeIds.has(edge.id));
    const curves = computeEdgeCurves(layout, edges);

    for (const edge of edges) {
      const points = curves.get(edge.id);
      if (points === undefined || points.length < 2) {
        continue;
      }
      const curve = new THREE.CatmullRomCurve3(
        points.map((point) => new THREE.Vector3(point[0], point[1], point[2])),
      );
      const geometry = new THREE.TubeGeometry(curve, Math.max(6, points.length), 0.045, 5, false);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorForEdgeType(edge.type)),
        transparent: true,
        opacity: edgeOpacityFor(edge.similarity) * 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = edge.id;
      this.disposable.push(geometry);
      this.disposableMaterials.push(material);
      this.edgeGroup.add(mesh);
    }
  }

  /**
   * The axis furniture: a time rail under the graph, one coloured row per
   * branch and one lane per module.
   *
   * These are deliberately thin, dim lines. They are reference furniture, not
   * data: the data is the nodes and edges, and an axis that competes with them
   * makes the whole picture harder to read.
   */
  private rebuildAxes(axis: AxisSpec): void {
    this.disposeGroup(this.axisGroup);
    this.axisGroup.clear();
    if (axis.yRows.length === 0 || axis.zLanes.length === 0) {
      return;
    }
    const yValues = axis.yRows.map((row) => row.value);
    const zValues = axis.zLanes.map((lane) => lane.value);
    const zMin = Math.min(...zValues);
    const zMax = Math.max(...zValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);

    for (const tick of axis.xTicks) {
      void tick;
      break;
    }

    // X rail.
    const railGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, yMin - 1.6, zMin),
      new THREE.Vector3(0, yMin - 1.6, zMax),
    ]);
    this.disposable.push(railGeometry);
    const railMaterial = new THREE.LineBasicMaterial({
      color: 0x555555,
      transparent: true,
      opacity: 0.7,
    });
    this.disposableMaterials.push(railMaterial);
    this.axisGroup.add(new THREE.Line(railGeometry, railMaterial));

    // One faint row per branch, tinted with the branch's palette colour.
    for (let index = 0; index < axis.yRows.length; index += 1) {
      const row = axis.yRows[index]!;
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, row.value, zMin),
        new THREE.Vector3(0, row.value, zMax),
      ]);
      this.disposable.push(geometry);
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(row.color),
        transparent: true,
        opacity: 0.18,
      });
      this.disposableMaterials.push(material);
      this.axisGroup.add(new THREE.Line(geometry, material));
    }

    // One faint lane per module.
    for (const lane of axis.zLanes) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, yMin, lane.value),
        new THREE.Vector3(0, yMax, lane.value),
      ]);
      this.disposable.push(geometry);
      const material = new THREE.LineBasicMaterial({
        color: 0x777777,
        transparent: true,
        opacity: 0.12,
      });
      this.disposableMaterials.push(material);
      this.axisGroup.add(new THREE.Line(geometry, material));
    }
  }

  /** Rebuilds the highlight aura: selected node + the highlighted set. */
  private rebuildHighlight(): void {
    this.disposeGroup(this.highlightGroup);
    this.highlightGroup.clear();
    const ids = new Set(this.highlightIds);
    if (this.selectedId !== null) {
      ids.add(this.selectedId);
    }
    for (const id of ids) {
      const position = this.positionById.get(id);
      if (position === undefined) {
        continue;
      }
      const node = this.nodeById.get(id);
      const color = node === undefined ? '#ffffff' : colorForNode(node);
      const geometry = new THREE.RingGeometry(0.9, 1.25, 24);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.position.copy(position);
      ring.lookAt(this.camera.position);
      ring.userData = { billboard: true, nodeId: id };
      this.disposable.push(geometry);
      this.disposableMaterials.push(material);
      this.highlightGroup.add(ring);
    }
  }

  private applyVisibility(): void {
    for (const [id, mesh] of this.nodeMeshes) {
      mesh.visible = this.visibleNodeIds.has(id);
    }
    this.edgeGroup.visible = this.edgesEnabled;
  }

  private disposeGroup(group: THREE.Group): void {
    for (const child of group.children) {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        const geometry = child.geometry;
        const material = child.material;
        if (Array.isArray(material)) {
          for (const item of material) {
            item.dispose();
          }
        } else {
          material.dispose();
        }
        if (child instanceof THREE.Mesh) {
          geometry.dispose();
        }
      }
    }
    group.clear();
  }

  // -----------------------------------------------------------------------
  // events, resize, frame loop
  // -----------------------------------------------------------------------

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('dblclick', this.handleDoubleClick);
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const hit = this.pick(event);
    this.selectedId = hit;
    this.rebuildHighlight();
    this.options.onSelect?.(hit);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastHoverTime < HOVER_INTERVAL_MS) {
      return;
    }
    this.lastHoverTime = now;
    const hit = this.pick(event);
    if (hit === this.hoveredId) {
      return;
    }
    this.hoveredId = hit;
    this.canvas.style.cursor = hit === null ? 'grab' : 'pointer';
    this.options.onHover?.(hit);
  };

  private readonly handlePointerLeave = (): void => {
    if (this.hoveredId !== null) {
      this.hoveredId = null;
      this.options.onHover?.(null);
    }
  };

  private readonly handleDoubleClick = (event: MouseEvent): void => {
    const hit = this.pick(event);
    if (hit !== null) {
      this.focusNode(hit);
    }
  };

  /**
   * Raycasts the visible node meshes.
   *
   * Only *visible* meshes are tested, and the sphere geometry is shared with a
   * generous `THREE.Sphere` threshold instead of the exact triangles: an exact
   * pick on 18×12-segment spheres is both slower and, for a 0.35-radius sphere
   * at 100 world units away, less usable.
   */
  private pick(event: PointerLike): string | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates: THREE.Object3D[] = [];
    for (const [id, mesh] of this.nodeMeshes) {
      if (mesh.visible && this.visibleNodeIds.has(id)) {
        candidates.push(mesh);
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    const hits = this.raycaster.intersectObjects(candidates, false);
    for (const hit of hits) {
      const nodeId = (hit.object as THREE.Mesh).userData?.nodeId;
      if (typeof nodeId === 'string') {
        return nodeId;
      }
    }
    return null;
  }

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') {
      this.resize();
      return;
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
  }

  private resize(): void {
    if (this.disposed) {
      return;
    }
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height);
    this.webgl.setSize(width, height, false);
    this.orbit.setAspect(width / height);
    this.needsLabels = true;
  }

  private start(): void {
    const loop = (time: number): void => {
      if (this.disposed) {
        return;
      }
      this.frameHandle = window.requestAnimationFrame(loop);
      const dt = this.lastFrameTime === 0 ? 0.016 : (time - this.lastFrameTime) / 1000;
      this.lastFrameTime = time;
      this.orbit.update(dt);
      for (const child of this.highlightGroup.children) {
        if (child.userData?.billboard === true) {
          child.lookAt(this.camera.position);
        }
      }
      this.webgl.render(this.scene, this.camera);
      if (this.needsLabels || this.orbit.isDragging) {
        this.needsLabels = false;
        this.options.onLabels?.(this.getLabelPositions());
      }
    };
    this.frameHandle = window.requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.frameHandle !== null) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }
}

/** The `rgba()` string for an edge, exported so tests and the legend agree. */
export function edgeColorString(type: AncestryEdge['type'], similarity: number): string {
  return withAlpha(colorForEdgeType(type), edgeOpacityFor(similarity));
}

/**
 * Finds or creates the `<canvas>` inside the mount container.
 *
 * React renders the *container* and never the canvas. Three.js needs a canvas it
 * can own exclusively — it creates the WebGL context on it, resizes it, and
 * attaches its own listeners — and letting both React and the renderer write to
 * the same node is the one thing that reliably breaks this hybrid (React's
 * reconciliation will eventually remove or clobber a child it did not create).
 * So the container is empty as far as React is concerned and the renderer
 * appends the canvas itself.
 *
 * The attributes set here are all *literals we produce*; the `aria-label` is the
 * only caller-supplied string and it goes through `setAttribute`, never into
 * markup.
 */
function resolveCanvas(container: HTMLElement, ariaLabel: string | undefined): HTMLCanvasElement {
  const existing = container.querySelector('canvas');
  const canvas =
    existing instanceof HTMLCanvasElement ? existing : document.createElement('canvas');
  if (canvas.className.length === 0) {
    canvas.className = 'stage-canvas';
  }
  // A canvas has no implicit accessible role; `img` plus a label is what a
  // screen reader will announce, and the keyboard-navigable equivalent of the
  // scene is the version list next to it.
  canvas.setAttribute('role', 'img');
  if (typeof ariaLabel === 'string' && ariaLabel.length > 0) {
    canvas.setAttribute('aria-label', ariaLabel);
  }
  if (canvas.tabIndex < 0) {
    canvas.tabIndex = 0;
  }
  if (canvas.parentElement !== container) {
    container.append(canvas);
  }
  return canvas;
}

/** Cheap set equality, used to decide whether an edge rebuild is worth it. */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}
