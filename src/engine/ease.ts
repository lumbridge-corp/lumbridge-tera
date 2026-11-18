// Eases and interpolation for `animate` ops. Pure: no three.js, runs in Node.
import type { Ease, Transform } from "../schema/index.ts";

export const EASES: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  inQuad: (u) => u * u,
  outQuad: (u) => 1 - (1 - u) * (1 - u),
  inOutQuad: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  inCubic: (u) => u * u * u,
  outCubic: (u) => 1 - Math.pow(1 - u, 3),
  inOutCubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  inOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
};

export const clamp01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u);

/** Eased progress of an animation that started at `t0` and lasts `duration`, at time `t`. */
export function progress(t: number, t0: number, duration: number, ease: Ease = "inOutCubic"): number {
  if (duration <= 0) return t >= t0 ? 1 : 0;
  return EASES[ease](clamp01((t - t0) / duration));
}

type V3 = [number, number, number];
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: V3, b: V3, u: number): V3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const scale3 = (s: number | V3 | undefined): V3 => (s === undefined ? [1, 1, 1] : typeof s === "number" ? [s, s, s] : s);

export interface AnimTo {
  position?: V3;
  rotation?: V3;
  scale?: number | V3;
}

/**
 * Transform at eased progress `u` from `from` towards `to`. Only the channels named in
 * `to` move; the others keep their `from` value. Rotation lerps Euler degrees
 * component-wise (what a JSON author expects: 0 -> 360 spins once).
 */
export function lerpTransform(from: Transform | undefined, to: AnimTo, u: number): Transform {
  const f = from ?? {};
  const out: Transform = { ...f };
  if (to.position) out.position = lerp3(f.position ?? [0, 0, 0], to.position, u);
  if (to.rotation) out.rotation = lerp3(f.rotation ?? [0, 0, 0], to.rotation, u);
  if (to.scale !== undefined) {
    if (typeof to.scale === "number" && (f.scale === undefined || typeof f.scale === "number"))
      out.scale = lerp(f.scale ?? 1, to.scale, u);
    else out.scale = lerp3(scale3(f.scale), scale3(to.scale), u);
  }
  return out;
}
