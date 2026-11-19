// Islands in the live viewer (docs/islands.md): which islands are loaded, their live feeds, and the
// ferry cabins shuttling on their own. The engine composes what is drawn (engine.mountIsland);
// this decides when.
//
//   lazy loading   an island loads when the camera (or your avatar) comes within its `load`
//                  distance of its footprint, and goes back to its impostor beyond 1.25x that
//                  (never the island you are on, or one a ride is heading to)
//   live           ref.live while loaded: a snapshot mounts the island's world, ops go to it
//   ferries        the cabin shuttles on its own (ferryAt) unless a ride holds it (holdCabin);
//                  after a ride it waits at the end it arrived at, then carries on. It swings a
//                  little in the wind (cabinSway). Other people riding (presence: a player on
//                  the cable) ride a cabin too: the shuttle comes to carry the first one, a
//                  copy of the cabin carries each other one
//   cross-fade     loading or unloading an island dissolves the old look into the new (fade.ts)
import * as THREE from "three";
import type { IslandRef, Op, WorldPack } from "../../schema/index.ts";
import type { Engine } from "../engine.ts";
import { FERRY, cabinId, cabinSway, ferryAt, islandAt, islandDistance, nearestOnRoute, routeLengths, routePoint, wantLoaded, type V3 } from "../islands.ts";
import type { LiveStatus } from "../live.ts";
import { Fade, ghostOf } from "./fade.ts";

/** Seconds an island takes to dissolve from its impostor into the full world (and back). */
export const ISLAND_FADE = 1.8;

export interface IslandsDeps {
  engine: Engine;
  /** The world's URL (island srcs are relative to it). */
  base(): string;
  /** Where the avatar is (world frame) and the island it is on (null = home), or null. */
  avatar(): { position: V3; island: string | null; active?: boolean } | null;
  /** Where the orbit camera looks (world frame), or null: an island looked at from near enough loads. */
  focus?(): V3 | null;
  /** Something about the islands changed (mounted / unmounted): layers, presets. */
  changed(): void;
  toast?(msg: string): void;
}

interface State {
  ref: IslandRef;
  loaded: boolean;
  loading: Promise<void> | null;
  live: LiveStatus | null;
  stopLive: (() => void) | null;
  /** A ride's hold on the cabin (metres from the home end), or null = shuttling. */
  hold: number | null;
  /** Shuttle clock offset (s), set when a ride lets go so the cabin carries on from where it is. */
  phase: number;
  keep: boolean;
  /** Other people riding: the shuttle carries the first (metres from the home end), or null. */
  remote: number | null;
  /** Copies of the cabin carrying the other riders. */
  ghosts: THREE.Object3D[];
}

const wsUrl = (path: string) => {
  const u = new URL(path, location.href);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  return u.href;
};

export class Islands {
  private list = new Map<string, State>();
  private checkIn = 0;
  private d: IslandsDeps;
  private fades: Fade[] = [];
  /** Positions (world frame) of the other people in the room: riders are those on a cable. */
  private others: V3[] = [];
  /** The cabin's own yaw (its entity's), kept while the swing turns it. */
  private cabinYaw = new WeakMap<THREE.Object3D, number>();
  /** ?reduced motion: no fades. */
  reduced = false;
  constructor(d: IslandsDeps) { this.d = d; }

  /** A (new) home world: its islands. Islands still listed keep their state. */
  setWorld(w: WorldPack) {
    const refs = w.islands ?? [];
    for (const [id, s] of this.list) if (!refs.some((r) => r.id === id)) { s.stopLive?.(); this.dropGhosts(s, 0); this.list.delete(id); }
    for (const ref of refs) {
      const s = this.list.get(ref.id);
      if (s) {
        const srcChanged = s.ref.src !== ref.src || s.ref.live !== ref.live;
        s.ref = ref;
        if (srcChanged && s.loaded) { s.stopLive?.(); s.stopLive = null; s.loaded = false; void this.load(ref.id); }
        else if (s.loaded && !this.d.engine.islandWorld(ref.id)) { s.loaded = false; void this.load(ref.id); } // a new home load forgot it
      } else this.list.set(ref.id, { ref, loaded: false, loading: null, live: null, stopLive: null, hold: null, phase: 0, keep: false, remote: null, ghosts: [] });
    }
    this.checkIn = 0;
  }

  refs(): IslandRef[] { return [...this.list.values()].map((s) => s.ref); }
  loaded(): Set<string> { return new Set([...this.list.values()].filter((s) => s.loaded).map((s) => s.ref.id)); }

  /** Load an island now (a trip is heading there); keeps it loaded until `release`. */
  async ensure(id: string): Promise<boolean> {
    const s = this.list.get(id);
    if (!s) return false;
    s.keep = true;
    await this.load(id);
    return s.loaded;
  }

  release(id: string) {
    const s = this.list.get(id);
    if (s) s.keep = false;
  }

