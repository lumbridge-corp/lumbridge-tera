// The player in the live viewer (docs/players.md): Orbit / Walk / Fly, layer travel, other
// people (presence), all around one local avatar.
//
//   Orbit   the existing orbit camera; your avatar stands where you left it
//   Walk    third person: WASD / arrows (Shift runs), drag to look, wheel to zoom; a joystick
//           on touch screens. On the floor of the layer you are in, inside its walk disc,
//           blocked by walls (engine.solidHit); the camera is pulled in when something is in the way
//   Fly     free flight (Space / E up, Q / C down, Shift faster); never below the floor of the
//           layer you are in, never into solid geometry
//   Layers  one button per world.layers entry: ride the `spine-car` when the world has one
//           (walk in, ride to the floor, walk out), else a smooth flight to the layer's spawn
//   People  `?presence=<url>`: a PresenceClient (presence.ts) sends your state ~10 Hz and
//           draws everyone else, interpolated, with a name tag
//   Islands other worlds in the same sky (docs/islands.md): the panel is "Islands › Layers";
//           travel to another island rides its ferry (walk to the dock, ride the cabin, walk to
//           the spawn) or flies; presence is one room at a time, the island you are on
//           (positions on the wire are island-local)
import type { IslandRef, Layer, WorldPack } from "../../schema/index.ts";
import type { Engine } from "../engine.ts";
import { EASES } from "../ease.ts";
import { Avatars } from "./avatars.ts";
import type { Pose, V3 } from "./flight.ts";
import {
  FLY, Interp, MODES, WALK, approach, clampCamera, flyStep, followPose, hash01, layerAt, planRide, rideAt, sortLayers, spawnPoint, walkStep,
  type Body, type Mode, type MoveInput, type Ride,
} from "./players.ts";
import { PresenceClient, webSocketTransport, type Player, type PlayerState, type PresenceStatus } from "../presence.ts";
import { composedLayerId, ferryRideAt, islandSections, layerIsland, planFerry, rideCamera, routeLengths, showSections, toLocal, toWorld } from "../islands.ts";
import { splitTitle } from "./model.ts";

/** What the player needs from the viewer's islands manager (viewer/islands.ts). */
export interface IslandsLink {
  loaded(): Set<string>;
  /** Load an island now (and keep it while a trip heads there). */
  ensure(id: string): Promise<boolean>;
  release(id: string): void;
  /** The island's ferry cabin: metres from the home end; a ride holds it (null lets go). */
  cabinS(id: string): number;
  holdCabin(id: string, sFromHome: number | null): void;
  /** The other people in the room (world frame): those on a cable ride a cabin of their own. */
  riders?(positions: V3[]): void;
  /** How far the cabin's swing moves its floor (`floor` m below the grip), world frame. */
  swayOffset?(id: string, floor: number): V3;
}

/**
 * A trip to another island. Ferry rides keep `dir` (the direction of travel, x/z), `side` (+1 / -1:
 * where the ride camera swings out to), `u` (0..1 along the ride) and the cabin floor offset.
 */
type Trip = { plan: ReturnType<typeof planFerry>; t: number; to: Layer; ferry: string | null; total: number; dest: string | null; dir: V3; side: number; u: number; floor: number };

export interface PlayDeps {
  engine: Engine;
  /** The viewer's UI root (null with ?ui=0). */
  root: HTMLElement | null;
  toast(msg: string): void;
  reduced: boolean;
  /** `?presence=` value (a ws url or a path), or null for no presence. */
  presence: string | null;
  /** Called when the mode changes (the viewer stops its flights / idle orbit). */
  onMode?(m: Mode): void;
  /** Islands in the same sky (the viewer's manager), if the world has any. */
  islands?: IslandsLink;
}

const LOCAL = "local";
const MODE_LABEL: Record<Mode, string> = { orbit: "Orbit", walk: "Walk", fly: "Fly" };
const ICON: Record<Mode, string> = {
  orbit: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2.5-6.5L14 17v4"/><path d="M7.5 11.5 10 8l3.2 1 2.3 3 2.5.8"/><path d="m10 8 1.5 6.5"/>',
  fly: '<path d="M2.5 13.5 21 6l-5.5 13-3-5.5Z"/><path d="m12.5 13.5 3-3"/>',
};
const icon = (p: string) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Layers of a world, or one implicit ground layer framed from its content (worlds without `layers`). */
export function worldLayers(w: WorldPack, box: { min: V3; max: V3 } | null): Layer[] {
  if (w.layers?.length) return sortLayers(w.layers);
  const cx = box ? (box.min[0] + box.max[0]) / 2 : 0, cz = box ? (box.min[2] + box.max[2]) / 2 : 0;
  const r = box ? Math.max(5, Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2) : 20;
  const floor = !box || (box.min[1] <= 0 && box.max[1] >= 0) ? 0 : box.min[1];
  const cam = w.cameras?.default;
  const sx = cam ? cam.target[0] : cx, sz = cam ? cam.target[2] : cz;
  const d = Math.hypot(sx - cx, sz - cz);
  const k = d > r - 1 ? (r - 1) / d : 1;
  return [{ id: "ground", name: "Ground", floorY: floor, walk: { center: [cx, cz], radius: r }, spawn: [cx + (sx - cx) * k, floor, cz + (sz - cz) * k] }];
}

interface Remote {
  p: Player;
  interp: Interp;
}

