// Residents: named agents with a role, drawn as a figure of their own — not a worker robot
// (no dark visor, no antenna) and not a player (no human head, no cap). A resident is a
// rounder, taller character in its role's colour with a warm cream face (ink eyes, a small
// smile), a role badge on its chest, a glowing halo ring over its head in its accent colour
// and a prop that says what it does (the steward's lantern, the librarian's book ...). Its name
// plate is a light pill, the opposite of the workers' dark tags.
//
// Behaviour (all a pure function of the actor's pose and time, so render mode stays pose = f(t)):
//   walking  arms swing, the halo trails a little
//   working  the role's work gesture, a small holo panel in its accent colour, the halo spins
//   idle     "at home": the role's idle gesture (the steward looks out over the town with its
//            lantern up, the maintenance crew sweeps, the librarian reads, the simulator turns a
//            die over its hand ...), slow breathing, blinks
//
// Residents are few (≤ 64), so each is a small THREE.Group of shared geometries with its own
// two materials (body, accent). docs/residents.md.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ResidentDef } from "../schema/residents.ts";
import type { ActorPose } from "./living-math.ts";
import { makeExact } from "./exact.ts";
import { labelFit, type LabelFitOptions } from "./label-fit.ts";

import { lookOf, type Prop, type RoleLook } from "./resident-looks.ts";
export { ROLE_LOOKS, lookOf, type RoleLook } from "./resident-looks.ts";

const INK = "#2f2b26";
const CREAM = "#fbf6ec";
const GRAPHITE = "#3a3d42";
const WOOD = "#cfae80";

// ---------------------------------------------------------------- canvas art

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
}

/** A role badge: cream disc, accent rim, an ink icon. */
export function badgeTexture(badge: string, accent: string): THREE.Texture {
  const { c, g } = canvas(128, 128);
  g.fillStyle = CREAM;
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = accent;
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.lineWidth = 8;
  g.lineCap = "round";
  g.lineJoin = "round";
  drawIcon(g, badge, accent);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function drawIcon(g: CanvasRenderingContext2D, badge: string, accent: string) {
  const line = (pts: number[][]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x!, y!) : g.moveTo(x!, y!)));
    g.stroke();
  };
  const circle = (x: number, y: number, r: number, fill = false) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    fill ? g.fill() : g.stroke();
  };
  switch (badge) {
    case "key":
      circle(46, 52, 15);
      line([[58, 62], [88, 92]]);
      line([[76, 80], [84, 72]]);
      line([[84, 88], [92, 80]]);
      break;
    case "broom":
      line([[84, 30], [56, 74]]);
      g.beginPath();
      g.moveTo(50, 66); g.lineTo(66, 78); g.lineTo(56, 98); g.lineTo(32, 86); g.closePath();
      g.fill();
      break;
    case "dice":
      g.strokeRect(38, 38, 52, 52);
      for (const [x, y] of [[52, 52], [76, 76], [64, 64]]) circle(x!, y!, 5, true);
      break;
    case "chart":
      line([[36, 92], [92, 92]]);
      g.fillRect(42, 66, 12, 24);
      g.fillRect(60, 52, 12, 38);
      g.fillStyle = accent;
      g.fillRect(78, 38, 12, 52);
      break;
    case "hammer":
      line([[50, 92], [74, 52]]);
      g.fillRect(56, 34, 40, 18);
      break;
    case "letter":
      g.strokeRect(34, 44, 60, 42);
      line([[34, 44], [64, 68], [94, 44]]);
      break;
    case "book":
      line([[64, 44], [64, 92]]);
      line([[64, 44], [36, 38], [36, 86], [64, 92], [92, 86], [92, 38], [64, 44]]);
      break;
    case "dial":
      g.beginPath();
      g.arc(64, 72, 28, Math.PI, 0);
      g.stroke();
      g.strokeStyle = accent;
      line([[64, 72], [82, 54]]);
      g.fillStyle = INK;
      circle(64, 72, 6, true);
      break;
    case "wave":
      g.beginPath();
      for (let x = 32; x <= 96; x += 2) {
        const y = 64 + Math.sin((x - 32) / 64 * Math.PI * 3) * 16 * Math.sin((x - 32) / 64 * Math.PI);
        x === 32 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      break;
    case "lock":
      g.beginPath();
      g.arc(64, 56, 15, Math.PI, 0);
      g.stroke();
      g.fillRect(42, 56, 44, 34);
      g.fillStyle = CREAM;
      circle(64, 70, 5, true);
      break;
    case "bolt":
      g.beginPath();
      g.moveTo(70, 30); g.lineTo(44, 70); g.lineTo(62, 70); g.lineTo(56, 98); g.lineTo(84, 56); g.lineTo(66, 56); g.closePath();
      g.fill();
      break;
    case "eye":
      g.beginPath();
      g.moveTo(32, 64); g.quadraticCurveTo(64, 34, 96, 64); g.quadraticCurveTo(64, 94, 32, 64);
      g.stroke();
      circle(64, 64, 9, true);
      break;
    case "leaf":
      g.beginPath();
      g.moveTo(40, 90); g.quadraticCurveTo(40, 40, 90, 38); g.quadraticCurveTo(88, 88, 40, 90);
      g.fill();
      break;
    default: {
      // star
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 13 : 30;
        const x = 64 + Math.cos(a) * r, y = 66 + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.fill();
    }
  }
}

