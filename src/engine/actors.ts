// Actors: the little worker robots (and glTF stand-ins) that walk the world's paths.
//
// Style "worker" is an original robot built from primitives — a rounded bean body, a dark
// visor with two lime eyes, stubby legs, mitten arms, an antenna — with a procedural
// walk cycle (driven by distance walked, so feet match the ground), idle breathing and a
// "working" pose (arms tapping a holo screen, a gear spinning overhead).
//
// Every worker part is ONE InstancedMesh shared by all workers (≈12 draw calls for any
// number of robots); per frame we only write instance matrices. Pose is a pure function
// of time (living-math.ts), so render mode is deterministic.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ActorMove } from "../schema/living.ts";
import { actorPose, autoLane, hash01, nearestNode, nearestS, roundCorners, route, samplePath, samplePoints, separate, type ActorPose, type Phase, type Sampled, type V3 } from "./living-math.ts";
import type { LivingWorld } from "./flows.ts";
import { makeExact } from "./exact.ts";
import { labelFit, type LabelFitOptions } from "./label-fit.ts";

export interface ActorSpec {
  id: string;
  kind: "actor";
  style?: "worker" | "model";
  src?: string;
  color?: string;
  label?: string;
  state?: Phase;
  move?: ActorMove;
  transform?: { position?: V3; rotation?: V3; scale?: number | V3 };
  visible?: boolean;
}

export interface LivingHooks {
  resolve(src: string): string;
  track<T>(p: Promise<T>): Promise<T>;
  warn(msg: string): void;
  loadModel(url: string): Promise<THREE.Object3D>;
}

const PALETTE = ["#f3efe4", "#ffb547", "#7cc6ff", "#ff8a65", "#c7b6ff", "#7fe0c3", "#ffd84d", "#f2f5f8"];
export const LIME = "#b8ff3c";
const GRAPHITE = "#2a2e35";

// ---------------------------------------------------------------- shared textures

let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.15, "rgba(255,255,255,0.6)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.16)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  glowTex.userData.shared = true;
  return glowTex;
}

let blobTex: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(0,0,0,0.9)");
  grd.addColorStop(0.55, "rgba(0,0,0,0.45)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  blobTex.userData.shared = true;
  return blobTex;
}

function holoTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 160;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(120,255,200,0.10)";
  g.beginPath();
  g.roundRect(4, 4, 248, 152, 14);
  g.fill();
  g.strokeStyle = "rgba(190,255,120,0.95)";
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = "rgba(190,255,120,0.9)";
  const bars = [0.55, 0.8, 0.4, 0.95, 0.65, 0.3, 0.75];
  bars.forEach((b, i) => g.fillRect(24 + i * 30, 132 - b * 90, 18, b * 90));
  g.fillStyle = "rgba(160,240,255,0.85)";
  g.fillRect(24, 22, 110, 7);
  g.fillRect(150, 22, 60, 7);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Name tag height in metres (before label fitting). */
const LABEL_H = 0.24;

function labelSprite(text: string): THREE.Sprite {
  const font = `600 44px "Inter", "Helvetica Neue", "DejaVu Sans", Arial, sans-serif`;
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = font;
  const tw = Math.ceil(m.measureText(text).width);
  const h = 72, padL = 52, padR = 26, w = tw + padL + padR;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(12,14,18,0.78)";
  g.beginPath();
  g.roundRect(0, 0, w, h, h / 2);
  g.fill();
  g.fillStyle = LIME;
  g.beginPath();
  g.arc(30, h / 2, 9, 0, Math.PI * 2);
  g.fill();
  g.font = font;
  g.fillStyle = "#f4f6f8";
  g.textBaseline = "middle";
  g.fillText(text, padL, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false }));
  const H = LABEL_H;
  sp.scale.set((H * w) / h, H, 1);
  sp.userData.baseScale = [(H * w) / h, H];
  sp.center.set(0.5, 0);
  sp.renderOrder = 11;
  return sp;
}

// ---------------------------------------------------------------- robot parts

