// Satellites in the observer's sky: SGP4 (satellite.js, MIT) from OMM / TLE element sets,
// turned into world directions on a sky dome, with how sunlit each one is. Pure: no three.js,
// runs in Node.
//
// Ported from Lumbridge's earlier Tera prototype (satellites.ts) and reshaped for this engine:
// a satellite at 550 km cannot live in a metric world a few hundred metres across, so each one
// is drawn where you would see it if you looked up — its true azimuth and elevation from the
// world's lat/lon, on a dome around the camera. The dome radius means nothing; the direction is
// everything. A Starlink is visible to the naked eye when it is in sunlight while the observer's
// sky is dark, which is why every fix carries `shadow` (satellite.js shadowFraction: 0 lit,
// 1 umbra, in between = penumbra, where the fade at the end of a train comes from).
//
// Cost: SGP4 is ~4 µs per object, so a full Starlink catalogue (~10 000) is ~40 ms.
// - Render mode calls fixesAt(t) for every frame: exact and deterministic.
// - Live mode uses LiveSatellites: two keyframes 20 s of sky time apart, the next one built in
//   time-budgeted slices across frames, positions linearly interpolated in between (an
//   orbit's chord over 20 s is ~0.1 km off the arc: invisible), and only objects near or above
//   the horizon are evaluated per frame.
import { geodeticToEcf, gstime, json2satrec, propagate, shadowFraction, sunPos, twoline2satrec, type SatRec } from "satellite.js";

export interface SatRecord {
  name: string;
  /** NORAD catalogue number. */
  id: number;
  rec: SatRec;
  /** Mean altitude under 380 km: freshly launched and still climbing (Starlink "trains"), brighter. */
  low: boolean;
  /** Standard magnitude: brightness at 1000 km range, half lit (ISS −1.8, a Starlink ≈ 6.3). */
  stdMag: number;
}

/** Standard magnitudes (at 1000 km) by name; everything else is a small satellite. */
function standardMagnitude(name: string, low: boolean): number {
  if (/^ISS( |$)|ZARYA/i.test(name)) return -1.8;
  if (/TIANHE|^CSS/i.test(name)) return -0.8;
  if (/^STARLINK/i.test(name)) return low ? 4.0 : 6.3;
  if (/^ONEWEB/i.test(name)) return 7.5;
  return 5.5;
}

export interface SatParseResult {
  sats: SatRecord[];
  /** Element sets that could not be read or that SGP4 rejects. */
  skipped: number;
}

/** Group filters: name patterns. "all" (or no groups) keeps everything. */
export const SAT_GROUPS: Record<string, RegExp> = {
  starlink: /^STARLINK/i,
  oneweb: /^ONEWEB/i,
  iss: /^ISS( |$)|ZARYA/i,
  stations: /^ISS( |$)|ZARYA|^CSS|TIANHE|WENTIAN|MENGTIAN|^TIANGONG/i,
  kuiper: /^KUIPER/i,
};

const EARTH_RADIUS_KM = 6378.137;
const MU = 398600.4418; // km³/s²

function meanAltitudeKm(rec: SatRec): number {
  const n = rec.no / 60; // rad/s (satrec.no is rad/min)
  const a = Math.cbrt(MU / (n * n));
  return a - EARTH_RADIUS_KM;
}

function okRec(rec: SatRec): boolean {
  return rec.error === 0 && Number.isFinite(rec.no) && rec.no > 0 && Number.isFinite(rec.inclo) && Number.isFinite(rec.ecco);
}

/**
 * Read element sets: a JSON array of OMM objects (Celestrak GP JSON: OBJECT_NAME, NORAD_CAT_ID,
 * EPOCH, MEAN_MOTION, …) or TLE text (2-line or 3-line with names). `groups` filters by name
 * (keys of SAT_GROUPS, or "all"); `max` keeps the first n after filtering (file order).
 */
