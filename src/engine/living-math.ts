// Living world math: path sampling, street-graph routing, actor kinematics and flow
// pulses. Pure (no three.js, no DOM): runs in Node for tests and in the page.
//
// Everything is a function of time: the same t gives the same pose, so seek(t) is exact
// and a video can start at any frame.
import type { ActorMove, Graph, PathDef } from "../schema/living.ts";
import { edgeEnds } from "../schema/living.ts";

export type V3 = [number, number, number];

// ---------------------------------------------------------------- paths

/** A path resampled into a dense polyline with an arc-length table. */
export interface Sampled {
  /** x,y,z triples. */
  pts: Float64Array;
  /** Cumulative length at each point (cum[0] = 0). */
  cum: Float64Array;
  length: number;
  closed: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Centripetal Catmull-Rom point between p1 and p2 at u in [0,1]. */
function catmull(p0: V3, p1: V3, p2: V3, p3: V3, u: number): V3 {
  const a = 0.5; // centripetal
  const t01 = Math.pow(Math.max(dist(p0, p1), 1e-6), a);
  const t12 = Math.pow(Math.max(dist(p1, p2), 1e-6), a);
  const t23 = Math.pow(Math.max(dist(p2, p3), 1e-6), a);
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const m1 = (p2[k]! - p1[k]! + t12 * ((p1[k]! - p0[k]!) / t01 - (p2[k]! - p0[k]!) / (t01 + t12)));
    const m2 = (p2[k]! - p1[k]! + t12 * ((p3[k]! - p2[k]!) / t23 - (p3[k]! - p1[k]!) / (t12 + t23)));
    const a0 = 2 * p1[k]! - 2 * p2[k]! + m1 + m2;
    const b0 = -3 * p1[k]! + 3 * p2[k]! - 2 * m1 - m2;
    out[k] = a0 * u * u * u + b0 * u * u + m1 * u + p1[k]!;
  }
  return out;
}

/** Resample points into a dense polyline. `step` = target spacing in metres for curves. */
export function samplePoints(points: V3[], opts: { closed?: boolean; smooth?: boolean } = {}, step = 0.2): Sampled {
  const closed = !!opts.closed;
  const src = points.filter((p, i) => i === 0 || dist(p, points[i - 1]!) > 1e-9);
  if (closed && src.length > 2 && dist(src[0]!, src[src.length - 1]!) < 1e-9) src.pop();
  const out: V3[] = [];
  if (src.length < 2) {
    const p = src[0] ?? [0, 0, 0];
    out.push(p, p);
  } else if (!opts.smooth) {
    out.push(...src);
    if (closed) out.push(src[0]!);
  } else {
    const n = src.length;
    const at = (i: number): V3 => {
      if (closed) return src[((i % n) + n) % n]!;
      if (i < 0) return sub(src[0]!, sub(src[1]!, src[0]!));
      if (i >= n) return sub(src[n - 1]!, sub(src[n - 2]!, src[n - 1]!));
      return src[i]!;
    };
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const k = Math.max(4, Math.ceil(dist(p1, p2) / step));
      for (let j = 0; j < k; j++) out.push(catmull(p0, p1, p2, p3, j / k));
    }
    out.push(closed ? src[0]! : src[n - 1]!);
  }
  const pts = new Float64Array(out.length * 3);
  const cum = new Float64Array(out.length);
  out.forEach((p, i) => {
    pts.set(p, i * 3);
    if (i > 0) cum[i] = cum[i - 1]! + dist(p, out[i - 1]!);
  });
  return { pts, cum, length: cum[cum.length - 1]!, closed };
}

export function samplePath(p: PathDef, step = 0.2): Sampled {
  return samplePoints(p.points as V3[], { closed: p.closed, smooth: p.smooth }, step);
}

/** Wrap (closed) or clamp (open) an arc length into [0, length]. */
export function wrapS(path: Sampled, s: number): number {
  if (path.length <= 0) return 0;
  if (path.closed) return ((s % path.length) + path.length) % path.length;
  return s < 0 ? 0 : s > path.length ? path.length : s;
}

