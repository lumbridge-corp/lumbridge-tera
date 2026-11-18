// Camera pose at script time t — CONTRACT.md section 3. Pure TypeScript (no three.js), so
// it runs the same in the engine page and in Node (validation, previews, tests).
//
// Rules
// - Frame n is time n / fps (see frameTime / frameCount).
// - Inside a shot the shot decides the pose. Before the first shot the camera holds the
//   first shot's opening pose; in a gap or after the last shot it holds the pose the
//   previous shot ended on.
// - "keys" shots: the shot `ease` warps time across the whole key range (first key ..
//   last key), so a multi-key move eases in once and out once instead of stopping at
//   every key. Between keys, position and target follow a centripetal Catmull-Rom spline
//   (`path: "catmull"`, the default) or straight lines (`path: "linear"`); fov follows the
//   same curve kind on its own values, clamped to [5, 120]. Inside the shot but before the
//   first key / after the last key the camera holds that key. A key without fov inherits
//   the nearest earlier key's fov (else the next one's, else 45).
// - "orbit" shots: angle goes fromDeg → toDeg with the shot ease; position is
//   center + (r·cos θ, height, r·sin θ) (θ measured from +X towards +Z), target = center.
import type { CameraPose, CameraScript, Shot } from "../schema/index.ts";
import { ease } from "./ease.ts";

type V3 = [number, number, number];
type KeysShot = Extract<Shot, { kind: "keys" }>;
type OrbitShot = Extract<Shot, { kind: "orbit" }>;

export const DEFAULT_FOV = 45;
const clampFov = (f: number) => Math.min(120, Math.max(5, f));

/** Seconds for frame n. */
export const frameTime = (n: number, fps: number) => n / fps;
/** Frames in a script: round(duration * fps), at least 1. */
export const frameCount = (script: Pick<CameraScript, "duration" | "fps">) => Math.max(1, Math.round(script.duration * script.fps));

// --- centripetal Catmull-Rom (alpha = 0.5), same formulation as three.js CatmullRomCurve3 ---

function cubic(x0: number, x1: number, t0: number, t1: number, s: number): number {
  const c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
  const c3 = 2 * x0 - 2 * x1 + t0 + t1;
  return x0 + t0 * s + c2 * s * s + c3 * s * s * s;
}

function nonuniform(x0: number, x1: number, x2: number, x3: number, dt0: number, dt1: number, dt2: number, s: number): number {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1;
  t2 *= dt1;
  return cubic(x1, x2, t1, t2, s);
}

const dist2 = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + (v - b[i]!) ** 2, 0);

/** Point on the centripetal Catmull-Rom segment p1→p2 at s ∈ [0, 1] (works for any dimension). */
export function catmull(p0: number[], p1: number[], p2: number[], p3: number[], s: number): number[] {
  let dt0 = dist2(p0, p1) ** 0.25, dt1 = dist2(p1, p2) ** 0.25, dt2 = dist2(p2, p3) ** 0.25;
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  return p1.map((_, i) => nonuniform(p0[i]!, p1[i]!, p2[i]!, p3[i]!, dt0, dt1, dt2, s));
}

/** Point on a polyline through pts with Catmull-Rom between pts[i] and pts[i+1]; ends are reflected. */
function splineAt(pts: number[][], i: number, s: number): number[] {
  const p1 = pts[i]!, p2 = pts[i + 1]!;
  const p0 = pts[i - 1] ?? p1.map((v, k) => 2 * v - p2[k]!);
  const p3 = pts[i + 2] ?? p2.map((v, k) => 2 * v - p1[k]!);
  return catmull(p0, p1, p2, p3, s);
}

const lerpN = (a: number[], b: number[], s: number) => a.map((v, i) => v + (b[i]! - v) * s);

// --- shots ---

function resolvedFovs(keys: KeysShot["keys"]): number[] {
  const out: number[] = [];
  let last: number | undefined;
  for (const k of keys) {
    if (k.fov !== undefined) last = k.fov;
    out.push(last ?? NaN);
  }
  const firstDefined = keys.find((k) => k.fov !== undefined)?.fov ?? DEFAULT_FOV;
  return out.map((f) => (Number.isNaN(f) ? firstDefined : f));
}

function prepared(shot: KeysShot) {
  const keys = [...shot.keys].sort((a, b) => a.t - b.t);
  return { keys, fovs: resolvedFovs(keys) };
}

function keysPose(shot: KeysShot, t: number): CameraPose {
  const { keys, fovs } = prepared(shot);
  const first = keys[0]!, last = keys[keys.length - 1]!;
  const pose = (i: number): CameraPose => ({ position: [...keys[i]!.position] as V3, target: [...keys[i]!.target] as V3, fov: fovs[i]! });
  if (keys.length === 1 || t <= first.t) return pose(0);
  if (t >= last.t) return pose(keys.length - 1);

  // Ease warps time across the key range, then we find the segment at the warped time.
  const span = last.t - first.t;
  const T = first.t + ease(shot.ease, (t - first.t) / span) * span;
  let i = 0;
  while (i < keys.length - 2 && T >= keys[i + 1]!.t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const s = b.t > a.t ? Math.min(1, Math.max(0, (T - a.t) / (b.t - a.t))) : 1;

  const linear = shot.path === "linear";
  const curve = (pts: number[][]) => (linear ? lerpN(pts[i]!, pts[i + 1]!, s) : splineAt(pts, i, s));
  const position = curve(keys.map((k) => k.position)) as V3;
  const target = curve(keys.map((k) => k.target)) as V3;
  const fov = clampFov(curve(fovs.map((f) => [f]))[0]!);
  return { position, target, fov };
}

function orbitPose(shot: OrbitShot, t: number): CameraPose {
  const u = ease(shot.ease, (t - shot.start) / (shot.end - shot.start));
  const r = ((shot.fromDeg + (shot.toDeg - shot.fromDeg) * u) * Math.PI) / 180;
  const [cx, cy, cz] = shot.center;
  return {
    position: [cx + shot.radius * Math.cos(r), cy + shot.height, cz + shot.radius * Math.sin(r)],
    target: [cx, cy, cz],
    fov: shot.fov ?? DEFAULT_FOV,
  };
}

/** Pose of one shot at t (t is clamped to the shot). */
export function shotPose(shot: Shot, t: number): CameraPose {
  const tc = Math.min(shot.end, Math.max(shot.start, t));
  return shot.kind === "orbit" ? orbitPose(shot, tc) : keysPose(shot, tc);
}

export function evaluateCamera(script: CameraScript, t: number): CameraPose {
  const shots = [...script.shots].sort((a, b) => a.start - b.start);
  let prev: Shot | undefined;
  for (const s of shots) {
    if (t < s.start) return prev ? shotPose(prev, prev.end) : shotPose(s, s.start);
    if (t <= s.end) return shotPose(s, t);
    prev = s;
  }
  return shotPose(prev!, prev!.end);
}
