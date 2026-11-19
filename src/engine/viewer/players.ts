// Walk / fly / layer maths for the live viewer's player (docs/players.md). Pure: no three.js,
// no DOM, testable in Node. The three.js side (avatars.ts) and the input side (play.ts) call it.
//
//   layers       world.layers (CONTRACT.md 1c): flat floors at floorY, a walk disc, a spawn,
//                an optional room height (ceiling)
//   walkStep     third-person walking on a layer's floor: eased speed, inside the walk disc,
//                sliding along anything `blocked` reports (building walls)
//   flyStep      free flight: eased velocity, never below the floor of the layer you are in
//                (nor above its ceiling), sliding along anything `blocked` reports (the rock)
//   followPose   the third-person camera behind the avatar, pulled in when something is in the way
//   Interp       remote players: a short buffer of timed states, drawn ~120 ms in the past
import type { Layer } from "../../schema/index.ts";
import { angleDelta, type V3 } from "./flight.ts";

export type Mode = "orbit" | "walk" | "fly";
export const MODES: Mode[] = ["orbit", "walk", "fly"];

export const WALK = {
  speed: 3.0, // m/s
  run: 6.2, // m/s with Shift
  accel: 10, // 1/s: how fast speed reaches the wanted speed
  turn: 9, // 1/s: how fast the body turns to face where it walks
  radius: 0.32, // body radius against walls (m)
  eye: 1.45, // camera target above the floor (head height)
};
export const FLY = {
  speed: 9, // m/s
  boost: 3.2, // × with Shift
  accel: 4.5, // 1/s
  margin: 0.35, // never closer than this to a floor / ceiling (m)
  maxY: 400, // m
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** Frame-rate independent exponential approach factor. */
export const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * Math.max(0, dt));

/** The layers sorted top (highest floor) to bottom. */
export function sortLayers(layers: readonly Layer[]): Layer[] {
  return [...layers].sort((a, b) => b.floorY - a.floorY);
}

/** Horizontal distance from a layer's walk centre. */
export const discDist = (l: Layer, x: number, z: number) => Math.hypot(x - l.walk.center[0], z - l.walk.center[1]);

/**
 * The layer a point is in: the highest floor at or below the point (0.6 m tolerance) whose walk
 * disc (+ `slack` m) contains it and whose ceiling (if any) is above it. null = outside every layer.
 */
export function layerAt(layers: readonly Layer[], p: V3, slack = 2): Layer | null {
  let best: Layer | null = null;
  for (const l of layers) {
    if (p[1] < l.floorY - 0.6) continue;
    if (l.height !== undefined && p[1] > l.floorY + l.height + 0.6) continue;
    if (discDist(l, p[0], p[2]) > l.walk.radius + slack) continue;
    if (!best || l.floorY > best.floorY) best = l;
  }
  return best;
}

/** Keep (x, z) inside the walk disc, `inset` metres in from its edge. */
export function clampToDisc(l: Layer, x: number, z: number, inset = WALK.radius): [number, number] {
  const r = Math.max(0, l.walk.radius - inset);
  const dx = x - l.walk.center[0], dz = z - l.walk.center[1];
  const d = Math.hypot(dx, dz);
  if (d <= r || d < 1e-9) return [x, z];
  return [l.walk.center[0] + (dx / d) * r, l.walk.center[1] + (dz / d) * r];
}

/** A spot near the layer's spawn for player `seed` (0..1), so people arriving together don't stand inside each other. */
export function spawnPoint(l: Layer, seed: number): V3 {
  const a = seed * Math.PI * 2, r = 0.6 + 1.2 * ((seed * 7.31) % 1);
  const [x, z] = clampToDisc(l, l.spawn[0] + Math.cos(a) * r, l.spawn[2] + Math.sin(a) * r, 0.6);
  return [x, Math.max(l.floorY, l.spawn[1]), z];
}

/** Stable 0..1 hash of a string (FNV-1a). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Heading in degrees (0 = facing +Z, 90 = +X, as rotation[1]) of a ground direction. */
export const headingOf = (dx: number, dz: number) => ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
export const normDeg = (d: number) => ((d % 360) + 360) % 360;

export interface Body {
  position: V3;
  velocity: V3;
  heading: number; // degrees
}