/** Name plate height in metres (before fitting). */
export const PLATE_H = 0.28;
/** Live viewer fit: a touch larger than the workers' tags (they are the characters). */
export const PLATE_FIT: LabelFitOptions = { maxPx: 24, minPx: 9, fadePx: 4, near: 0.9, nearFull: 2.4 };

/** A light pill: accent dot, the name in ink, the role in a quieter tone. */
export function plateSprite(name: string, role: string, accent: string): THREE.Sprite {
  const font = `650 44px "Inter", "Helvetica Neue", "DejaVu Sans", Arial, sans-serif`;
  const small = `500 34px "Inter", "Helvetica Neue", "DejaVu Sans", Arial, sans-serif`;
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = font;
  const nw = Math.ceil(m.measureText(name).width);
  m.font = small;
  const rw = role ? Math.ceil(m.measureText(role).width) : 0;
  const h = 76, padL = 56, gap = role ? 18 : 0, padR = 30, w = padL + nw + gap + rw + padR;
  const { c, g } = canvas(w, h);
  g.fillStyle = "rgba(251,248,242,0.95)";
  g.beginPath();
  g.roundRect(0, 0, w, h, h / 2);
  g.fill();
  g.strokeStyle = "rgba(58,53,46,0.18)";
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = accent;
  g.beginPath();
  g.arc(32, h / 2, 11, 0, Math.PI * 2);
  g.fill();
  g.textBaseline = "middle";
  g.font = font;
  g.fillStyle = INK;
  g.fillText(name, padL, h / 2 + 2);
  if (role) {
    g.font = small;
    g.fillStyle = "rgba(58,53,46,0.58)";
    g.fillText(role, padL + nw + gap, h / 2 + 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false }));
  sp.scale.set((PLATE_H * w) / h, PLATE_H, 1);
  sp.userData.baseScale = [(PLATE_H * w) / h, PLATE_H];
  sp.center.set(0.5, 0);
  sp.renderOrder = 12;
  return sp;
}

// ---------------------------------------------------------------- shared geometry

interface Geos {
  body: THREE.BufferGeometry;
  face: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  smile: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  halo: THREE.BufferGeometry;
  badge: THREE.BufferGeometry;
  badgeRim: THREE.BufferGeometry;
  blob: THREE.BufferGeometry;
  holo: THREE.BufferGeometry;
  props: Record<Exclude<Prop, "none">, { geo: THREE.BufferGeometry; mat: "wood" | "graphite" | "accent" | "body" | "cream" | "lamp" }[]>;
}
let G: Geos | null = null;

function hanging(r: number, len: number) {
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  g.translate(0, -(len / 2 + r) + r * 0.6, 0);
  return g;
}

