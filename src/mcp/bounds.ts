// Approximate world-space bounds computed in Node from entity JSON (no browser).
// Exact for primitives under the size convention below; models/splats/text have no
// known size without the engine.
//
// Primitive size convention (matches the engine): box [w,h,d] (one number = cube),
// sphere [radius], plane [w,d] lying flat in XZ, cylinder [radius,height] along Y,
// torus [radius,tube] in the XY plane, cone [bottom radius,height] apex up (optional third
// = top radius, a frustum), capsule [radius,total height], prism [w,h,d]; every one centred on
// its position. segment = a cylinder from `from` to `to` (radius `radius`). Partial arcs are
// measured as the swept sector (an arc is not a full circle); repeats are measured copy by copy
// (grid, radial, skip, jitter reach). `partBounds()` is the helper for footprint checks (town
// assemble): the same boxes plus a size estimate for text.
// When the engine page is running, the session overlays the engine's real boxes
// (bridge bounds()) so models, splats and text get sizes too.
import { type Entity, type Vec3 } from "../schema/index.ts";
import { radialAngles, repeatCellsOf, repeatDims } from "../engine/repeat-math.ts";

const SEGMENT_RADIUS = 0.05; // = engine/primitives.ts (kept import-free of three.js)

export interface Box { min: Vec3; max: Vec3 }
type M = number[]; // 4x4 column-major like three.js

const I: M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: M, b: M): M {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    o[c * 4 + r] = s;
  }
  return o;
}

/** position · R(Euler XYZ, degrees) · scale — same as three.js Object3D with order "XYZ". */
export function compose(e: Pick<Entity, "transform">): M {
  const t = e.transform ?? {};
  const [px, py, pz] = t.position ?? [0, 0, 0];
  const [rx, ry, rz] = (t.rotation ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180) as Vec3;
  const s = t.scale === undefined ? [1, 1, 1] : typeof t.scale === "number" ? [t.scale, t.scale, t.scale] : t.scale;
  const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e2 = Math.cos(rz), f = Math.sin(rz);
  const ae = a * e2, af = a * f, be = b * e2, bf = b * f;
  // three.js makeRotationFromEuler, order XYZ (row-major terms)
  const r11 = c * e2, r12 = -c * f, r13 = d;
  const r21 = af + be * d, r22 = ae - bf * d, r23 = -b * c;
  const r31 = bf - ae * d, r32 = be + af * d, r33 = a * c;
  return [
    r11 * s[0]!, r21 * s[0]!, r31 * s[0]!, 0,
    r12 * s[1]!, r22 * s[1]!, r32 * s[1]!, 0,
    r13 * s[2]!, r23 * s[2]!, r33 * s[2]!, 0,
    px, py, pz, 1,
  ];
}

export function apply(m: M, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
  ];
}

type Prim = Extract<Entity, { kind: "primitive" }>;

/** Half extents of the full (un-cut) shape around its centre. Segments: see primitiveBox. */
export function primitiveHalfExtents(e: Prim): Vec3 {
  const s = e.size ?? [];
  switch (e.shape) {
    case "box": return [(s[0] ?? 1) / 2, (s[1] ?? s[0] ?? 1) / 2, (s[2] ?? s[0] ?? 1) / 2];
    case "sphere": { const r = s[0] ?? 0.5; return [r, r, r]; }
    case "plane": return [(s[0] ?? 10) / 2, 0, (s[1] ?? s[0] ?? 10) / 2];
    case "cylinder": { const r = Math.max(s[0] ?? 0.5, s[2] ?? s[0] ?? 0.5); return [r, (s[1] ?? 1) / 2, r]; }
    case "cone": { const r = Math.max(s[0] ?? 0.5, s[2] ?? 0); return [r, (s[1] ?? 1) / 2, r]; }
    case "torus": { const R = (s[0] ?? 1) + (s[1] ?? 0.3); return [R, R, s[1] ?? 0.3]; }
    case "capsule": { const r = s[0] ?? 0.25; return [r, Math.max((s[1] ?? 1) / 2, r), r]; }
    case "prism": return [(s[0] ?? 1) / 2, (s[1] ?? s[0] ?? 1) / 2, (s[2] ?? s[0] ?? 1) / 2];
    case "segment": { const b = primitiveBox(e); return [0, 1, 2].map((i) => (b.max[i]! - b.min[i]!) / 2) as Vec3; }
  }
}

/** Angles (deg) that bound a swept arc: both ends plus every quarter turn inside it. */
function arcAngles(start: number, length: number): number[] {
  const out = [start, start + length];
  for (let q = Math.ceil(start / 90) * 90; q < start + length; q += 90) out.push(q);
  return out;
}
function boxOf(points: Vec3[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, p[i]!); max[i] = Math.max(max[i]!, p[i]!); }
  return { min, max };
}

