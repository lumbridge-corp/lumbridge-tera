// Sky radiance on the CPU, written into equirectangular float images. Pure: runs in Node.
//
// The atmosphere is the Preetham analytic model (the same maths as three's Sky addon,
// ported from its shader) so one sky image works on WebGPU and WebGL alike: the engine
// uses it as both the background and the image-based light. Below the horizon the sky
// fades to a dim ground bounce so reflections and IBL have a floor.
//
// Image layout matches three's equirect lookup with flipY = false: row 0 is straight
// down, u = atan2(z, x) / 2pi + 0.5.

type V3 = [number, number, number];

const totalRayleigh: V3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MieConst: V3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const cutoffAngle = 1.6110731556870734;
const steepness = 1.5;
const EE = 1000;
const rayleighZenithLength = 8.4e3;
const mieZenithLength = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

export interface SkyParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

export const DEFAULT_SKY: SkyParams = { turbidity: 5, rayleigh: 1.4, mieCoefficient: 0.005, mieDirectionalG: 0.8 };

/** Overall scale from the Preetham output to scene-referred radiance. */
const SKY_GAIN = 0.45;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function sunIntensity(zenithAngleCos: number) {
  const c = Math.max(-1, Math.min(1, zenithAngleCos));
  return EE * Math.max(0, 1 - Math.exp(-(cutoffAngle - Math.acos(c)) / steepness));
}

/** Precomputed per-sun terms. */
export interface SkyState {
  sun: V3;
  sunE: number;
  betaR: V3;
  betaM: V3;
  g: number;
}

export function skyState(sun: V3, p: SkyParams = DEFAULT_SKY): SkyState {
  const sunE = sunIntensity(sun[1]);
  const rayleighCoefficient = p.rayleigh; // sunfade is 1 for a unit sun vector
  const c = 0.2 * p.turbidity * 10e-18;
  return {
    sun,
    sunE,
    betaR: [totalRayleigh[0] * rayleighCoefficient, totalRayleigh[1] * rayleighCoefficient, totalRayleigh[2] * rayleighCoefficient],
    betaM: [0.434 * c * MieConst[0] * p.mieCoefficient, 0.434 * c * MieConst[1] * p.mieCoefficient, 0.434 * c * MieConst[2] * p.mieCoefficient],
    g: p.mieDirectionalG,
  };
}

/** Linear radiance of the sky (no sun disc) in direction `d` (unit vector). */
export function skyRadiance(s: SkyState, d: V3, out: V3 = [0, 0, 0]): V3 {
  const up = Math.max(0, d[1]);
  const zenithAngle = Math.acos(up);
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = rayleighZenithLength * inv;
  const sM = mieZenithLength * inv;
  const cosTheta = d[0] * s.sun[0] + d[1] * s.sun[1] + d[2] * s.sun[2];
  const rc = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + rc * rc);
  const g2 = s.g * s.g;
  const mPhase = ONE_OVER_FOURPI * ((1 - g2) / Math.pow(1 - 2 * s.g * cosTheta + g2, 1.5));
  const horizonMix = Math.min(1, Math.max(0, Math.pow(1 - s.sun[1], 5)));
  // The model's constant "night sky" term turns grey after the gamma below; fade it out
  // with the sun and let the night floor take over.
  const l0Scale = smooth(-0.08, 0.12, s.sun[1]);
  for (let i = 0; i < 3; i++) {
    const bR = s.betaR[i]!, bM = s.betaM[i]!;
    const fex = Math.exp(-(bR * sR + bM * sM));
    const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
    let lin = Math.pow(s.sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.sqrt(s.sunE * ratio * fex) - 1) * horizonMix;
    const l0 = 0.1 * fex * l0Scale;
    const tex = (lin + l0) * 0.04 + (i === 0 ? 0 : i === 1 ? 0.0003 : 0.00075) * l0Scale;
    out[i] = Math.pow(tex, 1 / 2.4) * SKY_GAIN;
  }
  // Moonless night floor so a sky below the horizon is deep blue, not black.
  const night = 1 - Math.min(1, Math.max(0, (s.sun[1] + 0.1) / 0.2));
  out[0] = Math.max(out[0], 0.004 * night);
  out[1] = Math.max(out[1], 0.007 * night);
  out[2] = Math.max(out[2], 0.016 * night);
  return out;
}