function geos(): Geos {
  if (G) return G;
  const body = new THREE.CapsuleGeometry(0.26, 0.24, 12, 32);
  body.scale(1, 1, 0.9);
  const face = new THREE.SphereGeometry(0.19, 32, 20);
  face.scale(1.0, 0.7, 0.4);
  const eye = new THREE.CapsuleGeometry(0.022, 0.03, 4, 10);
  const smile = new THREE.TorusGeometry(0.035, 0.009, 6, 16, Math.PI);
  smile.rotateZ(Math.PI);
  const leg = hanging(0.055, 0.1);
  const foot = new THREE.SphereGeometry(0.075, 16, 10);
  foot.scale(1, 0.6, 1.4);
  foot.translate(0, -0.2, 0.03);
  const legGeo = mergeNonIndexed([leg, foot]);
  const arm = hanging(0.045, 0.12);
  const hand = new THREE.SphereGeometry(0.06, 14, 10);
  hand.translate(0, -0.21, 0);
  const armGeo = mergeNonIndexed([arm, hand]);
  const halo = new THREE.TorusGeometry(0.15, 0.018, 8, 40).rotateX(Math.PI / 2);
  const badge = new THREE.CircleGeometry(0.075, 28);
  const badgeRim = new THREE.TorusGeometry(0.078, 0.008, 6, 28);
  const blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const holo = new THREE.PlaneGeometry(0.34, 0.22);

  // props, in the RIGHT hand's frame (hand at y -0.21 of the arm pivot), or the body's for the satchel
  const lanternBody = new THREE.CylinderGeometry(0.045, 0.05, 0.1, 14).translate(0, -0.33, 0.02);
  const lanternTop = new THREE.ConeGeometry(0.055, 0.04, 14).translate(0, -0.26, 0.02);
  const lanternLoop = new THREE.TorusGeometry(0.022, 0.006, 6, 12).translate(0, -0.235, 0.02);
  const broomStick = new THREE.CylinderGeometry(0.012, 0.012, 0.75, 8).translate(0, -0.3, 0.05);
  const broomHead = new THREE.BoxGeometry(0.16, 0.1, 0.05).translate(0, -0.69, 0.05);
  const die = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  const board = new THREE.BoxGeometry(0.17, 0.22, 0.014).rotateX(-0.35).translate(0, -0.24, 0.1);
  const boardScreen = new THREE.PlaneGeometry(0.13, 0.15).rotateX(-0.35).translate(0, -0.24, 0.108);
  const hamHandle = new THREE.CylinderGeometry(0.011, 0.011, 0.24, 8).rotateX(Math.PI / 2).translate(0, -0.22, 0.1);
  const hamHead = new THREE.BoxGeometry(0.1, 0.045, 0.045).translate(0, -0.22, 0.22);
  const satchel = new THREE.BoxGeometry(0.16, 0.13, 0.07).translate(0, 0, 0);
  const strap = new THREE.TorusGeometry(0.27, 0.012, 6, 48).rotateX(Math.PI / 2);
  const book = new THREE.BoxGeometry(0.17, 0.12, 0.03).rotateX(-0.6).translate(0, -0.23, 0.1);
  const pages = new THREE.BoxGeometry(0.15, 0.105, 0.033).rotateX(-0.6).translate(0, -0.226, 0.1);
  const wrench = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 8).rotateX(Math.PI / 2).translate(0, -0.22, 0.09);
  const wrenchHead = new THREE.TorusGeometry(0.03, 0.011, 6, 14, Math.PI * 1.5).translate(0, -0.22, 0.2);
  G = {
    body, face, eye, smile, leg: legGeo, arm: armGeo, halo, badge, badgeRim, blob, holo,
    props: {
      lantern: [{ geo: lanternBody, mat: "lamp" }, { geo: lanternTop, mat: "graphite" }, { geo: lanternLoop, mat: "graphite" }],
      broom: [{ geo: broomStick, mat: "wood" }, { geo: broomHead, mat: "accent" }],
      die: [{ geo: die, mat: "cream" }],
      board: [{ geo: board, mat: "graphite" }, { geo: boardScreen, mat: "accent" }],
      hammer: [{ geo: hamHandle, mat: "wood" }, { geo: hamHead, mat: "graphite" }],
      satchel: [{ geo: satchel, mat: "wood" }, { geo: strap, mat: "wood" }],
      book: [{ geo: book, mat: "accent" }, { geo: pages, mat: "cream" }],
      wrench: [{ geo: wrench, mat: "graphite" }, { geo: wrenchHead, mat: "graphite" }],
    },
  };
  return G;
}