/** The primitive's own box in its local space (before its transform): arcs as swept sectors, segments between their points. */
export function primitiveBox(e: Prim): Box {
  const s = e.size ?? [];
  if (e.shape === "segment") {
    const a = e.from ?? [0, 0, 0], b = e.to ?? [0, 1, 0], r = e.radius ?? SEGMENT_RADIUS;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    // A disc of radius r perpendicular to the axis reaches r·sqrt(1 − dᵢ²) along axis i.
    const ext = d.map((v) => r * Math.sqrt(Math.max(0, 1 - (v / L) ** 2)));
    return { min: [0, 1, 2].map((i) => Math.min(a[i]!, b[i]!) - ext[i]!) as Vec3, max: [0, 1, 2].map((i) => Math.max(a[i]!, b[i]!) + ext[i]!) as Vec3 };
  }
  const full = (): Box => { const h = primitiveHalfExtents(e); return { min: [-h[0], -h[1], -h[2]], max: h }; };
  if (!e.arc || e.arc.length >= 360) return full();
  const start = e.arc.start ?? 0, angles = arcAngles(start, e.arc.length);
  if (e.shape === "cylinder" || e.shape === "cone") {
    const h = (s[1] ?? 1) / 2;
    const rings: [number, number][] = e.shape === "cylinder" ? [[s[0] ?? 0.5, -h], [s[2] ?? s[0] ?? 0.5, h]] : [[s[0] ?? 0.5, -h], [s[2] ?? 0, h]];
    const pts: Vec3[] = [];
    for (const [r, y] of rings) for (const t of angles) {
      const a = (t * Math.PI) / 180;
      pts.push([Math.sin(a) * r, y, Math.cos(a) * r]);
      if (e.inner) pts.push([Math.sin(a) * Math.min(e.inner, r), y, Math.cos(a) * Math.min(e.inner, r)]);
    }
    if (!e.inner && !e.open) pts.push([0, -h, 0], [0, h, 0]); // pie-slice caps reach the axis
    if (e.shape === "cone" && !(s[2] ?? 0)) pts.push([0, h, 0]); // apex
    return boxOf(pts);
  }
  if (e.shape === "torus") {
    const R = s[0] ?? 1, t = s[1] ?? 0.3;
    const b = boxOf(angles.map((d) => { const a = (d * Math.PI) / 180; return [Math.cos(a) * R, Math.sin(a) * R, 0] as Vec3; }));
    return { min: [b.min[0] - t, b.min[1] - t, -t], max: [b.max[0] + t, b.max[1] + t, t] };
  }
  return full();
}

function transformMinMax(m: M, b: Box): Box {
  const pts: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(apply(m, [x, y, z]));
  return boxOf(pts);
}

/** Rough text box (sans, ~0.62 em per character, 1.2 em lines), centred like align "center". */
function textBox(e: Extract<Entity, { kind: "text" }>): Box {
  const size = e.size ?? 1, lines = e.text.split("\n");
  const w = (size * 0.62 * Math.max(...lines.map((l) => l.length))) / 2, h = (size * 1.2 * lines.length) / 2;
  return { min: [-w, -h, 0], max: [w, h, 0] };
}

/** Box of a repeat in its own space: the template's box placed at every copy (turn, skip, jitter reach). */
function repeatBox(e: Extract<Entity, { kind: "repeat" }>, text: boolean): Box | null {
  const t = text ? partBounds([e.of]) : sceneBounds([e.of], { rows: rows([e.of]) });
  if (!t) return null;
  const j = e.jitter;
  const pad = j?.rotation || j?.scale ? Math.max(...t.max.map((v, i) => Math.abs(v - t.min[i]!))) * (0.5 * (j?.scale ?? 0) + (j?.rotation ? 0.3 : 0)) : 0;
  let b: Box | null = null;
  for (const c of repeatCellsOf(e)) {
    const r = c.basis ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const m: M = [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, c.position[0], c.position[1], c.position[2], 1];
    b = union(b, transformMinMax(m, t));
  }
  if (b && pad) for (let i = 0; i < 3; i++) { b.min[i] = b.min[i]! - pad; b.max[i] = b.max[i]! + pad; }
  return b;
}

/**
 * World-space box of entities for footprint / height checks without a browser: primitives
 * (arcs as sectors, segments, prisms), repeats copy by copy, groups, and an estimate for text.
 * Models and splats are not measured. Returns null when nothing has a size.
 */
