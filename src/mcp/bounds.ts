// Approximate world-space bounds computed in Node from entity JSON (no browser).
// Exact for primitives under the size convention below; models/splats/text have no
// known size without the engine.
//
// Primitive size convention (matches the engine): box [w,h,d] (one number = cube),
// sphere [radius], plane [w,d] lying flat in XZ, cylinder [radius,height] along Y,
// torus [radius,tube] in the XY plane, cone [bottom radius,height] apex up (optional third
// = top radius, a frustum), capsule [radius,total height]. Every primitive is centred on its
// position. Partial arcs keep the full-sweep box (conservative).
// When the engine page is running, the session overlays the engine's real boxes
// (bridge bounds()) so models, splats and text get sizes too.
import { repeatCount, type Entity, type Vec3 } from "../schema/index.ts";
import { repeatDims, repeatSpan } from "../engine/repeat-math.ts";

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

export function primitiveHalfExtents(e: Extract<Entity, { kind: "primitive" }>): Vec3 {
  const s = e.size ?? [];
  switch (e.shape) {
    case "box": return [(s[0] ?? 1) / 2, (s[1] ?? s[0] ?? 1) / 2, (s[2] ?? s[0] ?? 1) / 2];
    case "sphere": { const r = s[0] ?? 0.5; return [r, r, r]; }
    case "plane": return [(s[0] ?? 10) / 2, 0, (s[1] ?? s[0] ?? 10) / 2];
    case "cylinder": { const r = Math.max(s[0] ?? 0.5, s[2] ?? s[0] ?? 0.5); return [r, (s[1] ?? 1) / 2, r]; }
    case "cone": { const r = Math.max(s[0] ?? 0.5, s[2] ?? 0); return [r, (s[1] ?? 1) / 2, r]; }
    case "torus": { const R = (s[0] ?? 1) + (s[1] ?? 0.3); return [R, R, s[1] ?? 0.3]; }
    case "capsule": { const r = s[0] ?? 0.25; return [r, Math.max((s[1] ?? 1) / 2, r), r]; }
  }
}

function transformBox(m: M, h: Vec3): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = apply(m, [sx * h[0], sy * h[1], sz * h[2]]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, p[i]!); max[i] = Math.max(max[i]!, p[i]!); }
  }
  return { min, max };
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
      bounds = transformBox(m, primitiveHalfExtents(e));
      detail = `${e.shape}${e.size ? " " + JSON.stringify(e.size) : ""}${e.material?.color ? " " + e.material.color : ""}`;
    } else if (e.kind === "light") detail = `${e.light} ${e.intensity ?? 1}`;
    else if (e.kind === "model" || e.kind === "splat") detail = e.src;
    else if (e.kind === "actor") detail = `${e.style ?? "worker"}${e.label ? " " + JSON.stringify(e.label) : ""}${e.move ? ` move ${e.move.to ? "to " + e.move.to : "path " + e.move.path}` : ""} ${e.state ?? "idle"}`;
    else if (e.kind === "flow") detail = `path ${e.path} ${e.style ?? "dots"}${e.pipe ? " pipe" : ""}`;
    else if (e.kind === "meter") detail = `${e.style ?? "bar"} ${e.value}`;
    else if (e.kind === "text") detail = JSON.stringify(e.text.length > 30 ? e.text.slice(0, 30) + "…" : e.text);
    else if (e.kind === "repeat") {
      // Template box (in the repeat's space) swept over the cell origins (+ jitter reach).
      const [nx, ny, nz] = repeatDims(e.count);
      detail = `${repeatCount(e.count)} × ${e.of.kind}${e.of.kind === "primitive" ? " " + e.of.shape : ""} (${nx}×${ny}×${nz}, step ${fmtV(e.step)})`;
      const t = sceneBounds([e.of], { rows: rows([e.of]) });
      if (t) {
        const span = repeatSpan(e.count, e.step, e.jitter);
        const pad = e.jitter?.rotation || e.jitter?.scale ? Math.max(...t.max.map((v, i) => Math.abs(v - t.min[i]!))) * (0.5 * (e.jitter?.scale ?? 0) + (e.jitter?.rotation ? 0.3 : 0)) : 0;
        const lo: Vec3 = [0, 0, 0], hi: Vec3 = [0, 0, 0];
        for (let i = 0; i < 3; i++) { lo[i] = t.min[i]! + span.min[i]! - pad; hi[i] = t.max[i]! + span.max[i]! + pad; }
        const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        bounds = transformBox(mul(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1]), [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2]);
      }
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