/** Position at arc length s (written into out). Returns the segment index. */
export function pointAt(path: Sampled, s: number, out: V3 = [0, 0, 0]): V3 {
  const { pts, cum } = path;
  s = wrapS(path, s);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi]! - cum[lo]!;
  const u = seg > 1e-12 ? (s - cum[lo]!) / seg : 0;
  for (let k = 0; k < 3; k++) out[k] = pts[lo * 3 + k]! + (pts[hi * 3 + k]! - pts[lo * 3 + k]!) * u;
  return out;
}

/** Unit tangent at s, smoothed over ±h metres (central difference). */
export function tangentAt(path: Sampled, s: number, out: V3 = [0, 0, 1], h = 0.15): V3 {
  let a = s - h, b = s + h;
  if (!path.closed) {
    if (a < 0) { a = 0; b = Math.min(path.length, 2 * h); }
    if (b > path.length) { b = path.length; a = Math.max(0, path.length - 2 * h); }
  }
  const p = pointAt(path, a, [0, 0, 0]), q = pointAt(path, b, [0, 0, 0]);
  const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  if (d < 1e-9) return out;
  out[0] = (q[0] - p[0]) / d; out[1] = (q[1] - p[1]) / d; out[2] = (q[2] - p[2]) / d;
  return out;
}

/** Arc length of the point on the path closest to p (coarse: nearest sample). */
export function nearestS(path: Sampled, p: V3): number {
  let best = Infinity, s = 0;
  for (let i = 0; i < path.cum.length; i++) {
    const d = (path.pts[i * 3]! - p[0]) ** 2 + (path.pts[i * 3 + 1]! - p[1]) ** 2 + (path.pts[i * 3 + 2]! - p[2]) ** 2;
    if (d < best) { best = d; s = path.cum[i]!; }
  }
  return s;
}

/** Replace each interior corner of a polyline with a quadratic curve of radius ≤ r. */
export function roundCorners(points: V3[], r = 0.9, steps = 6): V3[] {
  if (points.length < 3) return points.slice();
  const out: V3[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const lab = dist(a, b), lbc = dist(b, c);
    const rr = Math.min(r, lab * 0.5, lbc * 0.5);
    if (rr < 1e-3) { out.push(b); continue; }
    const p0: V3 = [b[0] + ((a[0] - b[0]) * rr) / lab, b[1] + ((a[1] - b[1]) * rr) / lab, b[2] + ((a[2] - b[2]) * rr) / lab];
    const p2: V3 = [b[0] + ((c[0] - b[0]) * rr) / lbc, b[1] + ((c[1] - b[1]) * rr) / lbc, b[2] + ((c[2] - b[2]) * rr) / lbc];
    for (let j = 0; j <= steps; j++) {
      const u = j / steps, v = 1 - u;
      out.push([v * v * p0[0] + 2 * v * u * b[0] + u * u * p2[0], v * v * p0[1] + 2 * v * u * b[1] + u * u * p2[1], v * v * p0[2] + 2 * v * u * b[2] + u * u * p2[2]]);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

// ---------------------------------------------------------------- graph routing

export function nearestNode(graph: Graph, p: V3): string | undefined {
  let best = Infinity, id: string | undefined;
  for (const n of graph.nodes) {
    const d = dist(n.position as V3, p);
    if (d < best) { best = d; id = n.id; }
  }
  return id;
}

/**
 * Shortest route between two graph nodes (Dijkstra, edge weight = length). Returns the
 * route as points (edges with a `path` contribute that path's points, in the walking
 * direction), or null when the nodes are not connected.
 */
export function route(graph: Graph, paths: PathDef[], from: string, to: string): V3[] | null {
  const pos = new Map(graph.nodes.map((n) => [n.id, n.position as V3]));
  if (!pos.has(from) || !pos.has(to)) return null;
  if (from === to) return [pos.get(from)!, pos.get(from)!];
  const pathById = new Map(paths.map((p) => [p.id, p]));
  type Hop = { to: string; w: number; pts: V3[] };
  const adj = new Map<string, Hop[]>();
  const add = (a: string, b: string, pts: V3[]) => {
    let w = 0;
    for (let i = 1; i < pts.length; i++) w += dist(pts[i]!, pts[i - 1]!);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, w, pts });
  };
  for (const e of graph.edges) {
    const [a, b] = edgeEnds(e);
    const pa = pos.get(a), pb = pos.get(b);
    if (!pa || !pb) continue;
    const named = !Array.isArray(e) && e.path ? pathById.get(e.path) : undefined;
    let pts: V3[] = named ? (named.points as V3[]).slice() : [pa, pb];
    if (named && dist(pts[0]!, pa) > dist(pts[pts.length - 1]!, pa)) pts.reverse();
    add(a, b, pts);
    add(b, a, pts.slice().reverse());
  }
  const d = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; hop: Hop }>();
  const done = new Set<string>();
  for (;;) {
    let u: string | undefined, best = Infinity;
    for (const [k, v] of d) if (!done.has(k) && v < best) { best = v; u = k; }
    if (u === undefined) return null;
    if (u === to) break;
    done.add(u);
    for (const h of adj.get(u) ?? []) {
      const nd = best + h.w;
      if (nd < (d.get(h.to) ?? Infinity)) { d.set(h.to, nd); prev.set(h.to, { node: u, hop: h }); }
    }
  }
  const hops: Hop[] = [];
  for (let n = to; n !== from; ) {
    const p = prev.get(n)!;
    hops.unshift(p.hop);
    n = p.node;
  }
  const out: V3[] = [];
  for (const h of hops) for (const p of h.pts) if (!out.length || dist(out[out.length - 1]!, p) > 1e-9) out.push(p);
  return out;
}

