/**
 * A hand-rolled orbit/pan/zoom camera controller.
 *
 * WHY NOT `three/examples/jsm/controls/OrbitControls`: the base `three` package
 * does not export its controls through the published entry points we are allowed
 * to import, and the webview bundle is built with a strict CSP that forbids
 * anything dynamically constructed. Owning ~120 lines of spherical-coordinate
 * maths is cheaper than fighting the packaging, and it lets the damping and the
 * clamps be tuned for *this* scene: a graph whose camera is usually parked far
 * from the origin and whose "up" must stay aligned with the branch axis.
 *
 * MODEL
 * -----
 * The camera is described by:
 *   - a `target` (the point it looks at),
 *   - `theta` (azimuth), `phi` (polar, clamped away from the poles),
 *   - `radius` (distance, clamped),
 * and every input writes to a *desired* value while `update(dt)` eases the live
 * values toward it. That separation is what produces the inertial feel without
 * a physics loop, and it is why a fly-to animation and a user drag can be
 * interleaved safely: the animation writes the desired values, the user's next
 * drag simply overwrites them.
 */

import * as THREE from 'three';

/** Tuning constants, grouped so the renderer can pass a single object. */
export interface OrbitCameraOptions {
  /** The DOM element that receives pointer and wheel events. */
  readonly domElement: HTMLElement;
  /** The `THREE.PerspectiveCamera` (or subclass) to drive. */
  readonly camera: THREE.PerspectiveCamera;
  /** Initial look-at point. Defaults to the origin. */
  readonly target?: THREE.Vector3;
  /** Initial distance. Default 60. */
  readonly initialRadius?: number;
  /** Closest the camera may get, in world units. Default 2. */
  readonly minRadius?: number;
  /** Furthest the camera may get, in world units. Default 600. */
  readonly maxRadius?: number;
  /** Radians of rotation per pixel of drag. Default 0.005. */
  readonly rotateSpeed?: number;
  /** World units of pan per pixel of drag. Default 0.06. */
  readonly panSpeed?: number;
  /** Wheel zoom multiplier per notch. Default 1.0015. */
  readonly zoomSpeed?: number;
  /** Per-frame easing factor, 0..1. Default 0.15. */
  readonly damping?: number;
  /** Called after every update, so the renderer can draw. */
  readonly onChange?: () => void;
}

/** How close the eased camera is allowed to get to the desired state. */
const SNAP_EPSILON = 1e-4;

export class OrbitCamera {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly minRadius: number;
  private readonly maxRadius: number;
  private readonly rotateSpeed: number;
  private readonly panSpeed: number;
  private readonly zoomSpeed: number;
  private readonly damping: number;
  private readonly onChange: (() => void) | undefined;

  private readonly target = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();

  /** Live, eased state. */
  private theta = Math.PI * 0.28;
  private phi = Math.PI * 0.34;
  private radius = 60;

  /** Desired state; inputs write here, `update` eases toward it. */
  private desiredTheta = Math.PI * 0.28;
  private desiredPhi = Math.PI * 0.34;
  private desiredRadius = 60;