type PartName = "body" | "band" | "visor" | "eyes" | "eyeGlow" | "legL" | "legR" | "armL" | "armR" | "stalk" | "tip" | "gear" | "holo" | "blob" | "pack" | "led";

interface PartDef {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  tinted?: boolean; // instance colour = actor colour
  shadow?: boolean;
  billboard?: boolean;
}

function capsuleHanging(r: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  g.translate(0, -(len / 2 + r) + r * 0.6, 0); // pivot near the top
  return g;
}

function makeParts(): Record<PartName, PartDef> {
  const std = (color: string, rough: number, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  // Solid robot lights land on their exact colour on every backend (exact.ts); textured
  // additive glows (visor halo, holo screen) keep their texture colours untonemapped.
  const glowBasic = (color: string, extra: THREE.MeshBasicMaterialParameters = {}) => {
    const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });
    m.userData.glow = true;
    return extra.map ? m : makeExact(m, color);
  };
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

  // Body: a bean — capsule, slightly flattened front-to-back.
  const body = new THREE.CapsuleGeometry(0.24, 0.2, 10, 28);
  body.scale(1, 1, 0.9);
  // Leg + foot in one piece, pivot at the hip.
  const leg = capsuleHanging(0.052, 0.12);
  const foot = new THREE.SphereGeometry(0.07, 16, 10);
  foot.scale(1, 0.62, 1.35);
  foot.translate(0, -0.215, 0.025);
  const legGeo = mergeGeometries([leg.toNonIndexed(), foot.toNonIndexed()])!;
  // Arm + mitten.
  const arm = capsuleHanging(0.042, 0.11);
  const hand = new THREE.SphereGeometry(0.056, 14, 10);
  hand.translate(0, -0.2, 0);
  const armGeo = mergeGeometries([arm.toNonIndexed(), hand.toNonIndexed()])!;
  // Visor: a squashed sphere on the face.
  const visor = new THREE.SphereGeometry(0.2, 28, 16);
  visor.scale(1, 0.6, 0.5);
  // Eyes: two upright pills, merged.
  const eyeL = new THREE.CapsuleGeometry(0.026, 0.034, 4, 10);
  eyeL.translate(-0.068, 0, 0);
  const eyeR = new THREE.CapsuleGeometry(0.026, 0.034, 4, 10);
  eyeR.translate(0.068, 0, 0);
  const eyes = mergeGeometries([eyeL, eyeR])!;
  // Gear: disc + 8 teeth.
  const gearParts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.062, 0.062, 0.026, 24).toNonIndexed()];
  for (let i = 0; i < 8; i++) {
    const tooth = new THREE.BoxGeometry(0.03, 0.026, 0.034).toNonIndexed();
    tooth.translate(0, 0, 0.072);
    tooth.rotateY((i / 8) * Math.PI * 2);
    gearParts.push(tooth);
  }
  const gear = mergeGeometries(gearParts)!;
  gear.rotateX(Math.PI / 2); // face forward (+Z), spin around Z
  const holo = new THREE.PlaneGeometry(0.36, 0.225);
  const blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  return {
    body: { geo: body, mat: std("#ffffff", 0.38, 0.05), tinted: true, shadow: true },
    band: { geo: new THREE.TorusGeometry(0.232, 0.016, 8, 40).rotateX(Math.PI / 2), mat: std(GRAPHITE, 0.5, 0.4) },
    visor: { geo: visor, mat: std("#0b1015", 0.12, 0.35) },
    eyes: { geo: eyes, mat: glowBasic(LIME) },
    eyeGlow: { geo: new THREE.PlaneGeometry(1, 1), mat: glowBasic(LIME, { map: glowTexture(), ...additive, opacity: 0.55 }), billboard: true },
    legL: { geo: legGeo, mat: std(GRAPHITE, 0.55, 0.25), shadow: true },
    legR: { geo: legGeo, mat: std(GRAPHITE, 0.55, 0.25), shadow: true },
    armL: { geo: armGeo, mat: std("#ffffff", 0.4, 0.05), tinted: true, shadow: true },
    armR: { geo: armGeo, mat: std("#ffffff", 0.4, 0.05), tinted: true, shadow: true },
    stalk: { geo: new THREE.CylinderGeometry(0.011, 0.014, 0.13, 8).translate(0, 0.065, 0), mat: std(GRAPHITE, 0.5, 0.4) },
    tip: { geo: new THREE.SphereGeometry(0.034, 14, 10), mat: glowBasic(LIME) },
    gear: { geo: gear, mat: glowBasic("#93e626") },
    holo: { geo: holo, mat: glowBasic("#ffffff", { map: holoTexture(), ...additive, side: THREE.DoubleSide }), tinted: true },
    pack: { geo: new THREE.CapsuleGeometry(0.075, 0.12, 4, 12).rotateZ(Math.PI / 2).scale(1, 1.4, 0.7), mat: std(GRAPHITE, 0.45, 0.45) },
    led: { geo: new THREE.CapsuleGeometry(0.014, 0.12, 3, 8).rotateZ(Math.PI / 2), mat: glowBasic(LIME) },
    blob: { geo: blob, mat: new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.5, color: "#000000", polygonOffset: true, polygonOffsetFactor: -2 }) },
  };
}

