// three's ACES Filmic tone mapping (same constants in the GLSL chunk and the TSL node) and
// its inverse. WebGPU tone-maps everything at the end of the frame (material.toneMapped and
// fog colour included), WebGL2 leaves unlit backgrounds and fog colour untouched. Feeding
// WebGPU the inverse-tone-mapped colour makes the colour-sky background and the fog land on
// the exact hex on both backends. Pure: runs in Node.
type V3 = [number, number, number];

const IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777]; // row-major
const OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];

const mul = (m: number[], v: V3): V3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];

function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
}
const IN_INV = inv3(IN), OUT_INV = inv3(OUT);

const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
function fitInv(y: number): number {
  // (1 - 0.983729 y) v² + (0.0245786 - 0.432951 y) v - (0.000090537 + 0.238081 y) = 0, positive root
  const yy = Math.min(y, 1 / 0.983729 - 1e-4);
  const a = 1 - 0.983729 * yy, b = 0.0245786 - 0.432951 * yy, c = -(0.000090537 + 0.238081 * yy);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** Linear RGB → tone-mapped linear RGB (before the sRGB transfer), like three. */
export function acesFilmic(c: V3, exposure = 1): V3 {
  const k = exposure / 0.6;
  const o = mul(OUT, mul(IN, [c[0] * k, c[1] * k, c[2] * k]).map(fit) as V3);
  return o.map((x) => Math.min(1, Math.max(0, x))) as V3;
}

/** The linear colour that acesFilmic maps to `target` (clamped to what ACES can reach). */
export function acesFilmicInverse(target: V3, exposure = 1): V3 {
  const k = exposure / 0.6;
  const t = mul(OUT_INV, target).map((x) => fitInv(Math.max(0, x))) as V3;
  return mul(IN_INV, t).map((x) => Math.max(0, x / k)) as V3;
}

/**
 * The linear colour that ACES turns into `target` — or, when ACES cannot reach a colour that
 * saturated and bright (it bleeds a bright pure green into red and blue), into the brightest
 * reachable colour of the same hue and saturation (target scaled down). That keeps glows
 * saturated instead of washing them toward white. Returns the input colour and the scale used.
 */
export function acesSaturatedInverse(target: V3, exposure = 1, tolerance = 0.035): { color: V3; scale: number } {
  const err = (k: number) => {
    const t: V3 = [target[0] * k, target[1] * k, target[2] * k];
    const back = acesFilmic(acesFilmicInverse(t, exposure), exposure);
    return Math.max(Math.abs(back[0] - t[0]), Math.abs(back[1] - t[1]), Math.abs(back[2] - t[2]));
  };
  let k = 1;
  if (err(1) > tolerance) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (err(mid) <= tolerance) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  return { color: acesFilmicInverse([target[0] * k, target[1] * k, target[2] * k], exposure), scale: k };
}