export function parseSatellites(text: string, groups?: string[], max?: number): SatParseResult {
  const want = !groups || groups.length === 0 || groups.includes("all") ? null : groups.map((g) => SAT_GROUPS[g.toLowerCase()] ?? new RegExp(`^${g.replace(/[^a-z0-9 -]/gi, "")}`, "i"));
  const keep = (name: string) => !want || want.some((re) => re.test(name));
  const sats: SatRecord[] = [];
  let skipped = 0;
  const push = (name: string, id: number, rec: SatRec | null) => {
    if (!rec || !okRec(rec)) return void skipped++;
    const low = meanAltitudeKm(rec) < 380;
    sats.push({ name, id, rec, low, stdMag: standardMagnitude(name, low) });
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(data) ? data : [data];
    for (const o of list as Record<string, unknown>[]) {
      if (max !== undefined && sats.length >= max) break;
      const name = String(o?.OBJECT_NAME ?? "");
      if (!keep(name)) continue;
      let rec: SatRec | null = null;
      try {
        rec = json2satrec(o as unknown as Parameters<typeof json2satrec>[0]);
      } catch {
        rec = null;
      }
      push(name, Number(o?.NORAD_CAT_ID ?? 0), rec);
    }
  } else {
    const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length);
    for (let i = 0; i < lines.length; i++) {
      if (max !== undefined && sats.length >= max) break;
      const l = lines[i]!;
      if (l.startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
        const prev = i > 0 && !lines[i - 1]!.startsWith("2 ") && !lines[i - 1]!.startsWith("1 ") ? lines[i - 1]!.replace(/^0 /, "").trim() : "";
        const name = prev || `SAT ${l.slice(2, 7).trim()}`;
        if (keep(name)) {
          let rec: SatRec | null = null;
          try {
            rec = twoline2satrec(l, lines[i + 1]!);
          } catch {
            rec = null;
          }
          push(name, Number(l.slice(2, 7)) || 0, rec);
        }
        i++;
      }
    }
  }
  return { sats, skipped };
}

/** The observer: ECEF position (km) and the ENU basis at that point. */
export interface Observer {
  ecf: [number, number, number];
  /** sinφ, cosφ, sinλ, cosλ (geodetic). */
  s: [number, number, number, number];
}

export function makeObserver(lat: number, lon: number, heightKm = 0): Observer {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const e = geodeticToEcf({ latitude: phi as never, longitude: lam as never, height: heightKm as never });
  return { ecf: [e.x, e.y, e.z], s: [Math.sin(phi), Math.cos(phi), Math.sin(lam), Math.cos(lam)] };
}

/**
 * ECI (km) → world direction (unit, +X east, +Y up, −Z north) written into `out` at `o`.
 * Returns the range in km.
 */
export function eciToWorld(x: number, y: number, z: number, gmst: number, obs: Observer, out: Float32Array | number[], o: number): number {
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const ex = x * cg + y * sg - obs.ecf[0], ey = -x * sg + y * cg - obs.ecf[1], ez = z - obs.ecf[2];
  const [sp, cp, sl, cl] = obs.s;
  const E = -sl * ex + cl * ey;
  const N = -sp * cl * ex - sp * sl * ey + cp * ez;
  const U = cp * cl * ex + cp * sl * ey + sp * ez;
  const r = Math.hypot(E, N, U);
  out[o] = E / r; out[o + 1] = U / r; out[o + 2] = -N / r;
  return r;
}

/** One visible satellite in a frame. */
export interface SatFrame {
  /** Number of fixes. */
  count: number;
  /** World directions now (xyz × count). */
  dir: Float32Array;
  /** World directions `trail` seconds earlier (xyz × count). */
  tail: Float32Array;
  rangeKm: Float32Array;
  /** 0 lit … 1 umbra. */
  shadow: Float32Array;
  /** Index into the catalogue. */
  index: Uint32Array;
}

export function emptyFrame(n: number): SatFrame {
  return { count: 0, dir: new Float32Array(n * 3), tail: new Float32Array(n * 3), rangeKm: new Float32Array(n), shadow: new Float32Array(n), index: new Uint32Array(n) };
}

function eciAt(rec: SatRec, ms: number): { x: number; y: number; z: number } | null {
  const st = propagate(rec, new Date(ms));
  const p = st?.position as { x: number; y: number; z: number } | false | undefined;
  if (!p || typeof p !== "object" || !Number.isFinite(p.x)) return null;
  return p;
}