// ---------------------------------------------------------------- actor records

interface Memory {
  pos: V3;
  yaw: number;
  moveSig: string;
  posSig: string;
}

interface ActorRec {
  spec: ActorSpec;
  sig: string;
  route: Sampled | null;
  routeKey: string;
  /** Live mode: when the current move began (live clock seconds), and where from. */
  epoch: number;
  origin: V3 | null;
  /** Live mode on a closed path: where on the loop the actor joins it. */
  liveOffset?: number;
  color: THREE.Color;
  seed: number;
  label?: THREE.Sprite;
  model?: THREE.Group;
  pose: ActorPose;
  disposed: boolean;
}

const _m = new THREE.Matrix4();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const TIP = new THREE.Matrix4().makeTranslation(0, 0.14, 0);
const smooth01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const scaleOf = (s: ActorSpec["transform"]): number => (s?.scale === undefined ? 1 : typeof s.scale === "number" ? s.scale : s.scale[1]);
const sigOf = (v: unknown) => JSON.stringify(v ?? null);

export class ActorSystem {
  readonly root = new THREE.Group();
  private parts: Record<PartName, PartDef> | null = null;
  private meshes = new Map<PartName, THREE.InstancedMesh>();
  private capacity = 0;
  private recs = new Map<string, ActorRec>();
  private memory = new Map<string, Memory>();
  private world: LivingWorld = { paths: [], graph: undefined };
  private worldKey = "";
  /** Time of the last update (script seconds in render mode, live clock otherwise). */
  private now = 0;
  /** Name tags fitted to the screen (label-fit.ts); null = plain world-size tags. */
  labelFit: LabelFitOptions | null = null;
  /** Viewport height in CSS px (label fitting). */
  viewportH = 720;

  constructor(private renderMode: boolean, private hooks: LivingHooks) {
    this.root.name = "__actors";
    this.root.userData.tera = "living";
  }

  get count() {
    return this.recs.size;
  }

  setWorld(w: LivingWorld) {
    const key = sigOf([w.paths, w.graph]);
    this.world = w;
    if (key !== this.worldKey) {
      this.worldKey = key;
      for (const r of this.recs.values()) r.routeKey = "";
    }
  }

