// The live viewer: everything around the canvas in live mode (never loaded in render mode).
//
//   loading screen   title from world.title, a bar fed by real load progress, error + retry
//   HUD              title, live dot, agent count, flow legend, views, idle orbit, screenshot,
//                    fullscreen, VR/AR; light/dark aware; ?ui=0 hides all of it
//   sky time         real skies: local time at the world's place, a 24 h scrubber, Now (docs/sky.md)
//   camera           presets from world.cameras + plots, eased flights, keys 1–9, double-click
//                    or double-tap to fly to a thing, idle auto-orbit after 60 s
//   selection        click / tap a robot, building, machine or meter: a small card (world data only)
//   performance      adaptive quality (quality.ts), paused while the tab is hidden
//
// docs/viewer.md has the query flags and the performance policy.
import "./viewer.css";
import type { TeraBridge } from "../../bridge/types.ts";
import type { Op as WorldOp, WorldPack } from "../../schema/index.ts";
import type { Engine } from "../engine.ts";
import type { XrOptions } from "../xr.ts";
import type { LiveStatus, ReplayPlayer } from "../live.ts";
import { Flight, fitAspect, framePose, outwardDir, type Pose, type V3 } from "./flight.ts";
import { LEVELS, QualityGovernor, initialLevel, levelIndex, pixelRatioAt } from "./quality.ts";
import { buildPresets, countAgents, describe, legendOf, parseSavedView, resolveSelection, splitTitle, type Card, type Preset } from "./model.ts";

export interface ViewerInit {
  engine: Engine;
  bridge: TeraBridge;
  params: URLSearchParams;
  xr?: XrOptions;
}

const ICON: Record<string, string> = {
  views: '<path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  orbit: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.4-2h6l1.4 2h2.1A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.8" r="3.3"/>',
  expand: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  twilight: '<path d="M3 18h18"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 7.5v2M5.6 10.6l1.4 1.4M18.4 10.6 17 12"/>',
};

/** Local wall-clock parts of `ms` in `zone` (IANA), else a fixed offset of round(lon/15) hours. */
export function localParts(ms: number, zone: string | undefined, lon: number): { minutes: number; seconds: number; label: string; date: string; zoneLabel: string } {
  if (zone) {
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric", hourCycle: "h23", timeZoneName: "short" });
      const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const hh = Number(p.hour) % 24, mm = Number(p.minute), ss = Number(p.second);
      return { minutes: hh * 60 + mm, seconds: ss, label: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, date: `${p.month} ${p.day}`, zoneLabel: p.timeZoneName ?? zone };
    } catch { /* unknown zone: fall through */ }
  }
  const off = Math.round(lon / 15);
  const d = new Date(ms + off * 3600_000);
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { minutes: hh * 60 + mm, seconds: d.getUTCSeconds(), label: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, date: `${months[d.getUTCMonth()]} ${d.getUTCDate()}`, zoneLabel: `UTC${off >= 0 ? "+" : "−"}${Math.abs(off)}` };
}
const icon = (name: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode, blocked storage: fine */ }
  },
};

