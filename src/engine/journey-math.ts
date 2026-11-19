// Journeys: an actor walks from its start through a list of stops (dwelling at each) to an
// end node — `move.stops` (CONTRACT.md section 1a). Pure (no three.js): the whole journey is
// one polyline (the legs end to end) with a stop mark at the end of every leg but the last,
// and the pose is a function of time, so render mode stays frame-exact.
//
// Queues: actors that stand at the same stop at the same time are spread around the stop
// node (first to arrive on the node, the next ones on a ring around it, facing it), assigned
// greedily by arrival time over everybody's itineraries — again a pure function of t.
import { DEFAULT_SPEED, laneRamp, pointAt, tangentAt, travel, type ActorPose, type Phase, type Sampled, type V3 } from "./living-math.ts";
import type { JourneyStop } from "../schema/living.ts";

/** A journey's timing, relative to its start (move.startT). */
export interface JourneyPlan {
  /** Arc length (metres along the whole route) where each leg ends; marks[i] = stop i for i < stops.length. */
  marks: number[];
  /** Leg lengths (stops.length + 1 legs). */
  legs: number[];
  /** Walking time of each leg. */
  legT: number[];
  /** Arrival / departure at each stop (seconds after the start). */
  arrive: number[];
  depart: number[];
  /** When the actor reaches the end of its last leg. */
  total: number;
  dwell: number[];
  state: Phase[];
  speed: number;
}

/** Timing of a journey whose legs are `legLengths` long (one more leg than stops). */
export function journeyPlan(legLengths: number[], stops: (Pick<JourneyStop, "dwell" | "state"> & { to?: string })[], speed = DEFAULT_SPEED): JourneyPlan {
  const legs = legLengths.map((l) => Math.max(0, l));
  const marks: number[] = [];
  const legT: number[] = [];
  const arrive: number[] = [];
  const depart: number[] = [];
  let s = 0, t = 0;
  for (let i = 0; i < legs.length; i++) {
    s += legs[i]!;
    marks.push(s);
    const T = legs[i]! > 1e-6 ? travel(legs[i]!, speed, 0).T : 0;
    legT.push(T);
    t += T;
    if (i < stops.length) {
      arrive.push(t);
      t += Math.max(0, stops[i]!.dwell);
      depart.push(t);
    }
  }
  return {
    marks, legs, legT, arrive, depart, total: t, speed,
    dwell: stops.map((x) => Math.max(0, x.dwell)),
    state: stops.map((x) => x.state ?? "working"),
  };
}

/** Where on the journey the actor is τ seconds after its start. */
export interface JourneyAt {
  /** Arc length along the whole route. */
  s: number;
  /** Index of the stop it stands at, -1 while walking (or before / after). */
  stop: number;
  /** Leg being walked (or just finished). */
  leg: number;
  /** Seconds since the current phase began. */
  since: number;
  /** Walking speed / max, 0..1. */
  speed: number;
  phase: "before" | "walking" | "dwelling" | "done";
}

export function journeyAt(p: JourneyPlan, tau: number): JourneyAt {
  if (tau <= 0) return { s: 0, stop: -1, leg: 0, since: tau + 1e6, speed: 0, phase: "before" };
  let t = 0;
  for (let i = 0; i < p.legs.length; i++) {
    const s0 = i ? p.marks[i - 1]! : 0;
    const T = p.legT[i]!;
    if (tau < t + T) {
      const r = travel(p.legs[i]!, p.speed, tau - t);
      return { s: s0 + r.s, stop: -1, leg: i, since: tau - t, speed: r.v / p.speed, phase: "walking" };
    }
    t += T;
    if (i < p.dwell.length) {
      if (tau < t + p.dwell[i]!) return { s: p.marks[i]!, stop: i, leg: i, since: tau - t, speed: 0, phase: "dwelling" };
      t += p.dwell[i]!;
    }
  }
  return { s: p.marks[p.marks.length - 1] ?? 0, stop: -1, leg: p.legs.length - 1, since: tau - t, speed: 0, phase: "done" };
}

