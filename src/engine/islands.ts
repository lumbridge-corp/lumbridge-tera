// Islands in one sky (CONTRACT.md section 1e, docs/islands.md). Pure: no three.js, no DOM,
// testable in Node. The engine composes the world it shows from the home world plus every island
// it has mounted; the viewer (viewer/islands.ts, viewer/play.ts) uses the frame and ferry maths.
//
//   composeIslands  home + mounted islands -> one world: ids "<island>.<id>", paths / graph nodes /
//                   cameras / layers prefixed and moved by the island's offset, residents and
//                   sandboxes "<island>-<id>", living references remapped; an island not mounted is
//                   its impostor; a ferry's entities are mounted with its ref. A world without
//                   islands composes to itself (the same object).
//   island frames   which island a layer / point belongs to, local <-> world positions (presence
//                   speaks island-local)
//   ferries         the cabin's idle shuttle (ferryAt), arc-length positions on a route, a ride plan
import type { Entity, Ferry, IslandRef, Layer, WorldPack } from "../schema/index.ts";

export type V3 = [number, number, number];

/** Kinds of light that light a whole world: dropped from a mounted island (the home world lights the sky). */
export const GLOBAL_LIGHTS = new Set(["directional", "hemisphere", "ambient"]);

export const islandEntityId = (island: string, id: string) => `${island}.${id}`;
export const islandResidentId = (island: string, id: string) => `${island}-${id}`;
export const ferryGroupId = (island: string) => `${island}.ferry`;
export const ferryEntityId = (island: string, id: string) => `${island}.ferry.${id}`;
/** The id the cabin of island `island`'s ferry has in the composed world. */
export const cabinId = (ref: Pick<IslandRef, "id" | "ferry">) => (ref.ferry ? ferryEntityId(ref.id, ref.ferry.cabin) : null);

const add3 = (a: readonly number[], o: readonly number[]): V3 => [a[0]! + o[0]!, a[1]! + o[1]!, a[2]! + o[2]!];
const sub3 = (a: readonly number[], o: readonly number[]): V3 => [a[0]! - o[0]!, a[1]! - o[1]!, a[2]! - o[2]!];

type AnyEntity = Entity & Record<string, unknown>;

/** Rename every id in a subtree (and drop what `drop` says), in place on a clone. */
function renameTree(list: Entity[], rename: (id: string) => string, visit?: (e: AnyEntity) => void, drop?: (e: Entity) => boolean): Entity[] {
  const out: Entity[] = [];
  for (const e of list) {
    if (drop?.(e)) continue;
    const x = e as AnyEntity;
    x.id = rename(x.id);
    visit?.(x);
    if (x.kind === "group") (x as { children: Entity[] }).children = renameTree((x as { children: Entity[] }).children, rename, visit, drop);
    if (x.kind === "repeat") {
      const of = (x as { of: Entity }).of as AnyEntity;
      if (typeof of.id === "string") of.id = rename(of.id);
      if (of.kind === "group") (of as { children: Entity[] }).children = renameTree((of as { children: Entity[] }).children, rename, undefined, drop);
    }
    out.push(x);
  }
  return out;
}

const isGlobalLight = (e: Entity) => e.kind === "light" && GLOBAL_LIGHTS.has((e as { light: string }).light);

/** Pull every flow out of a tree (flows draw along world paths: parents' transforms must not move them). */
function takeFlows(list: Entity[], out: Entity[]): Entity[] {
  const keep: Entity[] = [];
  for (const e of list) {
    if (e.kind === "flow") { out.push(e); continue; }
    if (e.kind === "group") (e as { children: Entity[] }).children = takeFlows((e as { children: Entity[] }).children, out);
    keep.push(e);
  }
  return keep;
}

export interface ComposeResult {
  world: WorldPack;
  warnings: string[];
}