// ---------------------------------------------------------------- actor kinematics

export const DEFAULT_SPEED = 1.2;
/** Seconds to reach full speed from a stop (and to stop). */
export const ACCEL_TIME = 0.6;
/** Minimum stop at each end of a back-and-forth walk: time to turn around. */
export const MIN_TURN = 0.7;

/** Distance and speed after τ seconds of a stop-to-stop walk of length L (trapezoid profile). */
export function travel(L: number, v: number, tau: number): { s: number; v: number; T: number } {
  const a = v / ACCEL_TIME;
  let ta = ACCEL_TIME, vm = v;
  if (L < v * ACCEL_TIME) { ta = Math.sqrt(L / a); vm = a * ta; }
  const cruise = Math.max(0, (L - vm * ta) / vm);
  const T = 2 * ta + cruise;
  if (tau <= 0) return { s: 0, v: 0, T };
  if (tau >= T) return { s: L, v: 0, T };
  if (tau < ta) return { s: 0.5 * a * tau * tau, v: a * tau, T };
  if (tau < ta + cruise) return { s: 0.5 * a * ta * ta + vm * (tau - ta), v: vm, T };
  const r = T - tau;
  return { s: L - 0.5 * a * r * r, v: a * r, T };
}

export type Phase = "idle" | "walking" | "working";

export interface ActorPose {
  pos: V3;
  /** Heading in radians around +Y; 0 faces +Z. */
  yaw: number;
  phase: Phase;
  /** Seconds since the current phase began (for blend-ins). */
  since: number;
  /** Current speed / max speed, 0..1. */
  speed: number;
  /** Distance walked so far (drives the step cycle, so feet match the ground). */
  stride: number;
}

const yawOf = (t: V3) => Math.atan2(t[0], t[2]);
const angLerp = (a: number, b: number, u: number) => {
  let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + d * u;
};
const smooth01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/**
 * Pose of an actor walking `route` at local time τ (script seconds; the walk starts at
 * move.startT). `rest` is what it does when stopped. Deterministic.
 */
