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
import type { ActorCard, ActorMove, ActorTrail } from "../schema/living.ts";
import { actorPose, autoLane, hash01, nearestNode, nearestS, roundCorners, route, samplePath, samplePoints, separate, travel, DEFAULT_SPEED, type ActorPose, type Phase, type Sampled, type V3 } from "./living-math.ts";
import { QUEUE_EASE, journeyPlan, journeyPoint, journeyPose, queueOffset, queuePlaces, type JourneyPlan, type StopVisit } from "./journey-math.ts";
import type { LivingWorld } from "./flows.ts";
import { makeExact } from "./exact.ts";
import { labelFit, type LabelFitOptions } from "./label-fit.ts";
import { PLATE_FIT, ResidentFigure } from "./residents.ts";
import type { ResidentDef } from "../schema/residents.ts";

export interface ActorSpec {
  id: string;
  kind: "actor";
  style?: "worker" | "model" | "resident";
  src?: string;
  resident?: string;
  color?: string;
  label?: string;
  state?: Phase;
  move?: ActorMove;
  trail?: ActorTrail;
  card?: ActorCard;
  tags?: string[];
  transform?: { position?: V3; rotation?: V3; scale?: number | V3 };
  visible?: boolean;
}

/** A journey (move.stops) as built for the current world: its plan and the stop nodes. */
interface JourneyRec {
  plan: JourneyPlan;
  nodes: string[];
  nodePos: V3[];
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
  figure?: ResidentFigure;
  figureKey?: string;
  pose: ActorPose;
  disposed: boolean;
  journey?: JourneyRec;
  /** Journey state this frame (null when not on a journey). */
  jat?: { stop: number; since: number; startT: number; s: number; walking: boolean; tau: number } | null;
  trail?: THREE.Mesh;
  /** When its current name tag appeared (older tags win a declutter). */
  labelSeq?: number;
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
  /** world.residents by id (looks, names, roles of style "resident" actors). */
  private residents = new Map<string, ResidentDef>();
  private residentsKey = "";
  /** Viewport width in CSS px (label declutter). */
  viewportW = 1280;
  private labelSeqs = 0;

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

  /** The world's residents (world.residents): a changed look rebuilds the figures that use it. */
  setResidents(list: ResidentDef[] | undefined) {
    const key = sigOf(list ?? []);
    if (key === this.residentsKey) return;
    this.residentsKey = key;
    this.residents = new Map((list ?? []).map((r) => [r.id, r]));
    for (const r of this.recs.values()) if (r.figure) this.setFigure(r);
  }

  private figureKeyOf(spec: ActorSpec): string {
    const def = spec.resident ? this.residents.get(spec.resident) : undefined;
    return sigOf([spec.resident, spec.color, spec.label, def ?? null]);
  }

