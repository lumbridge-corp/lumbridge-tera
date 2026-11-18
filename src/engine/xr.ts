// WebXR for live mode: ?xr=vr (Quest 3 immersive VR) and ?xr=ar (passthrough mixed
// reality on Quest 3, see-through AR on Snap Spectacles). docs/xr.md has the user guide.
//
// The world never moves. The user moves: a "rig" group carries the camera, controllers
// and hands, and its transform (position, yaw, uniform scale k) maps real metres to
// world metres: world = pos + R(yaw) · k · real. k = 1 walks the world 1:1; a big k makes
// the user a giant, so the world looks like a tabletop model. Every gesture (teleport,
// smooth move, snap turn, grab-move/rotate/scale) is one formula on (pos, yaw, k).
//
// Inputs (Quest Touch controllers, xr-standard mapping; hands work through the same
// select/squeeze events — pinch = select):
//   left stick       smooth move (head direction)        right stick ←/→  snap turn 30°
//   trigger / pinch  point at an entity → `tera:select`   (VR walk: point at the floor → teleport)
//   grip / pinch-drag  grab the world: one hand moves + turns it, two hands also scale it
//   A / X            toggle tabletop ↔ walk (VR)          B / Y   reset the view
//   AR: the first select places the model on the surface under the reticle (hit-test),
//   otherwise it starts 0.8 m in front of you at table height.
import * as THREE from "three";

export type XrMode = "vr" | "ar";
export type Scale = "table" | "walk";

/** What the XR controller needs from the engine. */
export interface XrHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Top-level entity objects (for picking and teleport targets). */
  pickables(): THREE.Object3D[];
  /** World-space box of the scene without big ground planes; null when empty. */
  contentBox(): THREE.Box3 | null;
  /** The world's default camera (walk mode starts there). */
  defaultPose(): { position: THREE.Vector3; target: THREE.Vector3 };
  /** Entity id of an object (walks up to the owning entity). */
  entityOf(o: THREE.Object3D): string | null;
  /** Called when a session starts/ends so the engine can switch to the cheap path. */
  onPresenting(on: boolean, mode: XrMode): void;
  hud(msg: string): void;
}

export interface XrOptions {
  mode: XrMode;
  /** Real size (m) of the tabletop model's longest side. Default 1.0 in VR, 0.5 in AR. */
  tableSize?: number;
  /** World metres per real metre in walk mode (default 1 = 1:1). */
  walkScale?: number;
  /** Start in "table" or "walk" (VR default: table). */
  start?: Scale;
}

/** Quest 3 budget (docs/xr.md). Over it, the page warns once per session. */
export const XR_BUDGET = { drawCalls: 150, triangles: 750_000, splats: 1_000_000, shadowMap: 1024, framebufferScale: 1.0, foveation: 1 };

const SNAP_DEG = 30;
const MOVE_SPEED = 1.6; // real m/s at full stick
const DRAG_START_M = 0.025; // a pinch that moves farther than this is a grab, not a click

export interface RigState { pos: THREE.Vector3; yaw: number; k: number }

const Y = new THREE.Vector3(0, 1, 0);

/** Real → world under a rig state. Pure; tested in Node. */
export function rigToWorld(s: RigState, real: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(real).multiplyScalar(s.k).applyAxisAngle(Y, s.yaw).add(s.pos);
}

/** Rig position so that world point `w` sits under real point `real` (yaw and k given). */
export function anchorRig(w: THREE.Vector3, real: THREE.Vector3, yaw: number, k: number): THREE.Vector3 {
  return w.clone().sub(real.clone().multiplyScalar(k).applyAxisAngle(Y, yaw));
}

/**
 * Two-point grab: at the start the hands were at a0,b0 (real, b0 may equal a0 for one hand
 * with `turn` = its yaw change); now at a1,b1. Returns the rig that keeps the world glued
 * to the hands: the world turns with the hands and grows as they spread apart.
 */