const jdayOf = (ms: number) => ms / 86_400_000 + 2_440_587.5;

/**
 * Exact fixes at `ms`: every satellite at or above `minElevation` (degrees), with its
 * direction `trailSec` earlier for the motion trail. Deterministic.
 */
export function fixesAt(sats: SatRecord[], obs: Observer, ms: number, minElevation: number, trailSec: number, out?: SatFrame): SatFrame {
  const f = out && out.index.length >= sats.length ? out : emptyFrame(sats.length);
  const g = gstime(new Date(ms));
  const g0 = gstime(new Date(ms - trailSec * 1000));
  const sun = sunPos(jdayOf(ms) as never).rsun;
  const minY = Math.sin((minElevation * Math.PI) / 180);
  const tmp = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < sats.length; i++) {
    const p = eciAt(sats[i]!.rec, ms);
    if (!p) continue;
    const r = eciToWorld(p.x, p.y, p.z, g, obs, tmp, 0);
    if (tmp[1]! < minY) continue;
    const q = eciAt(sats[i]!.rec, ms - trailSec * 1000) ?? p;
    eciToWorld(q.x, q.y, q.z, g0, obs, f.tail, n * 3);
    f.dir[n * 3] = tmp[0]!; f.dir[n * 3 + 1] = tmp[1]!; f.dir[n * 3 + 2] = tmp[2]!;
    f.rangeKm[n] = r;
    f.shadow[n] = shadowFraction(sun as never, p as never);
    f.index[n] = i;
    n++;
  }
  f.count = n;
  return f;
}

/**
 * Visual magnitude estimate of a satellite from its standard magnitude (at 1000 km): a current
 * Starlink ≈ 5 at 550 km straight up (brightness-mitigated), one still low after launch ≈ 2.7
 * (the bright "trains"), the ISS ≈ −3 overhead. Infinity when in the earth's shadow.
 */
export function satMagnitude(rangeKm: number, shadow: number, stdMag: number): number {
  const lit = 1 - Math.min(1, Math.max(0, shadow));
  if (lit <= 0.001) return Infinity;
  return stdMag + 5 * Math.log10(Math.max(rangeKm, 200) / 1000) - 2.5 * Math.log10(lit);
}

// ---------------------------------------------------------------- live mode

const STEP_MS = 20_000;

interface Key {
  t: number;
  /** ECI km, xyz × n (NaN = no fix). */
  eci: Float64Array;
  /** Sun ECI (AU) at t. */
  sun: { x: number; y: number; z: number };
}

/**
 * Live-mode tracker: interpolated positions between keyframes, the next keyframe built
 * a slice per frame. Call `frame(ms)` every drawn frame with the sky time.
 */
export class LiveSatellites {
  private a: Key | null = null;
  private b: Key | null = null;
  private next: { key: Key; i: number } | null = null;
  private candidates: number[] = [];
  private readonly out: SatFrame;
  /** Time budget per frame for building keyframes (ms of wall time). */
  budgetMs = 2.5;

  readonly sats: SatRecord[];
  private obs: Observer;
  private minElevation: number;
  private trailSec: number;

  constructor(sats: SatRecord[], obs: Observer, minElevation: number, trailSec: number) {
    this.sats = sats;
    this.obs = obs;
    this.minElevation = minElevation;
    this.trailSec = trailSec;
    this.out = emptyFrame(Math.min(sats.length, 20000));
  }

  private newKey(t: number): Key {
    const s = sunPos(jdayOf(t) as never).rsun as unknown as { x: number; y: number; z: number };
    return { t, eci: new Float64Array(this.sats.length * 3).fill(NaN), sun: { x: s.x, y: s.y, z: s.z } };
  }

  private fill(k: Key, from: number, deadline: number): number {
    let i = from;
    for (; i < this.sats.length; i++) {
      const p = eciAt(this.sats[i]!.rec, k.t);
      if (p) { k.eci[i * 3] = p.x; k.eci[i * 3 + 1] = p.y; k.eci[i * 3 + 2] = p.z; }
      if ((i & 63) === 63 && performance.now() > deadline) return i + 1;
    }
    return i;
  }