/** home + mounted islands -> the world to draw. `mounted` maps island id -> its own world (unprefixed). */
export function composeIslands(home: WorldPack, mounted: ReadonlyMap<string, WorldPack> = new Map()): ComposeResult {
  const refs = home.islands ?? [];
  if (!refs.length) return { world: home, warnings: [] };
  const warnings: string[] = [];
  const out: WorldPack = {
    ...home,
    entities: [...home.entities],
    ...(home.paths ? { paths: [...home.paths] } : {}),
    ...(home.graph ? { graph: { nodes: [...home.graph.nodes], edges: [...home.graph.edges] } } : {}),
    ...(home.cameras ? { cameras: { ...home.cameras } } : {}),
    ...(home.layers ? { layers: [...home.layers] } : {}),
    ...(home.residents ? { residents: [...home.residents] } : {}),
    ...(home.sandboxes ? { sandboxes: [...home.sandboxes] } : {}),
  };
  const topIds = new Set(home.entities.map((e) => e.id));
  const flows: Entity[] = [];
  const ferries: Entity[] = [];
  for (const ref of refs) {
    const clash = [...topIds].find((id) => id === ref.id || id.startsWith(ref.id + "."));
    if (clash) { warnings.push(`island "${ref.id}" skipped: the world already has an entity "${clash}"`); continue; }
    const o = ref.offset;
    const P = (id: string) => islandEntityId(ref.id, id);
    const R = (id: string) => islandResidentId(ref.id, id);
    const w = mounted.get(ref.id);
    let children: Entity[];
    if (w) {
      const src = structuredClone(w.entities);
      children = renameTree(src, P, (e) => {
        if (e.kind === "actor") {
          const t = (e.transform ??= {}) as { position?: V3 };
          // actors are posed in world space (their parents' transforms don't move them)
          t.position = add3(t.position ?? [0, 0, 0], o);
          const m = e.move as Record<string, unknown> | undefined;
          if (m) {
            for (const k of ["path", "to", "from"]) if (typeof m[k] === "string") m[k] = P(m[k] as string);
            if (Array.isArray(m.stops)) m.stops = (m.stops as { to: string }[]).map((s) => ({ ...s, to: P(s.to) }));
          }
          if (typeof e.resident === "string") e.resident = R(e.resident);
        }
        if (e.kind === "flow" && typeof e.path === "string") e.path = P(e.path);
      }, isGlobalLight);
      children = takeFlows(children, flows);
      for (const p of w.paths ?? []) (out.paths ??= []).push({ ...p, id: P(p.id), points: p.points.map((q) => add3(q, o)) });
      if (w.graph) {
        const g = (out.graph ??= { nodes: [], edges: [] });
        for (const n of w.graph.nodes) g.nodes.push({ id: P(n.id), position: add3(n.position, o) });
        for (const ed of w.graph.edges) g.edges.push(Array.isArray(ed) ? [P(ed[0]), P(ed[1])] : { from: P(ed.from), to: P(ed.to), ...(ed.path ? { path: P(ed.path) } : {}) });
      }
      for (const [k, c] of Object.entries(w.cameras ?? {})) (out.cameras ??= {})[P(k)] = { ...c, position: add3(c.position, o), target: add3(c.target, o) };
      for (const l of w.layers ?? []) {
        (out.layers ??= []).push({
          ...l, id: P(l.id), floorY: l.floorY + o[1],
          walk: { center: [l.walk.center[0] + o[0], l.walk.center[1] + o[2]], radius: l.walk.radius },
          spawn: add3(l.spawn, o), ...(l.camera ? { camera: P(l.camera) } : {}),
        });
      }
      for (const r of w.residents ?? []) (out.residents ??= []).push({ ...r, id: R(r.id), ...(r.sandbox ? { sandbox: R(r.sandbox) } : {}), ...(r.homeNode ? { homeNode: P(r.homeNode) } : {}) });
      for (const s of w.sandboxes ?? []) (out.sandboxes ??= []).push({ ...s, id: R(s.id), ...(s.entity ? { entity: P(s.entity) } : {}) });
    } else {
      children = renameTree(structuredClone(ref.impostor ?? []), (id) => P(`impostor.${id}`), undefined, isGlobalLight);
    }
    out.entities.push({
      id: ref.id, kind: "group", tags: ["island", `island:${ref.id}`, w ? "island-full" : "island-impostor"],
      transform: { position: [o[0], o[1], o[2]] }, children,
    } as Entity);
    if (ref.ferry) {
      const fid = (id: string) => ferryEntityId(ref.id, id);
      ferries.push({ id: ferryGroupId(ref.id), kind: "group", tags: ["ferry", `island:${ref.id}`], children: renameTree(structuredClone(ref.ferry.entities), fid) } as Entity);
    }
  }
  out.entities.push(...flows, ...ferries);
  return { world: out, warnings };
}

/** The composed world only. */
export const compose = (home: WorldPack, mounted?: ReadonlyMap<string, WorldPack>) => composeIslands(home, mounted).world;

// ---------------------------------------------------------------- frames

export interface IslandFrame {
  /** null = the home world. */
  id: string | null;
  offset: V3;
}

/** Which island a composed layer id belongs to, and its island-local id. */
export function layerIsland(layerId: string, refs: readonly Pick<IslandRef, "id" | "offset">[]): { island: string | null; local: string; offset: V3 } {
  const i = layerId.indexOf(".");
  if (i > 0) {
    const ref = refs.find((r) => r.id === layerId.slice(0, i));
    if (ref) return { island: ref.id, local: layerId.slice(i + 1), offset: [...ref.offset] as V3 };
  }
  return { island: null, local: layerId, offset: [0, 0, 0] };
}