export function partBounds(entities: Entity[], parent: M = I): Box | null {
  let b: Box | null = null;
  for (const e of entities) {
    if (e.visible === false) continue;
    const m = mul(parent, compose(e));
    if (e.kind === "primitive") b = union(b, transformMinMax(m, primitiveBox(e)));
    else if (e.kind === "text") b = union(b, transformMinMax(m, textBox(e)));
    else if (e.kind === "repeat") { const r = repeatBox(e, true); if (r) b = union(b, transformMinMax(m, r)); }
    else if (e.kind === "group") b = union(b, partBounds(e.children, m));
  }
  return b;
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export interface Row {
  id: string;
  kind: string;
  detail: string;
  position: Vec3; // world space
  bounds: Box | null;
  parent?: string;
  tags?: string[];
  visible: boolean;
}

/** Flatten the entity tree to rows with world-space position and bounds. */
export function rows(entities: Entity[], parent: M = I, parentId?: string, out: Row[] = []): Row[] {
  for (const e of entities) {
    const m = mul(parent, compose(e));
    const position = apply(m, [0, 0, 0]);
    let bounds: Box | null = null;
    let detail = "";
    if (e.kind === "primitive") {
      bounds = transformMinMax(m, primitiveBox(e));
      const shape = e.shape === "segment" ? `segment ${fmtV(e.from ?? [0, 0, 0])}→${fmtV(e.to ?? [0, 1, 0])} r ${fmt(e.radius ?? SEGMENT_RADIUS)}` : `${e.shape}${e.size ? " " + JSON.stringify(e.size) : ""}`;
      detail = `${shape}${e.material?.color ? " " + e.material.color : ""}`;
    } else if (e.kind === "light") detail = `${e.light} ${e.intensity ?? 1}`;
    else if (e.kind === "model" || e.kind === "splat") detail = e.src;
    else if (e.kind === "actor") detail = `${e.style ?? "worker"}${e.label ? " " + JSON.stringify(e.label) : ""}${e.move ? ` move ${e.move.to ? "to " + e.move.to : "path " + e.move.path}` : ""} ${e.state ?? "idle"}`;
    else if (e.kind === "flow") detail = `path ${e.path} ${e.style ?? "dots"}${e.pipe ? " pipe" : ""}`;
    else if (e.kind === "meter") detail = `${e.style ?? "bar"} ${e.value}`;
    else if (e.kind === "text") detail = JSON.stringify(e.text.length > 30 ? e.text.slice(0, 30) + "…" : e.text);
    else if (e.kind === "repeat") {
      const n = repeatCellsOf(e).length;
      const what = `${e.of.kind}${e.of.kind === "primitive" ? " " + e.of.shape : ""}`;
      if (e.radial) {
        const a = radialAngles(e.radial);
        detail = `${n} × ${what} (radial ${e.radial.count} around ${e.radial.axis ?? "y"}, r ${fmt(e.radial.radius)}, ${fmt(a[0] ?? 0)}..${fmt(a[a.length - 1] ?? 0)} deg)`;
      } else {
        const [nx, ny, nz] = repeatDims(e.count ?? 1);
        detail = `${n} × ${what} (${nx}×${ny}×${nz}, step ${fmtV(e.step ?? [0, 0, 0])})`;
      }
      const r = repeatBox(e, false);
      if (r) bounds = transformMinMax(m, r);
    }
    const row: Row = { id: e.id, kind: e.kind, detail, position, bounds, visible: e.visible ?? true };
    if (parentId) row.parent = parentId;
    if (e.tags?.length) row.tags = e.tags;
    out.push(row);
    if (e.kind === "group") {
      const start = out.length;
      rows(e.children, m, e.id, out);
      for (let i = start; i < out.length; i++) if (out[i]!.parent === e.id) row.bounds = union(row.bounds, out[i]!.bounds);
      row.detail = `${e.children.length} children`;
    }
  }
  return out;
}

/** Bounds of everything solid (primitives/groups), ignoring big ground planes if asked. */
export function sceneBounds(entities: Entity[], opts: { skipGround?: boolean; rows?: Row[] } = {}): Box | null {
  let b: Box | null = null;
  for (const r of opts.rows ?? rows(entities)) {
    if (r.parent || !r.bounds || !r.visible) continue;
    const size = r.bounds.max.map((v, i) => v - r.bounds!.min[i]!);
    if (opts.skipGround && size[1]! < 0.05 && Math.max(size[0]!, size[2]!) > 8) continue;
    b = union(b, r.bounds);
  }
  return b;
}

export const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
export const fmtV = (v: readonly number[]) => `[${v.map(fmt).join(", ")}]`;