/** Lane easing for a journey: to the centre line near every stop and both ends (like laneRamp). */
export function journeyLaneRamp(route: Sampled, marks: number[], s: number, ramp = 1.2): number {
  let d = Math.min(s, route.length - s);
  for (const m of marks) d = Math.min(d, Math.abs(s - m));
  const u = d / ramp;
  return u <= 0 ? 0 : u >= 1 ? laneRamp(route, s) : u * u * (3 - 2 * u);
}

/** Point on the journey at arc length s, `lane` metres right of the walking direction. */
export function journeyPoint(route: Sampled, marks: number[], s: number, lane: number, out: V3 = [0, 0, 0], tan: V3 = [0, 0, 1]): V3 {
  pointAt(route, s, out);
  tangentAt(route, s, tan, 0.3);
  if (lane) {
    const k = lane * journeyLaneRamp(route, marks, s);
    const h = Math.hypot(tan[0], tan[2]);
    if (h > 1e-6) { out[0] += (-tan[2] / h) * k; out[2] += (tan[0] / h) * k; }
  }
  return out;
}

/** The pose τ seconds into a journey (`rest` = what it does at the end). Deterministic. */
export function journeyPose(route: Sampled, p: JourneyPlan, rest: Phase, tau: number, lane = 0): ActorPose & { at: JourneyAt } {
  const at = journeyAt(p, tau);
  const tan: V3 = [0, 0, 1];
  const pos = journeyPoint(route, p.marks, at.s, at.phase === "walking" ? lane : 0, [0, 0, 0], tan);
  // facing: the walking direction; standing, the direction it came in (the queue may turn it)
  if (at.phase !== "walking" && at.s > 0.4) tangentAt(route, at.s - 0.35, tan, 0.3);
  const yaw = Math.atan2(tan[0], tan[2]);
  let stride = 0;
  for (let i = 0; i < at.leg; i++) stride += p.legs[i]!;
  stride += at.s - (at.leg ? p.marks[at.leg - 1]! : 0);
  const phase: Phase = at.phase === "walking" ? "walking" : at.phase === "dwelling" ? p.state[at.stop]! : rest === "walking" ? "idle" : rest;
  return { pos, yaw, phase, since: at.since, speed: at.speed, stride, at };
}

// ---------------------------------------------------------------- queues at stops

/** One actor standing at a stop node from `a` to `b` (absolute seconds). */
export interface StopVisit {
  key: string; // actor id
  node: string;
  a: number;
  b: number;
}

/**
 * Queue places at shared stops: every visit gets the lowest place not taken by an earlier
 * arrival still standing there (ties: by key). Place 0 = on the node itself. Returns
 * `${key}@${a}` → place. Pure: same visits, same places.
 */
export function queuePlaces(visits: StopVisit[]): Map<string, number> {
  const out = new Map<string, number>();
  const byNode = new Map<string, StopVisit[]>();
  for (const v of visits) (byNode.get(v.node) ?? byNode.set(v.node, []).get(v.node)!).push(v);
  for (const list of byNode.values()) {
    list.sort((x, y) => x.a - y.a || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const standing: { b: number; place: number }[] = [];
    for (const v of list) {
      for (let i = standing.length - 1; i >= 0; i--) if (standing[i]!.b <= v.a) standing.splice(i, 1);
      const used = new Set(standing.map((x) => x.place));
      let place = 0;
      while (used.has(place)) place++;
      standing.push({ b: v.b, place });
      out.set(`${v.key}@${v.a}`, place);
    }
  }
  return out;
}

/** Ring places around a stop: angle offsets (deg) from the approach side, alternating sides. */
const RING = [0, 45, -45, 90, -90, 135, -135, 180];
/** Metres from the node for place k (0 = on it); about 0.75 m apart, a wider ring after eight. */
export function queueOffset(place: number, approachYaw: number, spacing = 0.75): V3 {
  if (place <= 0) return [0, 0, 0];
  const ring = Math.floor((place - 1) / RING.length);
  const r = spacing * (1 + ring * 0.85);
  const a = approachYaw + Math.PI + ((RING[(place - 1) % RING.length]! + ring * 22.5) * Math.PI) / 180;
  return [Math.sin(a) * r, 0, Math.cos(a) * r];
}

/** Seconds a queued actor takes to step to / from its place. */
export const QUEUE_EASE = 0.5;
