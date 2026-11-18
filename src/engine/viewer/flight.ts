// Camera flights for the live viewer: eased moves between two poses (presets, fly-to).
//
// A flight swings around its (moving) target in spherical coordinates instead of sliding
// in a straight line: distance changes geometrically (zooming feels even), the azimuth takes
// the short way round, and the camera never cuts through the middle of the island on the
// way from one side to the other. Pure maths, no three.js: testable in Node.
import { EASES } from "../ease.ts";

export type V3 = [number, number, number];
export interface Pose { position: V3; target: V3; fov: number }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

interface Sph { r: number; theta: number; phi: number }
/** theta = azimuth around +Y (0 on +Z), phi = angle from +Y. */
function toSph(v: V3): Sph {
  const r = Math.max(1e-6, len(v));
  return { r, theta: Math.atan2(v[0], v[2]), phi: Math.acos(Math.min(1, Math.max(-1, v[1] / r))) };
}
function fromSph(s: Sph): V3 {
  const sp = Math.sin(s.phi);
  return [s.r * sp * Math.sin(s.theta), s.r * Math.cos(s.phi), s.r * sp * Math.cos(s.theta)];
}

/** Shortest signed angle from a to b, radians in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Seconds a flight takes: longer for longer trips and bigger turns, 0.8–2.2 s.
 * With prefers-reduced-motion: a short 0.3 s cross-move.
 */
export function flightDuration(a: Pose, b: Pose, reduced = false): number {
  if (reduced) return 0.3;
  const sa = toSph(sub(a.position, a.target)), sb = toSph(sub(b.position, b.target));
  const travel = len(sub(a.target, b.target)) / Math.max(sa.r, sb.r, 1);
  const zoom = Math.abs(Math.log(sb.r / sa.r));
  const turn = Math.abs(angleDelta(sa.theta, sb.theta)) / Math.PI + Math.abs(sb.phi - sa.phi) / Math.PI;
  return Math.min(2.2, Math.max(0.8, 0.8 + 0.55 * travel + 0.35 * zoom + 0.6 * turn));
}

/** The pose at progress u ∈ [0, 1] (already eased) of a flight from a to b. */
export function flightPose(a: Pose, b: Pose, u: number): Pose {
  const sa = toSph(sub(a.position, a.target)), sb = toSph(sub(b.position, b.target));
  const target: V3 = [lerp(a.target[0], b.target[0], u), lerp(a.target[1], b.target[1], u), lerp(a.target[2], b.target[2], u)];
  const s: Sph = {
    r: sa.r * Math.pow(sb.r / sa.r, u),
    theta: sa.theta + angleDelta(sa.theta, sb.theta) * u,
    phi: lerp(sa.phi, sb.phi, u),
  };
  const off = fromSph(s);
  return { position: [target[0] + off[0], target[1] + off[1], target[2] + off[2]], target, fov: lerp(a.fov, b.fov, u) };
}

/** A running flight: call at(now) every frame until done. */
export class Flight {
  readonly duration: number;
  readonly from: Pose;
  /** Mutable: a flight to a walking robot shifts its end with the robot. */
  to: Pose;
  readonly t0: number;
  constructor(from: Pose, to: Pose, t0: number, reduced = false) {
    this.from = from;
    this.to = to;
    this.t0 = t0;
    this.duration = flightDuration(from, to, reduced);
  }
  at(now: number): { pose: Pose; done: boolean } {
    const raw = this.duration > 0 ? (now - this.t0) / this.duration : 1;
    const u = raw >= 1 ? 1 : raw <= 0 ? 0 : EASES.inOutCubic(raw);
    return { pose: raw >= 1 ? this.to : flightPose(this.from, this.to, u), done: raw >= 1 };
  }
}

export interface BoxLike { min: V3; max: V3 }

/**
 * A pose that frames `box`: looking at its centre from `dir` (a vector from target toward
 * the camera; normalised here), far enough that the box's bounding sphere fits the view
 * with some air. `minDist` keeps tiny things (a robot) from filling the screen.
 */
export function framePose(box: BoxLike, dir: V3, fov: number, aspect: number, minDist = 3): Pose {
  const c: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = len(sub(box.max, box.min)) / 2;
  const vHalf = (fov * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.3, aspect));
  const dist = Math.max(minDist, (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.15);
  const d = len(dir) > 1e-6 ? dir : ([0, 0.5, 1] as V3);
  const k = dist / len(d);
  return { position: [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k], target: c, fov };
}

/** Direction from `center` outward to `p` in the ground plane, tilted up `elevDeg`. */
export function outwardDir(center: V3, p: V3, elevDeg = 32): V3 {
  let x = p[0] - center[0], z = p[2] - center[2];
  const h = Math.hypot(x, z);
  if (h < 1e-3) { x = 0; z = 1; } else { x /= h; z /= h; }
  const e = (elevDeg * Math.PI) / 180;
  return [x * Math.cos(e), Math.sin(e), z * Math.cos(e)];
}

/**
 * Authored cameras are framed for landscape (16:9). On a narrower screen (a phone held
 * upright) pull the camera back along its view line so about as much of the width stays in
 * frame, at most 1.5× the distance (further out, distance fog washes a world out). Wider screens keep the pose.
 */
export function fitAspect(p: Pose, aspect: number, designAspect = 16 / 9): Pose {
  if (!(aspect > 0) || aspect >= designAspect) return p;
  const v = (p.fov * Math.PI) / 360;
  const want = Math.atan(Math.tan(v) * designAspect), have = Math.atan(Math.tan(v) * aspect);
  const k = Math.min(1.5, Math.tan(want) / Math.tan(have));
  const off = sub(p.position, p.target);
  return { ...p, position: [p.target[0] + off[0] * k, p.target[1] + off[1] * k, p.target[2] + off[2] * k] };
}