export class Play {
  readonly avatars: Avatars;
  mode: Mode = "orbit";
  private e: Engine;
  private layers: Layer[] = [];
  private layer: Layer | null = null;
  private body: Body = { position: [0, 0, 0], velocity: [0, 0, 0], heading: 0 };
  private placed = false;
  private yaw = 0;
  private pitch = -0.28;
  private dist = 4.6;
  private cam: { position: V3; target: V3; fov?: number } | null = null;
  /** The ride camera's rise over whatever stands between it and the cabin (m), and the wanted rise. */
  private rideLift = 0;
  private rideLiftWant = 0;
  private rideCheck = 0;
  private keys = new Set<string>();
  private stick = { x: 0, z: 0, y: 0 };
  private drag: { id: number; x: number; y: number } | null = null;
  private ride: { plan: Ride; t: number; to: Layer; car: { obj: { position: { y: number } }; startY: number; pre: number } | null } | null = null;
  /** A trip to another island: a ferry ride or a flight. */
  private trip: Trip | null = null;
  private riding = false;
  private refs: IslandRef[] = [];
  private homeName = "";
  /** The island whose presence room we are in (null = home; undefined = none yet). */
  private presenceIsland: string | null | undefined = undefined;
  /** The island the HUD speaks for (viewer: the one you are on or look at); undefined = not told. */
  private hudIsland: string | null | undefined = undefined;
  private seed = Math.random();
  private presence: PresenceClient | null = null;
  private presenceStatus: PresenceStatus | "off" = "off";
  private remotes = new Map<string, Remote>();
  private me = { name: "You", color: "#5fb3a1" };
  private resumeWanted: PlayerState | null = null;
  private els: Record<string, HTMLElement> = {};
  private now = () => performance.now() / 1000;

  private d: PlayDeps;
  constructor(d: PlayDeps) {
    this.d = d;
    this.e = d.engine;
    this.avatars = new Avatars(this.e.scene, this.e.camera, () => this.e.handle?.canvas ?? null, d.root);
    this.avatars.upsert(LOCAL, "You", this.me.color, true);
    this.setupInput();
    if (d.root) this.buildDom(d.root);
  }

  // ------------------------------------------------------------------ world

  /** A (new) world: its layers; the avatar keeps its place when its layer still exists. */
  setWorld(w: WorldPack) {
    this.refs = w.islands ?? [];
    this.homeName = splitTitle(w.title).name;
    const box = this.e.contentBox({ homeOnly: true });
    this.layers = worldLayers(w, box ? { min: box.min.toArray() as V3, max: box.max.toArray() as V3 } : null);
    const keep = this.layer && this.layers.find((l) => l.id === this.layer!.id);
    if (!this.placed || !keep) {
      const want = this.resumeWanted && this.layers.find((l) => l.id === this.resumeWanted!.layer);
      if (want && this.resumeWanted) this.placeAt(want, this.resumeWanted.position, this.resumeWanted.heading);
      else this.placeAt(this.layers.find((l) => l.id === "surface") ?? this.layers[0]!, null);
    } else if (!this.trip) this.layer = keep;
    this.renderLayers();
  }

  private placeAt(l: Layer, pos: V3 | null, heading?: number) {
    this.layer = l;
    const p = pos ?? spawnPoint(l, this.seed);
    this.body = { position: [p[0], Math.max(l.floorY, Math.min(p[1], l.floorY + (l.height ?? 1e3))), p[2]], velocity: [0, 0, 0], heading: heading ?? (this.body.heading || 0) };
    if (this.mode === "walk") this.body.position[1] = l.floorY;
    this.placed = true;
    this.cam = null;
    this.renderLayers();
  }

  // ------------------------------------------------------------------ modes