  private load(id: string): Promise<void> {
    const s = this.list.get(id);
    if (!s) return Promise.resolve();
    if (s.loaded) return Promise.resolve();
    if (s.loading) return s.loading;
    const ref = s.ref;
    s.loading = (async () => {
      try {
        const r = await fetch(new URL(ref.src, this.d.base()).href, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`${r.status} for ${ref.src}`);
        const w = (await r.json()) as WorldPack;
        if (!this.list.has(id) || s.ref !== ref) return;
        await this.swap(id, () => this.d.engine.mountIsland(id, w));
        s.loaded = true;
        this.d.changed();
        if (ref.live) this.connect(s);
      } catch (err) {
        console.warn(`[tera islands] ${ref.id}: ${(err as Error).message}`);
      } finally {
        s.loading = null;
      }
    })();
    return s.loading;
  }

  private connect(s: State) {
    const id = s.ref.id;
    void import("../live.ts").then(({ connectLive }) => {
      if (!s.loaded || s.stopLive) return;
      s.stopLive = connectLive(wsUrl(s.ref.live!), {
        ops: (ops) => (s.loaded ? this.d.engine.applyIsland(id, ops as Op[]).then((r) => { if (!r.ok) console.warn(`[tera islands] ${r.error}`); }) : Promise.resolve()),
        snapshot: async (w) => {
          if (!s.loaded) return;
          await this.d.engine.mountIsland(id, w as WorldPack);
          this.d.changed();
        },
        status: (st) => { s.live = st; },
      });
    });
  }

  private async unload(id: string) {
    const s = this.list.get(id);
    if (!s || !s.loaded) return;
    s.stopLive?.();
    s.stopLive = null;
    s.live = null;
    s.loaded = false;
    await this.swap(id, () => this.d.engine.unmountIsland(id));
    this.d.changed();
  }

  /**
   * Change what an island draws (impostor <-> full world) as a cross-fade: the old look is kept as
   * a ghost that dissolves while the new one comes in. A trip or a jump right next to it (the camera
   * inside its footprint) cuts instead: there is nothing to see fade from up close.
   */
  private async swap(id: string, change: () => Promise<void>) {
    const e = this.d.engine;
    const old = e.entityObject(id);
    const s = this.list.get(id);
    const near = s ? islandDistance(e.camera.position.toArray(), s.ref) < 2 : false;
    if (!old || this.reduced || near) { await change(); return; }
    const ghost = ghostOf(old, e.scene);
    this.fades.push(new Fade(ghost.root, 1, 0, ISLAND_FADE, () => ghost.drop()));
    try {
      await change();
    } catch (err) {
      ghost.drop();
      throw err;
    }
    const now = e.entityObject(id);
    if (now) this.fades.push(new Fade(now, 0, 1, ISLAND_FADE));
  }

  // ------------------------------------------------------------------ ferries

  private shuttle(s: State, now: number) {
    const f = s.ref.ferry!;
    return ferryAt(f.route as V3[], now + s.phase, f.period ?? FERRY.period, FERRY.dwell);
  }

  /** Where island `id`'s cabin is now (metres from the home end). */
  cabinS(id: string): number {
    const s = this.list.get(id);
    if (!s?.ref.ferry) return 0;
    return s.hold ?? s.remote ?? this.shuttle(s, performance.now() / 1000).s;
  }

  /** Shuttle on from `at` (metres from the home end): wait at the end nearest, then carry on. */
  private letGo(s: State, at: number) {
    const f = s.ref.ferry!;
    const total = routeLengths(f.route as V3[]).total;
    const period = f.period ?? FERRY.period, dwell = FERRY.dwell, cycle = 2 * (period + dwell);
    // start of the dwell at the end the cabin is at
    const want = at > total / 2 ? period + dwell : 0;
    const now = performance.now() / 1000;
    s.phase = want - (((now % cycle) + cycle) % cycle);
  }

  /** A ride holds the cabin at `sFromHome`; null lets it go (it waits at the end nearest, then shuttles on). */
  holdCabin(id: string, sFromHome: number | null) {
    const s = this.list.get(id);
    if (!s?.ref.ferry) return;
    if (sFromHome === null && s.hold !== null) this.letGo(s, s.hold);
    s.hold = sFromHome;
    this.place(s, performance.now() / 1000); // now, not next frame: the rider stands in it this frame
  }

  /** The other people in the room (world frame); those on a cable ride a cabin. */
  riders(positions: V3[]) { this.others = positions; }

  /** How far the cabin's swing moves a point `floor` m below its grip (world frame), for the rider standing there. */
  swayOffset(id: string, floor: number): V3 {
    const s = this.list.get(id);
    const obj = s ? this.d.engine.entityObject(cabinId(s.ref) ?? "") : null;
    if (!obj) return [0, 0, 0];
    const v = new THREE.Vector3(0, floor, 0).applyQuaternion(obj.quaternion);
    return [v.x, v.y - floor, v.z];
  }

