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

// ---------------------------------------------------------------- the real sky (mode "real")
//
// Preetham is a daylight model: below the horizon it has nothing to say. The real sky keeps it
// for the day and builds the rest on top:
// - twilight: the sky of a sun just on the horizon, dimming with the sun's depression, slower
//   toward the sun's azimuth near the horizon (the glow that lingers) and faster at the zenith,
//   reddening in the glow and turning a deeper ozone blue overhead; opposite the sun the earth's
//   shadow rises as a dark blue band with the pink "belt of Venus" above it;
// - night: a deep blue floor (airglow and starlight; never grey, never pure black), a moonlit
//   sky (the same blue scattering, from the moon, scaled by its phase and height) and an
//   optional warm city glow low on the horizon.
// Values are display-referred (tuned to read on screen at exposure 1), smooth in every input.

export interface RealSkyInput {
  /** Unit vector to the sun (may be below the horizon). */
  sun: V3;
  /** Unit vector to the moon. */
  moon: V3;
  /** Moonlight on the sky 0..1 (phase and elevation). */
  moonLight: number;
  /** Warm horizon glow of a city at night 0..1. */
  cityGlow: number;
}

const NIGHT_ZENITH: V3 = [0.0021, 0.0036, 0.0088];
const NIGHT_HORIZON: V3 = [0.0048, 0.0064, 0.0115];
const CITY: V3 = [0.03, 0.017, 0.0075];
const MOON_SKY = 0.028;
const MOON_TINT: V3 = [0.8, 0.95, 1.3];
/** Ground bounce below the horizon at night: cool and dark (the warm daylight tint reads as brown fill at night). */
const NIGHT_GROUND: V3 = [0.24, 0.27, 0.34];

export class RealSkyModel {
  private readonly day: SkyState;
  private readonly moonState: SkyState | null;
  private readonly depression: number;
  private readonly sunH: [number, number];
  /** 0 by day … 1 when the sun is 14° down. */
  readonly night: number;
  readonly input: RealSkyInput;

  constructor(input: RealSkyInput, p: SkyParams = DEFAULT_SKY) {
    this.input = input;
    const s = input.sun;
    const elev = (Math.asin(Math.max(-1, Math.min(1, s[1]))) * 180) / Math.PI;
    this.depression = Math.max(0, -elev);
    const hn = Math.hypot(s[0], s[2]) || 1;
    this.sunH = [s[0] / hn, s[2] / hn];
    // the day sky with the sun no lower than just above the horizon
    const minY = Math.sin((0.4 * Math.PI) / 180);
    const sy = Math.max(s[1], minY), k = Math.sqrt(1 - sy * sy);
    // brightness of a sun just above the horizon, scattering phase from where the sun really is:
    // after sunset the forward-scattering glow sinks below the horizon with it
    this.day = { ...skyState([this.sunH[0] * k, sy, this.sunH[1] * k], p), sun: s[1] < sy ? [s[0], s[1], s[2]] : [this.sunH[0] * k, sy, this.sunH[1] * k] };
    const m = input.moon;
    if (input.moonLight > 0.001) {
      const my = Math.max(m[1], minY), mk = Math.sqrt(1 - my * my), mh = Math.hypot(m[0], m[2]) || 1;
      this.moonState = skyState([(m[0] / mh) * mk, my, (m[2] / mh) * mk], p);
    } else this.moonState = null;
    this.night = smooth(0, 14, this.depression);
  }