export interface MoveInput {
  /** Wanted direction in the camera's frame: x = right, z = forward, y = up (fly); each -1..1. */
  x: number;
  y: number;
  z: number;
  fast: boolean;
}

/** Camera-relative input → world direction on the ground (yaw in radians, 0 = camera looks along -Z... see below). */
export function groundDir(input: MoveInput, yaw: number): [number, number] {
  // yaw = the camera's heading around +Y in radians, measured like headingOf (0 = looking toward +Z).
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // forward
  const rx = -Math.cos(yaw), rz = Math.sin(yaw); // right (forward × up)
  let x = fx * input.z + rx * input.x, z = fz * input.z + rz * input.x;
  const m = Math.hypot(x, z);
  if (m > 1) { x /= m; z /= m; }
  return [x, z];
}

/** "Is the straight move from a to b blocked?" — the engine's raycast against solid geometry. */
export type Blocked = (a: V3, b: V3) => boolean;

/** One walking step on `layer`'s floor. */
export function walkStep(b: Body, input: MoveInput, yaw: number, dt: number, layer: Layer, blocked?: Blocked): Body {
  const [dx, dz] = groundDir(input, yaw);
  const want = input.fast ? WALK.run : WALK.speed;
  const k = approach(WALK.accel, dt);
  const vx = lerp(b.velocity[0], dx * want, k), vz = lerp(b.velocity[2], dz * want, k);
  const p = b.position;
  let nx = p[0] + vx * dt, nz = p[2] + vz * dt;
  [nx, nz] = clampToDisc(layer, nx, nz);
  const y = layer.floorY;
  let pos: V3 = [nx, y, nz];
  if (blocked && (Math.abs(nx - p[0]) > 1e-6 || Math.abs(nz - p[2]) > 1e-6)) {
    const from: V3 = [p[0], y, p[2]];
    const reach = (to: V3): V3 => {
      // look a body radius further than the step, so the body (not its centre) stops at the wall
      const d = Math.hypot(to[0] - from[0], to[2] - from[2]) || 1;
      return [to[0] + ((to[0] - from[0]) / d) * WALK.radius, y, to[2] + ((to[2] - from[2]) / d) * WALK.radius];
    };
    if (blocked(from, reach(pos))) {
      const xOnly: V3 = [nx, y, p[2]], zOnly: V3 = [p[0], y, nz];
      if (Math.abs(nx - p[0]) > 1e-6 && !blocked(from, reach(xOnly))) pos = xOnly;
      else if (Math.abs(nz - p[2]) > 1e-6 && !blocked(from, reach(zOnly))) pos = zOnly;
      else pos = from;
    }
  }
  const moved = Math.hypot(pos[0] - p[0], pos[2] - p[2]);
  const speed = dt > 0 ? moved / dt : 0;
  let heading = b.heading;
  if (Math.hypot(dx, dz) > 0.05 && speed > 0.05) {
    const target = headingOf(dx, dz);
    heading = normDeg(heading + ((angleDelta((heading * Math.PI) / 180, (target * Math.PI) / 180) * 180) / Math.PI) * approach(WALK.turn, dt));
  }
  return { position: pos, velocity: [dt > 0 ? (pos[0] - p[0]) / dt : 0, 0, dt > 0 ? (pos[2] - p[2]) / dt : 0], heading };
}

/** Floor and ceiling a flyer at `p` must stay between (the layer it is in), or null outside every layer. */
export function flyBounds(layers: readonly Layer[], p: V3): { floor: number; ceiling: number } | null {
  const l = layerAt(layers, p, 2);
  if (!l) return null;
  return { floor: l.floorY + FLY.margin, ceiling: l.height !== undefined ? l.floorY + l.height - FLY.margin : FLY.maxY };
}

