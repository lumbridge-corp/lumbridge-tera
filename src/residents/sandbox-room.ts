// A sandbox room: a glass room you can see into, with its policy on the door. Plain world JSON
// (primitives + text), so it renders everywhere, ships in any world and needs no engine code to
// draw. CONTRACT.md section 1d, docs/residents.md.
//
//   const room = sandboxRoom({ id: "ci-room", name: "CI runners", size: [5, 4], policy });
//   world.entities.push({ ...room.entity, transform: { position, rotation: [0, yaw, 0] } });
//   // room.spots (local coordinates): the door outside / inside, a work spot and slots inside,
//   // for the world's walking graph.
//
// Live ids (a feed may update them; all inside the room's group):
//   <id>-contain   the lit ledge round the glass's foot: CONTAIN_OFF (soft sea-green) when calm;
//                  CONTAIN_ON when an agent inside tried to reach out (a denied connection ...)
//   <id>-lamp      the status lamp over the door: LAMP_IDLE / LAMP_BUSY / LAMP_OFF
//   <id>-count     the plaque's last line ("3 inside"): an update op with a new `text`
// Entry faces local +Z, like a building part. No lights (emissive only), no shadows cast by glass.
import type { SandboxPolicy } from "../schema/residents.ts";

type V3 = [number, number, number];
type Ent = Record<string, unknown> & { id: string; kind: string };

export interface SandboxRoomSpec {
  id: string;
  name: string;
  /** Floor [width along X, depth along Z] in metres (min 2.4 x 2.2). */
  size: [number, number];
  /** Clear height (default 2.6). */
  height?: number;
  policy: SandboxPolicy;
  /** The plaque's live line at build time (default "empty"). */
  count?: string;
  /** What stands along the back wall: server racks, a desk with screens, a workbench, or nothing (default "desk"). */
  furnish?: "rack" | "desk" | "bench" | "none";
  /** Override colours (defaults: a light, neutral architect's-model palette). */
  colors?: Partial<typeof COLORS>;
}

export const COLORS = {
  base: "#e4dccd",
  floor: "#ebe5d9",
  frame: "#e3cba4",
  roof: "#fbf8f2",
  glass: "#e3efee",
  board: "#fbf8f2",
  ink: "#3a352e",
  sill: "#d8cab2",
  wood: "#cfae80",
  machine: "#3b3e42",
  metal: "#c9ccce",
};
/** Material for <id>-contain when something inside tried to get out. */
export const CONTAIN_ON = { color: "#ffb28a", emissive: "#e0703c", roughness: 0.4, glow: 2.2 };
/** ... and when all is calm: a soft sea-green line round the room's foot (it reads as "held"). */
export const CONTAIN_OFF = { color: "#cfe3da", emissive: "#6fb39a", roughness: 0.5, glow: 0.32 };
export const LAMP_IDLE = { color: "#cfe0c4", emissive: "#7fa36a", roughness: 0.3, glow: 0.8 };
export const LAMP_BUSY = { color: "#ffe2a8", emissive: "#e0a040", roughness: 0.3, glow: 1.6 };
export const LAMP_OFF = { color: "#b9bcbe", roughness: 0.5, glow: 0 };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The plaque's policy lines (also what a card shows). */
export function policyLines(p: SandboxPolicy): string[] {
  const tools = p.tools.length === 0 ? "none" : p.tools.includes("*") ? "all" : p.tools.join(", ");
  return [`network  ${p.network}`, `files  ${p.files}`, `tools  ${tools}`, ...(p.enforcer ? [`by  ${p.enforcer}`] : [])];
}