  /** Linear radiance in direction d (unit). */
  radiance(d: V3, out: V3 = [0, 0, 0]): V3 {
    const dep = this.depression;
    skyRadiance(this.day, d, out);
    const up = Math.max(0, d[1]);
    const hn = Math.hypot(d[0], d[2]) || 1;
    const cosAz = (d[0] / hn) * this.sunH[0] + (d[2] / hn) * this.sunH[1];
    if (dep > 0) {
      // degrees of depression for 1/e: the bright glow toward the sun falls fastest (it starts
      // brightest), the zenith slowest; reddening in the glow, ozone blue overhead
      const towards = ((cosAz + 1) / 2) ** 3;
      const low = 1 - smooth(0, 0.45, up);
      const glow = towards * low;
      const anti = ((1 - cosAz) / 2) ** 2 * low;
      const L = 3.8 - 1.4 * glow - 0.6 * anti;
      const att = Math.exp(-dep / L);
      const red = smooth(0, 4, dep) * glow;
      const blue = smooth(0, 4, dep) * (1 - glow);
      out[0] *= att * (1 - 0.3 * blue);
      out[1] *= att * (1 - 0.38 * red) * (1 - 0.05 * blue);
      out[2] *= att * (1 - 0.72 * red) * (1 + 0.5 * blue);
      // earth's shadow + belt of Venus opposite the sun, early twilight
      const beltOn = smooth(0, 1, dep) * (1 - smooth(4, 8, dep));
      if (beltOn > 0) {
        const elevDeg = (Math.asin(up) * 180) / Math.PI;
        const shadowTop = 0.6 + dep * 1.1;
        const inShadow = 1 - smooth(shadowTop - 1.5, shadowTop + 0.5, elevDeg);
        const belt = Math.exp(-(((elevDeg - (shadowTop + 4)) / 4) ** 2));
        const k = ((1 - cosAz) / 2) ** 2 * beltOn;
        out[0] = out[0] * (1 - 0.35 * inShadow * k) + 0.05 * belt * k * att;
        out[1] = out[1] * (1 - 0.3 * inShadow * k) + 0.026 * belt * k * att;
        out[2] = out[2] * (1 - 0.18 * inShadow * k) + 0.04 * belt * k * att;
      }
    }
    // night floor: brighter toward the horizon (airglow seen through more air)
    const n = this.night;
    if (n > 0) {
      const h = Math.pow(1 - up, 3);
      for (let i = 0; i < 3; i++) out[i] = out[i]! + n * (NIGHT_ZENITH[i]! + (NIGHT_HORIZON[i]! - NIGHT_ZENITH[i]!) * h);
    }
    // moonlit sky: daylight's blue scattering, from the moon
    if (this.moonState) {
      const m: V3 = [0, 0, 0];
      skyRadiance(this.moonState, d, m);
      const k = MOON_SKY * this.input.moonLight * n;
      for (let i = 0; i < 3; i++) out[i] = out[i]! + m[i]! * k * MOON_TINT[i]!;
    }
    if (this.input.cityGlow > 0 && n > 0) {
      const k = this.input.cityGlow * n * Math.exp(-up / 0.12);
      for (let i = 0; i < 3; i++) out[i] = out[i]! + CITY[i]! * k;
    }
    return out;
  }
}

/**
 * Rows [j0, j1) of the real sky as an equirect RGBA float image (row 0 = down), with the same
 * ground and fog treatment as sunSkyImage, written to `data` from its start (row j0 first).
 * Rows let live mode build the image over several frames.
 */
export function realSkyRows(model: RealSkyModel, width: number, height: number, data: Float32Array, j0: number, j1: number, fog?: V3) {
  const d: V3 = [0, 0, 0], c: V3 = [0, 0, 0], h: V3 = [0, 0, 0];
  for (let j = j0; j < j1; j++) {
    const ty = ((j + 0.5) / height - 0.5) * Math.PI;
    const cy = Math.cos(ty), sy = Math.sin(ty);
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      d[0] = cy * Math.cos(phi); d[1] = sy; d[2] = cy * Math.sin(phi);
      model.radiance(d, c);
      if (d[1] < 0) {
        const n = Math.hypot(d[0], d[2]) || 1;
        model.radiance([d[0] / n, 0, d[2] / n], h);
        const k = smooth(0, -0.12, d[1]);
        const nk = model.night;
        for (let q = 0; q < 3; q++) c[q] = c[q]! * (1 - k) + h[q]! * (GROUND_TINT[q]! * (1 - nk) + NIGHT_GROUND[q]! * nk) * 0.55 * k;
      }
      if (fog) {
        const k = smooth(0.07, -0.01, d[1]);
        for (let q = 0; q < 3; q++) c[q] = c[q]! * (1 - k) + fog[q]! * k;
      }
      const o = ((j - j0) * width + i) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 1;
    }
  }
}