/** The composed layer id of island-local `local` on `island` (null = home). */
export const composedLayerId = (island: string | null, local: string) => (island ? islandEntityId(island, local) : local);
export const toLocal = (p: readonly number[], offset: readonly number[]): V3 => sub3(p, offset);
export const toWorld = (p: readonly number[], offset: readonly number[]): V3 => add3(p, offset);

/** The island whose footprint (radius + slack, in x/z) contains p; null = home or open sky. */
export function islandAt(p: readonly number[], refs: readonly Pick<IslandRef, "id" | "offset" | "radius">[], slack = 4): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const r of refs) {
    const d = Math.hypot(p[0]! - r.offset[0], p[2]! - r.offset[2]);
    if (d <= r.radius + slack && d < bestD) { best = r.id; bestD = d; }
  }
  return best;
}

export interface IslandSection {
  /** null = the home world. */
  id: string | null;
  name: string;
  layers: Layer[];
  loaded: boolean;
}

/** The Islands › Layers panel: the home world first (named `homeName`), then each island in ref order. */
export function islandSections(homeName: string, refs: readonly Pick<IslandRef, "id" | "name">[], layers: readonly Layer[], loaded: ReadonlySet<string>): IslandSection[] {
  const ids = new Set(refs.map((r) => r.id));
  const own = (l: Layer) => { const i = l.id.indexOf("."); return i > 0 && ids.has(l.id.slice(0, i)) ? l.id.slice(0, i) : null; };
  const out: IslandSection[] = [{ id: null, name: homeName, layers: layers.filter((l) => own(l) === null), loaded: true }];
  for (const r of refs) out.push({ id: r.id, name: r.name, layers: layers.filter((l) => own(l) === r.id), loaded: loaded.has(r.id) });
  return out;
}

/** Show the panel? More than one island, or one with two or more layers. */
export const showSections = (s: readonly IslandSection[]) => s.length > 1 || (s[0]?.layers.length ?? 0) >= 2;

// ---------------------------------------------------------------- ferries

/** Cumulative arc length of a polyline. */
export function routeLengths(route: readonly V3[]): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1]! + Math.hypot(route[i]![0] - route[i - 1]![0], route[i]![1] - route[i - 1]![1], route[i]![2] - route[i - 1]![2]));
  return { cum, total: cum[cum.length - 1]! };
}

/** The point `s` metres along a route (clamped), and the direction there. */
export function routePoint(route: readonly V3[], s: number, L = routeLengths(route)): { position: V3; dir: V3 } {
  const d = Math.max(0, Math.min(L.total, s));
  let i = 1;
  while (i < route.length - 1 && L.cum[i]! < d) i++;
  const a = route[i - 1]!, b = route[i]!;
  const seg = L.cum[i]! - L.cum[i - 1]! || 1;
  const u = Math.max(0, Math.min(1, (d - L.cum[i - 1]!) / seg));
  const dir: V3 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg, (b[2] - a[2]) / seg];
  return { position: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], dir };
}

export const FERRY = { period: 40, dwell: 6, speed: 7, minRide: 6, maxRide: 30 };
const smooth = (u: number) => 0.5 - Math.cos(Math.PI * Math.max(0, Math.min(1, u))) / 2;

export type FerryPhase = "home" | "out" | "island" | "back";

/** The cabin shuttling on its own: dwell at home, cross, dwell at the island, come back. `t` in seconds. */
export function ferryAt(route: readonly V3[], t: number, period = FERRY.period, dwell = FERRY.dwell): { position: V3; s: number; u: number; phase: FerryPhase } {
  const L = routeLengths(route);
  const cycle = 2 * (period + dwell);
  const x = ((t % cycle) + cycle) % cycle;
  let u: number, phase: FerryPhase;
  if (x < dwell) { u = 0; phase = "home"; }
  else if (x < dwell + period) { u = smooth((x - dwell) / period); phase = "out"; }
  else if (x < 2 * dwell + period) { u = 1; phase = "island"; }
  else { u = 1 - smooth((x - 2 * dwell - period) / period); phase = "back"; }
  const s = u * L.total;
  return { position: routePoint(route, s, L).position, s, u, phase };
}

/** Heading (degrees, 0 = +Z, 90 = +X) of a route's overall direction, start to end. */
export function routeHeading(route: readonly V3[]): number {
  const a = route[0]!, b = route[route.length - 1]!;
  return ((Math.atan2(b[0] - a[0], b[2] - a[2]) * 180) / Math.PI + 360) % 360;
}