  /** Build (or rebuild) the figure of a style "resident" actor; drop it for any other style. */
  private setFigure(r: ActorRec) {
    const want = r.spec.style === "resident";
    const key = want ? this.figureKeyOf(r.spec) : "";
    if (r.figure && r.figureKey === key) return;
    r.figure?.dispose();
    r.figure = undefined;
    r.figureKey = undefined;
    if (!want) return;
    const def = r.spec.resident ? this.residents.get(r.spec.resident) ?? null : null;
    const name = r.spec.label || def?.name || r.spec.resident || r.spec.id;
    r.figure = new ResidentFigure(def, r.spec.color, name, r.seed);
    r.figureKey = key;
    this.root.add(r.figure.root);
    if (r.figure.plate) this.root.add(r.figure.plate);
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
    if (spec.style === "resident" || r.figure) this.setFigure(r);
    if (spec.style === "resident") {
      if (r.label) {
        r.label.removeFromParent();
        (r.label.material as THREE.SpriteMaterial).map?.dispose();
        r.label.material.dispose();
        r.label = undefined;
      }
    } else if (labelChanged || !spec.label) {
      if (r.label) {
        r.label.removeFromParent();
        (r.label.material as THREE.SpriteMaterial).map?.dispose();
        r.label.material.dispose();
        r.label = undefined;
      }
      if (spec.label) {
        r.label = labelSprite(spec.label);
        r.labelSeq = ++this.labelSeqs;
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
    r.figure?.dispose();
    if (r.trail) {
      r.trail.removeFromParent();
      r.trail.geometry.dispose();
      (r.trail.material as THREE.Material).dispose();
    }
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
    r.journey = undefined;
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
    if (m.stops?.length) return this.buildJourney(r, from, !m.from ? startPos : null);
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

  /** A journey's route: from → every stop → to, one polyline, with its plan (journey-math.ts). */
  private buildJourney(r: ActorRec, from: string, startPos: V3 | null): Sampled | null {
    const g = this.world.graph!;
    const m = r.spec.move!;
    const stops = m.stops!;
    const legs: V3[][] = [];
    let a = from;
    for (const n of [...stops.map((x) => x.to), m.to!]) {
      const pts = route(g, this.world.paths, a, n);
      if (!pts) {
        this.hooks.warn(`actor "${r.spec.id}": no route from "${a}" to "${n}"`);
        return null;
      }
      legs.push(pts);
      a = n;
    }
    if (startPos) {
      const p0 = legs[0]![0]!;
      if (Math.hypot(startPos[0] - p0[0], startPos[2] - p0[2]) > 0.05) legs[0]!.unshift(startPos);
    }
    const rounded = legs.map((pts) => roundCorners(pts, 0.9));
    const lens = rounded.map((pts) => pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1], p[2] - pts[i - 1]![2]) : 0), 0));
    const pos = new Map(g.nodes.map((n) => [n.id, n.position as V3]));
    r.journey = {
      plan: journeyPlan(lens, stops, m.speed ?? DEFAULT_SPEED),
      nodes: stops.map((x) => x.to),
      nodePos: stops.map((x) => pos.get(x.to) ?? [0, 0, 0]),
    };
    return samplePoints(rounded.flat(), {});
  }

  /** Actors carrying any of these tags are not drawn, labelled or pickable (viewer toggles, e.g. "journey"). */
  readonly hiddenTags = new Set<string>();
  private shown(r: ActorRec): boolean {
    if (r.spec.visible === false) return false;
    if (!this.hiddenTags.size || !r.spec.tags) return true;
    return !r.spec.tags.some((t) => this.hiddenTags.has(t));
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
      if (!this.shown(r)) continue;
      const s = scaleOf(r.spec.transform);
      const h = r.figure ? r.figure.height(s) / 2 : 0.55 * s;
      sphere.center.set(r.pose.pos[0], r.pose.pos[1] + h, r.pose.pos[2]);
      sphere.radius = h;
      if (!ray.intersectSphere(sphere, at)) continue;
      const d = at.distanceTo(ray.origin);
      if (!best || d < best.distance) best = { id: r.spec.id, distance: d, point: at.clone() };
    }
    return best;
  }

  /** What an actor is doing at the last update: its phase and, on a journey, the stop it stands at. */
  activity(id: string): { phase: Phase; stop?: string } | null {
    const r = this.recs.get(id);
    if (!r) return null;
    const stop = r.journey && r.jat && r.jat.stop >= 0 ? r.journey.nodes[r.jat.stop] : undefined;
    return { phase: r.pose.phase, ...(stop ? { stop } : {}) };
  }

  /** World box around an actor at its current pose, or null when there is no such actor. */
  box(id: string): THREE.Box3 | null {
    const r = this.recs.get(id);
    if (!r) return null;
    const s = scaleOf(r.spec.transform) * (r.figure ? r.figure.look.scale : 1), p = r.pose.pos;
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
        if (r.journey) {
          const startT = move.startT ?? 0;
          const jp = journeyPose(r.route, r.journey.plan, rest, t - startT, lane);
          r.pose = jp;
          r.jat = { stop: jp.at.stop, since: jp.at.since, startT, s: jp.at.s, walking: jp.at.phase === "walking", tau: t - startT };
        } else {
          r.pose = actorPose(r.route, move, rest, t, lane);
          r.jat = null;
        }
      } else {
        r.jat = null;
        const p = (spec.transform?.position ?? [0, 0, 0]) as V3;
        const yaw = THREE.MathUtils.degToRad(spec.transform?.rotation?.[1] ?? 0);
        r.pose = { pos: [p[0], p[1], p[2]], yaw, phase: rest === "walking" ? "walking" : rest, since: t + 100, speed: rest === "walking" ? 0.35 : 0, stride: rest === "walking" ? t * 0.5 : 0 };
      }
    }
    this.queue();
    // Crowds: walkers step around each other (stateless, so render mode stays pose = f(t)).
    // Journey actors standing at a stop count as standing (the queue placed them); residents are bigger.
    const all = [...this.recs.values()].filter((r) => this.shown(r));
    separate(all.map((r) => r.pose.pos), all.map((r) => 0.55 * scaleOf(r.spec.transform) * (r.figure ? r.figure.look.scale : 1)), all.map((r) => !!r.route && !(r.jat && r.jat.stop >= 0)));
    for (const r of this.recs.values()) {
      const spec = r.spec;
      const mem = this.memory.get(spec.id);
      if (mem) { mem.pos = r.pose.pos; mem.yaw = r.pose.yaw; }
      const visible = this.shown(r);
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
      if (r.figure) {
        r.figure.root.visible = visible;
        if (visible) r.figure.pose(r.pose, t, scaleOf(spec.transform));
        r.figure.placePlate(camera, this.labelFit ? PLATE_FIT : null, this.viewportH, visible && spec.label !== "");
      }
      if ((spec.style ?? "worker") === "worker" && visible) workers.push(r);
    }
    if (!this.renderMode && this.labelFit) this.declutter(camera);
    this.updateTrails();
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

  /**
   * Journey queues: actors standing at the same stop at the same time take places around it
   * (journey-math.ts queuePlaces / queueOffset), stepping there and back over QUEUE_EASE and
   * turning to face the stop. A pure function of every journey's plan and t.
   */
  private queue() {
    const standing = [...this.recs.values()].filter((r) => r.jat && r.jat.stop >= 0 && this.shown(r));
    if (!standing.length) return;
    const visits: StopVisit[] = [];
    for (const r of this.recs.values()) {
      if (!r.journey || !r.jat || !this.shown(r)) continue;
      const p = r.journey.plan;
      for (let i = 0; i < p.arrive.length; i++) visits.push({ key: r.spec.id, node: r.journey.nodes[i]!, a: r.jat.startT + p.arrive[i]!, b: r.jat.startT + p.depart[i]! });
    }
    const places = queuePlaces(visits);
    for (const r of standing) {
      const i = r.jat!.stop, p = r.journey!.plan;
      const place = places.get(`${r.spec.id}@${r.jat!.startT + p.arrive[i]!}`) ?? 0;
      if (place <= 0) continue;
      const off = queueOffset(place, r.pose.yaw, 0.75 * scaleOf(r.spec.transform));
      const dwell = p.dwell[i]!;
      const e = smooth01(Math.min(r.jat!.since, dwell - r.jat!.since) / QUEUE_EASE);
      r.pose.pos[0] += off[0] * e;
      r.pose.pos[2] += off[2] * e;
      const n = r.journey!.nodePos[i]!;
      const face = Math.atan2(n[0] - r.pose.pos[0], n[2] - r.pose.pos[2]);
      let d = face - r.pose.yaw;
      d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      r.pose.yaw += d * e;
    }
  }

  /**
   * Live mode: name tags never sit on top of each other. Tags are projected to the screen; a tag
   * overlapping one that appeared earlier is hidden until they part. (Render mode never does this:
   * frames stay a function of the script only.)
   */
  private declutter(camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    const k = this.viewportH / (2 * Math.tan(THREE.MathUtils.degToRad((cam.fov ?? 45) / 2)));
    const placed: [number, number, number, number][] = [];
    const list = [...this.recs.values()].filter((r) => r.label?.visible).sort((a, b) => (a.labelSeq ?? 0) - (b.labelSeq ?? 0));
    for (const r of list) {
      const l = r.label!;
      _p.copy(l.position).applyMatrix4(cam.matrixWorldInverse);
      const d = -_p.z;
      if (d <= 0.05) continue;
      _p.copy(l.position).project(cam);
      const x = (_p.x * 0.5 + 0.5) * this.viewportW, y = (-_p.y * 0.5 + 0.5) * this.viewportH;
      const w = (l.scale.x * k) / d, h = (l.scale.y * k) / d;
      const box: [number, number, number, number] = [x - w / 2, y - h, x + w / 2, y];
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
        l.visible = false;
        continue;
      }
      placed.push(box);
    }
  }

  // ---------------------------------------------------------------- trails

  /**
   * Trails (`trail`): a ribbon on the ground over the stretch walked in the last `seconds`
   * (journeys and one-shot `to` walks), fading to nothing at the tail. It shrinks away while
   * the actor stands. One small mesh per trailed actor; pure function of t.
   */
  private updateTrails() {
    for (const r of this.recs.values()) {
      const tr = r.spec.trail;
      const span = tr && this.shown(r) && r.route ? this.trailSpan(r, tr.seconds ?? 2.4) : null;
      if (!span || span[1] - span[0] < 0.05) {
        if (r.trail) r.trail.visible = false;
        continue;
      }
      if (!r.trail) {
        r.trail = makeTrailMesh();
        this.root.add(r.trail);
      }
      const mat = r.trail.material as THREE.MeshBasicMaterial;
      mat.color.set(tr!.color ?? r.spec.color ?? "#ffffff");
      mat.opacity = tr!.opacity ?? 0.8;
      r.trail.visible = true;
      const lane = r.spec.move?.lane ?? autoLane(r.seed) * scaleOf(r.spec.transform);
      writeTrail(r.trail.geometry, r.route!, r.journey?.plan.marks ?? [], span[0], span[1], lane, (tr!.width ?? 0.14) * scaleOf(r.spec.transform));
    }
  }

  /** [tail, head] arc lengths of the stretch walked in the last `seconds`, or null. */
  private trailSpan(r: ActorRec, seconds: number): [number, number] | null {
    if (r.journey && r.jat) {
      const p = r.journey.plan;
      const tail = journeyPose(r.route!, p, "idle", r.jat.tau - seconds, 0).at.s;
      return [tail, r.jat.s];
    }
    const m = r.spec.move;
    if (!m || m.path || m.loop || r.route!.closed) return null;
    const v = m.speed ?? DEFAULT_SPEED;
    const startT = !this.renderMode && r.origin ? r.epoch + (m.startT && m.startT > 0 ? m.startT : 0) : m.startT ?? 0;
    const s0 = Math.min(Math.max(m.offset ?? 0, 0), r.route!.length);
    const at = (tau: number) => (tau <= 0 ? s0 : s0 + travel(r.route!.length - s0, v, tau).s);
    return [at(this.now - startT - seconds), at(this.now - startT)];
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

// ---------------------------------------------------------------- trail meshes

const TRAIL_SEGS = 28;
let trailTex: THREE.Texture | null = null;
/** Alpha ramp along a trail: 0 at the tail (u = 0) to 1 at the feet (u = 1). */
function trailTexture(): THREE.Texture {
  if (trailTex) return trailTex;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 4;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, "rgba(255,255,255,0)");
  grd.addColorStop(0.55, "rgba(255,255,255,0.45)");
  grd.addColorStop(0.92, "rgba(255,255,255,1)");
  grd.addColorStop(1, "rgba(255,255,255,0.6)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 4);
  trailTex = new THREE.CanvasTexture(c);
  trailTex.colorSpace = THREE.SRGBColorSpace;
  trailTex.userData.shared = true;
  return trailTex;
}

function makeTrailMesh(): THREE.Mesh {
  const n = TRAIL_SEGS + 1;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const u = i / TRAIL_SEGS;
    uv.set([u, 0, u, 1], i * 4);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  const idx: number[] = [];
  for (let i = 0; i < TRAIL_SEGS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ map: trailTexture(), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "__actor-trail";
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

const _tp: V3 = [0, 0, 0], _tq: V3 = [0, 0, 0], _tt: V3 = [0, 0, 1];
/** Fill a trail ribbon over [s0, s1] of `route` (lane-shifted like the walker), lying on the ground. */
function writeTrail(geo: THREE.BufferGeometry, routeP: Sampled, marks: number[], s0: number, s1: number, lane: number, width: number) {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i <= TRAIL_SEGS; i++) {
    const s = s0 + ((s1 - s0) * i) / TRAIL_SEGS;
    journeyPoint(routeP, marks, s, lane, _tp, _tt);
    // the ribbon narrows towards the tail
    const w = width * (0.35 + 0.65 * (i / TRAIL_SEGS)) * 0.5;
    let nx = -_tt[2], nz = _tt[0];
    const h = Math.hypot(nx, nz);
    if (h > 1e-6) { nx /= h; nz /= h; } else { nx = 1; nz = 0; }
    _tq[0] = _tp[0]; _tq[1] = _tp[1] + 0.035; _tq[2] = _tp[2];
    arr.set([_tq[0] + nx * w, _tq[1], _tq[2] + nz * w, _tq[0] - nx * w, _tq[1], _tq[2] - nz * w], i * 6);
  }
  pos.needsUpdate = true;
}