export function sandboxRoom(spec: SandboxRoomSpec): { entity: Ent; spots: { outside: V3; inside: V3; work: V3; slots: V3[] } } {
  const c = { ...COLORS, ...(spec.colors ?? {}) };
  const [w, d] = [Math.max(2.4, spec.size[0]), Math.max(2.2, spec.size[1])];
  const h = spec.height ?? 2.6;
  const id = spec.id;
  const furnish = spec.furnish ?? "desk";
  const base = 0.14; // floor top
  const top = base + h;
  const doorW = 1.0;
  const t = 0.05; // glass thickness
  const fz = d / 2, fx = w / 2;
  const mat = (color: string, roughness = 0.85, extra: Record<string, unknown> = {}) => ({ color, roughness, metalness: 0, ...extra });
  const glass = { color: c.glass, roughness: 0.06, metalness: 0.1, glass: true };
  const frame = mat(c.frame, 0.7);
  const box = (sid: string, size: V3, position: V3, material: Record<string, unknown>, more: Record<string, unknown> = {}): Ent => ({ id: `${id}-${sid}`, kind: "primitive", shape: "box", size: size.map(r3), transform: { position: position.map(r3) }, material, ...more });
  const kids: Ent[] = [];

  // plinth; the containment sill (one entity: a lit ledge all round the glass's foot, sea-green when
  // calm, orange when something tried to get out); the floor on it
  kids.push(box("plinth", [w + 0.3, 0.07, d + 0.36], [0, 0.035, 0], mat(c.base, 0.9), { radius: 0.03 }));
  kids.push({ ...box("contain", [w + 0.2, 0.06, d + 0.2], [0, 0.1, 0], CONTAIN_OFF), tags: ["sandbox-contain"] });
  kids.push(box("floor", [w - 0.12, 0.03, d - 0.12], [0, 0.125, 0], mat(c.floor, 0.9)));

  // glass: back, sides, the front either side of the door (the door sits left of centre, so
  // whoever works inside stands clear of it and of its plaque)
  const dx = r3(-fx + 0.45 + doorW / 2); // door centre
  const leftW = dx - doorW / 2 + fx, rightW = fx - (dx + doorW / 2);
  kids.push(box("glass-back", [w - 0.1, h, t], [0, base + h / 2, -fz + 0.05], glass));
  kids.push(box("glass-left", [t, h, d - 0.1], [-fx + 0.05, base + h / 2, 0], glass));
  kids.push(box("glass-right", [t, h, d - 0.1], [fx - 0.05, base + h / 2, 0], glass));
  kids.push(box("glass-front-l", [leftW - 0.05, h, t], [-fx + leftW / 2, base + h / 2, fz - 0.05], glass));
  kids.push(box("glass-front-r", [rightW - 0.05, h, t], [fx - rightW / 2, base + h / 2, fz - 0.05], glass));
  // the door: a glass leaf in a pale-wood frame, closed, a bar handle
  const doorH = Math.min(2.15, h - 0.25);
  kids.push(box("door", [doorW - 0.08, doorH - 0.04, t], [dx, base + doorH / 2, fz - 0.03], glass));
  kids.push(box("door-head", [doorW + 0.08, 0.08, 0.1], [dx, base + doorH + 0.04, fz - 0.05], frame));
  kids.push(box("door-handle", [0.035, 0.42, 0.05], [dx + doorW / 2 - 0.13, base + 1.0, fz + 0.01], mat(c.metal, 0.35, { metalness: 0.8 })));

  // pale-wood frame: corner posts, the door's jambs, mullions on the long runs of glass, a ring
  // beam, a transom rail at the door head's height and a kick rail at the foot
  const post = (sid: string, x: number, z: number, s = 0.09) => box(sid, [s, h, s], [x, base + h / 2, z], frame);
  kids.push(post("post-bl", -fx + 0.05, -fz + 0.05), post("post-br", fx - 0.05, -fz + 0.05), post("post-fl", -fx + 0.05, fz - 0.05), post("post-fr", fx - 0.05, fz - 0.05));
  kids.push(post("jamb-l", dx - doorW / 2, fz - 0.05), post("jamb-r", dx + doorW / 2, fz - 0.05));
  const mullions = (len: number) => Math.max(0, Math.ceil(len / 1.45) - 1);
  for (let i = 1, n = mullions(w); i <= n; i++) kids.push(post(`mullion-b${i}`, -fx + (w * i) / (n + 1), -fz + 0.05, 0.06));
  for (let i = 1, n = mullions(d); i <= n; i++) {
    const z = -fz + (d * i) / (n + 1);
    kids.push(post(`mullion-l${i}`, -fx + 0.05, z, 0.06), post(`mullion-r${i}`, fx - 0.05, z, 0.06));
  }
  kids.push(box("beam-front", [w, 0.12, 0.12], [0, top - 0.06, fz - 0.05], frame));
  kids.push(box("beam-back", [w, 0.12, 0.12], [0, top - 0.06, -fz + 0.05], frame));
  kids.push(box("beam-left", [0.12, 0.12, d], [-fx + 0.05, top - 0.06, 0], frame));
  kids.push(box("beam-right", [0.12, 0.12, d], [fx - 0.05, top - 0.06, 0], frame));
  const ty = base + doorH + 0.03;
  kids.push(box("transom-back", [w - 0.1, 0.05, 0.08], [0, ty, -fz + 0.05], frame));
  kids.push(box("transom-left", [0.08, 0.05, d - 0.1], [-fx + 0.05, ty, 0], frame));
  kids.push(box("transom-right", [0.08, 0.05, d - 0.1], [fx - 0.05, ty, 0], frame));
  kids.push(box("transom-front-r", [rightW - 0.05, 0.05, 0.08], [fx - rightW / 2, ty, fz - 0.05], frame));
  if (leftW > 0.2) kids.push(box("transom-front-l", [leftW - 0.05, 0.05, 0.08], [-fx + leftW / 2, ty, fz - 0.05], frame));
  const ky = base + 0.07;
  kids.push(box("kick-back", [w - 0.1, 0.14, 0.08], [0, ky, -fz + 0.05], frame));
  kids.push(box("kick-left", [0.08, 0.14, d - 0.1], [-fx + 0.05, ky, 0], frame));
  kids.push(box("kick-right", [0.08, 0.14, d - 0.1], [fx - 0.05, ky, 0], frame));
  kids.push(box("kick-front-r", [rightW - 0.05, 0.14, 0.08], [fx - rightW / 2, ky, fz - 0.05], frame));
  if (leftW > 0.2) kids.push(box("kick-front-l", [leftW - 0.05, 0.14, 0.08], [-fx + leftW / 2, ky, fz - 0.05], frame));

  // roof: a warm-white roof with an overhang all round and a frosted skylight in the middle (the
  // room still reads from above), a deeper fascia over the front that carries the room's name
  // overhang: 0.25 m front and back, 0.12 m at the sides (rooms may stand side by side 0.3 m apart)
  const ov = 0.25, os = 0.12, rb = 0.45, ry = top + 0.05; // border width, roof centre height
  const roofMat = mat(c.roof, 0.8);
  kids.push(box("roof-front", [w + 2 * os, 0.1, rb], [0, ry, fz + ov - rb / 2], roofMat));
  kids.push(box("roof-back", [w + 2 * os, 0.1, rb], [0, ry, -fz - ov + rb / 2], roofMat));
  kids.push(box("roof-left", [rb - ov + os, 0.1, d + 2 * ov - 2 * rb], [-fx - os + (rb - ov + os) / 2, ry, 0], roofMat));
  kids.push(box("roof-right", [rb - ov + os, 0.1, d + 2 * ov - 2 * rb], [fx + os - (rb - ov + os) / 2, ry, 0], roofMat));
  kids.push(box("roof", [w - 2 * (rb - ov) + 0.02, 0.04, d + 2 * ov - 2 * rb + 0.02], [0, ry + 0.01, 0], { ...glass, roughness: 0.28 }));
  // the fascia over the front: the room's name, right of the door canopy (the canopy sits just under it)
  const fasciaH = 0.2, cw = doorW + 0.6;
  const signL = dx + cw / 2 + 0.1, signR = fx + os;
  kids.push(box("fascia", [w + 2 * os, fasciaH, 0.06], [0, ry + 0.05 - fasciaH / 2, fz + ov + 0.03], roofMat, { tags: ["sign"] }));
  kids.push({ id: `${id}-sign`, kind: "text", text: spec.name, size: 0.13, color: c.ink, align: "center", billboard: false, transform: { position: [r3((signL + signR) / 2), r3(ry + 0.05 - fasciaH / 2 - 0.004), r3(fz + ov + 0.065)] } });
  // inside: two warm light bars under the skylight (lit at night: the room glows from inside)
  const barW = Math.max(0.6, w - 1.3);
  for (const [k, z] of [[1, -d / 4], [2, d / 4]] as const) kids.push(box(`light-${k}`, [barW, 0.04, 0.1], [0, top - 0.16, z], { color: "#fff4e0", roughness: 0.4, metalness: 0, night: { emissive: "#ffd9a0", intensity: 2.4 } }));
  kids.push(box("light-rail", [0.04, 0.03, d / 2], [0, top - 0.12, 0], frame));

  // the door canopy: a slim warm-white cantilever just under the fascia, a downlight under it (night)
  const cd = 0.7, cy = base + doorH + 0.27;
  kids.push(box("canopy", [cw, 0.06, cd], [dx, cy, fz + cd / 2], roofMat, { radius: 0.015 }));
  kids.push(box("canopy-light", [cw - 0.3, 0.02, 0.06], [dx, cy - 0.04, fz + cd - 0.14], { color: "#fff4e0", roughness: 0.4, metalness: 0, night: { emissive: "#ffd9a0", intensity: 2.0 } }));

  // the status lamp over the door: a bar light on a pale-wood backplate
  const ly = base + doorH + 0.17;
  kids.push(box("lamp-plate", [0.56, 0.12, 0.04], [dx, ly, fz + 0.0], frame, { radius: 0.01 }));
  kids.push({ id: `${id}-lamp`, kind: "primitive", shape: "capsule", size: [0.055, 0.46], transform: { position: [dx, r3(ly), r3(fz + 0.06)], rotation: [0, 0, 90] }, material: LAMP_IDLE, tags: ["sandbox-lamp"] });

  // the plaque: name, policy and the live line on a warm-white board on the glass beside the
  // door, at eye height, big enough to read from a few steps away (lit softly at night)
  const lines = policyLines(spec.policy);
  const lh = 0.07; // line height
  const bw = r3(Math.min(0.9, rightW - 0.25)), bh = r3(0.24 + lh * (lines.length + 1));
  const px = r3(dx + doorW / 2 + 0.12 + bw / 2), py = r3(base + 1.42), pz = r3(fz + 0.0);
  kids.push(box("plaque", [bw, bh, 0.03], [px, py, pz], mat(c.board, 0.6, { night: { emissive: "#fff3df", intensity: 0.55 } }), { radius: 0.012, tags: ["sandbox-plaque"] }));
  kids.push(box("plaque-band", [bw, 0.035, 0.034], [px, py + bh / 2 - 0.0175, pz], frame, { radius: 0.008 }));
  const text = (sid: string, s: string, size: number, y: number, extra: Record<string, unknown> = {}): Ent => ({ id: `${id}-${sid}`, kind: "text", text: s, size, color: c.ink, align: "left", billboard: false, transform: { position: [r3(px - bw / 2 + 0.06), r3(y), r3(pz + 0.02)] }, ...extra });
  const top0 = py + bh / 2 - 0.11;
  kids.push(text("plaque-name", spec.name, 0.08, top0));
  lines.forEach((l, i) => kids.push(text(`plaque-${i}`, l, 0.052, top0 - 0.1 - i * lh)));
  kids.push(text("count", spec.count ?? "empty", 0.052, top0 - 0.1 - lines.length * lh, { tags: ["sandbox-count"] }));

  // what stands along the back wall (≤ 0.6 m deep, so the slots in front stay clear)
  kids.push(...furniture(furnish, { id, w, fx, fz, base, c, mat, box }));

  // spots for the walking graph (in front of the furniture)
  const z0 = -fz + (furnish === "none" ? 0.7 : 1.05);
  const cols = Math.max(2, Math.floor((w - 0.9) / 0.75) + 1), rows = Math.max(1, Math.floor((fz - 0.55 - 0.45 - z0) / 0.75) + 1);
  const slots: V3[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = cols === 1 ? 0 : -((cols - 1) * 0.75) / 2 + i * 0.75;
    const z = z0 + j * 0.75;
    slots.push([r3(x), base, r3(z)]);
  }
  return {
    entity: { id, kind: "group", tags: ["sandbox", "glass-room"], children: kids },
    spots: { outside: [dx, 0.02, r3(fz + 1.0)], inside: [dx, base, r3(fz - 0.55)], work: [r3(Math.max(0, dx + doorW)), base, r3(Math.max(z0, Math.min(0, fz - 1.4)))], slots },
  };
}