  /** Put the cabin where its ride / rider / shuttle has it, swinging gently. */
  private place(s: State, now: number) {
    const f = s.ref.ferry;
    if (!f) return;
    const obj = this.d.engine.entityObject(cabinId(s.ref)!);
    if (!obj) return;
    const route = f.route as V3[];
    const L = routeLengths(route);
    let at: number, moving = 1;
    if (s.hold !== null) at = s.hold;
    else if (s.remote !== null) at = s.remote;
    else { const sh = this.shuttle(s, now); at = sh.s; moving = sh.phase === "out" || sh.phase === "back" ? 1 : 0; }
    const p = routePoint(route, at, L).position;
    obj.position.set(p[0], p[1], p[2]);
    this.swing(obj, now, L.total ? at / L.total : 0, moving);
  }

  private swing(obj: THREE.Object3D, now: number, u: number, moving: number) {
    if (!this.cabinYaw.has(obj)) this.cabinYaw.set(obj, obj.rotation.y);
    const sw = this.reduced ? { roll: 0, pitch: 0 } : cabinSway(now, u, moving);
    const r = Math.PI / 180;
    obj.rotation.set(sw.pitch * r, this.cabinYaw.get(obj)!, sw.roll * r, "YXZ");
  }

  /** Riders on this ferry's cable (metres from the home end), from the other people's positions. */
  private ridersOn(s: State): number[] {
    const f = s.ref.ferry!;
    const floor = f.floor ?? 0;
    const route = (f.route as V3[]).map((p) => [p[0], p[1] + floor, p[2]] as V3);
    const L = routeLengths(route);
    const out: number[] = [];
    for (const p of this.others) {
      const n = nearestOnRoute(route, p, L);
      // on the cable, not standing in a station (the station ends are on a deck anyway)
      if (n.d < 1.3 && n.s > 2 && n.s < L.total - 2) out.push(n.s);
    }
    return out;
  }

  private dropGhosts(s: State, keep: number) {
    while (s.ghosts.length > keep) s.ghosts.pop()!.removeFromParent();
  }

  private ferries(now: number) {
    for (const s of this.list.values()) {
      const f = s.ref.ferry;
      if (!f) continue;
      const riders = this.ridersOn(s);
      // the shuttle carries the first rider when nobody here rides it; copies carry the rest
      const remote = s.hold === null ? riders.shift() ?? null : null;
      if (remote === null && s.remote !== null) this.letGo(s, s.remote);
      s.remote = remote;
      this.place(s, now);
      const others = s.hold !== null ? riders.filter((x) => Math.abs(x - s.hold!) > 3) : riders;
      const cabin = this.d.engine.entityObject(cabinId(s.ref)!);
      if (!cabin || !others.length) { this.dropGhosts(s, 0); continue; }
      const route = f.route as V3[];
      const L = routeLengths(route);
      others.forEach((at, i) => {
        let g = s.ghosts[i];
        if (!g || g.userData.of !== cabin) {
          g?.removeFromParent();
          g = cabin.clone(true);
          g.userData.of = cabin;
          this.d.engine.scene.add(g);
          s.ghosts[i] = g;
        }
        const p = routePoint(route, at, L).position;
        g.position.set(p[0], p[1], p[2]);
        this.cabinYaw.set(g, this.cabinYaw.get(cabin) ?? cabin.rotation.y);
        this.swing(g, now + i * 1.7, at / L.total, 1);
      });
      this.dropGhosts(s, others.length);
    }
  }

  // ------------------------------------------------------------------ per frame

  frame(dt: number) {
    const now = performance.now() / 1000;
    if (this.fades.length) this.fades = this.fades.filter((f) => f.step(dt));
    this.ferries(now);
    this.checkIn -= dt;
    if (this.checkIn > 0) return;
    this.checkIn = 0.5;
    const cam = this.d.engine.camera.position;
    const me = this.d.avatar();
    const f = this.d.focus?.() ?? null;
    const looked = f ? islandAt(f, this.refs(), 6) : null;
    for (const s of this.list.values()) {
      if (s.loading) continue;
      const dCam = islandDistance([cam.x, cam.y, cam.z], s.ref);
      const dMe = me && me.active !== false ? islandDistance(me.position, s.ref) : Infinity;
      // the island the camera looks at (its view in Views, a fly-to) loads from a little further out
      const load = s.ref.load ?? 260;
      const keep = s.keep || me?.island === s.ref.id || (looked === s.ref.id && dCam <= load * 2);
      const want = wantLoaded(s.loaded, Math.min(dCam, dMe), s.ref.load ?? 260, keep);
      if (want && !s.loaded) void this.load(s.ref.id);
      else if (!want && s.loaded) void this.unload(s.ref.id);
    }
  }

  /** The live feed status of a loaded island (null: none / not loaded). */
  liveOf(id: string): LiveStatus | null { return this.list.get(id)?.live ?? null; }

  /** For tests and devtools. */
  state(here: string | null) {
    return [...this.list.values()].map((s) => ({ id: s.ref.id, name: s.ref.name, loaded: s.loaded, live: s.live, here: here === s.ref.id }));
  }

  stop() {
    for (const s of this.list.values()) { s.stopLive?.(); this.dropGhosts(s, 0); }
    for (const f of this.fades) f.end();
    this.fades = [];
  }
}
