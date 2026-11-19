// Astronomy for the real sky (sky.mode "real"). Pure: no three.js, runs in Node.
//
// Everything is computed locally from the time and the place: no network, no account, so a
// real sky works offline and renders deterministically. Precision targets what a viewer can
// see: the sun to ~0.01° (NOAA's truncation of Meeus), the moon to ~0.02° plus topocentric
// parallax, sidereal time and precession to well under the size of a star dot.
//
// Ported from Lumbridge's earlier Tera prototype (solar.ts, atmosphere.ts moonPosition) and
// extended with sidereal time, precession, phase geometry and the night ramps.
//
// World axes: +X east, +Y up, -Z north (the engine's convention; solar.ts sunDirection).

export type V3 = [number, number, number];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const JD_UNIX_EPOCH = 2_440_587.5;
const J2000 = 2_451_545;

const mod = (x: number, n: number) => ((x % n) + n) % n;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function julianDay(ms: number): number {
  return ms / MS_PER_DAY + JD_UNIX_EPOCH;
}
/** Julian centuries since J2000.0. */
export function julianCentury(ms: number): number {
  return (julianDay(ms) - J2000) / 36_525;
}

/** Greenwich mean sidereal time in degrees (Meeus 12.4). */
export function gmstDeg(ms: number): number {
  const jd = julianDay(ms);
  const t = (jd - J2000) / 36_525;
  return mod(280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * t * t - (t * t * t) / 38_710_000, 360);
}

/** Local mean sidereal time in degrees (longitude east positive). */
export function lstDeg(ms: number, lon: number): number {
  return mod(gmstDeg(ms) + lon, 360);
}

/** Unit vector of RA/Dec (degrees) in the equatorial frame: x → vernal equinox, z → north celestial pole. */
export function radecToVec(raDeg: number, decDeg: number): V3 {
  const a = raDeg * DEG, d = decDeg * DEG;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** Row-major 3x3. */
export type M3 = [number, number, number, number, number, number, number, number, number];

export function mulM3(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0) as M3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}
export function applyM3(m: M3, v: readonly number[]): V3 {
  return [m[0] * v[0]! + m[1] * v[1]! + m[2] * v[2]!, m[3] * v[0]! + m[4] * v[1]! + m[5] * v[2]!, m[6] * v[0]! + m[7] * v[1]! + m[8] * v[2]!];
}

/**
 * Precession from J2000 mean equator/equinox to the mean equator of date (IAU 1976:
 * Lieske's ζ, z, θ). Star catalogues are J2000; the sky of 2026 has turned ~0.36° since.
 */
export function precessionMatrix(ms: number): M3 {
  const t = julianCentury(ms);
  const as = DEG / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * as;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * as;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * as;
  // P = R3(-z) · R2(θ) · R3(-ζ)  (frame rotations)
  const r3 = (a: number): M3 => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const r2 = (a: number): M3 => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
  return mulM3(r3(-z), mulM3(r2(theta), r3(-zeta)));
}

/**
 * Equatorial-of-date unit vectors → world directions (+X east, +Y up, -Z north) for an
 * observer at latitude `lat` with local sidereal time `lstDegrees`. A pure rotation.
 */
export function equatorialToWorld(lstDegrees: number, lat: number): M3 {
  const th = lstDegrees * DEG, ph = lat * DEG;
  const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
  return [-st, ct, 0, cp * ct, cp * st, sp, sp * ct, sp * st, -cp];
}

/** J2000 catalogue vectors → world directions at this time and place (precession included). */
export function catalogToWorld(ms: number, lat: number, lon: number): M3 {
  return mulM3(equatorialToWorld(lstDeg(ms, lon), lat), precessionMatrix(ms));
}

/** Degrees above the horizon (y) and clockwise from north of a world direction. */
export function altAz(d: readonly number[]): { elevation: number; azimuth: number } {
  return { elevation: Math.asin(clamp(d[1]!, -1, 1)) * RAD, azimuth: mod(Math.atan2(d[0]!, -d[2]!) * RAD, 360) };
}