type Box = (sid: string, size: V3, position: V3, material: Record<string, unknown>, more?: Record<string, unknown>) => Ent;
type Mat = (color: string, roughness?: number, extra?: Record<string, unknown>) => Record<string, unknown>;

/** Back-wall furniture: racks (CI), a desk with two screens (worktrees), a workbench (experiments). */
function furniture(kind: SandboxRoomSpec["furnish"], o: { id: string; w: number; fx: number; fz: number; base: number; c: typeof COLORS; mat: Mat; box: Box }): Ent[] {
  const { w, fx, fz, base, c, mat, box } = o;
  const out: Ent[] = [];
  const bz = -fz + 0.1; // back of the furniture
  const led = (on: boolean) => ({ color: on ? "#ffe9c4" : "#cfe0c4", emissive: on ? "#e8c890" : "#7fa36a", roughness: 0.3, metalness: 0, glow: 0.9 });
  if (kind === "rack") {
    const n = w >= 3.6 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const x = fx - 0.55 - k * 0.72, z = bz + 0.25;
      out.push(box(`rack-${k}`, [0.6, 1.9, 0.5], [x, base + 0.95, z], mat(c.machine, 0.55), { radius: 0.02 }));
      for (let u = 0; u < 5; u++) {
        const y = base + 0.35 + u * 0.32;
        out.push(box(`rack-${k}-u${u}`, [0.52, 0.22, 0.02], [x, y, z + 0.255], mat("#4a4e53", 0.5)));
        out.push(box(`rack-${k}-led${u}`, [0.05, 0.03, 0.012], [x + 0.19, y + 0.05, z + 0.268], led(u % 2 === 0)));
      }
    }
    // a slim console table to the left of the racks
    const tx = fx - 0.55 - n * 0.72 - 0.55;
    if (tx - 0.4 > -fx + 0.2) {
      out.push(box("console", [0.8, 0.04, 0.4], [tx, base + 0.76, bz + 0.2], mat(c.wood, 0.7)));
      out.push(box("console-leg-l", [0.04, 0.74, 0.36], [tx - 0.36, base + 0.37, bz + 0.2], mat(c.frame, 0.7)));
      out.push(box("console-leg-r", [0.04, 0.74, 0.36], [tx + 0.36, base + 0.37, bz + 0.2], mat(c.frame, 0.7)));
      out.push(box("console-screen", [0.46, 0.3, 0.03], [tx, base + 1.0, bz + 0.12], mat("#eef3ec", 0.4, { emissive: "#9fa89a", glow: 0.35 }), { radius: 0.01 }));
    }
  } else if (kind === "desk") {
    const dw = Math.min(2.2, w - 1.0), x = fx - 0.45 - dw / 2;
    out.push(box("desk", [dw, 0.05, 0.6], [x, base + 0.74, bz + 0.3], mat(c.wood, 0.7), { radius: 0.01 }));
    out.push(box("desk-leg-l", [0.05, 0.72, 0.54], [x - dw / 2 + 0.06, base + 0.36, bz + 0.3], mat(c.frame, 0.7)));
    out.push(box("desk-leg-r", [0.05, 0.72, 0.54], [x + dw / 2 - 0.06, base + 0.36, bz + 0.3], mat(c.frame, 0.7)));
    const screens = dw >= 1.6 ? 2 : 1;
    for (let k = 0; k < screens; k++) {
      const sx = x + (screens === 1 ? 0 : (k - 0.5) * 0.72);
      out.push(box(`screen-${k}`, [0.62, 0.38, 0.03], [sx, base + 1.06, bz + 0.12], mat("#eef3ec", 0.4, { emissive: "#9fa89a", glow: 0.35 }), { radius: 0.01 }));
      out.push(box(`screen-${k}-stand`, [0.05, 0.2, 0.05], [sx, base + 0.86, bz + 0.12], mat(c.metal, 0.4, { metalness: 0.6 })));
    }
    out.push(box("desk-keys", [0.42, 0.015, 0.14], [x, base + 0.775, bz + 0.38], mat("#e8e2d6", 0.6)));
    out.push({ id: `${o.id}-stool`, kind: "primitive", shape: "cylinder", size: [0.19, 0.46], transform: { position: [r3(x), r3(base + 0.23), r3(bz + 0.78)] }, material: mat(c.frame, 0.7) });
  } else if (kind === "bench") {
    const bw = Math.min(1.6, w - 1.2), x = fx - 0.45 - bw / 2;
    out.push(box("bench", [bw, 0.06, 0.55], [x, base + 0.88, bz + 0.28], mat(c.wood, 0.7), { radius: 0.01 }));
    out.push(box("bench-shelf", [bw - 0.1, 0.03, 0.45], [x, base + 0.25, bz + 0.28], mat(c.frame, 0.7)));
    for (const sx of [-1, 1]) out.push(box(`bench-leg-${sx < 0 ? "l" : "r"}`, [0.06, 0.86, 0.5], [x + sx * (bw / 2 - 0.06), base + 0.43, bz + 0.28], mat(c.frame, 0.7)));
    out.push(box("pegboard", [bw - 0.1, 0.62, 0.025], [x, base + 1.5, bz + 0.02], mat(c.board, 0.8)));
    out.push(box("tool-a", [0.05, 0.32, 0.03], [x - bw / 4, base + 1.52, bz + 0.05], mat(c.metal, 0.35, { metalness: 0.7 })));
    out.push(box("tool-b", [0.24, 0.05, 0.03], [x, base + 1.6, bz + 0.05], mat(c.wood, 0.6)));
    out.push(box("tool-c", [0.16, 0.16, 0.03], [x + bw / 4, base + 1.45, bz + 0.05], mat("#a9bd96", 0.7), { radius: 0.02 }));
    out.push(box("bench-box", [0.34, 0.2, 0.26], [x - bw / 4, base + 1.01, bz + 0.3], mat(c.metal, 0.5, { metalness: 0.3 }), { radius: 0.02 }));
    out.push(box("bench-lamp", [0.06, 0.4, 0.06], [x + bw / 3, base + 1.11, bz + 0.18], mat(c.metal, 0.4, { metalness: 0.5 })));
    out.push(box("bench-lamp-head", [0.2, 0.06, 0.12], [x + bw / 3 - 0.06, base + 1.3, bz + 0.26], { color: "#ffe9c4", emissive: "#e8c890", roughness: 0.4, metalness: 0, glow: 0.4 }));
  }
  return out;
}
