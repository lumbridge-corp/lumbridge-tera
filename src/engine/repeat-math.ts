// Layout of a `repeat` entity: one cell per copy, deterministic jitter. Pure (no three.js):
// runs in Node for tests and in the page.
//
// Cell (i, j, k) sits at (i·step.x, j·step.y, k·step.z) in the repeat's own space, i fastest.
// Jitter draws from hash01(cell index, seed·16 + channel), so the same seed always gives the
// same layout and changing count only adds or drops cells at the end of each row.
//
// Radial (`radial` instead of count/step): copy i sits on a circle around the axis and is turned
// with its angle (Cell.basis), so its local +Z points away from the axis. `skip` drops cells after
// the layout (and jitter) is computed: the other copies stay exactly where they were.
import { hash01 } from "./living-math.ts";
import type { RepeatJitter, RepeatRadial, RepeatSkip } from "../schema/index.ts";

export type V3 = [number, number, number];

export interface Cell {
  index: number;
  position: V3;
  /** Degrees, Euler XYZ, added to the copied entity's own rotation. */
  rotation: V3;
  /** Uniform scale factor. */
  scale: number;
  /** Colour shift: hue (turns), saturation and lightness (0..1 offsets), as for THREE.Color.offsetHSL. */
  tint: V3 | null;
  /** Radial copies: the cell's turn, a row-major 3x3 rotation applied before the copied entity's transform. */
  basis?: number[];
}

/** Grid or radial repeat layout fields (the repeat entity itself works). */
export interface RepeatLayout {
  count?: number | V3;
  step?: V3;
  radial?: RepeatRadial;
  skip?: RepeatSkip;
  jitter?: RepeatJitter;
}

export function repeatDims(count: number | V3): V3 {
  return typeof count === "number" ? [count, 1, 1] : count;
}

const sym = (u: number) => u * 2 - 1; // [0,1) → [-1,1)

/** Every copy of a repeat (grid or radial), skipped cells removed. */
export function repeatCellsOf(e: RepeatLayout): Cell[] {
  const cells = e.radial ? radialCells(e.radial, e.jitter) : repeatCells(e.count ?? 1, e.step ?? [0, 0, 0], e.jitter);
  if (!e.skip?.length) return cells;
  const [nx, ny] = e.radial ? [e.radial.count, 1] : repeatDims(e.count ?? 1);
  const drop = new Set(e.skip.map((s) => (typeof s === "number" ? s : s[0] + nx * (s[1] + ny * s[2]))));
  return cells.filter((c) => !drop.has(c.index));
}

// Maps the Y-axis ring frame onto the chosen axis (cyclic permutations, so it stays a rotation):
// around x the ring runs +Y → +Z, around z it runs +X → +Y.
const AXIS_FRAME: Record<"x" | "y" | "z", number[]> = {
  y: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  x: [0, 1, 0, 0, 0, 1, 1, 0, 0],
  z: [0, 0, 1, 1, 0, 0, 0, 1, 0],
};
const mul3 = (a: number[], b: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
const apply3 = (m: number[], v: V3): V3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];

/** Angles (degrees) of the radial copies. */
export function radialAngles(r: RepeatRadial): number[] {
  const start = r.startDeg ?? 0, len = r.lengthDeg ?? 360;
  const step = len >= 360 ? len / r.count : r.count > 1 ? len / (r.count - 1) : 0;
  return Array.from({ length: r.count }, (_, i) => start + i * step);
}

export function radialCells(r: RepeatRadial, jitter?: RepeatJitter): Cell[] {
  // Same jitter draws as a grid row of the same count, then each cell is placed on the circle.
  const cells = repeatCells(r.count, [0, 0, 0], jitter);
  const frame = AXIS_FRAME[r.axis ?? "y"];
  const angles = radialAngles(r);
  for (const c of cells) {
    const t = (angles[c.index]! * Math.PI) / 180, s = Math.sin(t), k = Math.cos(t);
    const turn = [k, 0, s, 0, 1, 0, -s, 0, k]; // around Y: local +Z → (sin, 0, cos)
    const ring = apply3(frame, [s * r.radius, 0, k * r.radius]);
    const off = apply3(frame, c.position); // position jitter, in the ring frame
    c.position = [ring[0] + off[0], ring[1] + off[1], ring[2] + off[2]];
    c.basis = mul3(frame, turn);
  }
  return cells;
}

export function repeatCells(count: number | V3, step: V3, jitter?: RepeatJitter): Cell[] {
  const [nx, ny, nz] = repeatDims(count);
  const seed = jitter?.seed ?? 1;
  const jp: V3 | null = jitter?.position === undefined ? null : typeof jitter.position === "number" ? [jitter.position, 0, jitter.position] : jitter.position;
  const jr: V3 | null = jitter?.rotation === undefined ? null : typeof jitter.rotation === "number" ? [0, jitter.rotation, 0] : jitter.rotation;
  const js = jitter?.scale ?? 0;
  const jc = jitter?.color ?? 0;
  const out: Cell[] = [];
  let index = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, index++) {
    const h = (c: number) => sym(hash01(index, seed * 16 + c));
    const position: V3 = [i * step[0], j * step[1], k * step[2]];
    if (jp) for (let a = 0; a < 3; a++) position[a] = position[a]! + h(a) * jp[a]!;
    const rotation: V3 = jr ? [h(3) * jr[0], h(4) * jr[1], h(5) * jr[2]] : [0, 0, 0];
    const scale = js ? 1 + h(6) * js : 1;
    const tint: V3 | null = jc ? [h(7) * 0.06 * jc, h(8) * 0.25 * jc, h(9) * 0.18 * jc] : null;
    out.push({ index, position, rotation, scale, tint });
  }
  return out;
}

/** Local-space extent of the cell origins plus the jitter reach (for bounds). */
export function repeatSpan(count: number | V3, step: V3, jitter?: RepeatJitter): { min: V3; max: V3 } {
  const d = repeatDims(count);
  const jp: V3 = jitter?.position === undefined ? [0, 0, 0] : typeof jitter.position === "number" ? [jitter.position, 0, jitter.position] : jitter.position;
  const min: V3 = [0, 0, 0], max: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const end = (d[a]! - 1) * step[a]!;
    min[a] = Math.min(0, end) - jp[a]!;
    max[a] = Math.max(0, end) + jp[a]!;
  }
  return { min, max };
}