/** World direction for azimuth (clockwise from north) / elevation in degrees. */
export function dirFromAltAz(azimuth: number, elevation: number): V3 {
  const el = elevation * DEG, az = azimuth * DEG;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

// ---------------------------------------------------------------- the sun

export interface SolarPosition {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon, refraction applied. */
  elevation: number;
  /** Geometric (unrefracted) elevation, degrees: the twilight bands are defined on this. */
  geometric: number;
  declination: number;
  /** Apparent minus mean solar time, minutes. */
  equationOfTime: number;
}

function solarTerms(t: number) {
  const meanLongitude = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360);
  const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnomaly * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * DEG) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * DEG);
  const declination = Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLongitude * DEG)) * RAD;
  const y = Math.tan((obliquity / 2) * DEG) ** 2;
  const equationOfTime =
    4 * RAD *
    (y * Math.sin(2 * meanLongitude * DEG) -
      2 * eccentricity * Math.sin(meanAnomaly * DEG) +
      4 * eccentricity * y * Math.sin(meanAnomaly * DEG) * Math.cos(2 * meanLongitude * DEG) -
      0.5 * y * y * Math.sin(4 * meanLongitude * DEG) -
      1.25 * eccentricity ** 2 * Math.sin(2 * meanAnomaly * DEG));
  return { declination, equationOfTime, apparentLongitude, obliquity };
}

/** Atmospheric refraction (degrees, to add to a geometric elevation). NOAA's piecewise fit. */
export function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * DEG);
  let arcsec: number;
  if (elevation > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575) arcsec = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

/**
 * The sun for an observer (NOAA Solar Calculator = Meeus ch. 22/25/28, ~0.01° 1800–2100).
 * Longitude positive east.
 */
export function solarPosition(ms: number, lat: number, lon: number): SolarPosition {
  const { declination, equationOfTime } = solarTerms(julianCentury(ms));
  const utcMinutes = mod(ms / MS_PER_MINUTE, 1440);
  const trueSolarTime = mod(utcMinutes + equationOfTime + 4 * lon, 1440);
  const hourAngle = trueSolarTime / 4 - 180;
  const latR = lat * DEG, decR = declination * DEG;
  const cosZ = clamp(Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(hourAngle * DEG), -1, 1);
  const zenith = Math.acos(cosZ) * RAD;
  const geometric = 90 - zenith;
  const sinZ = Math.sin(zenith * DEG), cosLat = Math.cos(latR);
  let azimuth: number;
  if (Math.abs(sinZ) < 1e-9 || Math.abs(cosLat) < 1e-9) azimuth = mod(hourAngle + 180, 360);
  else {
    const a = Math.acos(clamp((Math.sin(latR) * cosZ - Math.sin(decR)) / (cosLat * sinZ), -1, 1)) * RAD;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  return { azimuth, elevation: geometric + refraction(geometric), geometric, declination, equationOfTime };
}

/** The sun's apparent geocentric RA/Dec (degrees), for phase and eclipse geometry. */
export function sunRaDec(ms: number): { ra: number; dec: number } {
  const t = julianCentury(ms);
  const { apparentLongitude, obliquity } = solarTerms(t);
  const l = apparentLongitude * DEG, e = obliquity * DEG;
  return { ra: mod(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)) * RAD, 360), dec: Math.asin(Math.sin(e) * Math.sin(l)) * RAD };
}

// ---------------------------------------------------------------- the moon

export interface MoonPosition {
  azimuth: number;
  /** Degrees above the horizon, topocentric (parallax applied) and refracted. */
  elevation: number;
  /** Geocentric RA/Dec of date, degrees. */
  ra: number;
  dec: number;
  distanceKm: number;
  /** Fraction of the disc lit, 0 new … 1 full. */
  illuminated: number;
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number;
  /** Apparent angular diameter, degrees. */
  diameter: number;
}

const EARTH_RADIUS_KM = 6378.14;
const MOON_RADIUS_KM = 1737.4;

/**
 * The moon (Meeus ch. 47, the largest terms: ~0.02° in longitude, a few hundred km in
 * distance) with topocentric parallax, which moves it by up to a degree.
 */