export function actorPose(routeP: Sampled, move: Pick<ActorMove, "speed" | "startT" | "offset" | "loop" | "dwell">, rest: Phase, t: number, lane = 0): ActorPose {
  const v = move.speed ?? DEFAULT_SPEED;
  const tau = t - (move.startT ?? 0);
  const L = routeP.length;
  const stopPhase: Phase = rest === "walking" ? "idle" : rest;
  const tan: V3 = [0, 0, 1];
  const at = (s: number, dir: number, phase: Phase, since: number, speed: number, stride: number, yawOverride?: number): ActorPose => {
    const pos = pointAt(routeP, s, [0, 0, 0]);
    tangentAt(routeP, s, tan, 0.3);
    const y = yawOverride ?? yawOf(dir >= 0 ? tan : [-tan[0], -tan[1], -tan[2]]);
    if (lane) {
      // Keep to a lane: `lane` metres to the right of the walking direction (so walkers going
      // opposite ways pass each other), easing to the centre line at the ends of open routes.
      const k = lane * laneRamp(routeP, s) * (dir >= 0 ? 1 : -1);
      const h = Math.hypot(tan[0], tan[2]);
      if (h > 1e-6) { pos[0] += (-tan[2] / h) * k; pos[2] += (tan[0] / h) * k; }
    }
    return { pos, yaw: y, phase, since, speed, stride };
  };
  const offset = move.offset ?? 0;

  // Closed loop: keep walking around forever.
  if (routeP.closed && move.loop !== false) {
    if (tau <= 0) return at(offset, 1, stopPhase, tau + 1e6, 0, 0);
    const a = v / ACCEL_TIME;
    const d = tau < ACCEL_TIME ? 0.5 * a * tau * tau : 0.5 * v * ACCEL_TIME + v * (tau - ACCEL_TIME);
    const sp = tau < ACCEL_TIME ? (a * tau) / v : 1;
    return at(offset + d, 1, "walking", tau, sp, d);
  }

  if (L < 1e-6) return at(0, 1, stopPhase, Math.max(0, tau), 0, 0);
  const T = travel(L, v, 0).T;

  // Back and forth with a stop (working / idle) at each end.
  if (move.loop) {
    const dwell = Math.max(MIN_TURN, move.dwell ?? 0);
    const leg = T + dwell;
    // offset (metres) shifts the cycle like a time offset at full speed.
    const tt = tau + Math.min(offset, L) / v;
    if (tt <= 0) return at(Math.min(offset, L), 1, stopPhase, tt + 1e6, 0, 0);
    const n = Math.floor(tt / leg);
    const local = tt - n * leg;
    const fwd = n % 2 === 0;
    const strideBefore = n * L;
    if (local < T) {
      const r = travel(L, v, local);
      return at(fwd ? r.s : L - r.s, fwd ? 1 : -1, "walking", local, r.v / v, strideBefore + r.s);
    }
    // Stopped at the far end of this leg: turn around during the last part of the stop.
    const end = fwd ? L : 0;
    const arrive = at(end, fwd ? 1 : -1, stopPhase, local - T, 0, strideBefore + L);
    const depart = at(end, fwd ? -1 : 1, stopPhase, local - T, 0, strideBefore + L);
    const turnLen = Math.min(MIN_TURN, dwell);
    const u = smooth01((local - (leg - turnLen)) / turnLen);
    return { ...arrive, yaw: angLerp(arrive.yaw, depart.yaw, u) };
  }

  // One-shot: walk to the end and stay.
  const s0 = Math.min(Math.max(offset, 0), L);
  const rem = L - s0;
  if (tau <= 0) return at(s0, 1, stopPhase, tau + 1e6, 0, 0);
  const r = travel(rem, v, tau);
  if (tau < r.T) return at(s0 + r.s, 1, "walking", tau, r.v / v, r.s);
  return at(L, 1, stopPhase, tau - r.T, 0, rem);
}

// ---------------------------------------------------------------- crowds

/** Metres over which a lane offset eases in/out at the ends of an open route. */
export const LANE_RAMP = 1.2;

/** 0 at the ends of an open route, 1 after LANE_RAMP metres (always 1 on a closed loop). */
export function laneRamp(routeP: Sampled, s: number): number {
  if (routeP.closed) return 1;
  return smooth01(Math.min(s, routeP.length - s) / LANE_RAMP);
}