  setMode(m: Mode, quiet = false) {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    if (this.e.controls) this.e.controls.enabled = m === "orbit";
    if (m === "walk" && this.layer) {
      // land on the floor of the layer below
      const l = layerAt(this.layers, this.body.position, 4) ?? this.layer;
      this.layer = l;
      this.body.position = [this.body.position[0], l.floorY, this.body.position[2]];
    }
    if (m !== "orbit") {
      // look from where the camera is now, so the switch is a short glide, not a cut
      const c = this.e.camera.position, p = this.body.position;
      if (prev === "orbit") {
        this.yaw = Math.atan2(p[0] - c.x, p[2] - c.z);
        this.cam = { position: c.toArray() as V3, target: (this.e.controls?.target.toArray() ?? [p[0], p[1], p[2]]) as V3 };
      }
    } else if (this.e.controls) {
      this.e.controls.target.set(this.body.position[0], this.body.position[1] + WALK.eye, this.body.position[2]);
    }
    this.keys.clear();
    this.stick = { x: 0, z: 0, y: 0 };
    this.markMode();
    this.d.onMode?.(m);
    if (!quiet) this.d.toast(m === "walk" ? "Walk · WASD or arrows, drag to look, Shift to run" : m === "fly" ? "Fly · WASD, Space up, Q down, Shift faster" : "Orbit");
  }

  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!); }

  // ------------------------------------------------------------------ input

  private setupInput() {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || typing(ev.target)) return;
      const k = ev.key.toLowerCase();
      if (k === "v") { this.cycleMode(); ev.preventDefault(); return; }
      if (this.mode === "orbit") return;
      if (k === "f" && !ev.repeat) { this.setMode(this.mode === "fly" ? "walk" : "fly"); ev.preventDefault(); return; }
      if (k === "escape") { this.setMode("orbit"); return; }
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "e", "q", "c", "shift"].includes(k)) {
        this.keys.add(k);
        ev.preventDefault();
      }
    });
    addEventListener("keyup", (ev) => this.keys.delete(ev.key.toLowerCase()));
    addEventListener("blur", () => this.keys.clear());
    addEventListener("pointerdown", (ev) => {
      if (this.mode === "orbit" || !(ev.target instanceof HTMLCanvasElement) || this.drag) return;
      this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    });
    addEventListener("pointermove", (ev) => {
      if (!this.drag || ev.pointerId !== this.drag.id || this.mode === "orbit") return;
      const dx = ev.clientX - this.drag.x, dy = ev.clientY - this.drag.y;
      this.drag.x = ev.clientX;
      this.drag.y = ev.clientY;
      const k = ev.pointerType === "touch" ? 0.0075 : 0.0052;
      this.yaw -= dx * k;
      this.pitch = Math.max(-1.25, Math.min(0.55, this.pitch - dy * k));
    });
    const end = (ev: PointerEvent) => { if (this.drag?.id === ev.pointerId) this.drag = null; };
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    addEventListener("wheel", (ev) => {
      if (this.mode === "orbit" || !(ev.target instanceof HTMLCanvasElement)) return;
      this.dist = Math.max(2.2, Math.min(14, this.dist * Math.exp(ev.deltaY * 0.0012)));
    }, { passive: true });
  }

  private input(): MoveInput {
    const k = this.keys;
    const on = (...a: string[]) => a.some((x) => k.has(x));
    let x = (on("d", "arrowright") ? 1 : 0) - (on("a", "arrowleft") ? 1 : 0);
    let z = (on("w", "arrowup") ? 1 : 0) - (on("s", "arrowdown") ? 1 : 0);
    let y = (on(" ", "e") ? 1 : 0) - (on("q", "c") ? 1 : 0);
    x += this.stick.x;
    z += this.stick.z;
    y += this.stick.y;
    const m = Math.hypot(x, z);
    if (m > 1) { x /= m; z /= m; }
    return { x, y: Math.max(-1, Math.min(1, y)), z, fast: k.has("shift") || Math.hypot(this.stick.x, this.stick.z) > 0.92 };
  }

  // ------------------------------------------------------------------ per frame

  frame(dt: number) {
    const now = this.now();
    if (!this.layer) return;
    let speed = 0;
    if (this.trip) speed = this.stepTrip(dt);
    else if (this.ride) speed = this.stepRide(dt);
    else if (this.mode === "walk") {
      const before = this.body.position;
      this.body = walkStep(this.body, this.input(), this.yaw, dt, this.layer, (a, b) => this.blockedWalk(a, b));
      speed = dt > 0 ? Math.hypot(this.body.position[0] - before[0], this.body.position[2] - before[2]) / dt : 0;
    } else if (this.mode === "fly") {
      const before = this.body.position;
      this.body = flyStep(this.body, this.input(), this.yaw, this.pitch * -1 * 0.9, dt, this.layers, (a, b) => this.blockedFly(a, b));
      speed = dt > 0 ? Math.hypot(this.body.position[0] - before[0], this.body.position[1] - before[1], this.body.position[2] - before[2]) / dt : 0;
      this.layer = layerAt(this.layers, this.body.position, 2) ?? this.layer;
    }
    this.avatars.pose(LOCAL, { position: this.body.position, heading: this.body.heading, mode: this.ride || this.trip ? "walk" : this.mode, speed }, dt);
    if (this.mode !== "orbit" || this.ride || this.trip) this.followCamera(dt);
    // other people (those on a cable ride a cabin: the islands manager draws it under them)
    const at: V3[] = [];
    for (const r of this.remotes.values()) {
      const s = r.interp.at(now);
      if (s) { this.avatars.pose(r.p.id, { position: s.position, heading: s.heading, mode: r.p.mode, speed: s.speed }, dt); at.push(s.position); }
    }
    this.d.islands?.riders?.(at);
    this.avatars.frame(dt);
    this.syncPresence();
    if (this.presence) {
      const at = layerIsland(this.layer.id, this.refs);
      if (at.island === this.presenceIsland) this.presence.update({ layer: at.local, position: toLocal(this.body.position, at.offset), heading: this.body.heading, mode: this.ride || this.trip ? "walk" : this.mode });
    }
  }

  private blockedWalk(a: V3, b: V3): boolean {
    // the body is a disc, not a point: probe along both of its sides too, so a step that grazes a
    // narrow box (a cabinet, a table) cannot slip its centre past the corner and end up inside
    // (from inside, the faces are not hit and the body would walk out through the back)
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const d = Math.hypot(dx, dz) || 1;
    const sx = (-dz / d) * WALK.radius * 0.9, sz = (dx / d) * WALK.radius * 0.9;
    for (const h of [0.45, 1.25])
      for (const k of [0, 1, -1])
        if (this.e.solidHit([a[0] + sx * k, a[1] + h, a[2] + sz * k], [b[0] + sx * k, b[1] + h, b[2] + sz * k]) !== null) return true;
    return false;
  }

  private blockedFly(a: V3, b: V3): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-5) return false;
    const pad = 0.45 / d; // look a body radius past the step
    const mid: V3 = [a[0], a[1] + 0.8, a[2]];
    return this.e.solidHit(mid, [b[0] + dx * pad, b[1] + 0.8 + dy * pad, b[2] + dz * pad]) !== null;
  }

  private followCamera(dt: number) {
    const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    if (this.riding && this.trip) {
      // riding a ferry: the ride camera (islands.ts rideCamera) frames the cabin and where it goes,
      // swinging out to the side mid-span; it eases in from the walk camera at the station
      const r = this.trip;
      const want = rideCamera(r.u, this.body.position, r.dir, r.side, this.e.camera.aspect || 16 / 9, this.now());
      // something between the camera and the cabin (a tree by the station, a tower)? rise above it
      // (checked a few times a second; the lift eases, it never jumps)
      const now = this.now();
      if (now >= this.rideCheck) {
        this.rideCheck = now + 0.25;
        const eye: V3 = [this.body.position[0], this.body.position[1] + 1.2, this.body.position[2]];
        this.rideLiftWant = 0;
        for (const lift of [0, 3, 6, 10]) {
          const at: V3 = [want.position[0], want.position[1] + lift, want.position[2]];
          // from just outside the cabin (its own glass and walls are not in the way)
          const d = Math.hypot(at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]) || 1;
          const out: V3 = [eye[0] + ((at[0] - eye[0]) / d) * 1.8, eye[1] + ((at[1] - eye[1]) / d) * 1.8, eye[2] + ((at[2] - eye[2]) / d) * 1.8];
          this.rideLiftWant = lift;
          if (this.e.solidHit(out, at) === null) break;
        }
      }
      this.rideLift += (this.rideLiftWant - this.rideLift) * (this.d.reduced ? 1 : approach(1.5, dt));
      want.position[1] += this.rideLift;
      if (!this.cam) this.cam = { ...want };
      const k = this.d.reduced ? 1 : approach(2.4, dt);
      const fov = (this.cam.fov ?? 55) + (want.fov - (this.cam.fov ?? 55)) * k;
      this.cam = { position: lerp3(this.cam.position, want.position, k), target: lerp3(this.cam.target, want.target, Math.min(1, k * 1.5)), fov };
      this.e.setPose({ position: this.cam.position, target: this.cam.target, fov });
      return;
    }
    const want = followPose(this.body.position, this.yaw, this.pitch, this.dist);
    // pull the camera in front of whatever is between it and the head
    const hit = this.e.solidHit(want.target, want.position);
    let pos = want.position;
    if (hit !== null) {
      const d = Math.max(0.6, hit - 0.3);
      const k = d / this.dist;
      pos = [want.target[0] + (want.position[0] - want.target[0]) * k, want.target[1] + (want.position[1] - want.target[1]) * k, want.target[2] + (want.position[2] - want.target[2]) * k];
    }
    pos = clampCamera(pos, this.layer && layerAt([this.layer], this.body.position, 2) ? this.layer : null);
    if (!this.cam) this.cam = { position: pos, target: want.target };
    // ease toward the wanted pose (faster when the camera is blocked: never sit inside a wall);
    // gently just after a ride, when the camera comes back in from the ride view
    const back = this.trip && !this.riding && (this.cam.fov ?? 55) !== 55;
    const k = this.d.reduced ? 1 : approach(hit !== null ? 20 : back ? 3 : 9, dt);
    const fov = this.cam.fov === undefined ? 55 : Math.abs(this.cam.fov - 55) < 0.05 ? 55 : this.cam.fov + (55 - this.cam.fov) * k;
    this.cam = { position: lerp3(this.cam.position, pos, k), target: lerp3(this.cam.target, want.target, Math.min(1, k * 1.6)), fov };
    const pose: Pose = { position: this.cam.position, target: this.cam.target, fov };
    this.e.setPose(pose);
  }

  // ------------------------------------------------------------------ layer travel

  /** The island you are on (null = the home world). */
  get island(): string | null { return this.layer ? layerIsland(this.layer.id, this.refs).island : null; }
  /** On a lift ride or a trip to another island. */
  get travelling(): boolean { return !!this.ride || !!this.trip; }
  /** The avatar's position (world frame). */
  get position(): V3 { return [...this.body.position] as V3; }

  /** Travel to a layer (composed id), or to an island ("island:<id>": its surface layer). */
  travel(id: string) {
    if (this.ride || this.trip) return;
    if (id.startsWith("island:")) { void this.travelIsland(id.slice(7)); return; }
    const to = this.layers.find((l) => l.id === id);
    if (!to) {
      // a layer of an island not loaded yet: load it and go (its surface, or this layer once it is in)
      const isl = layerIsland(id, this.refs).island;
      if (isl) void this.travelIsland(isl, id);
      return;
    }
    if (to.id === this.layer?.id && this.mode !== "orbit") { this.d.toast(`You are in ${to.name}`); return; }
    const toIsland = layerIsland(to.id, this.refs).island;
    if (toIsland !== this.island) { this.tripTo(to); return; }
    if (this.mode === "orbit" || this.mode === "fly") this.setMode("walk", true);
    const carId = toIsland ? `${toIsland}.spine-car` : "spine-car";
    const carBox = this.e.focusBox(carId);
    const carObj = carBox ? this.e.entityObject(carId) : null;
    const car = carBox && carObj ? { x: (carBox.min.x + carBox.max.x) / 2, z: (carBox.min.z + carBox.max.z) / 2 } : null;
    const plan = planRide(this.body.position, to, this.seed, car, this.d.reduced);
    this.ride = {
      plan, t: 0, to,
      car: carBox && carObj ? { obj: carObj, startY: carObj.position.y, pre: this.body.position[1] - carBox.min.y } : null,
    };
    this.d.toast(car ? `${to.floorY > this.body.position[1] ? "Going up" : "Going down"} to ${to.name}` : `To ${to.name}`);
  }

  /** Go to another island: load it, then travel to its surface (or first) layer. "" = the home world. */
  async travelIsland(id: string, layerId?: string) {
    if (this.ride || this.trip) return;
    if (!id) {
      const l = this.layers.find((x) => x.id === "surface") ?? this.layers.find((x) => layerIsland(x.id, this.refs).island === null);
      if (l) this.travel(l.id);
      return;
    }
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) return;
    if (this.island === id && this.mode !== "orbit") { this.d.toast(`You are on ${ref.name}`); return; }
    if (!this.d.islands?.loaded().has(id)) this.d.toast(`Opening ${ref.name}`);
    const ok = (await this.d.islands?.ensure(id)) ?? false;
    const mine = this.layers.filter((l) => layerIsland(l.id, this.refs).island === id);
    const l = mine.find((x) => x.id === layerId) ?? mine.find((x) => x.id === `${id}.surface`) ?? mine.sort((a, b) => b.floorY - a.floorY)[0];
    if (!ok || !l) { this.d.islands?.release(id); this.d.toast(`${ref.name} isn’t available`); return; }
    if (this.island === id) this.travel(l.id);
    else this.tripTo(l);
  }

  /** A trip to a layer on another island: its ferry when one links the two, else a flight. */
  private tripTo(to: Layer) {
    if (this.ride || this.trip) return;
    const from = this.island, dest = layerIsland(to.id, this.refs).island;
    if (this.mode !== "walk") this.setMode("walk", true);
    const target = spawnPoint(to, this.seed);
    const viaId = dest !== null && from === null ? dest : dest === null && from !== null ? from : null;
    const via = viaId ? this.refs.find((r) => r.id === viaId) : undefined;
    if (dest) void this.d.islands?.ensure(dest);
    if (via?.ferry) {
      const plan = planFerry(this.body.position, via.ferry, target, { reverse: dest === null, cabinS: this.d.islands?.cabinS(via.id) ?? 0, reduced: this.d.reduced });
      const a = plan.route[0]!, b = plan.route[plan.route.length - 1]!;
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const dir: V3 = [(b[0] - a[0]) / l, 0, (b[2] - a[2]) / l];
      // the ride camera swings out on the side the home view looks from (the side the town is lit and framed from)
      const cam = this.e.shown()?.cameras?.default?.position;
      const mid = [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2];
      const side = cam && (-dir[2] * (cam[0] - mid[0]!) + dir[0] * (cam[2] - mid[1]!)) < 0 ? -1 : 1;
      this.trip = { plan, t: 0, to, ferry: via.id, total: routeLengths(via.ferry.route as V3[]).total, dest, dir, side, u: 0, floor: via.ferry.floor ?? 0 };
      this.d.toast(`${via.ferry.name ?? "Ferry"} to ${dest ? via.name : this.homeName || to.name}`);
    } else {
      // a flight: an arc over the gap between the islands
      const a = this.body.position, n = 32;
      const dist = Math.hypot(target[0] - a[0], target[1] - a[1], target[2] - a[2]);
      const h = Math.min(40, Math.max(6, dist * 0.18));
      const path: V3[] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        path.push([a[0] + (target[0] - a[0]) * u, a[1] + (target[1] - a[1]) * u + Math.sin(Math.PI * u) * h, a[2] + (target[2] - a[2]) * u]);
      }
      const duration = (this.d.reduced ? 0.35 : 1) * Math.min(10, Math.max(3, 2 + dist / 22));
      const plan = { legs: [{ from: a, to: target, duration, path }], total: duration, route: path, reverse: false };
      this.trip = { plan, t: 0, to, ferry: null, total: routeLengths(path).total, dest, dir: [0, 0, 1], side: 1, u: 0, floor: 0 };
      this.d.toast(`To ${dest ? this.refs.find((r) => r.id === dest)?.name ?? to.name : this.homeName || to.name}`);
    }
    this.renderLayers();
  }

  private stepTrip(dt: number): number {
    const r = this.trip!;
    r.t += dt;
    const before = this.body.position;
    const at = ferryRideAt(r.plan, r.t, r.total);
    if (r.ferry && at.cabinS !== null) this.d.islands?.holdCabin(r.ferry, at.cabinS);
    const was = this.riding;
    this.riding = at.riding && !!r.ferry;
    let p = at.position;
    if (this.riding && r.ferry && at.cabinS !== null) {
      r.u = r.total ? (r.plan.reverse ? 1 - at.cabinS / r.total : at.cabinS / r.total) : 0;
      // the cabin swings: so does its floor, and the rider on it
      const o = this.d.islands?.swayOffset?.(r.ferry, r.floor) ?? [0, 0, 0];
      p = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
      if (!was) {
        // aboard: face the way we go; the walk camera picks up behind us when we step out
        this.body.heading = (Math.atan2(r.dir[0], r.dir[2]) * 180) / Math.PI;
        this.yaw = Math.atan2(r.dir[0], r.dir[2]);
        this.pitch = -0.28;
      }
    }
    const dx = p[0] - before[0], dz = p[2] - before[2];
    if (Math.hypot(dx, dz) > 1e-4 && !this.riding) this.body.heading = (Math.atan2(dx, dz) * 180) / Math.PI;
    this.body.position = p;
    if (at.done) {
      this.trip = null;
      this.riding = false;
      this.layer = r.to;
      this.body.position = [p[0], r.to.floorY, p[2]];
      if (r.ferry) this.d.islands?.holdCabin(r.ferry, null);
      if (r.dest) this.d.islands?.release(r.dest);
      this.renderLayers();
      this.d.toast(r.dest ? this.refs.find((x) => x.id === r.dest)?.name ?? r.to.name : r.to.name);
      return 0;
    }
    if (!at.riding) {
      const l = layerAt(this.layers, p, 1);
      if (l && l.id !== this.layer?.id) { this.layer = l; this.renderLayers(); }
    }
    return this.riding || dt <= 0 ? 0 : Math.hypot(dx, dz) / dt;
  }

  private stepRide(dt: number): number {
    const r = this.ride!;
    r.t += dt;
    const before = this.body.position;
    const at = rideAt(r.plan, r.t, EASES.inOutCubic);
    if (r.car) {
      // the car first comes to our floor (while we walk to it), then carries us
      const leg0 = r.plan.legs[0]!;
      const u0 = Math.min(1, r.t / Math.max(1e-3, leg0.duration));
      const pre = r.car.pre * (at.leg === 0 ? EASES.inOutCubic(u0) : 1);
      const ride = at.leg === 1 && at.carDy !== null ? at.carDy : at.leg === 2 ? r.plan.legs[1]!.to[1] - r.plan.legs[1]!.from[1] : 0;
      r.car.obj.position.y = r.car.startY + pre + ride;
    }
    const p = at.position;
    const dx = p[0] - before[0], dz = p[2] - before[2];
    if (Math.hypot(dx, dz) > 1e-4) this.body.heading = (Math.atan2(dx, dz) * 180) / Math.PI;
    this.body.position = p;
    if (at.done) {
      this.layer = r.to;
      this.body.position = [p[0], r.to.floorY, p[2]];
      this.ride = null;
      this.renderLayers();
      this.d.toast(r.to.name);
    } else if (at.leg >= 1 && this.layer?.id !== r.to.id && Math.abs(p[1] - r.to.floorY) < Math.abs(p[1] - (this.layer?.floorY ?? 0))) {
      this.layer = r.to;
      this.renderLayers();
    }
    return dt > 0 ? Math.hypot(dx, dz) / dt : 0;
  }

  // ------------------------------------------------------------------ presence

  /** The presence room of an island (null = home: ?presence=). */
  private presenceUrl(island: string | null): string | null {
    return island ? this.refs.find((r) => r.id === island)?.presence ?? null : this.d.presence;
  }

  /** One room at a time: the island you are on (switch when you arrive somewhere else). */
  private syncPresence() {
    if (this.trip || !this.layer) return;
    const here = this.island;
    if (this.presenceIsland !== undefined && here === this.presenceIsland) return;
    const had = this.presenceIsland !== undefined;
    this.presence?.stop();
    this.presence = null;
    for (const id of [...this.remotes.keys()]) { this.remotes.delete(id); this.avatars.remove(id); }
    this.presenceIsland = here;
    const url = this.presenceUrl(here);
    if (url) this.startPresence(url);
    else this.presenceStatus = "off";
    if (had) { this.renderPeople(); this.renderLayers(); }
  }

  private offset(island: string | null): V3 {
    const r = island ? this.refs.find((x) => x.id === island) : undefined;
    return r ? ([...r.offset] as V3) : [0, 0, 0];
  }

  private startPresence(url: string) {
    let factory;
    try { factory = webSocketTransport(url); } catch { return; }
    const island = this.presenceIsland ?? null;
    const off = this.offset(island);
    // the wire speaks island-local layers and positions; we draw in the composed world
    const inWorld = <T extends { layer: string; position: V3 }>(p: T): T => ({ ...p, layer: composedLayerId(island, p.layer), position: toWorld(p.position, off) });
    const client: PresenceClient = new PresenceClient(factory, {
      status: (st) => { if (client !== this.presence) return; this.presenceStatus = st; this.renderPeople(); this.renderLayers(); },
      welcome: (you, resume0) => {
        if (client !== this.presence) return;
        const resume = resume0 ? inWorld(resume0) : null;
        this.me = { name: you.name, color: you.color };
        this.avatars.upsert(LOCAL, you.name, you.color, true);
        this.seed = hash01(you.id);
        if (resume && !this.ride && !this.trip) {
          this.resumeWanted = resume;
          const l = this.layers.find((x) => x.id === resume.layer);
          if (l) this.placeAt(l, resume.position, resume.heading);
        }
        this.renderPeople();
      },
      join: (p0) => {
        if (client !== this.presence) return;
        const p = inWorld(p0);
        // our own copy: the client updates its Player in place before telling us what changed
        this.remotes.set(p.id, { p: { ...p, position: [...p.position] as V3 }, interp: new Interp() });
        this.avatars.upsert(p.id, p.name, p.color);
        this.renderPeople();
        this.renderLayers();
      },
      move: (id, s0, t) => {
        if (client !== this.presence) return;
        const r = this.remotes.get(id);
        if (!r) return;
        const s = inWorld(s0);
        const last = r.interp.last;
        const jump = !last || Math.hypot(s.position[0] - last.position[0], s.position[1] - last.position[1], s.position[2] - last.position[2]) > 30;
        const changed = r.p.layer !== s.layer;
        Object.assign(r.p, s);
        if (jump) r.interp.reset({ t, position: s.position, heading: s.heading });
        else r.interp.push({ t, position: s.position, heading: s.heading });
        if (changed) this.renderLayers();
      },
      leave: (id) => {
        if (client !== this.presence) return;
        this.remotes.delete(id);
        this.avatars.remove(id);
        this.renderPeople();
        this.renderLayers();
      },
      reject: (why) => {
        if (client !== this.presence) return;
        if (why === "layer" || why === "bounds") {
          const mine = this.layers.filter((x) => layerIsland(x.id, this.refs).island === island);
          const l = mine.find((x) => x.id === composedLayerId(island, "surface")) ?? mine[0];
          if (l) this.placeAt(l, null);
        }
      },
    });
    this.presence = client;
    this.presenceStatus = "connecting";
    client.start();
  }

  stop() { this.presence?.stop(); }

  // ------------------------------------------------------------------ HUD

  private buildDom(root: HTMLElement) {
    const modes = document.createElement("div");
    modes.className = "tv-modes tv-panel";
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "Move mode (V)");
    modes.innerHTML = MODES.map((m) => `<button type="button" role="radio" class="tv-mode" data-mode="${m}" aria-checked="${m === this.mode}" title="${MODE_LABEL[m]} (V cycles)">${icon(ICON[m])}<span>${MODE_LABEL[m]}</span></button>`).join("");
    modes.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => this.setMode(b.dataset.mode as Mode)));
    const layers = document.createElement("nav");
    layers.className = "tv-layers tv-panel";
    layers.setAttribute("aria-label", "Layers");
    layers.hidden = true;
    const people = document.createElement("span");
    people.className = "tv-people";
    people.hidden = true;
    const stick = document.createElement("div");
    stick.className = "tv-stick";
    stick.hidden = true;
    stick.setAttribute("aria-hidden", "true");
    stick.innerHTML = '<span class="tv-stick-knob"></span>';
    const updown = document.createElement("div");
    updown.className = "tv-updown";
    updown.hidden = true;
    updown.innerHTML = `<button type="button" class="tv-icon" data-dy="1" aria-label="Up">${icon('<path d="m6 15 6-6 6 6"/>')}</button><button type="button" class="tv-icon" data-dy="-1" aria-label="Down">${icon('<path d="m6 9 6 6 6-6"/>')}</button>`;
    const toast = root.querySelector(".tv-toast");
    for (const el of [modes, layers, stick, updown]) root.insertBefore(el, toast);
    root.querySelector(".tv-brand")?.appendChild(people);
    Object.assign(this.els, { modes, layers, people, stick, updown });
    this.setupStick(stick, updown);
  }

  private setupStick(stick: HTMLElement, updown: HTMLElement) {
    const knob = stick.querySelector<HTMLElement>(".tv-stick-knob")!;
    let id: number | null = null;
    const set = (ev: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      const R = r.width / 2;
      let x = (ev.clientX - (r.left + R)) / R, y = (ev.clientY - (r.top + R)) / R;
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      this.stick.x = x;
      this.stick.z = -y;
      knob.style.transform = `translate(${(x * R * 0.55).toFixed(1)}px, ${(y * R * 0.55).toFixed(1)}px)`;
    };
    stick.addEventListener("pointerdown", (ev) => { id = ev.pointerId; stick.setPointerCapture(ev.pointerId); set(ev); ev.preventDefault(); });
    stick.addEventListener("pointermove", (ev) => { if (ev.pointerId === id) set(ev); });
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      id = null;
      this.stick.x = this.stick.z = 0;
      knob.style.transform = "";
    };
    stick.addEventListener("pointerup", up);
    stick.addEventListener("pointercancel", up);
    updown.querySelectorAll<HTMLButtonElement>("[data-dy]").forEach((b) => {
      const dy = Number(b.dataset.dy);
      b.addEventListener("pointerdown", (ev) => { this.stick.y = dy; b.setPointerCapture(ev.pointerId); });
      const stop = () => { this.stick.y = 0; };
      b.addEventListener("pointerup", stop);
      b.addEventListener("pointercancel", stop);
    });
  }

  private markMode() {
    const el = this.els.modes;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === this.mode)));
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    this.els.stick!.hidden = !(touch && this.mode !== "orbit");
    this.els.updown!.hidden = !(touch && this.mode === "fly");
    document.documentElement.dataset.teraMode = this.mode;
  }

  private renderLayers() {
    const el = this.els.layers;
    if (!el) return;
    const secs = islandSections(this.homeName || "World", this.refs, this.layers, this.d.islands?.loaded() ?? new Set());
    el.hidden = !showSections(secs);
    const counts = new Map<string, number>();
    if (this.layer && this.presenceStatus !== "off") counts.set(this.layer.id, 1);
    for (const r of this.remotes.values()) counts.set(r.p.layer, (counts.get(r.p.layer) ?? 0) + 1);
    const here = this.island;
    const going = this.trip ? layerIsland(this.trip.to.id, this.refs).island : undefined;
    const key = JSON.stringify([secs.map((x) => [x.id, x.layers.map((l) => l.id)]), this.layer?.id, [...counts], this.trip ? going ?? "home" : "-"]);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    // everyone on each layer, you included (the people count in the title bar counts you too)
    const n = (k: number, me = false) => (k ? `<span class="tv-layer-n" aria-label="${k} ${k === 1 ? "person" : "people"}${me ? ", you included" : ""}" title="${k} here${me ? " (you included)" : ""}">${k}</span>` : "");
    const layerBtn = (l: Layer) => `<button type="button" class="tv-layer" data-layer="${esc(l.id)}" aria-current="${l.id === this.layer?.id}" title="Go to ${esc(l.name)}"><span>${esc(l.name)}</span>${n(counts.get(l.id) ?? 0, l.id === this.layer?.id)}</button>`;
    // how you would get to island `id` from here: its ferry (by name) or a flight
    const how = (id: string | null) => {
      if (id === here) return "";
      const via = id !== null && here === null ? id : id === null && here !== null ? here : null;
      const ref = via ? this.refs.find((r) => r.id === via) : undefined;
      return ref?.ferry ? `by ${ref.ferry.name ?? "ferry"}` : "fly";
    };
    const sub = (id: string | null) => (going !== undefined && going === id ? `<small class="tv-island-how" data-going="true">on the way</small>` : how(id) ? `<small class="tv-island-how">${esc(how(id))}</small>` : "");
    if (secs.length === 1) {
      el.setAttribute("aria-label", "Layers");
      el.innerHTML = `<p class="tv-sec">Layers</p>` + secs[0]!.layers.map(layerBtn).join("");
    } else {
      el.setAttribute("aria-label", "Islands and layers");
      el.innerHTML = `<p class="tv-sec">Islands</p>` + secs.map((sec) => {
        const on = sec.id === here;
        const k = sec.layers.reduce((a, l) => a + (counts.get(l.id) ?? 0), 0);
        const label = `${on ? "You are on" : "Go to"} ${esc(sec.name)}${how(sec.id) ? ` (${esc(how(sec.id))})` : ""}`;
        // one layer (or not loaded yet): the island is one button; more: its name (a button too), then its layers
        if (sec.layers.length <= 1) return `<button type="button" class="tv-layer tv-island-go" data-island="${esc(sec.id ?? "")}" aria-current="${on}" title="${label}"><span class="tv-island-label"><span>${esc(sec.name)}</span>${sub(sec.id)}</span>${n(k, on)}</button>`;
        return `<div class="tv-island" role="group" aria-label="${esc(sec.name)}"><button type="button" class="tv-island-name" data-island="${esc(sec.id ?? "")}" data-here="${on}" title="${label}"><span class="tv-island-label"><span>${esc(sec.name)}</span>${sub(sec.id)}</span></button>${sec.layers.map(layerBtn).join("")}</div>`;
      }).join("");
    }
    el.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => b.addEventListener("click", () => this.travel(b.dataset.layer!)));
    el.querySelectorAll<HTMLButtonElement>("[data-island]").forEach((b) => b.addEventListener("click", () => void this.travelIsland(b.dataset.island!)));
  }

  /** The HUD speaks for island `id` (null = home): the people count shows only for the room you are in. */
  peopleOf(id: string | null) {
    if (this.hudIsland === id) return;
    this.hudIsland = id;
    this.renderPeople();
  }

  private renderPeople() {
    const el = this.els.people;
    if (!el) return;
    el.hidden = this.presenceStatus === "off" || (this.hudIsland !== undefined && this.presenceIsland !== undefined && this.hudIsland !== this.presenceIsland);
    const n = this.remotes.size + 1;
    el.dataset.status = this.presenceStatus;
    el.innerHTML = `${icon('<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>')}<b>${n}</b>`;
    const names = [this.me.name + " (you)", ...[...this.remotes.values()].map((r) => r.p.name)];
    el.title = this.presenceStatus === "open" ? `Here now: ${names.join(", ")}` : "People: connecting";
    el.setAttribute("aria-label", `${n} ${n === 1 ? "person" : "people"} here`);
  }

  /** Tests and devtools: put the avatar somewhere (a layer, a point on it) facing `yawDeg`. */
  teleport(layerId: string, pos?: V3, yawDeg?: number) {
    const l = this.layers.find((x) => x.id === layerId);
    if (!l) return false;
    this.ride = null;
    this.trip = null;
    this.riding = false;
    this.placeAt(l, pos ?? null);
    if (yawDeg !== undefined) { this.yaw = (yawDeg * Math.PI) / 180; this.body.heading = yawDeg; }
    return true;
  }

  /** For tests and devtools. */
  state() {
    return {
      mode: this.mode,
      layer: this.layer?.id ?? null,
      layers: this.layers.map((l) => l.id),
      position: this.body.position.map((v) => Math.round(v * 100) / 100),
      heading: Math.round(this.body.heading),
      riding: !!this.ride || !!this.trip,
      island: this.island,
      trip: this.trip ? { to: this.trip.to.id, ferry: this.trip.ferry, t: Math.round(this.trip.t * 10) / 10, total: Math.round(this.trip.plan.total * 10) / 10, aboard: this.riding } : null,
      camera: this.e.camera.position.toArray().map((v) => Math.round(v * 100) / 100),
      presence: this.presenceStatus,
      you: this.presence?.you ?? null,
      players: [...this.remotes.values()].map((r) => ({ id: r.p.id, name: r.p.name, layer: r.p.layer, mode: r.p.mode, position: r.p.position })),
      fly: FLY.speed,
    };
  }
}