export function moonPosition(ms: number, lat: number, lon: number): MoonPosition {
  const jd = julianDay(ms);
  const t = (jd - J2000) / 36_525;
  const sin = (d: number) => Math.sin(d * DEG);
  const cos = (d: number) => Math.cos(d * DEG);
  const Lp = 218.3164477 + 481_267.88123421 * t - 0.0015786 * t * t;
  const d = 297.8501921 + 445_267.1114034 * t - 0.0018819 * t * t;
  const m = 357.5291092 + 35_999.0502909 * t - 0.0001536 * t * t;
  const mp = 134.9633964 + 477_198.8675055 * t + 0.0087414 * t * t;
  const f = 93.272095 + 483_202.0175233 * t - 0.0036539 * t * t;
  const E = 1 - 0.002516 * t - 0.0000074 * t * t;

  const longitude = Lp +
    6.288774 * sin(mp) + 1.274027 * sin(2 * d - mp) + 0.658314 * sin(2 * d) + 0.213618 * sin(2 * mp) -
    0.185116 * E * sin(m) - 0.114332 * sin(2 * f) + 0.058793 * sin(2 * d - 2 * mp) + 0.057066 * E * sin(2 * d - m - mp) +
    0.053322 * sin(2 * d + mp) + 0.045758 * E * sin(2 * d - m) - 0.040923 * E * sin(m - mp) - 0.03472 * sin(d) -
    0.030383 * E * sin(m + mp) + 0.015327 * sin(2 * d - 2 * f) - 0.012528 * sin(mp + 2 * f) + 0.01098 * sin(mp - 2 * f) +
    0.010675 * sin(4 * d - mp) + 0.010034 * sin(3 * mp) + 0.008548 * sin(4 * d - 2 * mp) - 0.007888 * E * sin(2 * d + m - mp) -
    0.006766 * E * sin(2 * d + m) - 0.005163 * sin(d - mp) + 0.004987 * E * sin(d + m) + 0.004036 * E * sin(2 * d - m + mp);
  const latitude =
    5.128122 * sin(f) + 0.280602 * sin(mp + f) + 0.277693 * sin(mp - f) + 0.173237 * sin(2 * d - f) +
    0.055413 * sin(2 * d - mp + f) + 0.046271 * sin(2 * d - mp - f) + 0.032573 * sin(2 * d + f) +
    0.017198 * sin(2 * mp + f) + 0.009266 * sin(2 * d + mp - f) + 0.008822 * sin(2 * mp - f) +
    0.008216 * E * sin(2 * d - m - f) + 0.004324 * sin(2 * d - 2 * mp - f) + 0.0042 * sin(2 * d + f + mp);
  const distanceKm = 385_000.56 - 20_905.355 * cos(mp) - 3699.111 * cos(2 * d - mp) - 2955.968 * cos(2 * d) -
    569.925 * cos(2 * mp) + 48.888 * E * cos(m) - 3.149 * cos(2 * f) + 246.158 * cos(2 * d - 2 * mp) -
    152.138 * E * cos(2 * d - m - mp) - 170.733 * cos(2 * d + mp) - 204.586 * E * cos(2 * d - m) - 129.62 * E * cos(m - mp) +
    108.743 * cos(d) + 104.755 * E * cos(m + mp);

  // nutation in longitude (dominant term) so the moon and the apparent sun share a frame
  const omega = 125.04452 - 1934.136261 * t;
  const lambda = (longitude - 0.00478 * Math.sin(omega * DEG)) * DEG;
  const beta = latitude * DEG;
  const eps = (23.4392911 - 0.0130042 * t + 0.00256 * Math.cos(omega * DEG)) * DEG;
  const ra = Math.atan2(Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lambda));
  const dec = Math.asin(clamp(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda), -1, 1));

  // topocentric: subtract the observer's position (spherical earth is plenty here)
  const geo = radecToVec(ra * RAD, dec * RAD);
  const lst = lstDeg(ms, lon) * DEG, ph = lat * DEG;
  const k = EARTH_RADIUS_KM / distanceKm;
  const obs: V3 = [Math.cos(ph) * Math.cos(lst) * k, Math.cos(ph) * Math.sin(lst) * k, Math.sin(ph) * k];
  const topo: V3 = [geo[0] - obs[0], geo[1] - obs[1], geo[2] - obs[2]];
  const n = Math.hypot(topo[0], topo[1], topo[2]);
  const w = applyM3(equatorialToWorld(lst * RAD, lat), [topo[0] / n, topo[1] / n, topo[2] / n]);
  const { elevation, azimuth } = altAz(w);

  // phase from the geocentric elongation (sun and moon in the same apparent frame)
  const s = sunRaDec(ms);
  const sv = radecToVec(s.ra, s.dec);
  const cosElong = clamp(sv[0] * geo[0] + sv[1] * geo[1] + sv[2] * geo[2], -1, 1);
  const elong = Math.acos(cosElong);
  // phase angle (sun–moon–earth), Meeus 48.3 with the sun at 1 AU
  const R = 149_597_870;
  const i = Math.atan2(R * Math.sin(elong), distanceKm - R * cosElong);
  const illuminated = (1 + Math.cos(i)) / 2;
  const sunLon = Math.atan2(Math.sin(s.ra * DEG) * Math.cos(eps) + Math.tan(s.dec * DEG) * Math.sin(eps), Math.cos(s.ra * DEG));
  const phase = mod((lambda - sunLon) * RAD, 360) / 360;
  return {
    azimuth,
    elevation: elevation + refraction(elevation),
    ra: mod(ra * RAD, 360),
    dec: dec * RAD,
    distanceKm,
    illuminated,
    phase,
    diameter: 2 * Math.atan(MOON_RADIUS_KM / (distanceKm * n)) * RAD,
  };
}