/** Can this browser draw at all? (WebGPU, else a WebGL2 context.) */
function has3D(): boolean {
  if ((navigator as Navigator & { gpu?: unknown }).gpu) return true;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    (gl?.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

async function fetchWorld(url: string, progress: (f: number) => void): Promise<WorldPack> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || "error"} for ${url}`);
  const total = Number(r.headers.get("content-length")) || 0;
  if (!r.body || !total) return (await r.json()) as WorldPack;
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress(Math.min(1, got / total));
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return JSON.parse(new TextDecoder().decode(all)) as WorldPack;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class Viewer {
  readonly engine: Engine;
  private bridge: TeraBridge;
  private params: URLSearchParams;
  private ui: boolean;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private liveUrl: string | null;
  /** `?replay=<url>`: a recorded live stream played in a loop (wins over ?live=). */
  private replayUrl: string | null;
  private replay: ReplayPlayer | null = null;
  /** The fetched world, kept to reset a replay at its loop point. */
  private baseWorld: WorldPack | null = null;
  private skipSnapshot: unknown = null;
  private fade: HTMLElement | null = null;
  private worldSrc: string;

  // state
  private worldId = "";
  private firstLoaded = false;
  private progressShown = 0;
  private presets: Preset[] = [];
  private activePreset: string | null = null;
  private flight: Flight | null = null;
  private islandCenter: V3 = [0, 0, 0];
  private selected: string | null = null;
  private lastInput = performance.now();
  private idleOn: boolean;
  private idleAfter: number;
  private orbiting = false;
  private governor: QualityGovernor | null = null;
  private level = 0;
  private liveStatus: LiveStatus | null = null;
  private stopLive: (() => void) | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  /** Camera follows a robot (after flying to it) until another view is chosen. */
  private follow: { id: string; last: V3 } | null = null;

  // DOM (only with ui)
  private root!: HTMLElement;
  private loader!: HTMLElement;
  private els: Record<string, HTMLElement> = {};

  constructor(init: ViewerInit) {
    this.engine = init.engine;
    this.bridge = init.bridge;
    this.params = init.params;
    this.ui = init.params.get("ui") !== "0";
    this.replayUrl = init.params.get("replay");
    this.liveUrl = this.replayUrl ? null : init.params.get("live");
    this.worldSrc = new URL(init.params.get("world") ?? "worlds/demo/world.json", location.href).href;
    const idleParam = Number(init.params.get("idle"));
    this.idleAfter = Number.isFinite(idleParam) && idleParam > 0 ? idleParam : 60;
    this.idleOn = !this.reduced && store.get("tera:idle") !== "0";
    if (init.xr) document.documentElement.classList.add("tera-xr");
  }

  // ------------------------------------------------------------------ start

  start() {
    if (this.ui) this.buildDom();
    const e = this.engine;
    e.setSize(innerWidth, innerHeight);
    addEventListener("resize", () => {
      e.setSize(innerWidth, innerHeight);
      this.governor?.reset();
    });
    document.addEventListener("visibilitychange", () => {
      e.setPaused(document.hidden);
      this.governor?.reset();
      if (document.hidden) this.saveView();
    });
    addEventListener("pagehide", () => this.saveView());
    this.setupQuality();
    this.setupInput();
    e.onFrame((dt) => this.frame(dt));
    setInterval(() => this.updateCounts(), 1000);
    setInterval(() => this.updateTime(), 500);
    if (!has3D()) {
      this.fail("3D isn’t available here", "Lumbridge Tera needs WebGPU or WebGL 2. Try a current Chrome, Edge, Safari or Firefox with hardware acceleration turned on.", () => location.reload());
      return;
    }
    this.open();
  }

  /** Open the world (from ?world=, or the live feed's first snapshot). */
  private open() {
    this.clearError();
    if (this.liveUrl) this.connect();
    // a replay starts once its world is in (its first ops need the world), or right away
    // when the recording carries its own snapshot (no ?world=)
    if (this.replayUrl && !this.params.get("world")) {
      this.status("Opening the replay", 0.06);
      this.startReplay();
      return;
    }
    if (!this.liveUrl || this.params.get("world")) {
      this.status("Opening world", 0.02);
      fetchWorld(this.worldSrc, (f) => this.status("Opening world", 0.05 + 0.25 * f))
        .then((w) => {
          if (this.replayUrl) this.baseWorld = structuredClone(w);
          return this.loadWorld(w, this.worldSrc);
        })
        .then(() => {
          if (this.replayUrl && this.firstLoaded && !this.replay) this.startReplay();
        })
        .catch((err) => this.fail("Couldn’t open this world", (err as Error).message, () => this.open()));
    } else this.status("Connecting to the live town", 0.06);
  }

  /** `?replay=`: play the recording through the same handlers as the live feed. */
  private startReplay() {
    this.stopLive?.();
    const base = this.params.get("world") ? this.worldSrc : new URL(this.replayUrl!, location.href).href;
    let firstSnapshot: unknown = null;
    void import("../live.ts").then(({ connectReplay, replaySpeed }) => {
      this.stopLive = connectReplay(new URL(this.replayUrl!, location.href).href, {
        ops: (ops) => this.applyTolerant(ops),
        snapshot: (w) => {
          if (w === this.skipSnapshot) return Promise.resolve((this.skipSnapshot = null));
          return this.loadWorld(w, base);
        },
        status: (st, detail) => {
          this.setLive(st);
          if (st === "closed" && !this.firstLoaded) this.fail("Couldn’t open the replay", detail ?? "The recording isn’t available.", () => { this.clearError(); this.startReplay(); });
        },
        loaded: (r, player) => {
          this.replay = player;
          const f = r.frames[0];
          if (f && f.t === 0 && f.msg.type === "snapshot") firstSnapshot = f.msg.world;
        },
        loop: () => this.replayLoop(firstSnapshot, base),
      }, replaySpeed(this.params.get("replaySpeed")));
    });
  }

  /** Apply ops like the live feed does, but skip (and log) an op that fails instead of dropping the rest. */
  private async applyTolerant(ops: WorldOp[]): Promise<void> {
    let rest = ops;
    for (let guard = 0; rest.length && guard < 1000; guard++) {
      const r = await this.bridge.apply(rest);
      if (r.ok) return;
      if (guard < 3) console.warn(`[tera replay] ${r.error}`);
      rest = rest.slice(r.applied + 1);
    }
  }

  /** The loop point: dip out, put the world back as it was at t = 0, dip in. */
  private async replayLoop(firstSnapshot: unknown, base: string): Promise<void> {
    const cut = this.params.get("replayLoop") === "cut" || this.reduced;
    if (!cut) await this.dip(true);
    if (firstSnapshot) {
      await this.loadWorld(firstSnapshot as WorldPack, base);
      this.skipSnapshot = firstSnapshot; // the t = 0 snapshot frame is already loaded
    } else if (this.baseWorld) await this.loadWorld(structuredClone(this.baseWorld), this.worldSrc);
    await nextFrame();
    await nextFrame();
    if (!cut) void this.dip(false);
  }

  private dip(out: boolean): Promise<void> {
    if (!this.fade) {
      this.fade = document.createElement("div");
      this.fade.className = "tv-replay-fade";
      Object.assign(this.fade.style, { position: "fixed", inset: "0", pointerEvents: "none", opacity: "0", transition: "opacity 0.6s ease", background: getComputedStyle(document.body).backgroundColor || "#f5f0e6", zIndex: "1" });
      document.body.appendChild(this.fade);
    }
    const el = this.fade;
    el.getBoundingClientRect();
    el.style.opacity = out ? "1" : "0";
    return new Promise((r) => setTimeout(r, 620));
  }

  private connect() {
    this.stopLive?.();
    let fails = 0;
    const started = performance.now();
    void import("../live.ts").then(({ connectLive }) => {
      this.stopLive = connectLive(this.liveUrl!, {
        ops: (ops) => this.bridge.apply(ops),
        snapshot: (w) => this.loadWorld(w, this.params.get("world") ? this.worldSrc : location.href),
        status: (st) => {
          this.setLive(st);
          if (st === "closed") fails++;
          if (!this.firstLoaded && st === "closed" && (fails >= 3 || performance.now() - started > 8000))
            this.fail("Can’t reach the live town", "The live feed isn’t answering. Still retrying in the background.", () => { this.clearError(); this.connect(); });
          if (st === "open" && !this.firstLoaded) { this.clearError(); this.status("Receiving the town", 0.2); }
        },
      });
    });
  }

  private loading: Promise<void> = Promise.resolve();

  /** Load a world (fetched or a live snapshot), one at a time; later loads keep the camera. */
  private loadWorld(w: WorldPack, baseUrl: string): Promise<void> {
    const run = this.loading.then(() => this.doLoad(w, baseUrl));
    this.loading = run.catch(() => undefined);
    return run;
  }

  private async doLoad(w: WorldPack, baseUrl: string) {
    const e = this.engine;
    const first = !this.firstLoaded;
    const keep = first ? null : this.currentPose();
    if (first) {
      this.setTitle(w.title);
      this.status("Loading", 0.32);
    }
    const s0 = { ...e.loadStats };
    const poll = first
      ? setInterval(() => {
          const started = e.loadStats.started - s0.started, done = e.loadStats.done - s0.done;
          if (started > 0) this.status(`Loading assets · ${Math.min(done, started)} of ${started}`, 0.32 + 0.55 * (done / started));
        }, 80)
      : undefined;
    let res: { warnings: string[] };
    try {
      res = await this.bridge.load(w, baseUrl);
    } catch (err) {
      clearInterval(poll);
      const msg = (err as Error).message;
      const gpu = /webgl|webgpu|context|renderer/i.test(msg);
      this.fail(gpu ? "3D isn’t available here" : "Couldn’t open this world", msg, () => (gpu ? location.reload() : this.open()));
      return;
    }
    clearInterval(poll);
    if (keep && !this.flight) await this.bridge.setCamera(keep);
    for (const m of res.warnings) console.warn(`[tera] ${m}`);
    this.worldId = w.id;
    this.presets = buildPresets(w);
    const box = e.contentBox();
    if (box) {
      const c = box.getCenter(e.camera.position.clone());
      this.islandCenter = [c.x, c.y, c.z];
    }
    this.renderPresets();
    this.renderLegend(w);
    this.updateCounts();
    if (first) {
      this.restoreView();
      this.status("Drawing the first frame", 0.92);
      // The loop draws on its own; wait for two frames with everything loaded.
      await nextFrame();
      await nextFrame();
      this.status("Ready", 1);
      this.firstLoaded = true;
      this.hideLoader();
      this.governor?.reset();
    }
    if (this.selected) this.refreshCard();
  }

  // ------------------------------------------------------------------ per frame

  private frame(dt: number) {
    const e = this.engine;
    if (this.follow) {
      const b = e.focusBox(this.follow.id);
      if (!b) this.follow = null;
      else {
        const c = b.getCenter(e.camera.up.clone());
        const d: V3 = [c.x - this.follow.last[0], c.y - this.follow.last[1], c.z - this.follow.last[2]];
        this.follow.last = [c.x, c.y, c.z];
        const shift = (v: V3): V3 => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
        if (this.flight) this.flight.to = { ...this.flight.to, position: shift(this.flight.to.position), target: shift(this.flight.to.target) };
        else if (e.controls && (d[0] || d[1] || d[2])) {
          e.camera.position.set(...shift(e.camera.position.toArray() as V3));
          e.controls.target.set(...shift(e.controls.target.toArray() as V3));
          e.camera.lookAt(e.controls.target);
        }
      }
    }
    if (this.flight) {
      const { pose, done } = this.flight.at(performance.now() / 1000);
      e.setPose(pose);
      if (done) this.flight = null;
    }
    if (this.governor && this.firstLoaded && !document.hidden) {
      const n = this.governor.frame(dt);
      if (n !== null) this.applyLevel(n);
    }
    // Idle orbit: OrbitControls.autoRotate (only while nothing else moves the camera).
    const idle = this.idleOn && !this.flight && this.firstLoaded && performance.now() - this.lastInput > this.idleAfter * 1000;
    if (idle !== this.orbiting && e.controls) {
      this.orbiting = idle;
      e.controls.autoRotate = idle;
      e.controls.autoRotateSpeed = 0.3; // ≈ 200 s per turn
    }
  }

  // ------------------------------------------------------------------ quality

  private setupQuality() {
    const pinned = levelIndex(this.params.get("quality"));
    this.level = pinned >= 0 ? pinned : initialLevel({ coarsePointer: matchMedia("(pointer: coarse)").matches, minScreenSide: Math.min(screen.width, screen.height), dpr: devicePixelRatio });
    if (pinned < 0) this.governor = new QualityGovernor(this.level);
    this.applyLevel(this.level);
  }

  private applyLevel(i: number) {
    this.level = i;
    const L = LEVELS[i]!;
    void this.engine.setQuality({ pixelRatio: pixelRatioAt(i, devicePixelRatio), post: L.post, shadowCap: L.shadow });
    document.documentElement.dataset.teraQuality = L.name;
  }

  // ------------------------------------------------------------------ camera

  private currentPose(): Pose {
    const e = this.engine;
    return { position: e.camera.position.toArray() as V3, target: (e.controls?.target.toArray() ?? [0, 0, 0]) as V3, fov: e.camera.fov };
  }

  flyTo(pose: Pose, follow: string | null = null) {
    const b = follow ? this.engine.focusBox(follow) : null;
    this.follow = follow && b ? { id: follow, last: b.getCenter(this.engine.camera.up.clone()).toArray() as V3 } : null;
    this.flight = new Flight(this.currentPose(), pose, performance.now() / 1000, this.reduced);
    this.stopOrbit();
  }

  private presetPose(p: Preset): Pose | null {
    if (p.pose) return fitAspect({ position: p.pose.position, target: p.pose.target, fov: p.pose.fov ?? 45 }, this.engine.camera.aspect);
    const box = p.entity ? this.engine.focusBox(p.entity) : null;
    if (!box) return null;
    const c = box.getCenter(this.engine.camera.position.clone());
    return framePose({ min: box.min.toArray() as V3, max: box.max.toArray() as V3 }, outwardDir(this.islandCenter, [c.x, c.y, c.z], 30), 40, this.engine.camera.aspect, 6);
  }

  selectPreset(id: string, fly = true) {
    const p = this.presets.find((x) => x.id === id);
    const pose = p && this.presetPose(p);
    if (!p || !pose) return;
    this.follow = null;
    if (fly) this.flyTo(pose);
    else void this.bridge.setCamera(pose);
    this.activePreset = id;
    store.set(`tera:view:${this.worldId}`, JSON.stringify({ preset: id, pose }));
    this.markActivePreset();
    if (fly) this.toast(p.name);
  }

  private restoreView() {
    const saved = parseSavedView(store.get(`tera:view:${this.worldId}`));
    if (!saved) {
      // First visit: the world's default camera, fitted to this screen's shape.
      const home = this.presets[0];
      if (home?.pose) void this.bridge.setCamera(this.presetPose(home)!);
      return;
    }
    if (saved.pose) void this.bridge.setCamera(saved.pose);
    else if (saved.preset) this.selectPreset(saved.preset, false);
    if (saved.preset) this.activePreset = saved.preset;
    this.markActivePreset();
  }

  private saveView() {
    if (!this.firstLoaded || !this.worldId) return;
    store.set(`tera:view:${this.worldId}`, JSON.stringify({ preset: this.activePreset ?? undefined, pose: this.currentPose() }));
  }

  /** Fly to an entity (double-click / double-tap / the card's button). */
  flyToEntity(id: string) {
    const box = this.engine.focusBox(id);
    if (!box) return;
    const cur = this.currentPose();
    const isActor = this.engine.shown() && describe(this.engine.shown()!, id)?.kind === "Agent";
    let dir: V3 = [cur.position[0] - cur.target[0], cur.position[1] - cur.target[1], cur.position[2] - cur.target[2]];
    // Keep the current bearing at a calm elevation: robots from ~50° (over walls and
    // trees, they walk between buildings), places between ~20° and ~60°.
    const hz = Math.hypot(dir[0], dir[2]) || 1;
    const elev = isActor ? 0.87 : Math.min(Math.PI / 3, Math.max(0.35, Math.atan2(dir[1], hz)));
    dir = [(dir[0] / hz) * Math.cos(elev), Math.sin(elev), (dir[2] / hz) * Math.cos(elev)];
    const bounds = { min: box.min.toArray() as V3, max: box.max.toArray() as V3 };
    let pose = framePose(bounds, dir, cur.fov, this.engine.camera.aspect, isActor ? 6.5 : 5);
    if (isActor) {
      // Robots walk between buildings: turn the bearing until nothing solid is in the way.
      for (const turn of [0, 40, -40, 80, -80, 125, -125, 180]) {
        const a = (turn * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const p = framePose(bounds, [dir[0] * c - dir[2] * s, dir[1], dir[0] * s + dir[2] * c], cur.fov, this.engine.camera.aspect, 6.5);
        if (!this.engine.obstructed(p.target, p.position)) { pose = p; break; }
      }
    }
    this.flyTo(pose, isActor ? id : null);
    this.activePreset = null;
    this.markActivePreset();
  }

  private stopOrbit() {
    this.lastInput = performance.now();
    if (this.orbiting && this.engine.controls) {
      this.engine.controls.autoRotate = false;
      this.orbiting = false;
    }
  }

  // ------------------------------------------------------------------ input

  private setupInput() {
    const onInput = (ev: Event) => {
      this.stopOrbit();
      // A wheel on the canvas takes the camera back from a running flight (and from following).
      if (ev.type === "wheel" && ev.target instanceof HTMLCanvasElement) this.flight = null;
    };
    for (const t of ["pointerdown", "wheel", "keydown", "touchstart"]) addEventListener(t, onInput, { passive: true, capture: true });
    addEventListener("pointermove", (ev) => {
      if (!ev.buttons) return;
      this.stopOrbit();
      // So does a drag (not a plain click: double-clicks start flights).
      if (this.flight && ev.target instanceof HTMLCanvasElement && Math.abs(ev.movementX) + Math.abs(ev.movementY) > 2) this.flight = null;
    }, { passive: true });

    addEventListener("tera:select", (ev) => {
      const id = (ev as CustomEvent<{ id: string }>).detail.id;
      const w = this.engine.shown();
      const sel = w && resolveSelection(w, id);
      if (sel) this.select(sel);
      else this.select(null);
    });
    addEventListener("tera:deselect", () => this.select(null));

    // Double-click / double-tap (pointer events, so it works the same on touch).
    addEventListener("pointerup", (ev) => {
      if (!(ev.target instanceof HTMLCanvasElement)) return;
      const now = performance.now();
      const t = this.lastTap;
      if (t && now - t.t < 320 && Math.hypot(ev.clientX - t.x, ev.clientY - t.y) < 24) {
        this.lastTap = null;
        const hit = this.engine.pickAt(ev.clientX, ev.clientY);
        const w = this.engine.shown();
        const sel = hit && w ? resolveSelection(w, hit.id) : null;
        if (sel) {
          this.flyToEntity(sel);
          this.select(sel);
        }
      } else this.lastTap = { t: now, x: ev.clientX, y: ev.clientY };
    });

    if (!this.ui) return;
    addEventListener("keydown", (ev) => {
      const tgt = ev.target as HTMLElement | null;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
      if (/^[1-9]$/.test(ev.key)) {
        const p = this.presets[Number(ev.key) - 1];
        if (p) { this.selectPreset(p.id); ev.preventDefault(); }
      } else if (ev.key === "Escape") {
        if (!this.els.presets!.hidden) this.togglePresets(false, true);
        else if (this.selected) this.select(null);
      }
    });
  }

  // ------------------------------------------------------------------ DOM

  private buildDom() {
    const root = (this.root = h("div", { id: "tera-ui", class: "tv" }));
    // Loading screen
    this.loader = h("div", { class: "tv-loader", role: "status", "aria-live": "polite" }, `
      <div class="tv-loader-inner">
        <div class="tv-eyebrow"><span class="tv-mark" aria-hidden="true"></span>Lumbridge Tera</div>
        <h1 class="tv-loader-title"></h1>
        <p class="tv-loader-tag"></p>
        <div class="tv-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <p class="tv-loader-status">Starting</p>
        <div class="tv-loader-error" hidden>
          <p class="tv-err-title"></p>
          <p class="tv-err-detail"></p>
          <button type="button" class="tv-btn tv-primary">Try again</button>
        </div>
      </div>`);
    // Top bar: brand + live + agents (left), tools (right)
    const brand = h("div", { class: "tv-brand tv-panel" }, `
      <span class="tv-live" role="img" aria-label="Live feed" hidden></span>
      <span class="tv-replay-word" hidden>replay</span>
      <span class="tv-title"><b></b><span class="tv-tag"></span></span>
      <span class="tv-agents" hidden><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="5"/><path d="M12 4v4"/><circle cx="9.5" cy="13.5" r="0.6" fill="currentColor"/><circle cx="14.5" cy="13.5" r="0.6" fill="currentColor"/></svg><b></b><span class="tv-w"></span></span>`);
    const tools = h("nav", { class: "tv-tools tv-panel", "aria-label": "Viewer controls" });
    const btn = (key: string, label: string, ic: string, extra: Record<string, string> = {}) => {
      const b = h("button", { type: "button", class: "tv-icon", "aria-label": label, title: label, ...extra }, icon(ic));
      this.els[key] = b;
      tools.appendChild(b);
      return b;
    };
    const views = btn("views", "Views (1–9)", "views", { "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "tv-presets" });
    views.insertAdjacentHTML("beforeend", '<span class="tv-icon-label">Views</span>');
    views.classList.add("tv-wide");
    const idle = btn("idle", "Idle orbit", "orbit", { "aria-pressed": String(this.idleOn) });
    if (this.reduced) {
      idle.setAttribute("disabled", "");
      idle.title = "Idle orbit is off (reduced motion)";
    }
    btn("shot", "Save screenshot", "camera");
    if (document.fullscreenEnabled) btn("fs", "Fullscreen", "expand");
    for (const m of ["vr", "ar"] as const) {
      const b = h("button", { type: "button", class: "tv-icon tv-text", "aria-label": m === "vr" ? "Enter VR" : "Start AR", title: m === "vr" ? "Enter VR" : "Start AR", hidden: "" }, m.toUpperCase());
      this.els[m] = b;
      tools.appendChild(b);
    }
    const top = h("header", { class: "tv-top" });
    top.append(brand, tools);
    const presets = h("div", { id: "tv-presets", class: "tv-presets tv-panel", role: "menu", "aria-label": "Camera views", hidden: "" });
    const card = h("section", { class: "tv-card tv-panel", "aria-label": "Selection", hidden: "" });
    const legend = h("div", { class: "tv-legend tv-panel", "aria-label": "Flow colours", hidden: "" });
    const toast = h("div", { id: "hud", class: "tv-toast", role: "status", "aria-live": "polite" });
    const time = h("div", { class: "tv-time tv-panel", role: "group", "aria-label": "Sky time", hidden: "" }, `
      <span class="tv-time-icon" aria-hidden="true"></span>
      <span class="tv-time-text"><b class="tv-time-clock">--:--</b><span class="tv-time-date"></span></span>
      <input class="tv-time-range" type="range" min="0" max="1439" step="1" aria-label="Time of day at this place">
      <button type="button" class="tv-time-now" aria-pressed="false" title="Follow the real time">Now</button>`);
    root.append(top, time, presets, card, legend, toast, this.loader);
    document.body.appendChild(root);
    Object.assign(this.els, {
      brand, presets, card, legend, toast, time,
      live: brand.querySelector(".tv-live") as HTMLElement,
      replayWord: brand.querySelector(".tv-replay-word") as HTMLElement,
      name: brand.querySelector(".tv-title b") as HTMLElement,
      tag: brand.querySelector(".tv-tag") as HTMLElement,
      agents: brand.querySelector(".tv-agents") as HTMLElement,
    });

    views.addEventListener("click", (ev) => this.togglePresets(undefined, (ev as PointerEvent).detail === 0));
    idle.addEventListener("click", () => {
      this.idleOn = !this.idleOn;
      idle.setAttribute("aria-pressed", String(this.idleOn));
      store.set("tera:idle", this.idleOn ? "1" : "0");
      this.toast(this.idleOn ? `Idle orbit on · starts after ${Math.round(this.idleAfter)} s` : "Idle orbit off");
    });
    this.els.shot!.addEventListener("click", () => void this.screenshot());
    this.els.fs?.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => this.toast("Fullscreen isn’t allowed here"));
    });
    document.addEventListener("fullscreenchange", () => {
      const fs = this.els.fs;
      if (!fs) return;
      const on = !!document.fullscreenElement;
      fs.innerHTML = icon(on ? "shrink" : "expand");
      fs.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
      fs.title = on ? "Exit fullscreen" : "Fullscreen";
    });
    addEventListener("pointerdown", (ev) => {
      if (!presets.hidden && !presets.contains(ev.target as Node) && !views.contains(ev.target as Node)) this.togglePresets(false);
    });
    presets.addEventListener("keydown", (ev) => {
      const items = [...presets.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (ev.key === "Home") items[0]?.focus();
      else if (ev.key === "End") items[items.length - 1]?.focus();
    });
    this.setupXrButtons();
    this.setupTime();
  }

  // ------------------------------------------------------------------ sky time (real skies)

  private timeDrag = false;

  private setupTime() {
    const el = this.els.time!;
    const range = el.querySelector<HTMLInputElement>(".tv-time-range")!;
    const now = el.querySelector<HTMLButtonElement>(".tv-time-now")!;
    const scrub = (done: boolean) => {
      const st = this.engine.skyClockState();
      if (!st) return;
      const p = localParts(st.ms, st.timezone, st.lon);
      const midnight = st.ms - (p.minutes * 60 + p.seconds) * 1000 - (st.ms % 1000);
      this.engine.setSkyTime(midnight + Number(range.value) * 60_000, !done);
      this.updateTime();
    };
    range.addEventListener("input", () => { this.timeDrag = true; scrub(false); });
    range.addEventListener("change", () => { this.timeDrag = false; scrub(true); });
    now.addEventListener("click", () => {
      this.engine.skyNow();
      this.updateTime();
      this.toast("Following the real time");
    });
  }

  private updateTime() {
    if (!this.ui) return;
    const el = this.els.time;
    if (!el) return;
    const st = this.engine.skyClockState();
    el.hidden = !st || !this.firstLoaded;
    if (!st) return;
    const p = localParts(st.ms, st.timezone, st.lon);
    const info = this.engine.skyInfo();
    const mode = info.isNight ? "moon" : (info.sunElevation ?? 90) < 6 ? "twilight" : "sun";
    const iconEl = el.querySelector<HTMLElement>(".tv-time-icon")!;
    if (iconEl.dataset.mode !== mode) {
      iconEl.dataset.mode = mode;
      iconEl.innerHTML = icon(mode);
    }
    el.querySelector(".tv-time-clock")!.textContent = p.label;
    const rate = st.rate === 1 ? "" : ` · ×${Math.abs(st.rate) >= 100 ? Math.round(st.rate) : +st.rate.toFixed(1)}`;
    el.querySelector(".tv-time-date")!.textContent = `${p.date}${rate}`;
    el.title = `${p.label} ${p.zoneLabel}, ${p.date} at ${st.lat.toFixed(2)}, ${st.lon.toFixed(2)} · ${info.phase ?? ""}`;
    const range = el.querySelector<HTMLInputElement>(".tv-time-range")!;
    if (!this.timeDrag) range.value = String(p.minutes);
    range.setAttribute("aria-valuetext", `${p.label} ${p.zoneLabel}`);
    const now = el.querySelector<HTMLButtonElement>(".tv-time-now")!;
    now.setAttribute("aria-pressed", String(st.following));
  }

  private setupXrButtons() {
    if (document.documentElement.classList.contains("tera-xr")) return; // ?xr= shows xr.ts's own button
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
    if (!xr) return;
    for (const m of ["vr", "ar"] as const) {
      xr.isSessionSupported(`immersive-${m}`).then((ok) => {
        const b = this.els[m]!;
        if (!ok) return;
        b.hidden = false;
        // The XR path needs the WebGL2 renderer built with XR on: reopen with ?xr=.
        b.addEventListener("click", () => {
          const u = new URL(location.href);
          u.searchParams.set("xr", m);
          this.saveView();
          location.href = u.href;
        });
      }, () => {});
    }
  }

  private setTitle(title: string) {
    const { name, tagline } = splitTitle(title);
    document.title = `${name} · Lumbridge Tera`;
    if (!this.ui) return;
    this.loader.querySelector(".tv-loader-title")!.textContent = name;
    this.loader.querySelector(".tv-loader-tag")!.textContent = tagline;
    this.els.name!.textContent = name;
    this.els.tag!.textContent = tagline;
    this.els.brand!.title = `${title} · ${this.engine.backend === "webgpu" ? "WebGPU" : "WebGL 2"}`;
  }

  private status(text: string, frac: number) {
    if (!this.ui || this.firstLoaded) return;
    this.progressShown = Math.max(this.progressShown, Math.min(1, frac));
    const bar = this.loader.querySelector<HTMLElement>(".tv-bar")!;
    bar.querySelector("span")!.style.transform = `scaleX(${this.progressShown})`;
    bar.setAttribute("aria-valuenow", String(Math.round(this.progressShown * 100)));
    this.loader.querySelector(".tv-loader-status")!.textContent = text;
  }

  private hideLoader() {
    if (!this.ui) return;
    this.loader.classList.add("tv-done");
    this.root.classList.add("tv-ready");
    setTimeout(() => this.loader.remove(), this.reduced ? 50 : 700);
  }

  private fail(title: string, detail: string, retry: () => void) {
    console.error(`[tera] ${title}: ${detail}`);
    if (!this.ui) return;
    if (this.firstLoaded) {
      this.toast(`${title}: ${detail}`);
      return;
    }
    const box = this.loader.querySelector<HTMLElement>(".tv-loader-error")!;
    box.hidden = false;
    this.loader.classList.add("tv-error");
    box.querySelector(".tv-err-title")!.textContent = title;
    box.querySelector(".tv-err-detail")!.textContent = detail;
    const b = box.querySelector("button")!;
    b.onclick = () => retry();
    b.focus({ preventScroll: true });
  }

  private clearError() {
    if (!this.ui || !this.loader.isConnected) return;
    this.loader.classList.remove("tv-error");
    this.loader.querySelector<HTMLElement>(".tv-loader-error")!.hidden = true;
  }

  private setLive(st: LiveStatus) {
    this.liveStatus = st;
    if (!this.ui) return;
    const dot = this.els.live!;
    dot.hidden = false;
    const word = st === "open" ? "live" : st === "replay" ? "replay" : st === "connecting" ? (this.firstLoaded ? "reconnecting" : "connecting") : "offline";
    dot.dataset.status = st;
    dot.title = word;
    dot.setAttribute("aria-label", st === "replay" ? "Replay of a recording" : `Live feed: ${word}`);
    this.els.replayWord!.hidden = st !== "replay";
  }

  private updateCounts() {
    if (!this.ui) return;
    const w = this.engine.shown();
    const n = w ? countAgents(w) : 0;
    const el = this.els.agents!;
    el.hidden = n === 0 && !this.liveUrl && !this.replayUrl;
    const words = `${n} ${n === 1 ? "agent" : "agents"}`;
    el.querySelector("b")!.textContent = String(n);
    el.querySelector(".tv-w")!.textContent = n === 1 ? " agent" : " agents";
    el.title = `${words} in the town`;
    el.setAttribute("aria-label", words);
  }

  private renderLegend(w: WorldPack) {
    if (!this.ui) return;
    const items = legendOf(w);
    const el = this.els.legend!;
    el.hidden = !items;
    el.innerHTML = (items ?? []).map((i) => `<span class="tv-key"><i style="--c:${esc(i.color)}"></i>${esc(i.label)}</span>`).join("");
  }

  private renderPresets() {
    if (!this.ui) return;
    const el = this.els.presets!;
    const section = (g: Preset["group"], title: string) => {
      const list = this.presets.map((p, i) => ({ p, i })).filter(({ p }) => p.group === g);
      if (!list.length) return "";
      return `<p class="tv-sec" role="presentation">${title}</p>` + list.map(({ p, i }) =>
        `<button type="button" role="menuitem" class="tv-item" data-preset="${esc(p.id)}"><span>${esc(p.name)}</span>${i < 9 ? `<kbd aria-hidden="true">${i + 1}</kbd>` : ""}</button>`).join("");
    };
    el.innerHTML = section("view", "Views") + section("place", "Buildings");
    el.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      this.selectPreset(b.dataset.preset!);
      this.togglePresets(false);
    }));
    this.els.views!.hidden = this.presets.length === 0;
    this.markActivePreset();
  }

  private markActivePreset() {
    if (!this.ui) return;
    this.els.presets!.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => {
      if (b.dataset.preset === this.activePreset) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  }

  togglePresets(open?: boolean, focus = false) {
    const el = this.els.presets!, views = this.els.views!;
    const show = open ?? el.hidden;
    el.hidden = !show;
    views.setAttribute("aria-expanded", String(show));
    if (show && focus) el.querySelector<HTMLElement>("[aria-current]") ? el.querySelector<HTMLElement>("[aria-current]")!.focus() : el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    if (!show && focus) views.focus();
  }

  // ------------------------------------------------------------------ selection card

  private cardTimer: ReturnType<typeof setInterval> | undefined;

  select(id: string | null) {
    this.selected = id;
    clearInterval(this.cardTimer);
    if (!this.ui) return;
    if (!id || id !== this.follow?.id) this.follow = null;
    if (!id) {
      this.els.card!.hidden = true;
      return;
    }
    this.refreshCard();
    this.cardTimer = setInterval(() => this.refreshCard(), 500);
  }

  private lastCard = "";

  private refreshCard() {
    const w = this.engine.shown();
    const c: Card | null = w && this.selected ? describe(w, this.selected) : null;
    const el = this.els.card!;
    if (!c) {
      el.hidden = true;
      clearInterval(this.cardTimer);
      return;
    }
    const key = JSON.stringify(c);
    if (key === this.lastCard && !el.hidden) return;
    this.lastCard = key;
    const meter = (m: Card["meters"][number]) => {
      const p = Math.round(m.value * 100);
      const tone = m.value > 0.85 ? "hot" : m.value > 0.6 ? "warm" : "ok";
      return `<div class="tv-meter" data-tone="${tone}"><span class="tv-meter-l">${esc(m.label)}</span><span class="tv-meter-t"><i style="transform:scaleX(${m.value})"></i></span><span class="tv-meter-v">${p}%</span></div>`;
    };
    el.innerHTML = `
      <div class="tv-card-head">
        ${c.color ? `<i class="tv-swatch" style="--c:${esc(c.color)}"></i>` : ""}
        <div class="tv-card-titles"><p class="tv-card-kind">${esc(c.kind)}${c.state ? `<span class="tv-state" data-state="${esc(c.state)}">${esc(c.state)}</span>` : ""}</p><h2>${esc(c.title)}</h2></div>
        <button type="button" class="tv-icon tv-close" aria-label="Close" title="Close (Esc)">${icon("close")}</button>
      </div>
      ${c.detail ? `<p class="tv-card-detail">${esc(c.detail)}</p>` : ""}
      ${c.meters.length ? `<div class="tv-meters">${c.meters.map(meter).join("")}</div>` : ""}
      ${c.chips.length ? `<p class="tv-chips">${c.chips.slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
      <button type="button" class="tv-btn tv-fly">${icon("target")}<span>Fly to</span></button>`;
    el.hidden = false;
    el.querySelector(".tv-close")!.addEventListener("click", () => this.select(null));
    el.querySelector(".tv-fly")!.addEventListener("click", () => this.selected && this.flyToEntity(this.selected));
  }

  // ------------------------------------------------------------------ misc

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  toast(msg: string) {
    if (!this.ui) return;
    const el = this.els.toast!;
    el.textContent = msg;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2600);
  }

  async screenshot() {
    try {
      const b64 = await this.bridge.capture();
      const a = h("a", { href: `data:image/png;base64,${b64}`, download: `${this.worldId || "tera"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.toast("Screenshot saved");
    } catch (err) {
      this.toast(`Screenshot failed: ${(err as Error).message}`);
    }
  }

  /** For tests and devtools. */
  state() {
    return { sky: this.engine.skyClockState(), firstLoaded: this.firstLoaded, level: LEVELS[this.level]!.name, presets: this.presets.map((p) => p.id), selected: this.selected, flying: !!this.flight, orbiting: this.orbiting, live: this.liveStatus, replay: this.replay ? { t: this.replay.t, loops: this.replay.loops, duration: this.replay.replay.duration, speed: this.replay.speed } : null };
  }
}

export function startViewer(init: ViewerInit): Viewer {
  const v = new Viewer(init);
  (window as unknown as { teraViewer: Viewer }).teraViewer = v;
  v.start();
  return v;
}