export function grabRig(start: RigState, a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, turn = 0): RigState {
  const m0 = a0.clone().add(b0).multiplyScalar(0.5), m1 = a1.clone().add(b1).multiplyScalar(0.5);
  const anchor = rigToWorld(start, m0);
  const d0 = Math.hypot(b0.x - a0.x, b0.z - a0.z), d1 = Math.hypot(b1.x - a1.x, b1.z - a1.z);
  let k = start.k, dTheta = turn;
  if (d0 > 0.02 && d1 > 0.02) {
    k = THREE.MathUtils.clamp(start.k * (d0 / d1), 1e-4, 1e5);
    dTheta = Math.atan2(-(b1.z - a1.z), b1.x - a1.x) - Math.atan2(-(b0.z - a0.z), b0.x - a0.x);
  }
  const yaw = start.yaw - dTheta;
  return { pos: anchorRig(anchor, m1, yaw, k), yaw, k };
}

/** Tabletop placement: content box bottom-centre lands on real point `at`, longest side = size m, front (+Z) facing the user at yaw `facing`. */
export function tableRig(box: THREE.Box3, at: THREE.Vector3, size: number, facing: number): RigState {
  const ext = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, (box.max.y - box.min.y) * 0.5, 1e-3);
  const k = ext / size;
  const c = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const yaw = -facing;
  return { pos: anchorRig(c, at, yaw, k), yaw, k };
}

interface Hand {
  index: number;
  ray: THREE.Group; // target ray space (controllers and hands)
  grip: THREE.Group;
  line: THREE.Line;
  gamepad: Gamepad | null;
  handedness: XRHandedness | "none";
  isHand: boolean;
  selecting: boolean;
  selectStart: THREE.Vector3 | null;
  dragging: boolean;
  squeezing: boolean;
  lastStickX: number;
  buttons: boolean[];
}

export class XrController {
  readonly rig = new THREE.Group();
  scale: Scale;
  private renderer: THREE.WebGLRenderer | null = null;
  private hands: Hand[] = [];
  private state: RigState = { pos: new THREE.Vector3(), yaw: 0, k: 1 };
  private grab: { start: RigState; a0: THREE.Vector3; b0: THREE.Vector3; yaw0: number; hands: Hand[] } | null = null;
  private reticle: THREE.Mesh;
  private marker: THREE.Mesh;
  private hitSource: XRHitTestSource | null = null;
  private placed = false;
  private warned = false;
  private raycaster = new THREE.Raycaster();
  button: HTMLElement | null = null;

  private readonly host: XrHost;
  readonly opts: XrOptions;