export interface FerryLeg {
  from: V3;
  to: V3;
  duration: number;
  /** Riding legs: the rider follows this polyline (eased by arc length); the cabin moves with them. */
  path?: V3[];
  /** Walking to the dock: the cabin comes back to its home end from `cabinFrom` (m along its route). */
  cabinFrom?: number;
}

/**
 * A ferry ride from `from` (on the side the trip starts) to `dest` (a spawn on the other side).
 * `reverse` = from the island back home. `cabinS` = where the cabin is now (metres from the home end).
 * Legs: walk to the dock (the cabin comes to meet you), step in, ride, step out, walk to `dest`.
 * The ride takes `period` seconds when the ferry has one (the same pace as its shuttle), else
 * length / 7 m/s, 6–30 s.
 */
export function planFerry(from: V3, ferry: Pick<Ferry, "route" | "board" | "alight" | "floor" | "period">, dest: V3, opts: { reverse?: boolean; cabinS?: number; reduced?: boolean } = {}): { legs: FerryLeg[]; total: number; route: V3[]; reverse: boolean } {
  const reverse = !!opts.reverse;
  const route = (reverse ? [...ferry.route].reverse() : [...ferry.route]) as V3[];
  const L = routeLengths(route);
  const floor = ferry.floor ?? 0;
  const board = (reverse ? ferry.alight : ferry.board) as V3, alight = (reverse ? ferry.board : ferry.alight) as V3;
  const k = opts.reduced ? 0.35 : 1;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  // the cabin's distance from the end the trip starts at
  const cabinS = opts.cabinS ?? 0;
  const away = reverse ? L.total - cabinS : cabinS;
  const walkIn = Math.max(clamp(Math.hypot(board[0] - from[0], board[2] - from[2]) / 3.5, 0.4, 6), Math.min(8, away / (FERRY.speed * 2))) * k;
  const inCab = add3(route[0]!, [0, floor, 0]), outCab = add3(route[route.length - 1]!, [0, floor, 0]);
  // a ridden crossing takes as long as a shuttled one (`period`), else by length
  const ride = (ferry.period ?? clamp(L.total / FERRY.speed, FERRY.minRide, FERRY.maxRide)) * k;
  const step = 0.7 * k;
  const walkOut = clamp(Math.hypot(dest[0] - alight[0], dest[2] - alight[2]) / 3.5, 0.4, 4) * k;
  const legs: FerryLeg[] = [
    { from, to: [board[0], board[1], board[2]], duration: walkIn, cabinFrom: cabinS },
    { from: [board[0], board[1], board[2]], to: inCab, duration: step },
    { from: inCab, to: outCab, duration: ride, path: route.map((p) => add3(p, [0, floor, 0])) },
    { from: outCab, to: [alight[0], alight[1], alight[2]], duration: step },
    { from: [alight[0], alight[1], alight[2]], to: dest, duration: walkOut },
  ];
  return { legs, total: legs.reduce((a, l) => a + l.duration, 0), route, reverse };
}

/** Where a ferry ride is at `t`: rider position, leg, and the cabin's distance from the HOME end (null = not moving it). */
export function ferryRideAt(plan: ReturnType<typeof planFerry>, t: number, ferryTotal = routeLengths(plan.route).total): { position: V3; leg: number; done: boolean; cabinS: number | null; riding: boolean } {
  let acc = 0;
  const toHome = (s: number) => (plan.reverse ? ferryTotal - s : s);
  for (let i = 0; i < plan.legs.length; i++) {
    const L = plan.legs[i]!;
    if (t < acc + L.duration || i === plan.legs.length - 1) {
      const u = L.duration > 0 ? Math.max(0, Math.min(1, (t - acc) / L.duration)) : 1;
      const e = smooth(u);
      const done = t >= plan.total;
      if (L.path) {
        const s = e * ferryTotal;
        const p = routePoint(L.path, s).position;
        return { position: p, leg: i, done, cabinS: toHome(s), riding: true };
      }
      const p: V3 = [L.from[0] + (L.to[0] - L.from[0]) * e, L.from[1] + (L.to[1] - L.from[1]) * e, L.from[2] + (L.to[2] - L.from[2]) * e];
      let cabinS: number | null;
      if (i === 0) cabinS = (L.cabinFrom ?? toHome(0)) + (toHome(0) - (L.cabinFrom ?? toHome(0))) * e;
      else cabinS = i < 2 ? toHome(0) : toHome(ferryTotal);
      return { position: p, leg: i, done, cabinS, riding: false };
    }
    acc += L.duration;
  }
  const last = plan.legs[plan.legs.length - 1]!;
  return { position: last.to, leg: plan.legs.length - 1, done: true, cabinS: toHome(ferryTotal), riding: false };
}

