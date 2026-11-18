// Layout of a `repeat` entity: one cell per copy, deterministic jitter. Pure (no three.js):
// runs in Node for tests and in the page.
//
// Cell (i, j, k) sits at (i·step.x, j·step.y, k·step.z) in the repeat's own space, i fastest.
// Jitter draws from hash01(cell index, seed·16 + channel), so the same seed always gives the
// same layout and changing count only adds or drops cells at the end of each row.
import { hash01 } from "./living-math.ts";
import type { RepeatJitter } from "../schema/index.ts";

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
}

export function repeatDims(count: number | V3): V3 {
  return typeof count === "number" ? [count, 1, 1] : count;
}

const sym = (u: number) => u * 2 - 1; // [0,1) → [-1,1)

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