  private dragging: 'rotate' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;
  private pointerId: number | null = null;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  /** Set while an animated fly-to is running, so a user drag can cancel it. */
  private flight: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromTheta: number;
    toTheta: number;
    fromPhi: number;
    toPhi: number;
    fromRadius: number;
    toRadius: number;
    elapsed: number;
    duration: number;
  } | null = null;

  constructor(options: OrbitCameraOptions) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.minRadius = Math.max(0.1, options.minRadius ?? 2);
    this.maxRadius = Math.max(this.minRadius, options.maxRadius ?? 600);
    this.rotateSpeed = options.rotateSpeed ?? 0.005;
    this.panSpeed = options.panSpeed ?? 0.06;
    this.zoomSpeed = options.zoomSpeed ?? 1.0015;
    this.damping = clamp(options.damping ?? 0.15, 0.01, 1);
    this.onChange = options.onChange;

    this.radius = clamp(options.initialRadius ?? 60, this.minRadius, this.maxRadius);
    this.desiredRadius = this.radius;
    if (options.target !== undefined) {
      this.target.copy(options.target);
      this.desiredTarget.copy(options.target);
    }

    this.attach();
    this.applyToCamera();
  }

  /** The point the camera is currently looking at. */
  public getTarget(): THREE.Vector3 {
    return this.target.clone();
  }

  /** The current camera distance from the target. */
  public getRadius(): number {
    return this.radius;
  }

  /** True while the user is dragging. */
  public get isDragging(): boolean {
    return this.dragging !== null;
  }

  /**
   * Advances the animation. `dt` is in **seconds**; clamp it so a background tab
   * that wakes up after 30 seconds does not teleport the camera.
   */
  public update(dt: number): void {
    if (this.disposed) {
      return;
    }
    const step = clamp(dt, 0, 0.1);
    if (this.flight !== null) {
      this.advanceFlight(step);
    }
    const eased = 1 - Math.pow(1 - this.damping, Math.max(1, step * 60));
    const deltaTheta = this.desiredTheta - this.theta;
    const deltaPhi = this.desiredPhi - this.phi;
    const deltaRadius = this.desiredRadius - this.radius;
    const moving =
      Math.abs(deltaTheta) > SNAP_EPSILON ||
      Math.abs(deltaPhi) > SNAP_EPSILON ||
      Math.abs(deltaRadius) > SNAP_EPSILON * Math.max(1, this.radius) ||
      this.target.distanceToSquared(this.desiredTarget) > SNAP_EPSILON;
    if (moving) {
      this.theta += deltaTheta * eased;
      this.phi += deltaPhi * eased;
      this.radius += deltaRadius * eased;
      this.target.lerp(this.desiredTarget, eased);
      this.applyToCamera();
      this.onChange?.();
    }
  }

  /**
   * Eases the camera to look at `position` from a sensible distance over
   * `durationMs`. A user drag cancels it, which is why the flight state is
   * separate from the drag state.
   */
  public flyTo(position: THREE.Vector3, distance: number, durationMs = 600): void {
    if (this.disposed) {
      return;
    }
    this.desiredTarget.copy(position);
    this.desiredRadius = clamp(distance, this.minRadius, this.maxRadius);
    // Shortest angular path: without this, dragging past ±π makes the camera
    // spin the long way round.
    const targetTheta = normalizeAngle(this.theta);
    this.desiredTheta = targetTheta;
    this.flight = {
      fromTarget: this.target.clone(),
      toTarget: this.desiredTarget.clone(),
      fromTheta: this.theta,
      toTheta: targetTheta,
      fromPhi: this.phi,
      toPhi: this.phi,
      fromRadius: this.radius,
      toRadius: this.desiredRadius,
      elapsed: 0,
      duration: Math.max(0, durationMs) / 1000,
    };
    if (this.flight.duration === 0) {
      this.theta = this.desiredTheta;
      this.phi = this.desiredPhi;
      this.radius = this.desiredRadius;
      this.target.copy(this.desiredTarget);
      this.flight = null;
      this.applyToCamera();
      this.onChange?.();
    }
  }

  /** Instantly moves the camera to a framing, cancelling any flight. */
  public jumpTo(target: THREE.Vector3, distance: number): void {
    this.flight = null;
    this.desiredTarget.copy(target);
    this.target.copy(this.desiredTarget);
    this.desiredRadius = clamp(distance, this.minRadius, this.maxRadius);
    this.radius = this.desiredRadius;
    this.applyToCamera();
    this.onChange?.();
  }

  /** Sets the zoom without changing the look-at point. */
  public zoomBy(factor: number): void {
    this.flight = null;
    this.desiredRadius = clamp(this.desiredRadius * factor, this.minRadius, this.maxRadius);
  }

  /** Resizes the underlying camera after the canvas changed size. */
  public setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const off of this.disposers.splice(0, this.disposers.length)) {
      off();
    }
    this.flight = null;
    this.dragging = null;
    this.pointerId = null;
  }

  // -----------------------------------------------------------------------

  private advanceFlight(step: number): void {
    const flight = this.flight;
    if (flight === null) {
      return;
    }
    flight.elapsed += step;
    const raw = flight.duration <= 0 ? 1 : flight.elapsed / flight.duration;
    const t = clamp(raw, 0, 1);
    // easeInOutCubic: fast in the middle, gentle at both ends, so the camera
    // does not "snap off" the moment the fly-to starts.
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.theta = lerp(flight.fromTheta, flight.toTheta, eased);
    this.phi = lerp(flight.fromPhi, flight.toPhi, eased);
    this.radius = lerp(flight.fromRadius, flight.toRadius, eased);
    this.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
    if (t >= 1) {
      this.flight = null;
    }
  }

  private attach(): void {
    const element = this.domElement;
    const onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
    const onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event);
    const onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event);
    const onWheel = (event: WheelEvent): void => this.handleWheel(event);
    const onContextMenu = (event: Event): void => {
      // Right-drag pans; without this the workbench's own context menu would
      // steal the gesture half-way through.
      event.preventDefault();
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);
    this.disposers.push(
      () => element.removeEventListener('pointerdown', onPointerDown),
      () => element.removeEventListener('pointermove', onPointerMove),
      () => element.removeEventListener('pointerup', onPointerUp),
      () => element.removeEventListener('pointercancel', onPointerUp),
      () => element.removeEventListener('wheel', onWheel),
      () => element.removeEventListener('contextmenu', onContextMenu),
    );
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.pointerId !== null) {
      return;
    }
    const wantsPan = event.button === 2 || event.button === 1 || event.shiftKey;
    this.dragging = wantsPan ? 'pan' : 'rotate';
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.flight = null;
    this.domElement.setPointerCapture?.(event.pointerId);
    this.domElement.classList.add('is-dragging');
    event.preventDefault();
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.dragging === null || event.pointerId !== this.pointerId) {
      return;
    }
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (this.dragging === 'rotate') {
      this.desiredTheta -= dx * this.rotateSpeed;
      this.desiredPhi = clamp(this.desiredPhi - dy * this.rotateSpeed, 0.05, Math.PI - 0.05);
    } else {
      this.pan(dx, dy);
    }
    event.preventDefault();
  }

  private handlePointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    this.dragging = null;
    this.pointerId = null;
    this.domElement.releasePointerCapture?.(event.pointerId);
    this.domElement.classList.remove('is-dragging');
  }

  private handleWheel(event: WheelEvent): void {
    this.flight = null;
    // `deltaMode` 1 is lines, 2 is pages; normalise both to "notches".
    const notches =
      event.deltaMode === 1
        ? event.deltaY / 53
        : event.deltaMode === 2
          ? event.deltaY * 10
          : event.deltaY;
    this.zoomBy(Math.pow(this.zoomSpeed, -clamp(notches, -20, 20)));
    event.preventDefault();
  }

  /** Moves the look-at point within the camera's own screen plane. */
  private pan(dx: number, dy: number): void {
    const height = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.radius;
    const distance = (height * this.panSpeed * dy) / Math.max(1, this.domElement.clientHeight);
    const width = distance * this.camera.aspect;
    const offsetX = (width * -dx) / Math.max(1, this.domElement.clientWidth);
    const matrix = this.camera.matrix.elements;
    // The first two columns of the world matrix are the camera's right and up
    // axes; using them keeps the pan in screen space at any orientation.
    this.desiredTarget.x += matrix[0]! * offsetX + matrix[4]! * distance;
    this.desiredTarget.y += matrix[1]! * offsetX + matrix[5]! * distance;
    this.desiredTarget.z += matrix[2]! * offsetX + matrix[6]! * distance;
  }

  private applyToCamera(): void {
    const sinPhi = Math.sin(this.phi);
    const x = this.radius * sinPhi * Math.sin(this.theta);
    const y = this.radius * Math.cos(this.phi);
    const z = this.radius * sinPhi * Math.cos(this.theta);
    this.camera.position.set(this.target.x + x, this.target.y + y, this.target.z + z);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Wraps an angle into `(-π, π]` so fly-to always takes the short way round. */
function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) {
    value -= 2 * Math.PI;
  }
  while (value <= -Math.PI) {
    value += 2 * Math.PI;
  }
  return value;
}