/**
 * Bright-limb direction of the moon in world space: the direction, perpendicular to the line
 * of sight, from the disc centre toward the sun. The lit side of the disc faces it.
 */
export function brightLimb(moonDir: readonly number[], sunDir: readonly number[]): V3 {
  const d = sunDir[0]! * moonDir[0]! + sunDir[1]! * moonDir[1]! + sunDir[2]! * moonDir[2]!;
  const v: V3 = [sunDir[0]! - d * moonDir[0]!, sunDir[1]! - d * moonDir[1]!, sunDir[2]! - d * moonDir[2]!];
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-9) {
    // new or full moon exactly: any perpendicular works
    const up: V3 = Math.abs(moonDir[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = up[0] * moonDir[0]! + up[1] * moonDir[1]! + up[2] * moonDir[2]!;
    const p: V3 = [up[0] - u * moonDir[0]!, up[1] - u * moonDir[1]!, up[2] - u * moonDir[2]!];
    const pn = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / pn, p[1] / pn, p[2] / pn];
  }
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------- planets (naked-eye)

interface Elements { N: [number, number]; i: [number, number]; w: [number, number]; a: number; e: [number, number]; M: [number, number] }
// Orbital elements (Schlyter's "How to compute planetary positions", d = days from 2000 Jan 0.0 UT):
// value = x0 + x1·d. Good to a few arcminutes, plenty for points of light.
const PLANETS: Record<"venus" | "mars" | "jupiter" | "saturn" | "mercury", Elements & { mag: [number, number, number] }> = {
  mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.0e-8], w: [29.1241, 1.01444e-5], a: 0.387098, e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368], mag: [-0.36, 0.027, 2.2e-13] },
  venus: { N: [76.6799, 2.4659e-5], i: [3.3946, 2.75e-8], w: [54.891, 1.38374e-5], a: 0.72333, e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244], mag: [-4.34, 0.013, 4.2e-7] },
  mars: { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766], mag: [-1.51, 0.016, 0] },
  jupiter: { N: [100.4542, 2.76854e-5], i: [1.303, -1.557e-7], w: [273.8777, 1.64505e-5], a: 5.20256, e: [0.048498, 4.469e-9], M: [19.895, 0.0830853001], mag: [-9.25, 0.014, 0] },
  saturn: { N: [113.6634, 2.3898e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: 9.55475, e: [0.055546, -9.499e-9], M: [316.967, 0.0334442282], mag: [-9.0, 0.044, 0] },
};
export type PlanetName = keyof typeof PLANETS;
export const PLANET_NAMES = Object.keys(PLANETS) as PlanetName[];

function helio(el: Elements, d: number): V3 {
  const N = (el.N[0] + el.N[1] * d) * DEG, i = (el.i[0] + el.i[1] * d) * DEG, w = (el.w[0] + el.w[1] * d) * DEG;
  const e = el.e[0] + el.e[1] * d, M = mod(el.M[0] + el.M[1] * d, 360) * DEG;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 6; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = el.a * (Math.cos(E) - e), yv = el.a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  return [
    r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i)),
    r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i)),
    r * Math.sin(v + w) * Math.sin(i),
  ];
}