/** One flying step. `pitch` (radians, + = looking up) tilts forward input up or down. */
export function flyStep(b: Body, input: MoveInput, yaw: number, pitch: number, dt: number, layers: readonly Layer[], blocked?: Blocked): Body {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fx = Math.sin(yaw) * cp, fy = sp, fz = Math.cos(yaw) * cp;
  const rx = -Math.cos(yaw), rz = Math.sin(yaw);
  let wx = fx * input.z + rx * input.x, wy = fy * input.z + input.y, wz = fz * input.z + rz * input.x;
  const m = Math.hypot(wx, wy, wz);
  if (m > 1) { wx /= m; wy /= m; wz /= m; }
  const want = FLY.speed * (input.fast ? FLY.boost : 1);
  const k = approach(FLY.accel, dt);
  const v: V3 = [lerp(b.velocity[0], wx * want, k), lerp(b.velocity[1], wy * want, k), lerp(b.velocity[2], wz * want, k)];
  const p = b.position;
  let next: V3 = [p[0] + v[0] * dt, clamp(p[1] + v[1] * dt, -FLY.maxY, FLY.maxY), p[2] + v[2] * dt];
  // floors and ceilings of the layer we are in (glass floors count: they are floors)
  const lim = flyBounds(layers, p);
  if (lim) next[1] = clamp(next[1], Math.min(lim.floor, p[1]), Math.max(lim.ceiling, Math.min(p[1], FLY.maxY)));
  if (blocked && blocked(p, next)) {
    // slide: drop the axis that hits, keep the others
    const tries: V3[] = [[next[0], p[1], next[2]], [p[0], next[1], p[2]], [next[0], p[1], p[2]], [p[0], p[1], next[2]]];
    next = tries.find((t) => !blocked(p, t)) ?? p;
  }
  const vel: V3 = dt > 0 ? [(next[0] - p[0]) / dt, (next[1] - p[1]) / dt, (next[2] - p[2]) / dt] : [0, 0, 0];
  let heading = b.heading;
  if (Math.hypot(vel[0], vel[2]) > 0.3) heading = normDeg(heading + ((angleDelta((heading * Math.PI) / 180, Math.atan2(vel[0], vel[2])) * 180) / Math.PI) * approach(WALK.turn, dt));
  return { position: next, velocity: vel, heading };
}

/** Third-person camera: `dist` metres behind and above the avatar's head, looking at it. */
export function followPose(pos: V3, yaw: number, pitch: number, dist: number, eye = WALK.eye): { position: V3; target: V3 } {
  const target: V3 = [pos[0], pos[1] + eye, pos[2]];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // the camera sits opposite the look direction
  const position: V3 = [target[0] - Math.sin(yaw) * cp * dist, target[1] - sp * dist, target[2] - Math.cos(yaw) * cp * dist];
  return { position, target };
}

/** Keep a follow camera out of floors and ceilings of the layer the avatar is in. */
export function clampCamera(cam: V3, layer: Layer | null): V3 {
  if (!layer) return cam;
  const lo = layer.floorY + 0.25, hi = layer.height !== undefined ? layer.floorY + layer.height - 0.2 : Infinity;
  return [cam[0], clamp(cam[1], lo, Math.max(lo, hi)), cam[2]];
}

// ---------------------------------------------------------------- remote players

export interface Snap {
  t: number; // receive time, seconds
  position: V3;
  heading: number;
}

/** Remote movement: states arrive ~10 Hz; draw `delay` seconds in the past, interpolating between the two around it. */
export class Interp {
  private buf: Snap[] = [];
  readonly delay: number;
  readonly max: number;
  constructor(delay = 0.12, max = 12) {
    this.delay = delay;
    this.max = max;
  }
  push(s: Snap) {
    const last = this.buf[this.buf.length - 1];
    if (last && s.t <= last.t) s = { ...s, t: last.t + 1e-3 };
    this.buf.push(s);
    if (this.buf.length > this.max) this.buf.shift();
  }
  /** Jump (a teleport, a layer change far away): forget the history. */
  reset(s: Snap) { this.buf = [s]; }
  get last(): Snap | null { return this.buf[this.buf.length - 1] ?? null; }
  at(now: number): { position: V3; heading: number; speed: number } | null {
    const b = this.buf;
    if (!b.length) return null;
    const t = now - this.delay;
    if (b.length === 1 || t <= b[0]!.t) return { position: b[0]!.position, heading: b[0]!.heading, speed: 0 };
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1]!, c = b[i]!;
      if (t >= a.t) {
        if (t >= c.t) {
          // past the newest state: hold it (no extrapolation: a stopped player stays stopped)
          return { position: c.position, heading: c.heading, speed: 0 };
        }
        const u = (t - a.t) / (c.t - a.t);
        const d = Math.hypot(c.position[0] - a.position[0], c.position[1] - a.position[1], c.position[2] - a.position[2]);
        const h = normDeg(a.heading + ((angleDelta((a.heading * Math.PI) / 180, (c.heading * Math.PI) / 180) * 180) / Math.PI) * u);
        return {
          position: [lerp(a.position[0], c.position[0], u), lerp(a.position[1], c.position[1], u), lerp(a.position[2], c.position[2], u)],
          heading: h,
          speed: d / (c.t - a.t),
        };
      }
    }
    return { position: b[0]!.position, heading: b[0]!.heading, speed: 0 };
  }
}