/** Fill an RGBA float image (row 0 = down) from a direction -> radiance function. */
export function equirect(width: number, height: number, fn: (d: V3, out: V3) => void): Float32Array {
  const data = new Float32Array(width * height * 4);
  const d: V3 = [0, 0, 0], c: V3 = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    const ty = ((j + 0.5) / height - 0.5) * Math.PI;
    const cy = Math.cos(ty), sy = Math.sin(ty);
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      d[0] = cy * Math.cos(phi); d[1] = sy; d[2] = cy * Math.sin(phi);
      fn(d, c);
      const k = (j * width + i) * 4;
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 1;
    }
  }
  return data;
}

/** Ground colour under the horizon: a dim, slightly warm bounce of the horizon sky. */
const GROUND_TINT: V3 = [0.42, 0.38, 0.33];

/**
 * The full sun sky as an equirect image. With `fog` (linear rgb), the horizon band and
 * everything below it fade into the fog colour, so fogged ground meets the sky without
 * a seam (cheap aerial perspective).
 */
export function sunSkyImage(sun: V3, width: number, height: number, p: SkyParams = DEFAULT_SKY, fog?: V3): Float32Array {
  const s = skyState(sun, p);
  const h: V3 = [0, 0, 0];
  return equirect(width, height, (d, out) => {
    skyRadiance(s, d, out);
    if (d[1] < 0) {
      const n = Math.hypot(d[0], d[2]) || 1;
      skyRadiance(s, [d[0] / n, 0, d[2] / n], h);
      const k = smooth(0, -0.12, d[1]);
      for (let i = 0; i < 3; i++) out[i] = out[i]! * (1 - k) + h[i]! * GROUND_TINT[i]! * 0.55 * k;
    }
    if (fog) {
      const k = smooth(0.07, -0.01, d[1]);
      for (let i = 0; i < 3; i++) out[i] = out[i]! * (1 - k) + fog[i]! * k;
    }
  });
}

/** Soft studio gradient (top / horizon / bottom), used as IBL when the sky is a flat colour. */
export function gradientImage(top: V3, horizon: V3, bottom: V3, width: number, height: number): Float32Array {
  return equirect(width, height, (d, out) => {
    const y = d[1];
    const a = y >= 0 ? top : bottom;
    const k = Math.pow(Math.abs(y), 0.6);
    for (let i = 0; i < 3; i++) out[i] = horizon[i]! * (1 - k) + a[i]! * k;
  });
}

/** sRGB hex -> linear rgb. */
export function hexToLinear(hex: string): V3 {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/**
 * Colour and strength of direct sunlight after the atmosphere: white-ish at noon,
 * amber near the horizon, fading out just below it. `color` is linear rgb with a max
 * component of 1; `strength` is 0..1 (multiply by the light's noon intensity).
 */
export function sunLight(s: SkyState): { color: V3; strength: number } {
  const zen = Math.acos(Math.max(0, s.sun[1]));
  const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180) / Math.PI, -1.253));
  const c: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) c[i] = Math.exp(-(s.betaR[i]! * rayleighZenithLength * inv + s.betaM[i]! * mieZenithLength * inv));
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  const strength = smooth(-0.035, 0.1, s.sun[1]) * Math.min(1, 0.35 + m);
  // Real low sun reads orange, not blood red: soften the saturation a little.
  return { color: [Math.pow(c[0] / m, 0.6), Math.pow(c[1] / m, 0.6), Math.pow(c[2] / m, 0.6)], strength };
}