/** Default lane of an actor (metres right of the centre line), from its seed: 0.25..0.45. */
export function autoLane(seed: number): number {
  return 0.25 + 0.2 * hash01(seed, 5);
}

/**
 * Soft separation, stateless: push walkers apart where they overlap (closer than `radius`),
 * computed from this frame's poses only, so the result is still a function of t. `movable[i]`
 * false = a standing actor (does not move, others step around it). Positions are edited in
 * place; order of `pos` must be stable (world order) for determinism.
 */
export function separate(pos: V3[], radius: number[], movable: boolean[], iterations = 2): void {
  const n = pos.length;
  if (n < 2) return;
  const cell = Math.max(0.5, Math.max(...radius) * 2);
  for (let it = 0; it < iterations; it++) {
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(pos[i]![0] / cell)},${Math.floor(pos[i]![2] / cell)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
    }
    const push: V3[] = pos.map(() => [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(pos[i]![0] / cell), cz = Math.floor(pos[i]![2] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        for (const j of grid.get(`${gx},${gz}`) ?? []) {
          if (j <= i) continue;
          if (!movable[i] && !movable[j]) continue;
          if (Math.abs(pos[i]![1] - pos[j]![1]) > 1) continue; // different floors
          let dx = pos[j]![0] - pos[i]![0], dz = pos[j]![2] - pos[i]![2];
          const r = (radius[i]! + radius[j]!) / 2;
          let d = Math.hypot(dx, dz);
          if (d >= r) continue;
          if (d < 1e-6) { const a = hash01(i * 7919 + j, 9) * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); d = 0; }
          else { dx /= d; dz /= d; }
          const over = r - d;
          const wi = movable[i] ? (movable[j] ? 0.5 : 1) : 0, wj = movable[j] ? (movable[i] ? 0.5 : 1) : 0;
          push[i]![0] -= dx * over * wi; push[i]![2] -= dz * over * wi;
          push[j]![0] += dx * over * wj; push[j]![2] += dz * over * wj;
        }
      }
    }
    for (let i = 0; i < n; i++) { pos[i]![0] += push[i]![0]; pos[i]![2] += push[i]![2]; }
  }
}

// ---------------------------------------------------------------- flows

/** Integer hash → [0,1). Deterministic per pulse index. */
export function hash01(i: number, salt = 0): number {
  let h = (Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface Pulse {
  /** Pulse index (stable across frames: pulse i is the i-th emitted). */
  i: number;
  /** Arc length along the path. */
  s: number;
}

/** Effective rate: on a closed path, rounded so pulses tile the loop with no seam. */
export function flowRate(length: number, rate: number, speed: number, closed: boolean): number {
  if (!closed || length <= 0) return rate;
  const travelT = length / speed;
  return Math.max(1, Math.round(rate * travelT)) / travelT;
}

/**
 * Pulses on the path at time t. Pulse i is emitted at i/rate from s = 0 and moves at
 * `speed`; the flow is already in steady state at t = 0 (pulses emitted before 0 are on
 * the path). Same t → same pulses, so seeking is exact.
 */
export function flowPulses(length: number, rate: number, speed: number, t: number, closed = false, out: Pulse[] = []): Pulse[] {
  out.length = 0;
  if (length <= 0) return out;
  const r = flowRate(length, rate, speed, closed);
  const travelT = length / speed;
  const first = Math.ceil((t - travelT) * r - 1e-9);
  const last = Math.floor(t * r + 1e-9);
  for (let i = first; i <= last; i++) {
    const s = (t - i / r) * speed;
    if (s < 0 || s > length || (closed && s >= length - 1e-9)) continue;
    out.push({ i, s });
  }
  return out;
}

/** Most pulses a flow can show at once (instance capacity). */
export function maxPulses(length: number, rate: number, speed: number, closed = false): number {
  return Math.ceil((length / speed) * flowRate(length, rate, speed, closed)) + 2;
}