  constructor(host: XrHost, opts: XrOptions) {
    this.host = host;
    this.opts = opts;
    this.scale = opts.mode === "ar" ? "table" : (opts.start ?? "table");
    this.rig.name = "__xr-rig";
    this.rig.userData.tera = "xr";
    this.rig.matrixAutoUpdate = false;
    const ring = (r0: number, r1: number, color: string) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }));
      m.visible = false;
      m.renderOrder = 999;
      m.matrixAutoUpdate = false;
      return m;
    };
    this.reticle = ring(0.04, 0.05, "#7fe0ff"); // real-space, in the rig
    this.marker = ring(0.15, 0.2, "#7fe0ff"); // world-space teleport target
    this.rig.add(this.reticle);
  }

  get presenting(): boolean {
    return !!this.renderer?.xr.isPresenting;
  }

  /** Hook the WebGL renderer (called on every backend switch) and build the Enter button. */
  async attach(renderer: THREE.WebGLRenderer): Promise<HTMLElement> {
    if (this.renderer === renderer && this.button) return this.button;
    this.renderer = renderer;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    renderer.xr.setFramebufferScaleFactor(XR_BUDGET.framebufferScale);
    renderer.xr.setFoveation(XR_BUDGET.foveation);
    const cam = this.host.camera;
    if (cam.parent !== this.rig) this.rig.add(cam);
    if (!this.rig.parent) this.host.scene.add(this.rig);
    if (!this.marker.parent) this.host.scene.add(this.marker);
    this.hands = [];
    for (const old of this.rig.children.filter((c) => c.userData.xrInput)) this.rig.remove(old);
    const { XRHandModelFactory } = await import("three/addons/webxr/XRHandModelFactory.js");
    const handModels = new XRHandModelFactory();
    for (let i = 0; i < 2; i++) this.hands.push(this.makeHand(renderer, i, handModels));
    renderer.xr.addEventListener("sessionstart", () => this.onStart());
    renderer.xr.addEventListener("sessionend", () => this.onEnd());

    const init: XRSessionInit = { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking", "layers"] };
    let button: HTMLElement;
    if (this.opts.mode === "ar") {
      const { ARButton } = await import("three/addons/webxr/ARButton.js");
      init.optionalFeatures!.push("hit-test", "plane-detection", "anchors");
      button = ARButton.createButton(renderer, { optionalFeatures: init.optionalFeatures });
    } else {
      const { VRButton } = await import("three/addons/webxr/VRButton.js");
      button = VRButton.createButton(renderer, init);
    }
    button.dataset.tera = "xr-button";
    this.button?.remove();
    this.button = button;
    return button;
  }

  private makeHand(renderer: THREE.WebGLRenderer, index: number, models: { createHandModel(c: THREE.Group, profile?: "spheres" | "boxes" | "mesh"): THREE.Object3D }): Hand {
    const ray = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const handSpace = renderer.xr.getHand(index);
    // Primitive spheres: no model download (the "mesh" profile fetches from a CDN).
    handSpace.add(models.createHandModel(handSpace, "spheres"));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: "#7fe0ff", transparent: true, opacity: 0.6, toneMapped: false }),
    );
    line.scale.z = 3;
    ray.add(line);
    for (const o of [ray, grip, handSpace]) {
      o.userData.xrInput = true;
      this.rig.add(o);
    }
    const h: Hand = { index, ray, grip, line, gamepad: null, handedness: "none", isHand: false, selecting: false, selectStart: null, dragging: false, squeezing: false, lastStickX: 0, buttons: [] };
    ray.addEventListener("connected", (e) => {
      const src = (e as unknown as { data: XRInputSource }).data;
      h.gamepad = src.gamepad ?? null;
      h.handedness = src.handedness;
      h.isHand = !!src.hand;
      line.visible = true;
    });
    ray.addEventListener("disconnected", () => {
      h.gamepad = null;
      line.visible = false;
      this.release(h);
    });
    ray.addEventListener("selectstart", () => {
      h.selecting = true;
      h.selectStart = h.ray.position.clone();
      h.dragging = false;
    });
    ray.addEventListener("selectend", () => {
      const wasDrag = h.dragging;
      h.selecting = false;
      h.dragging = false;
      if (wasDrag) this.release(h);
      else this.click(h);
    });
    ray.addEventListener("squeezestart", () => {
      h.squeezing = true;
      this.beginGrab();
    });
    ray.addEventListener("squeezeend", () => {
      h.squeezing = false;
      this.release(h);
    });
    return h;
  }

  // ------------------------------------------------------------ session

  private async onStart() {
    const r = this.renderer!;
    this.warned = false;
    this.placed = false;
    this.host.onPresenting(true, this.opts.mode);
    if (this.opts.mode === "ar") {
      r.setClearColor(0x000000, 0);
      const session = r.xr.getSession();
      try {
        const viewer = await session?.requestReferenceSpace("viewer");
        if (viewer && session?.requestHitTestSource) this.hitSource = (await session.requestHitTestSource({ space: viewer })) ?? null;
      } catch {
        this.hitSource = null; // no hit-test: the model stays 0.8 m in front at table height
      }
    }
    this.applyScale(this.scale);
  }

  private onEnd() {
    this.hitSource?.cancel();
    this.hitSource = null;
    this.grab = null;
    this.reticle.visible = this.marker.visible = false;
    this.renderer?.setClearColor(0x000000, 1);
    this.setRig({ pos: new THREE.Vector3(), yaw: 0, k: 1 });
    this.host.onPresenting(false, this.opts.mode);
    // Back on the flat page: restore the live camera.
    const p = this.host.defaultPose();
    this.host.camera.position.copy(p.position);
    this.host.camera.lookAt(p.target);
  }

  private setRig(s: RigState) {
    this.state = { pos: s.pos.clone(), yaw: s.yaw, k: s.k };
    this.rig.matrix.compose(s.pos, new THREE.Quaternion().setFromAxisAngle(Y, s.yaw), new THREE.Vector3(s.k, s.k, s.k));
    this.rig.matrixWorldNeedsUpdate = true;
    this.rig.updateMatrixWorld(true);
  }

  /** Head position in real space (reference space, metres) and its yaw. */
  private head(): { pos: THREE.Vector3; yaw: number } {
    const xrCam = this.renderer!.xr.getCamera();
    const m = new THREE.Matrix4().copy(this.rig.matrixWorld).invert().multiply(xrCam.matrixWorld);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return { pos, yaw: Math.atan2(-fwd.x, -fwd.z) };
  }

  /** Switch tabletop ↔ walk; also used to (re)place the world. */
  applyScale(s: Scale, at?: THREE.Vector3) {
    this.scale = s;
    const box = this.host.contentBox() ?? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const head = this.presenting ? this.head() : { pos: new THREE.Vector3(0, 1.6, 0), yaw: 0 };
    if (s === "table") {
      const size = this.opts.tableSize ?? (this.opts.mode === "ar" ? 0.5 : 1.0);
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(Y, head.yaw);
      const spot = at ?? new THREE.Vector3(head.pos.x, 0.8, head.pos.z).addScaledVector(fwd, 0.45 + size / 2);
      this.setRig(tableRig(box, spot, size, head.yaw));
    } else {
      const k = this.opts.walkScale ?? 1;
      const p = this.host.defaultPose();
      const dir = p.target.clone().sub(p.position);
      const yaw = Math.atan2(-dir.x, -dir.z) - head.yaw; // look where the default camera looks
      const floor = new THREE.Vector3(p.position.x, box.min.y, p.position.z);
      this.setRig({ pos: anchorRig(floor, new THREE.Vector3(head.pos.x, 0, head.pos.z), yaw, k), yaw, k });
    }
    this.host.hud(this.opts.mode === "ar" ? "AR: pinch to select, pinch-drag to move, two hands to scale" : s === "table" ? "tabletop — A/X: walk in" : `walk ${this.opts.walkScale ?? 1}:1 — A/X: tabletop`);
  }

  // ------------------------------------------------------------ grab / click

  private grabbers(): Hand[] {
    return this.hands.filter((h) => h.squeezing || h.dragging);
  }

  private beginGrab() {
    const g = this.grabbers();
    if (!g.length) {
      this.grab = null;
      return;
    }
    const a = g[0]!, b = g[1] ?? g[0]!;
    this.grab = { start: { ...this.state, pos: this.state.pos.clone() }, a0: a.ray.position.clone(), b0: b.ray.position.clone(), yaw0: yawOf(a.ray), hands: [a, b] };
  }

  private release(h: Hand) {
    if (this.grab?.hands.includes(h)) this.beginGrab(); // re-anchor with the hands still holding
  }

  private click(h: Hand) {
    if (this.opts.mode === "ar" && !this.placed && this.reticle.visible) {
      this.placed = true;
      const at = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
      this.applyScale("table", at);
      return;
    }
    const hit = this.pick(h);
    if (hit?.id) {
      dispatchSelect(hit.id, hit.point, h.isHand ? "hand" : "controller");
      return;
    }
    if (this.opts.mode === "vr" && hit) this.teleport(hit.point);
  }

  private pick(h: Hand): { id: string | null; point: THREE.Vector3 } | null {
    const m = h.ray.matrixWorld;
    this.raycaster.ray.origin.setFromMatrixPosition(m);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
    const hits = this.raycaster.intersectObjects(this.host.pickables(), true);
    for (const x of hits) {
      if (!x.object.visible) continue;
      const id = this.host.entityOf(x.object);
      // Big flat ground: a teleport target, not a selection.
      const isGround = x.face && x.face.normal.y > 0.9 && x.object.userData.ground === true;
      return { id: isGround ? null : id, point: x.point.clone() };
    }
    // Nothing hit: the ground plane y = content bottom (teleport only).
    const box = this.host.contentBox();
    const floor = new THREE.Plane(Y, -(box?.min.y ?? 0));
    const p = this.raycaster.ray.intersectPlane(floor, new THREE.Vector3());
    return p ? { id: null, point: p } : null;
  }

  private teleport(w: THREE.Vector3) {
    const head = this.head();
    this.setRig({ pos: anchorRig(w, new THREE.Vector3(head.pos.x, 0, head.pos.z), this.state.yaw, this.state.k), yaw: this.state.yaw, k: this.state.k });
  }

  // ------------------------------------------------------------ per frame

  update(dt: number, frame?: XRFrame) {
    if (!this.presenting) return;
    const r = this.renderer!;
    for (const h of this.hands) {
      // A pinch/trigger that travels becomes a grab.
      if (h.selecting && !h.dragging && h.selectStart && h.ray.position.distanceTo(h.selectStart) > DRAG_START_M) {
        h.dragging = true;
        this.beginGrab();
      }
      const gp = h.gamepad;
      if (!gp) continue;
      const pressed = gp.buttons.map((b) => b.pressed);
      const edge = (i: number) => pressed[i] && !h.buttons[i];
      const sx = gp.axes[2] ?? 0, sy = gp.axes[3] ?? 0;
      if (h.handedness === "left" && this.opts.mode === "vr" && Math.hypot(sx, sy) > 0.15) {
        const head = this.head();
        const move = new THREE.Vector3(sx, 0, sy).applyAxisAngle(Y, head.yaw).multiplyScalar(MOVE_SPEED * dt);
        const s = this.state;
        this.setRig({ ...s, pos: s.pos.clone().add(move.multiplyScalar(s.k).applyAxisAngle(Y, s.yaw)) });
      }
      if (h.handedness === "right" && this.opts.mode === "vr") {
        if (Math.abs(sx) > 0.7 && Math.abs(h.lastStickX) <= 0.7) this.snapTurn(sx > 0 ? -1 : 1);
        h.lastStickX = sx;
      }
      if (edge(4) && this.opts.mode === "vr") this.applyScale(this.scale === "table" ? "walk" : "table");
      if (edge(5)) this.applyScale(this.scale);
      h.buttons = pressed;
    }
    if (this.grab) {
      const [a, b] = this.grab.hands as [Hand, Hand];
      const turn = a === b ? yawOf(a.ray) - this.grab.yaw0 : 0;
      this.setRig(grabRig(this.grab.start, this.grab.a0, this.grab.b0, a.ray.position, b.ray.position, turn));
    }
    // AR reticle from hit-test, until the model is placed.
    if (this.hitSource && frame && !this.placed) {
      const ref = r.xr.getReferenceSpace();
      const res = frame.getHitTestResults(this.hitSource)[0];
      const pose = ref ? res?.getPose(ref) : undefined;
      this.reticle.visible = !!pose;
      if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
    } else this.reticle.visible = false;
    // VR: show where a trigger press would teleport to.
    const aiming = this.opts.mode === "vr" ? this.hands.find((h) => h.handedness === "right" && h.gamepad) : undefined;
    const hit = aiming ? this.pick(aiming) : null;
    this.marker.visible = !!hit && !hit.id;
    if (hit && !hit.id) {
      this.marker.matrix.compose(hit.point, new THREE.Quaternion(), new THREE.Vector3(this.state.k, this.state.k, this.state.k));
      this.marker.matrixWorldNeedsUpdate = true;
    }
    if (!this.warned) this.checkBudget(r);
  }

  private snapTurn(dir: 1 | -1) {
    const head = this.head();
    const anchor = rigToWorld(this.state, head.pos);
    const yaw = this.state.yaw + (dir * SNAP_DEG * Math.PI) / 180;
    this.setRig({ pos: anchorRig(anchor, head.pos, yaw, this.state.k), yaw, k: this.state.k });
  }

  private checkBudget(r: THREE.WebGLRenderer) {
    const { calls, triangles } = r.info.render;
    let splats = 0;
    this.host.scene.traverse((o) => {
      const n = (o as unknown as { packedSplats?: { numSplats?: number } }).packedSplats?.numSplats;
      if (n) splats += n;
    });
    const over: string[] = [];
    if (calls > XR_BUDGET.drawCalls) over.push(`${calls} draw calls (budget ${XR_BUDGET.drawCalls})`);
    if (triangles > XR_BUDGET.triangles) over.push(`${triangles} triangles (budget ${XR_BUDGET.triangles})`);
    if (splats > XR_BUDGET.splats) over.push(`${splats} splats (budget ${XR_BUDGET.splats})`);
    if (calls > 0) this.warned = true;
    if (over.length) console.warn(`[tera] XR over the Quest budget: ${over.join(", ")} — expect < 72 fps (docs/xr.md)`);
  }
}

function yawOf(o: THREE.Object3D): number {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(o.quaternion);
  return Math.atan2(-f.x, -f.z);
}

/** Fire the `tera:select` DOM event (window). detail: { id, point: [x,y,z] world, source }. */
export function dispatchSelect(id: string, point: THREE.Vector3 | null, source: "controller" | "hand" | "mouse") {
  window.dispatchEvent(new CustomEvent("tera:select", { detail: { id, point: point ? [point.x, point.y, point.z] : null, source } }));
}
