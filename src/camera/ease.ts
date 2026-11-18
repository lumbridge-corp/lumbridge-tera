// Easing curves named in CONTRACT.md section 3. Pure; u is clamped to [0, 1].
// The engine can reuse `ease()` for `animate` ops so camera and objects move alike.
import type { Ease } from "../schema/index.ts";

const clamp01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u);

export const EASES: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  inQuad: (u) => u * u,
  outQuad: (u) => u * (2 - u),
  inOutQuad: (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2),
  inCubic: (u) => u * u * u,
  outCubic: (u) => 1 - (1 - u) ** 3,
  inOutCubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  inOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
};

export function ease(name: Ease | undefined, u: number): number {
  // exact endpoints (no -0 or 0.9999999 from the trig/pow forms)
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return EASES[name ?? "linear"](clamp01(u));
}