// ---------------------------------------------------------------- name tags

/** Name tag opacity by distance: full up close, gone past `far` (far enough to find someone from a world's overview camera). */
export function tagOpacity(dist: number, near = 80, far = 180): number {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  return 1 - (dist - near) / (far - near);
}

/** Which tags to show: the nearest `cap` with any opacity. */
export function visibleTags(list: { id: string; dist: number }[], cap = 8): Set<string> {
  return new Set(list.filter((x) => tagOpacity(x.dist) > 0.02).sort((a, b) => a.dist - b.dist).slice(0, cap).map((x) => x.id));
}

// ---------------------------------------------------------------- layer travel

export interface Ride {
  /** the stages: walk to the lift, ride it, walk out */
  legs: { from: V3; to: V3; duration: number; car: boolean }[];
  total: number;
}

/**
 * Travel from `from` to layer `to`: with a lift (`car` at x,z, stops at each layer's floor), walk
 * into the car, ride it to the new floor, walk out to the spawn; without one, a single smooth flight.
 */
export function planRide(from: V3, to: Layer, seed: number, car: { x: number; z: number } | null, reduced = false): Ride {
  const dest = spawnPoint(to, seed);
  const k = reduced ? 0.35 : 1;
  if (!car) {
    const d = Math.hypot(dest[0] - from[0], dest[1] - from[1], dest[2] - from[2]);
    const duration = reduced ? 0.3 : clamp(1.2 + d / 14, 1.4, 4);
    return { legs: [{ from, to: dest, duration, car: false }], total: duration };
  }
  const inCar: V3 = [car.x, from[1], car.z], outCar: V3 = [car.x, to.floorY, car.z];
  const walkIn = clamp(Math.hypot(inCar[0] - from[0], inCar[2] - from[2]) / 3.5, 0.4, 2.5) * k;
  const ride = clamp(Math.abs(to.floorY - from[1]) / 5, 1.6, 6) * k;
  const walkOut = clamp(Math.hypot(dest[0] - outCar[0], dest[2] - outCar[2]) / 3.5, 0.4, 2.5) * k;
  return {
    legs: [
      { from, to: inCar, duration: walkIn, car: false },
      { from: inCar, to: outCar, duration: ride, car: true },
      { from: outCar, to: dest, duration: walkOut, car: false },
    ],
    total: walkIn + ride + walkOut,
  };
}

/** Where a ride is at `t` seconds: position, which leg, and the car's offset from its start (riding legs). */
export function rideAt(r: Ride, t: number, ease: (u: number) => number): { position: V3; leg: number; done: boolean; carDy: number | null } {
  let acc = 0;
  for (let i = 0; i < r.legs.length; i++) {
    const L = r.legs[i]!;
    if (t < acc + L.duration || i === r.legs.length - 1) {
      const u = L.duration > 0 ? clamp((t - acc) / L.duration, 0, 1) : 1;
      const e = L.car ? ease(u) : u < 1 ? 0.5 - Math.cos(Math.PI * u) / 2 : 1;
      const p: V3 = [lerp(L.from[0], L.to[0], e), lerp(L.from[1], L.to[1], e), lerp(L.from[2], L.to[2], e)];
      if (!L.car && r.legs.length === 1 && L.from[1] !== L.to[1]) {
        // the lift-less flight: an arc that clears the floors on the way
        p[1] += Math.sin(Math.PI * e) * Math.min(8, 2 + Math.abs(L.to[1] - L.from[1]) * 0.25);
      }
      return { position: p, leg: i, done: t >= r.total, carDy: L.car ? p[1] - L.from[1] : null };
    }
    acc += L.duration;
  }
  const last = r.legs[r.legs.length - 1]!;
  return { position: last.to, leg: r.legs.length - 1, done: true, carDy: null };
}