  /** Add or refresh an actor from its JSON (called on every sync). */
  upsert(spec: ActorSpec) {
    const sig = sigOf(spec);
    let r = this.recs.get(spec.id);
    if (r && r.sig === sig) return;
    const mem = this.memory.get(spec.id);
    const moveSig = sigOf(spec.move);
    const posSig = sigOf(spec.transform?.position);
    if (!r) {
      r = {
        spec, sig, route: null, routeKey: "", epoch: 0, origin: null, color: new THREE.Color(), seed: 0,
        pose: { pos: (spec.transform?.position ?? [0, 0, 0]).slice() as V3, yaw: 0, phase: "idle", since: 0, speed: 0, stride: 0 }, disposed: false,
      };
      this.recs.set(spec.id, r);
    }
    // Live mode: a changed move (or a moved actor) continues from where it is drawn now.
    if (!this.renderMode && mem && (mem.moveSig !== moveSig || (!spec.move && mem.posSig !== posSig))) {
      r.epoch = this.now;
      r.origin = mem.pos.slice() as V3;
      r.pose.yaw = mem.yaw;
    }
    const styleChanged = r.spec.style !== spec.style || r.spec.src !== spec.src;
    const labelChanged = r.spec.label !== spec.label || (!!spec.label && !r.label);
    r.spec = spec;
    r.sig = sig;
    r.routeKey = "";
    r.seed = Math.floor(hash01(spec.id.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7), 3) * 1e6);
    r.color.set(spec.color ?? PALETTE[r.seed % PALETTE.length]!);
    if (labelChanged || !spec.label) {
      if (r.label) {
        r.label.removeFromParent();
        (r.label.material as THREE.SpriteMaterial).map?.dispose();
        r.label.material.dispose();
        r.label = undefined;
      }
      if (spec.label) {
        r.label = labelSprite(spec.label);
        this.root.add(r.label);
      }
    }
    if (styleChanged || (spec.style === "model" && !r.model)) this.setModel(r);
    this.memory.set(spec.id, { pos: r.pose.pos.slice() as V3, yaw: r.pose.yaw, moveSig, posSig });
  }

  remove(id: string) {
    const r = this.recs.get(id);
    if (!r) return;
    r.disposed = true;
    if (r.label) {
      r.label.removeFromParent();
      (r.label.material as THREE.SpriteMaterial).map?.dispose();
      r.label.material.dispose();
    }
    r.model?.removeFromParent();
    this.recs.delete(id);
  }

  /** Forget live-mode continuity (a new world was loaded in render mode, etc.). */
  clearMemory() {
    this.memory.clear();
  }

  private setModel(r: ActorRec) {
    r.model?.removeFromParent();
    r.model = undefined;
    if (r.spec.style !== "model" || !r.spec.src) return;
    const g = new THREE.Group();
    r.model = g;
    this.root.add(g);
    const src = r.spec.src;
    this.hooks.track(
      this.hooks.loadModel(this.hooks.resolve(src)).then(
        (obj) => { if (!r.disposed && r.model === g) g.add(obj); },
        (err) => this.hooks.warn(`actor "${r.spec.id}" (${src}): ${(err as Error).message ?? err}`),
      ),
    );
  }

  private buildRoute(r: ActorRec): Sampled | null {
    const m = r.spec.move;
    if (!m) {
      if (r.origin && !this.renderMode) {
        const to = (r.spec.transform?.position ?? [0, 0, 0]) as V3;
        return samplePoints([r.origin, to], {});
      }
      return null;
    }
    if (m.path) {
      const p = this.world.paths.find((x) => x.id === m.path);
      if (!p) return null;
      const s = samplePath(p);
      r.liveOffset = r.origin && s.closed ? nearestS(s, r.origin) : undefined;
      if (r.origin && !this.renderMode && !s.closed) {
        // Walk from where we are to the path start, then along it.
        return samplePoints(roundCorners([r.origin, ...(p.points as V3[])], 0.8), {});
      }
      return s;
    }
    const g = this.world.graph;
    if (!g || !m.to) return null;
    const startPos = (r.origin ?? r.spec.transform?.position ?? null) as V3 | null;
    const from = m.from ?? (startPos ? nearestNode(g, startPos) : undefined);
    if (!from) return null;
    const pts = route(g, this.world.paths, from, m.to);
    if (!pts) {
      this.hooks.warn(`actor "${r.spec.id}": no route from "${from}" to "${m.to}"`);
      return null;
    }
    if (!m.from && startPos) {
      const d = Math.hypot(startPos[0] - pts[0]![0], startPos[2] - pts[0]![2]);
      if (d > 0.05) pts.unshift(startPos);
    }
    return samplePoints(roundCorners(pts, 0.9), {});
  }

  private ensureMeshes(n: number) {
    if (n <= this.capacity && this.parts) return;
    if (!this.parts) this.parts = makeParts();
    let cap = Math.max(32, this.capacity);
    while (cap < n) cap *= 2;
    for (const m of this.meshes.values()) {
      m.removeFromParent();
      m.dispose();
    }
    this.meshes.clear();
    for (const [name, def] of Object.entries(this.parts) as [PartName, PartDef][]) {
      const mesh = new THREE.InstancedMesh(def.geo, def.mat, cap);
      mesh.name = `__actor-${name}`;
      mesh.frustumCulled = false;
      mesh.castShadow = !!def.shadow;
      mesh.receiveShadow = name === "body" || name === "armL" || name === "armR";
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (def.tinted || name === "eyes" || name === "tip") mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.count = 0;
      this.meshes.set(name, mesh);
      this.root.add(mesh);
    }
    this.capacity = cap;
  }

  /** Scale and fade one name tag for this camera (pure function of the pose). */
  private fitLabel(label: THREE.Sprite, camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    _p.copy(label.position).applyMatrix4(cam.matrixWorldInverse);
    const fit = labelFit(LABEL_H, -_p.z, cam.fov ?? 45, this.viewportH, this.labelFit!);
    const base = label.userData.baseScale as [number, number];
    label.scale.set(base[0] * fit.scale, base[1] * fit.scale, 1);
    (label.material as THREE.SpriteMaterial).opacity = fit.opacity;
    label.visible = fit.opacity > 0.01;
  }

  /** The nearest actor a ray passes through (a sphere around each robot), or null. */
  pick(ray: THREE.Ray): { id: string; distance: number; point: THREE.Vector3 } | null {
    let best: { id: string; distance: number; point: THREE.Vector3 } | null = null;
    const sphere = new THREE.Sphere();
    const at = new THREE.Vector3();
    for (const r of this.recs.values()) {
      if (r.spec.visible === false) continue;
      const s = scaleOf(r.spec.transform);
      sphere.center.set(r.pose.pos[0], r.pose.pos[1] + 0.55 * s, r.pose.pos[2]);
      sphere.radius = 0.55 * s;
      if (!ray.intersectSphere(sphere, at)) continue;
      const d = at.distanceTo(ray.origin);
      if (!best || d < best.distance) best = { id: r.spec.id, distance: d, point: at.clone() };
    }
    return best;
  }

  /** World box around an actor at its current pose, or null when there is no such actor. */
  box(id: string): THREE.Box3 | null {
    const r = this.recs.get(id);
    if (!r) return null;
    const s = scaleOf(r.spec.transform), p = r.pose.pos;
    return new THREE.Box3(new THREE.Vector3(p[0] - 0.45 * s, p[1], p[2] - 0.45 * s), new THREE.Vector3(p[0] + 0.45 * s, p[1] + 1.2 * s, p[2] + 0.45 * s));
  }

  /** Pose every actor at time t (script seconds in render mode, live clock otherwise). */
  update(t: number, camera: THREE.Camera) {
    this.now = t;
    const workers: ActorRec[] = [];
    for (const r of this.recs.values()) {
      if (r.routeKey !== this.worldKey) {
        r.route = this.buildRoute(r);
        r.routeKey = this.worldKey;
      }
      const spec = r.spec;
      const rest: Phase = spec.state ?? "idle";
      if (r.route) {
        const live = !this.renderMode && r.origin;
        const move = spec.move ? { ...spec.move } : { speed: 1.4 };
        if (live) {
          move.startT = r.epoch + (spec.move?.startT && spec.move.startT > 0 ? spec.move.startT : 0);
          if (r.liveOffset !== undefined) move.offset = r.liveOffset;
        }
        const lane = spec.move?.lane ?? autoLane(r.seed) * scaleOf(spec.transform);
        r.pose = actorPose(r.route, move, rest, t, lane);
      } else {
        const p = (spec.transform?.position ?? [0, 0, 0]) as V3;
        const yaw = THREE.MathUtils.degToRad(spec.transform?.rotation?.[1] ?? 0);
        r.pose = { pos: [p[0], p[1], p[2]], yaw, phase: rest === "walking" ? "walking" : rest, since: t + 100, speed: rest === "walking" ? 0.35 : 0, stride: rest === "walking" ? t * 0.5 : 0 };
      }
    }
    // Crowds: walkers step around each other (stateless, so render mode stays pose = f(t)).
    const all = [...this.recs.values()].filter((r) => r.spec.visible ?? true);
    separate(all.map((r) => r.pose.pos), all.map((r) => 0.55 * scaleOf(r.spec.transform)), all.map((r) => !!r.route));
    for (const r of this.recs.values()) {
      const spec = r.spec;
      const mem = this.memory.get(spec.id);
      if (mem) { mem.pos = r.pose.pos; mem.yaw = r.pose.yaw; }
      const visible = spec.visible ?? true;
      if (r.label) {
        r.label.visible = visible;
        const s = scaleOf(spec.transform);
        r.label.position.set(r.pose.pos[0], r.pose.pos[1] + 1.3 * s, r.pose.pos[2]);
        if (this.labelFit && visible) this.fitLabel(r.label, camera);
      }
      if (r.model) {
        r.model.visible = visible;
        r.model.position.fromArray(r.pose.pos);
        r.model.rotation.set(0, r.pose.yaw, 0);
        const s = scaleOf(spec.transform);
        r.model.scale.setScalar(s);
        r.model.position.y += Math.abs(Math.sin(r.pose.stride * Math.PI / 0.45)) * 0.03 * r.pose.speed * s;
      }
      if ((spec.style ?? "worker") === "worker" && visible) workers.push(r);
    }
    this.ensureMeshes(workers.length);
    for (const m of this.meshes.values()) m.count = workers.length;
    if (!workers.length) return;
    camera.getWorldQuaternion(_qb);
    workers.forEach((r, i) => this.poseWorker(r, i, t));
    for (const m of this.meshes.values()) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (m.castShadow) {
        m.boundingBox = null;
        m.boundingSphere = null;
      }
    }
  }

  private set(name: PartName, i: number, local: THREE.Matrix4 | null, color?: THREE.Color) {
    const mesh = this.meshes.get(name)!;
    if (!local) mesh.setMatrixAt(i, ZERO);
    else mesh.setMatrixAt(i, _m.multiplyMatrices(_root, local));
    if (color) mesh.setColorAt(i, color);
  }

  private poseWorker(r: ActorRec, i: number, t: number) {
    const { pose } = r;
    const s = scaleOf(r.spec.transform);
    const seed = r.seed;
    const tt = t + (seed % 997) * 0.013; // per-robot time offset so idles do not sync
    const walk = pose.phase === "walking" ? Math.max(pose.speed, 0.15) : 0;
    const work = pose.phase === "working" ? smooth01(pose.since / 0.45) : 0;
    const idle = Math.max(0, 1 - walk - work);
    const STRIDE = 0.46; // metres per full step cycle (two steps)
    const ph = (pose.stride / STRIDE) * Math.PI * 2;
    const sw = Math.sin(ph);
    const bob = Math.abs(Math.sin(ph)) * 0.04 * walk + Math.sin(tt * 2.6) * 0.006 * idle + Math.abs(Math.sin(tt * 13)) * 0.01 * work;
    const lean = 0.1 * walk * Math.min(1, pose.speed * 1.2) + 0.12 * work;
    const roll = sw * 0.06 * walk;
    const look = (Math.sin(tt * 0.45) * 0.35 + Math.sin(tt * 1.13) * 0.12) * idle;

    // Root: feet on the ground at pose.pos, facing yaw.
    _e.set(lean, pose.yaw + look, roll, "YXZ");
    _q.setFromEuler(_e);
    _p.set(pose.pos[0], pose.pos[1] + bob * s, pose.pos[2]);
    _s.setScalar(s);
    _root.compose(_p, _q, _s);

    const L = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      _e.set(rx, ry, rz, "XYZ");
      return _local.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
    };
    const breathe = 1 + Math.sin(tt * 2.6) * 0.012 * (idle + work);
    this.set("body", i, L(0, 0.6, 0, 0, 0, 0, 1, breathe, 1), r.color);
    this.set("band", i, L(0, 0.44, 0));
    this.set("visor", i, L(0, 0.7, 0.135));
    // Back: a little power pack with a lime charge strip.
    this.set("pack", i, L(0, 0.62, -0.205));
    this.set("led", i, L(0, 0.66, -0.262));
    // Blink every few seconds (per-robot rhythm), squint a little while working.
    const period = 2.8 + (seed % 7) * 0.45;
    const bt = (tt % period) / period;
    const blink = bt > 0.96 ? 0.15 : 1;
    this.set("eyes", i, L(0, 0.715, 0.232, 0, 0, 0, 1, blink * (1 - 0.35 * work), 1), _c.setScalar(1));
    // Visor glow: a camera-facing sprite just in front of the eyes.
    _m.multiplyMatrices(_root, L(0, 0.715, 0.27));
    _p.setFromMatrixPosition(_m);
    this.meshes.get("eyeGlow")!.setMatrixAt(i, _local.compose(_p, _qb, _s.setScalar(0.34 * s)));

    // Legs: swing with the stride; at rest stand slightly apart.
    const legSwing = 0.62 * walk;
    this.set("legL", i, L(-0.1, 0.3, 0, sw * legSwing, 0, 0.03));
    this.set("legR", i, L(0.1, 0.3, 0, -sw * legSwing, 0, -0.03));
    // Arms: swing opposite the legs; tap forward while working; tiny sway at idle.
    const tapL = Math.sin(tt * 15) * 0.22, tapR = Math.sin(tt * 15 + Math.PI) * 0.22;
    const idleArm = Math.sin(tt * 2.6) * 0.04;
    const armLx = -sw * 0.55 * walk + (-1.15 + tapL) * work + idleArm * idle;
    const armRx = sw * 0.55 * walk + (-1.15 + tapR) * work + idleArm * idle;
    this.set("armL", i, L(-0.245, 0.66, 0.0, armLx, 0, 0.18 + 0.12 * walk - 0.1 * work), r.color);
    this.set("armR", i, L(0.245, 0.66, 0.0, armRx, 0, -0.18 - 0.12 * walk + 0.1 * work), r.color);
    // Antenna lags behind the body: tilts back when walking, wobbles after taps.
    const wob = Math.sin(tt * 3.1) * 0.08 * idle + Math.sin(ph * 2) * 0.1 * walk + Math.sin(tt * 15) * 0.05 * work;
    this.set("stalk", i, L(0, 0.95, -0.02, -0.25 * walk + wob, 0, wob * 0.5));
    _m.multiplyMatrices(_root, L(0, 0.95, -0.02, -0.25 * walk + wob, 0, wob * 0.5));
    const tipM = _local.multiplyMatrices(_m, TIP);
    const pulse = 0.75 + 0.25 * Math.sin(tt * (work > 0 ? 9 : 2.2));
    this.meshes.get("tip")!.setMatrixAt(i, tipM);
    this.meshes.get("tip")!.setColorAt(i, _c.setScalar(pulse));

    // Working props: a gear spinning over the head, a holo screen in front.
    if (work > 0.01) {
      const k = smooth01(work);
      this.set("gear", i, L(0.0, 1.25 + Math.sin(tt * 2) * 0.02, 0.0, 0, 0, tt * 3.2, k, k, k));
      const flick = 0.85 + 0.15 * Math.sin(tt * 37) * Math.sin(tt * 11);
      this.set("holo", i, L(0, 0.62, 0.43, -0.45, 0, 0, k, k, 1), _c.setRGB(0.95 * flick, 1.0 * flick, 0.95 * flick));
    } else {
      this.set("gear", i, null);
      this.set("holo", i, null);
    }
    // Contact shadow: undo the bob/lean so it stays on the ground.
    _e.set(0, pose.yaw, 0, "YXZ");
    _root.compose(_p.set(pose.pos[0], pose.pos[1] + 0.012, pose.pos[2]), _q.setFromEuler(_e), _s.setScalar(s));
    const bs = 0.62 - bob * 2;
    this.set("blob", i, L(0, 0, 0.02, 0, 0, 0, bs, 1, bs));
  }
}