function mergeNonIndexed(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

let blobTex: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const { c, g } = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(0,0,0,0.85)");
  grd.addColorStop(0.55, "rgba(0,0,0,0.4)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  blobTex.userData.shared = true;
  return blobTex;
}

function holoTexture(accent: string): THREE.Texture {
  const { c, g } = canvas(256, 160);
  const col = new THREE.Color(accent);
  const rgba = (a: number) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
  g.fillStyle = rgba(0.14);
  g.beginPath();
  g.roundRect(4, 4, 248, 152, 16);
  g.fill();
  g.strokeStyle = rgba(0.95);
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = rgba(0.9);
  [0.5, 0.75, 0.35, 0.9, 0.6].forEach((b, i) => g.fillRect(30 + i * 40, 130 - b * 90, 24, b * 90));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- one figure

const smooth01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

export class ResidentFigure {
  readonly root = new THREE.Group();
  readonly look: RoleLook & { scale: number };
  private body = new THREE.Group(); // above the hips: leans, bobs
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private eyes: THREE.Mesh[] = [];
  private halo: THREE.Mesh;
  private holo: THREE.Mesh;
  private die: THREE.Group | null = null;
  private blob: THREE.Mesh;
  private mats: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  plate: THREE.Sprite | null = null;

  constructor(def: ResidentDef | null, fallbackColor: string | undefined, name: string, private seed: number) {
    const g = geos();
    this.look = lookOf(def, fallbackColor);
    const L = this.look;
    this.root.name = "__resident";
    const std = (color: string, rough: number, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}) => this.mat(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra }));
    const glow = (color: string) => {
      const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      m.userData.glow = true;
      return this.mat(makeExact(m, color));
    };
    const bodyMat = std(L.body, 0.42, 0.04);
    const cream = std(CREAM, 0.5);
    const ink = std(INK, 0.6);
    const graphite = std(GRAPHITE, 0.5, 0.3);
    const accentMat = std(L.accent, 0.45, 0.05, { emissive: new THREE.Color(L.accent).multiplyScalar(0.18) });
    const wood = std(WOOD, 0.7);
    const lamp = glow("#ffd89a");
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, shadow = false) => {
      const x = new THREE.Mesh(geo, m);
      x.castShadow = shadow;
      x.receiveShadow = shadow;
      parent.add(x);
      return x;
    };

    this.root.add(this.body, this.legL, this.legR);
    this.legL.position.set(-0.11, 0.3, 0);
    this.legR.position.set(0.11, 0.3, 0);
    mesh(g.leg, graphite, this.legL, true);
    mesh(g.leg, graphite, this.legR, true);

    const torso = mesh(g.body, bodyMat, this.body, true);
    torso.position.set(0, 0.64, 0);
    const face = mesh(g.face, cream, this.body);
    face.position.set(0, 0.79, 0.175);
    for (const x of [-0.062, 0.062]) {
      const e = mesh(g.eye, ink, this.body);
      e.position.set(x, 0.805, 0.243);
      this.eyes.push(e);
    }
    const smile = mesh(g.smile, ink, this.body);
    smile.position.set(0, 0.755, 0.246);
    smile.scale.set(1, 0.7, 1);

    const tex = badgeTexture(L.badge, L.accent);
    this.textures.push(tex);
    const badgeMat = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    const badge = mesh(g.badge, badgeMat, this.body);
    badge.position.set(0.085, 0.565, 0.236);
    badge.rotation.set(-0.08, 0.36, 0);
    const rim = mesh(g.badgeRim, accentMat, this.body);
    rim.position.copy(badge.position);
    rim.rotation.copy(badge.rotation);

    this.halo = mesh(g.halo, glow(L.accent), this.body);
    this.halo.position.set(0, 1.12, 0);

    this.armL.position.set(-0.27, 0.74, 0);
    this.armR.position.set(0.27, 0.74, 0);
    this.body.add(this.armL, this.armR);
    mesh(g.arm, bodyMat, this.armL, true);
    mesh(g.arm, bodyMat, this.armR, true);

    const pm = { wood, graphite, accent: accentMat, body: bodyMat, cream, lamp };
    if (L.prop !== "none") {
      const parts = g.props[L.prop];
      if (L.prop === "satchel") {
        const bag = new THREE.Group();
        bag.position.set(0.22, 0.47, 0.04);
        this.body.add(bag);
        mesh(parts[0]!.geo, pm[parts[0]!.mat], bag, true);
        const strap = mesh(parts[1]!.geo, pm[parts[1]!.mat], this.body);
        strap.position.set(0, 0.6, 0);
        strap.rotation.z = -0.42;
        strap.scale.set(1, 1, 0.93);
      } else if (L.prop === "die") {
        this.die = new THREE.Group();
        this.body.add(this.die);
        mesh(parts[0]!.geo, pm.cream, this.die, true);
        const dots = new THREE.SphereGeometry(0.011, 8, 6);
        for (const [x, y, z] of [[0, 0, 0.041], [0.041, 0.018, 0.018], [0.041, -0.018, -0.018], [0, 0.041, 0]]) {
          const d = mesh(dots, ink, this.die);
          d.position.set(x!, y!, z!);
        }
      } else {
        for (const p of parts) mesh(p.geo, pm[p.mat], this.armR, true);
      }
    }

    const holoMat = new THREE.MeshBasicMaterial({ map: holoTexture(L.accent), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    holoMat.userData.glow = true;
    this.textures.push(holoMat.map!);
    this.holo = mesh(g.holo, this.mat(holoMat), this.body);
    this.holo.position.set(0, 0.66, 0.46);
    this.holo.rotation.x = -0.4;
    this.holo.visible = false;

    this.blob = new THREE.Mesh(g.blob, this.mat(new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.45, color: "#000000", polygonOffset: true, polygonOffsetFactor: -2 })));
    this.root.add(this.blob);

    this.plate = plateSprite(name, def?.role ?? "", L.accent);
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  /** Pose for this frame. `s` = the actor's own transform scale (multiplies the look's). */
  pose(p: ActorPose, t: number, s: number) {
    const L = this.look;
    const S = L.scale * s;
    const tt = t + (this.seed % 997) * 0.013;
    const walk = p.phase === "walking" ? Math.max(p.speed, 0.15) : 0;
    const work = p.phase === "working" ? smooth01(p.since / 0.45) : 0;
    const idle = Math.max(0, 1 - walk - work);
    const ph = (p.stride / 0.52) * Math.PI * 2;
    const sw = Math.sin(ph);
    const bob = Math.abs(sw) * 0.035 * walk + Math.sin(tt * 2.2) * 0.008 * idle;
    this.root.position.set(p.pos[0], p.pos[1], p.pos[2]);
    this.root.rotation.set(0, p.yaw, 0);
    this.root.scale.setScalar(S);

    // the role's gesture at home (idle) and at work
    const g = L.gesture;
    let look = (Math.sin(tt * 0.4) * 0.3 + Math.sin(tt * 1.07) * 0.1) * idle;
    let armLx = Math.sin(tt * 2.2) * 0.04 * idle, armRx = armLx, armLz = 0.16, armRz = -0.16, lean = 0;
    if (g === "watch") {
      // looks out over the town in long slow sweeps, lantern held up now and then
      look = Math.sin(tt * 0.32) * 0.65 * idle;
      const up = smooth01((Math.sin(tt * 0.5) + 0.2) * 1.4);
      armRx += -1.25 * up * idle;
      armRz -= 0.2 * up * idle;
    } else if (g === "sweep") {
      const k = Math.sin(tt * 2.4);
      armRx += (-0.55 + k * 0.35) * idle;
      armLx += (-0.75 + k * 0.3) * idle;
      armLz -= 0.22 * idle;
      look = k * 0.12 * idle;
      lean = 0.12 * idle;
    } else if (g === "read") {
      armRx += -1.05 * idle;
      armLx += -1.05 * idle;
      armRz -= -0.28 * idle;
      armLz -= 0.28 * idle;
      lean = 0.08 * idle;
      look = Math.sin(tt * 0.25) * 0.08 * idle;
    } else if (g === "juggle") {
      armRx += (-0.95 + Math.sin(tt * 3) * 0.12) * idle;
    } else if (g === "hammer") {
      armRx += (-0.9 + Math.max(0, Math.sin(tt * 3.4)) * -0.55) * idle * 0.7;
    } else if (g === "carry") {
      const wave = smooth01(Math.sin(tt * 0.45) * 3 - 2);
      armLx += -2.4 * wave * idle;
      armLz += 0.35 * wave * idle + Math.sin(tt * 9) * 0.25 * wave * idle;
    } else if (g === "tinker") {
      armRx += (-0.9 + Math.sin(tt * 6) * 0.08) * idle;
      armRz -= -0.35 * idle;
      look = -0.12 * idle;
    } else if (g === "hum") {
      look = Math.sin(tt * 1.1) * 0.18 * idle;
      armLz += Math.sin(tt * 1.1) * 0.15 * idle;
      armRz -= Math.sin(tt * 1.1) * 0.15 * idle;
    } else if (g === "pace") {
      look = Math.sin(tt * 0.6) * 0.45 * idle;
    } else if (g === "wave") {
      const wave = smooth01(Math.sin(tt * 0.4) * 3 - 2);
      armRx += -2.5 * wave * idle;
      armRz += Math.sin(tt * 8) * 0.25 * wave * idle;
    }
    // walking + working on top
    armLx += -sw * 0.5 * walk;
    armRx += sw * 0.5 * walk;
    armLz += 0.1 * walk;
    armRz -= 0.1 * walk;
    const tapL = Math.sin(tt * 13) * 0.2, tapR = Math.sin(tt * 13 + Math.PI) * 0.2;
    armLx += (-1.1 + tapL) * work;
    armRx += (-1.1 + tapR) * work;
    lean += 0.08 * walk * Math.min(1, p.speed) + 0.1 * work;

    this.body.position.set(0, bob, 0);
    this.body.rotation.set(lean, look, Math.sin(ph) * 0.05 * walk, "YXZ");
    const breathe = 1 + Math.sin(tt * 2.2) * 0.012 * (idle + work);
    this.body.scale.set(1, breathe, 1);
    this.legL.rotation.set(sw * 0.6 * walk, 0, 0.03);
    this.legR.rotation.set(-sw * 0.6 * walk, 0, -0.03);
    this.armL.rotation.set(armLx, 0, armLz);
    this.armR.rotation.set(armRx, 0, armRz);

    // blink; happy squint at home
    const period = 3.1 + (this.seed % 5) * 0.5;
    const blink = (tt % period) / period > 0.955 ? 0.15 : 1;
    for (const e of this.eyes) e.scale.set(1, blink * (1 - 0.3 * work), 1);

    // the halo: floats, spins faster at work, trails when walking
    this.halo.position.set(0, 1.12 + Math.sin(tt * 1.6) * 0.02, -0.03 * walk);
    this.halo.rotation.set(-0.12 * walk + Math.sin(tt * 0.9) * 0.05, tt * (0.5 + 2.5 * work), 0);
    const hs = 1 + 0.06 * work * Math.sin(tt * 6);
    this.halo.scale.setScalar(hs);

    if (this.die) {
      const hop = Math.abs(Math.sin(tt * 3));
      this.die.visible = idle + work > 0.3;
      this.die.position.set(0.26, 0.86 + hop * 0.18, 0.2);
      this.die.rotation.set(tt * 2.1, tt * 1.3, 0);
    }
    this.holo.visible = work > 0.05;
    this.holo.scale.setScalar(Math.max(0.01, work));

    // contact shadow stays on the ground
    const bs = 0.7 - bob * 2;
    this.blob.position.set(0, 0.012, 0.02);
    this.blob.scale.set(bs, 1, bs);
  }

  /** Name plate over the halo, fitted to the camera (or world-sized without fit). */
  placePlate(camera: THREE.Camera, fit: LabelFitOptions | null, viewportH: number, visible: boolean) {
    const sp = this.plate;
    if (!sp) return;
    const S = this.root.scale.x;
    sp.position.set(this.root.position.x, this.root.position.y + 1.32 * S, this.root.position.z);
    sp.visible = visible;
    if (!fit || !visible) return;
    const cam = camera as THREE.PerspectiveCamera;
    const v = sp.position.clone().applyMatrix4(cam.matrixWorldInverse);
    const f = labelFit(PLATE_H, -v.z, cam.fov ?? 45, viewportH, fit);
    const base = sp.userData.baseScale as [number, number];
    sp.scale.set(base[0] * f.scale, base[1] * f.scale, 1);
    (sp.material as THREE.SpriteMaterial).opacity = f.opacity;
    sp.visible = f.opacity > 0.01;
  }

  /** Height of the figure (m) at transform scale s, for picking and framing. */
  height(s = 1) {
    return 1.25 * this.look.scale * s;
  }

  dispose() {
    this.root.removeFromParent();
    this.plate?.removeFromParent();
    for (const m of this.mats) m.dispose();
    for (const t of this.textures) t.dispose();
    if (this.plate) {
      (this.plate.material as THREE.SpriteMaterial).map?.dispose();
      this.plate.material.dispose();
    }
  }
}