  private full(t: number): Key {
    const k = this.newKey(t);
    this.fill(k, 0, Infinity);
    return k;
  }

  /** Recompute which objects may be above the horizon between a and b. */
  private pickCandidates() {
    const a = this.a!, b = this.b!;
    const ga = gstime(new Date(a.t)), gb = gstime(new Date(b.t));
    const lim = Math.sin(((this.minElevation - 6) * Math.PI) / 180);
    const tmp = [0, 0, 0];
    this.candidates = [];
    for (let i = 0; i < this.sats.length; i++) {
      const ax = a.eci[i * 3]!, bx = b.eci[i * 3]!;
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      eciToWorld(ax, a.eci[i * 3 + 1]!, a.eci[i * 3 + 2]!, ga, this.obs, tmp, 0);
      const ya = tmp[1]!;
      eciToWorld(bx, b.eci[i * 3 + 1]!, b.eci[i * 3 + 2]!, gb, this.obs, tmp, 0);
      if (Math.max(ya, tmp[1]!) > lim) this.candidates.push(i);
    }
  }

  /** Fixes at sky time `ms` (interpolated). Returns null while the first keyframes are not ready. */
  frame(ms: number): SatFrame {
    const out = this.out;
    // (re)start on the first frame or after a jump in time
    if (!this.a || !this.b || ms < this.a.t - STEP_MS || ms > this.b.t + STEP_MS) {
      const t0 = Math.floor(ms / STEP_MS) * STEP_MS;
      this.a = this.full(t0);
      this.b = this.full(t0 + STEP_MS);
      this.next = null;
      this.pickCandidates();
    }
    // advance keyframes
    while (ms > this.b.t) {
      const want = this.b.t + STEP_MS;
      let k: Key;
      if (this.next && this.next.key.t === want) {
        if (this.next.i < this.sats.length) this.fill(this.next.key, this.next.i, Infinity);
        k = this.next.key;
      } else k = this.full(want);
      this.a = this.b;
      this.b = k;
      this.next = null;
      this.pickCandidates();
    }
    // build the next keyframe in slices
    const want = this.b.t + STEP_MS;
    if (!this.next || this.next.key.t !== want) this.next = { key: this.newKey(want), i: 0 };
    if (this.next.i < this.sats.length) this.next.i = this.fill(this.next.key, this.next.i, performance.now() + this.budgetMs);

    const a = this.a, b = this.b;
    const span = b.t - a.t;
    const u = (ms - a.t) / span, u0 = (ms - this.trailSec * 1000 - a.t) / span;
    const g = gstime(new Date(ms)), g0 = gstime(new Date(ms - this.trailSec * 1000));
    const minY = Math.sin((this.minElevation * Math.PI) / 180);
    const tmp = [0, 0, 0];
    let n = 0;
    for (const i of this.candidates) {
      if (n >= out.index.length) break;
      const ax = a.eci[i * 3]!, ay = a.eci[i * 3 + 1]!, az = a.eci[i * 3 + 2]!;
      const bx = b.eci[i * 3]!, by = b.eci[i * 3 + 1]!, bz = b.eci[i * 3 + 2]!;
      const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, z = az + (bz - az) * u;
      const r = eciToWorld(x, y, z, g, this.obs, tmp, 0);
      if (tmp[1]! < minY) continue;
      eciToWorld(ax + (bx - ax) * u0, ay + (by - ay) * u0, az + (bz - az) * u0, g0, this.obs, out.tail, n * 3);
      out.dir[n * 3] = tmp[0]!; out.dir[n * 3 + 1] = tmp[1]!; out.dir[n * 3 + 2] = tmp[2]!;
      out.rangeKm[n] = r;
      const sun = u < 0.5 ? a.sun : b.sun;
      out.shadow[n] = shadowFraction(sun as never, { x, y, z } as never);
      out.index[n] = i;
      n++;
    }
    out.count = n;
    return out;
  }
}

