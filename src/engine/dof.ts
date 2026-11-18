// Depth of field maths shared by both backends (post.ts builds the GLSL and TSL versions of
// the same formulas). Pure: runs in Node for tests.
//
// Blur is a circle-of-confusion radius as a FRACTION OF THE IMAGE WIDTH, so a frame looks the
// same at any resolution and on either renderer.
//
//   depth:     coc = min(maxBlur, aperture · |1 − focus / d|)      d = distance along the view axis
//              (thin-lens shape: scale-free, so focus 2 m or 200 m use the same aperture numbers;
//               aperture is the blur of something infinitely far away)
//   tiltshift: coc = blur · smoothstep(0, falloff, |y − center| − band/2)   y = 0 top .. 1 bottom
//              (the diorama look: a sharp horizontal band on screen, no depth needed)
import type { Post } from "../schema/index.ts";

/** Default cap on the depth-mode blur (fraction of the width). */
export const DOF_MAX_BLUR = 0.012;
/** Taps on each side of the centre in each of the two separable blur passes. */
export const DOF_TAPS = 16;

export interface DofParams {
  mode: "depth" | "tiltshift";
  focus: number;
  aperture: number;
  maxBlur: number;
  center: number;
  band: number;
  falloff: number;
  blur: number;
}

/** Fill in defaults for environment.post.dof. */
export function resolveDof(d: NonNullable<Post["dof"]>): DofParams {
  if (d.mode === "tiltshift") {
    return { mode: "tiltshift", focus: 0, aperture: 0, maxBlur: d.blur ?? 0.008, center: d.center ?? 0.5, band: d.band ?? 0.2, falloff: d.falloff ?? 0.3, blur: d.blur ?? 0.008 };
  }
  return { mode: "depth", focus: d.focus, aperture: d.aperture, maxBlur: d.maxBlur ?? DOF_MAX_BLUR, center: 0.5, band: 0, falloff: 1, blur: 0 };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Depth-mode blur (fraction of width) of a point `d` metres in front of the camera. */
export function dofDepthCoc(p: Pick<DofParams, "focus" | "aperture" | "maxBlur">, d: number): number {
  if (!(d > 0)) return p.maxBlur > 0 ? Math.min(p.maxBlur, p.aperture) : 0;
  return Math.min(p.maxBlur, p.aperture * Math.abs(1 - p.focus / d));
}

/** Tilt-shift blur (fraction of width) at screen height y (0 = top, 1 = bottom). */
export function dofTiltCoc(p: Pick<DofParams, "center" | "band" | "falloff" | "blur">, y: number): number {
  return p.blur * smoothstep(0, p.falloff, Math.abs(y - p.center) - p.band / 2);
}

/** Depth range [near, far] (m) where the depth-mode blur stays under `coc` (e.g. one pixel = 1/width). */
export function dofSharpRange(p: Pick<DofParams, "focus" | "aperture">, coc: number): [number, number] {
  if (p.aperture <= coc) return [0, Infinity];
  const k = coc / p.aperture; // |1 − f/d| ≤ k  →  f/(1+k) ≤ d ≤ f/(1−k)
  return [p.focus / (1 + k), p.focus / (1 - k)];
}

/** Gaussian weight of tap k of DOF_TAPS (σ = half the blur radius). */
export function dofTapWeight(k: number, taps = DOF_TAPS): number {
  const u = k / taps;
  return Math.exp(-2 * u * u);
}