/** A naked-eye planet: geocentric RA/Dec of date (degrees) and visual magnitude. */
export function planetPosition(name: PlanetName, ms: number): { ra: number; dec: number; mag: number } {
  const d = julianDay(ms) - 2_451_543.5;
  const el = PLANETS[name];
  const p = helio(el, d);
  // the sun's geocentric ecliptic position (Schlyter), = minus the earth's heliocentric one
  const ws = (282.9404 + 4.70935e-5 * d) * DEG, es = 0.016709 - 1.151e-9 * d, Ms = mod(356.047 + 0.9856002585 * d, 360) * DEG;
  const Es = Ms + es * Math.sin(Ms) * (1 + es * Math.cos(Ms));
  const xs = Math.cos(Es) - es, ys = Math.sqrt(1 - es * es) * Math.sin(Es);
  const vs = Math.atan2(ys, xs), rs = Math.hypot(xs, ys);
  const sun: V3 = [rs * Math.cos(vs + ws), rs * Math.sin(vs + ws), 0];
  const g: V3 = [p[0] + sun[0], p[1] + sun[1], p[2] + sun[2]];
  const ecl = (23.4393 - 3.563e-7 * d) * DEG;
  const eq: V3 = [g[0], g[1] * Math.cos(ecl) - g[2] * Math.sin(ecl), g[1] * Math.sin(ecl) + g[2] * Math.cos(ecl)];
  const R = Math.hypot(eq[0], eq[1], eq[2]), r = Math.hypot(p[0], p[1], p[2]);
  // phase angle → magnitude
  const fv = Math.acos(clamp((r * r + R * R - rs * rs) / (2 * r * R), -1, 1)) * RAD;
  const mag = el.mag[0] + 5 * Math.log10(r * R) + el.mag[1] * fv + el.mag[2] * fv ** (name === "venus" ? 3 : 6);
  // Schlyter's elements are of date already (they include precession in N, w)
  return { ra: mod(Math.atan2(eq[1], eq[0]) * RAD, 360), dec: Math.asin(eq[2] / R) * RAD, mag };
}

// ---------------------------------------------------------------- night

/** Default sun-elevation ramp (degrees) over which night lights fade: fully day at +2°, fully night at −6°. */
export const NIGHT_RAMP: [number, number] = [2, -6];

/**
 * How much it is night, 0 (day) … 1 (night), from the sun's elevation, a smooth ramp
 * between `ramp[0]` (still day) and `ramp[1]` (night). Halfway (−2° with the default ramp)
 * is where streetlights are typically on; at −4° it is ≈ 0.84.
 */
export function nightness(sunElevation: number, ramp: readonly [number, number] = NIGHT_RAMP): number {
  const [a, b] = ramp;
  if (a === b) return sunElevation <= a ? 1 : 0;
  return smoothstep(a, b, sunElevation);
}

/** Twilight band from the sun's geometric elevation. */
export function daylightPhase(elevation: number): "day" | "golden" | "civil" | "nautical" | "astronomical" | "night" {
  if (elevation >= 6) return "day";
  if (elevation >= -0.833) return "golden";
  if (elevation >= -6) return "civil";
  if (elevation >= -12) return "nautical";
  if (elevation >= -18) return "astronomical";
  return "night";
}

/**
 * Sky darkness for stars and satellites, 0 (daylight) … 1 (astronomical night). Driven by
 * the sun's elevation; civil twilight shows only the brightest objects.
 */
export function skyDarkness(sunElevation: number): number {
  return smoothstep(-1, -15, sunElevation);
}

/**
 * Naked-eye limiting magnitude for the sky background: ~6.4 under a dark sky, less with
 * twilight, moonlight and city glow. `moonLight` 0..1 (full moon high up), `cityGlow` 0..1.
 */
export function limitingMagnitude(sunElevation: number, moonLight = 0, cityGlow = 0): number {
  // twilight: about −4 at sunset (only Venus), 1 at −6°, 4.5 at −12°, dark by −18°
  const tw = sunElevation >= 0 ? -4 : sunElevation > -6 ? -4 + (5 * -sunElevation) / 6 : sunElevation > -12 ? 1 + (3.5 * (-sunElevation - 6)) / 6 : 4.5 + Math.min(1.9, (1.9 * (-sunElevation - 12)) / 6);
  const moonCut = 1.5 * clamp(moonLight, 0, 1);
  const cityCut = 2.4 * clamp(cityGlow, 0, 1);
  return Math.min(tw, 6.4 - moonCut - cityCut);
}

/** Parse "now" or an ISO time (no zone = local clock time at the longitude, as mode "sun"). */
export function parseRealTime(time: string | undefined, lon: number, nowMs: number): number {
  if (time === undefined || time === "now") return nowMs;
  const s = time.trim();
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const ms = hasZone ? new Date(s).getTime() : new Date(s + "Z").getTime() - Math.round(lon / 15) * 3600_000;
  if (Number.isNaN(ms)) throw new Error(`bad sky time "${time}"`);
  return ms;
}
