// The bright-star catalogue (Yale BSC5, public domain; src/engine/data/stars.ts) decoded,
// plus the colour of a star from its B−V index and the Milky Way's brightness model. Pure.
import { radecToVec, type V3 } from "./astro.ts";

export interface StarTable {
  count: number;
  /** J2000 equatorial unit vectors, xyz per star. */
  dir: Float32Array;
  /** V magnitude. */
  mag: Float32Array;
  /** B−V colour index. */
  bv: Float32Array;
}

let cached: StarTable | null = null;

function decodeB64(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(s, "base64"));
}

/** Decode the packed catalogue (cached). `limit` keeps stars up to that magnitude. */
export async function loadStars(): Promise<StarTable> {
  if (cached) return cached;
  const { STARS_B64, STAR_COUNT } = await import("./data/stars.ts");
  const bytes = decodeB64(STARS_B64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = STAR_COUNT;
  const t: StarTable = { count: n, dir: new Float32Array(n * 3), mag: new Float32Array(n), bv: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const ra = (dv.getUint16(o, true) / 65536) * 360;
    const dec = (dv.getInt16(o + 2, true) / 32767) * 90;
    const v = radecToVec(ra, dec);
    t.dir[i * 3] = v[0]; t.dir[i * 3 + 1] = v[1]; t.dir[i * 3 + 2] = v[2];
    t.mag[i] = dv.getUint8(o + 4) / 20 - 2;
    t.bv[i] = dv.getInt8(o + 5) / 50;
  }
  cached = t;
  return t;
}

/**
 * Linear RGB (max component 1) of a star with colour index B−V: blue-white O/B stars,
 * white A, yellow G (the sun is 0.65), orange K, red M. Black-body temperature from
 * Ballesteros' formula, then a smooth black-body tint, gently desaturated (the eye sees
 * star colours weakly).
 */
export function starColor(bv: number): V3 {
  const b = Math.max(-0.4, Math.min(2, bv));
  const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  // black-body → sRGB-ish (Tanner Helland's fit, in linear-ish 0..1)
  const t = T / 100;
  let r: number, g: number, bl: number;
  if (t <= 66) {
    r = 1;
    g = Math.max(0, Math.min(1, (99.4708025861 * Math.log(t) - 161.1195681661) / 255));
    bl = t <= 19 ? 0 : Math.max(0, Math.min(1, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255));
  } else {
    r = Math.max(0, Math.min(1, (329.698727446 * Math.pow(t - 60, -0.1332047592)) / 255));
    g = Math.max(0, Math.min(1, (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255));
    bl = 1;
  }
  // sRGB → linear, then 55 % saturation
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const c: V3 = [lin(r), lin(g), lin(bl)];
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const s = 0.55;
  const o: V3 = [y + (c[0] - y) * s, y + (c[1] - y) * s, y + (c[2] - y) * s];
  const m = Math.max(o[0], o[1], o[2]);
  return [o[0] / m, o[1] / m, o[2] / m];
}

// ---------------------------------------------------------------- Milky Way

/** Galactic frame in J2000 equatorial coordinates (north galactic pole, galactic centre). */
const NGP = radecToVec(192.85948, 27.12825);
const GC0 = radecToVec(266.40499, -28.93617);
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const GX: V3 = (() => {
  const d = dot(GC0, NGP);
  const v: V3 = [GC0[0] - d * NGP[0], GC0[1] - d * NGP[1], GC0[2] - d * NGP[2]];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
})();
const GY: V3 = [NGP[1] * GX[2] - NGP[2] * GX[1], NGP[2] * GX[0] - NGP[0] * GX[2], NGP[0] * GX[1] - NGP[1] * GX[0]];

/** Galactic longitude/latitude (degrees) of a J2000 equatorial unit vector. */
export function galactic(e: readonly number[]): { l: number; b: number } {
  const b = (Math.asin(Math.max(-1, Math.min(1, dot(e, NGP)))) * 180) / Math.PI;
  const l = (((Math.atan2(dot(e, GY), dot(e, GX)) * 180) / Math.PI) % 360 + 360) % 360;
  return { l, b };
}

// deterministic value noise on the sphere (3D), for the mottled star clouds and dust lanes
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let acc = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    acc += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return acc;
}
export function fbm(x: number, y: number, z: number, octaves = 5): number {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * vnoise(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

const wrap180 = (l: number) => ((l + 180) % 360 + 360) % 360 - 180;

/**
 * Milky Way surface brightness (linear rgb, roughly 0..1) for a J2000 direction: a disc band
 * along the galactic plane, a bulge around the galactic centre in Sagittarius, bright star
 * clouds (Cygnus, Scutum, Carina), the Great Rift and other dust lanes. A procedural
 * approximation of the real band's shape, not survey data.
 */
export function milkyWay(e: readonly number[], out: V3 = [0, 0, 0]): V3 {
  const { l, b } = galactic(e);
  const lw = wrap180(l); // −180..180, 0 = galactic centre
  const al = Math.abs(lw);
  // disc: thin near the anticentre, thicker toward the centre
  const width = 3.5 + 5 * Math.exp(-((al / 70) ** 2));
  const lonFall = 0.3 + 0.7 * Math.exp(-((al / 85) ** 2));
  // a bright core lane plus a broad, faint skirt (the band is 20–30° wide to the eye)
  const disc = (Math.exp(-((b / width) ** 2)) * 0.75 + Math.exp(-((b / (width * 3.2)) ** 2)) * 0.3) * lonFall;
  // bulge: an oval glow in Sagittarius/Scorpius
  const bulge = 0.9 * Math.exp(-((lw / 13) ** 2) - ((b + 1.5) / 9) ** 2);
  // bright star clouds
  const clouds =
    0.32 * Math.exp(-(((lw - 77) / 13) ** 2) - (b / 5) ** 2) + // Cygnus
    0.28 * Math.exp(-(((lw - 27) / 7) ** 2) - ((b + 2) / 4) ** 2) + // Scutum
    0.24 * Math.exp(-(((lw + 73) / 10) ** 2) - ((b + 1) / 4) ** 2) + // Carina (l ≈ 287)
    0.16 * Math.exp(-(((lw + 30) / 12) ** 2) - (b / 5) ** 2); // Norma/Centaurus
  const n = fbm(e[0]! * 9 + 11.3, e[1]! * 9 - 4.1, e[2]! * 9 + 7.7, 5);
  const fine = fbm(e[0]! * 38 - 3.1, e[1]! * 38 + 9.2, e[2]! * 38 + 1.4, 4);
  let I = (disc + bulge + clouds) * (0.25 + 1.3 * n * n) * (0.6 + 0.8 * fine * fine);
  // dust: the Great Rift from Cygnus to Sagittarius (slightly above the plane), lanes elsewhere
  const riftCentre = 1.2 + 1.5 * Math.sin((lw / 40) * Math.PI);
  const riftSpan = Math.exp(-(((lw - 40) / 55) ** 4)); // smooth: strongest from Cygnus to Sagittarius
  const rift = riftSpan * Math.exp(-(((b - riftCentre) / (1.3 + 0.9 * n)) ** 2)) * (0.55 + 0.4 * fbm(e[0]! * 20, e[1]! * 20, e[2]! * 20, 3));
  const lanes = Math.exp(-((b / 1.1) ** 2)) * Math.max(0, fbm(e[0]! * 16 + 5, e[1]! * 16, e[2]! * 16 - 5, 4) - 0.45) * 1.8;
  I *= Math.max(0, 1 - 0.85 * rift - 0.6 * lanes);
  I = Math.max(0, I);
  // warm toward the bulge, cool in the disc
  const warm = Math.min(1, bulge * 1.4 + 0.15);
  out[0] = I * (0.86 + 0.14 * warm);
  out[1] = I * (0.88 + 0.04 * warm);
  out[2] = I * (1.0 - 0.18 * warm);
  return out;
}