// ---------------------------------------------------------------- loading

/** Load / unload by distance with hysteresis: true = should be loaded. */
export function wantLoaded(loaded: boolean, dist: number, load = 260, keep = false): boolean {
  if (keep) return true;
  return loaded ? dist <= load * 1.25 : dist <= load;
}

/** Distance from a point to an island's footprint (0 inside it). */
export function islandDistance(p: readonly number[], ref: Pick<IslandRef, "offset" | "radius">): number {
  const dxz = Math.max(0, Math.hypot(p[0]! - ref.offset[0], p[2]! - ref.offset[2]) - ref.radius);
  return Math.hypot(dxz, p[1]! - ref.offset[1]);
}

/** Distance from `p` to a route, and the arc length of the nearest point on it. */
export function nearestOnRoute(route: readonly V3[], p: readonly number[], L = routeLengths(route)): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ll = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    const u = Math.max(0, Math.min(1, ((p[0]! - a[0]) * ab[0] + (p[1]! - a[1]) * ab[1] + (p[2]! - a[2]) * ab[2]) / ll));
    const d = Math.hypot(a[0] + ab[0] * u - p[0]!, a[1] + ab[1] * u - p[1]!, a[2] + ab[2] * u - p[2]!);
    if (d < best.d) best = { s: L.cum[i - 1]! + Math.sqrt(ll) * u, d };
  }
  return best;
}

/**
 * A cabin's gentle swing (degrees) at `t` seconds: `roll` side to side about its direction of
 * travel, `pitch` fore and aft. `u` = 0..1 along the route; it swings most mid-span, settles in
 * the stations (u near 0 or 1), and `moving` = 0 holds it still.
 */
export function cabinSway(t: number, u: number, moving = 1): { roll: number; pitch: number } {
  const span = Math.min(1, Math.max(0, Math.min(u, 1 - u) / 0.12)) * moving;
  return {
    roll: span * (1.6 * Math.sin(t * 1.47) + 0.5 * Math.sin(t * 0.61 + 1.3)),
    pitch: span * 0.7 * Math.sin(t * 1.13 + 0.4),
  };
}

/**
 * The camera for a rider on a ferry (docs/islands.md "Riding"). `u` = 0..1 along the ride, `at` =
 * the rider's feet, `dir` = the direction of travel (x/z), `side` = +1 / -1 (which side of the
 * cable the camera swings out to), `aspect` = the view's width / height. Leaving and arriving:
 * a three-quarter view from behind and beside the cabin, looking ahead into the next station;
 * mid-span: out to the side and up, the cabin in the middle, the island behind on one edge and
 * the one ahead on the other (a portrait view rises behind the cabin and looks along the cable
 * instead). A slow drift keeps it alive (`t` seconds).
 */
export function rideCamera(u: number, at: readonly number[], dir: readonly number[], side: number, aspect = 16 / 9, t = 0): { position: V3; target: V3; fov: number } {
  const sstep = (a: number, b: number, x: number) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const w = sstep(0.04, 0.42, u) * (1 - sstep(0.58, 0.96, u));
  const l = Math.hypot(dir[0]!, dir[2]!) || 1;
  const D: V3 = [dir[0]! / l, 0, dir[2]! / l];
  const S: V3 = [-D[2] * side, 0, D[0] * side];
  const mix = (a: number, b: number) => a + (b - a) * w;
  // a portrait view (a phone) has no width for both islands side by side: mid-span it rises behind
  // the cabin and looks along the cable instead (the cabin low, the island ahead above it)
  const tall = Math.max(0, Math.min(1, (1.2 - aspect) / 0.5));
  const lerp = (a: number, b: number) => a + (b - a) * tall;
  const back = mix(7.5, lerp(1.5, 15)), out = mix(7, lerp(22, 4.5)), up = mix(3.4, lerp(5.5, 10)), ahead = mix(13, lerp(1.5, 16));
  const drift = Math.sin(t * 0.37) * 0.35;
  const position: V3 = [at[0]! - D[0] * back + S[0] * (out + drift), at[1]! + up + Math.sin(t * 0.53) * 0.18, at[2]! - D[2] * back + S[2] * (out + drift)];
  const target: V3 = [at[0]! + D[0] * ahead, at[1]! + mix(0.6, -0.4), at[2]! + D[2] * ahead];
  return { position, target, fov: mix(56, 50) };
}
