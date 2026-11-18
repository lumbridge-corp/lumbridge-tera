// Exact on-screen colours for glowing things, on both backends and with or without post.
//
// Tone mapping (ACES) desaturates bright colours: an amber strip at emissive 2 lands near
// pale yellow. `toneMapped: false` only skips ACES on WebGL2 without post effects (the
// composer's OutputPass and WebGPU tone-map the whole frame), so it cannot be relied on.
// Instead a glow colour is pre-compensated with the inverse of ACES at the current exposure
// and drawn tone-mapped like everything else: it lands on its hex on every path.
import * as THREE from "three";
import { acesSaturatedInverse } from "./tonemap.ts";

let exposure = 1;
const registry = new Map<THREE.Material & { color: THREE.Color }, THREE.Color>();

/** Current exposure the compensation is computed for. */
export function exactExposure(): number {
  return exposure;
}

const cache = new Map<string, [number, number, number]>();

/**
 * The linear colour that ACES (at the current exposure) turns into `target` (linear, 0..1;
 * brighter clamps). Colours too saturated for ACES at that brightness come out as the
 * brightest reachable colour of the same hue: saturated, never washed toward white.
 */
export function exactColor(target: THREE.Color, out = new THREE.Color()): THREE.Color {
  const t: [number, number, number] = [Math.min(1, target.r), Math.min(1, target.g), Math.min(1, target.b)];
  const key = `${exposure}:${t.map((v) => v.toFixed(4)).join(",")}`;
  let c = cache.get(key);
  if (!c) {
    c = acesSaturatedInverse(t, exposure).color;
    if (cache.size > 4096) cache.clear();
    cache.set(key, c);
  }
  return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}

/** Make a basic material show exactly `target` (registered: follows exposure changes). Marks it as pure glow for bloom. */
export function makeExact<M extends THREE.Material & { color: THREE.Color }>(mat: M, target: THREE.Color | string): M {
  const t = new THREE.Color(target);
  mat.toneMapped = true;
  mat.userData.glow = true;
  registry.set(mat, t);
  exactColor(t, mat.color);
  mat.addEventListener("dispose", () => registry.delete(mat));
  return mat;
}

/** New exposure: recompute every registered material. */
export function setExactExposure(e: number) {
  if (e === exposure) return;
  exposure = e;
  for (const [m, t] of registry) exactColor(t, m.color);
}
