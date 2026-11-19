// Live feed: `?live=ws://host:port` streams ops into the world as they happen.
// CONTRACT.md section 9. Server → page messages, one JSON object per WebSocket message:
//
//   { "type": "snapshot", "world": WorldPack }   replace the whole world (camera kept)
//   { "type": "ops", "ops": Op[] }               apply in order (actor moves tween)
//   { "type": "ping" }                           keep-alive, ignored
//
// The page reconnects with exponential backoff (0.5 s → 10 s, jittered) and shows a
// small connection dot in the HUD. This module does not import three.js, so the message
// parsing is testable in Node.
//
// Replay (`?replay=<url>`, CONTRACT.md section 9a): a recorded stream of the same
// messages (JSONL `{ t, msg }`) played back on the page's own clock, in a loop, through
// the same handlers as the WebSocket, so robots tween exactly as they do live.
import { LiveMessage, ReplayHeader, ReplayLine } from "../schema/living.ts";
import { Op, WorldPack } from "../schema/index.ts";
import type { Op as OpT, WorldPack as WorldPackT } from "../schema/index.ts";

export type Parsed =
  | { type: "ops"; ops: OpT[]; seq?: number }
  | { type: "snapshot"; world: WorldPackT; seq?: number }
  | { type: "ping" }
  | { type: "error"; error: string };

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ` : "") + i.message).join("; ");

/** Parse one feed message. Never throws: bad input comes back as { type: "error" }. */
export function parseLiveMessage(raw: string | unknown): Parsed {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { type: "error", error: `not JSON: ${(err as Error).message}` };
    }
  }
  const m = LiveMessage.safeParse(data);
  if (!m.success) return { type: "error", error: `bad message: ${issues(m.error)}` };
  const msg = m.data;
  if (msg.type === "ping") return { type: "ping" };
  if (msg.type === "snapshot") {
    const w = WorldPack.safeParse(msg.world);
    if (!w.success) return { type: "error", error: `bad snapshot world: ${issues(w.error)}` };
    return { type: "snapshot", world: w.data, seq: msg.seq };
  }
  const ops: OpT[] = [];
  for (let i = 0; i < msg.ops.length; i++) {
    const o = Op.safeParse(msg.ops[i]);
    if (!o.success) return { type: "error", error: `ops[${i}]: ${issues(o.error)}` };
    ops.push(o.data);
  }
  return { type: "ops", ops, seq: msg.seq };
}

/** Reconnect delay for the n-th consecutive failure (0-based), jittered ±20 %. */
export function backoff(n: number, rand: () => number = Math.random): number {
  const base = Math.min(10_000, 500 * 2 ** Math.min(n, 10));
  return Math.round(base * (0.8 + 0.4 * rand()));
}

export type LiveStatus = "connecting" | "open" | "closed" | "replay";

export interface LiveHandlers {
  ops(ops: OpT[]): Promise<unknown>;
  snapshot(world: WorldPackT): Promise<unknown>;
  status?(s: LiveStatus, detail?: string): void;
}

/** Connect to a live feed; returns a function that stops it. Browser only. */
export function connectLive(url: string, h: LiveHandlers): () => void {
  let ws: WebSocket | null = null;
  let fails = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) => (queue = queue.then(fn).catch((err) => console.warn(`[tera live] ${(err as Error).message}`)));

  const open = () => {
    if (stopped) return;
    h.status?.("connecting");
    try {
      ws = new WebSocket(url);
    } catch (err) {
      h.status?.("closed", (err as Error).message);
      return retry();
    }
    ws.onopen = () => {
      fails = 0;
      h.status?.("open");
    };
    ws.onmessage = (ev) => {
      const m = parseLiveMessage(typeof ev.data === "string" ? ev.data : "");
      if (m.type === "error") console.warn(`[tera live] ${m.error}`);
      else if (m.type === "ops") run(() => h.ops(m.ops));
      else if (m.type === "snapshot") run(() => h.snapshot(m.world));
    };
    ws.onclose = () => {
      ws = null;
      h.status?.("closed");
      retry();
    };
    ws.onerror = () => ws?.close();
  };
  const retry = () => {
    if (stopped) return;
    timer = setTimeout(open, backoff(fails++));
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

// ---------------------------------------------------------------- replay

export type ReplayMsg = Exclude<Parsed, { type: "error" } | { type: "ping" }>;
export interface ReplayFrame {
  t: number; // seconds from the start of the recording
  msg: ReplayMsg;
}
export interface Replay {
  frames: ReplayFrame[]; // sorted by t (ties keep file order)
  duration: number; // loop length, seconds
  title?: string;
  skipped: { line: number; error: string }[]; // malformed lines (1-based), never fatal
}

/** Parse a replay file (JSONL). Bad lines are skipped and reported, never thrown. */
export function parseReplay(text: string): Replay {
  const frames: ReplayFrame[] = [];
  const skipped: Replay["skipped"] = [];
  let header: ReplayHeader | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      skipped.push({ line: i + 1, error: `not JSON: ${(err as Error).message}` });
      continue;
    }
    if (!header && !frames.length && data && typeof data === "object" && "tera" in data) {
      const h = ReplayHeader.safeParse(data);
      if (h.success) header = h.data;
      else skipped.push({ line: i + 1, error: `bad header: ${issues(h.error)}` });
      continue;
    }
    const l = ReplayLine.safeParse(data);
    if (!l.success) {
      skipped.push({ line: i + 1, error: `bad line: ${issues(l.error)}` });
      continue;
    }
    const m = parseLiveMessage(l.data.msg);
    if (m.type === "error") skipped.push({ line: i + 1, error: m.error });
    else if (m.type !== "ping") frames.push({ t: l.data.t, msg: m });
  }
  frames.sort((a, b) => a.t - b.t); // stable: ties keep file order
  const last = frames.length ? frames[frames.length - 1]!.t : 0;
  const duration = header?.duration ?? Math.max(last, 0.001);
  return { frames: frames.filter((f) => f.t <= duration), duration, title: header?.title, skipped };
}

/**
 * The replay clock (pure): `advance(dt)` moves recording time by `dt * speed` and hands
 * out the frames it crossed. At the loop point it hands out the rest and reports `loop`;
 * it then stays at the end until `restart()` (the page resets the world in between).
 */
export class ReplayPlayer {
  t = 0;
  loops = 0;
  private i = 0;
  private atEnd = false;
  readonly replay: Replay;
  readonly speed: number;
  constructor(replay: Replay, speed = 1) {
    this.replay = replay;
    this.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  }
  advance(dt: number): { frames: ReplayFrame[]; loop: boolean } {
    if (this.atEnd) return { frames: [], loop: false };
    this.t += Math.max(0, dt) * this.speed;
    const { frames, duration } = this.replay;
    const out: ReplayFrame[] = [];
    while (this.i < frames.length && frames[this.i]!.t <= this.t) out.push(frames[this.i++]!);
    if (this.t >= duration) {
      while (this.i < frames.length) out.push(frames[this.i++]!);
      this.atEnd = true;
      return { frames: out, loop: true };
    }
    return { frames: out, loop: false };
  }
  /** Back to the start of the recording (after the page has reset its world). */
  restart(): void {
    this.t = 0;
    this.i = 0;
    this.atEnd = false;
    this.loops++;
  }
}

/** `&replaySpeed=` → a playback speed (0.1 – 32, default 1). */
export function replaySpeed(v: string | null): number {
  const n = Number(v);
  return v !== null && Number.isFinite(n) && n > 0 ? Math.min(32, Math.max(0.1, n)) : 1;
}

export interface ReplayHandlers extends LiveHandlers {
  /** The loop point: reset the world (e.g. fade out, reload, fade in). Frames wait for it. */
  loop?(): Promise<unknown>;
  /** The parsed file, once (title, duration, skipped lines). */
  loaded?(r: Replay, player: ReplayPlayer): void;
}
export interface ReplayDeps {
  fetchText?(url: string): Promise<string>;
  /** One display frame: calls back with a timestamp in ms (requestAnimationFrame). */
  frame?(cb: (now: number) => void): void;
  maxStep?: number; // seconds: a longer gap (hidden tab, a stall) counts as this much
}

/**
 * Play a recorded live stream in a loop. The clock only advances while frames are drawn
 * (a hidden tab pauses it) and never jumps more than `maxStep` at once. Returns a stop
 * function. Status: "connecting" while loading, then "replay" (or "closed" on failure).
 */
export function connectReplay(url: string, h: ReplayHandlers, speed = 1, deps: ReplayDeps = {}): () => void {
  const fetchText = deps.fetchText ?? (async (u: string) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  });
  const frame = deps.frame ?? ((cb: (now: number) => void) => void requestAnimationFrame(cb));
  const maxStep = deps.maxStep ?? 0.25;
  let stopped = false;
  let queue: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) => (queue = queue.then(fn).catch((err) => console.warn(`[tera replay] ${(err as Error).message}`)));
  const deliver = (f: ReplayFrame) => (f.msg.type === "ops" ? run(() => h.ops((f.msg as { ops: OpT[] }).ops)) : run(() => h.snapshot((f.msg as { world: WorldPackT }).world)));

  h.status?.("connecting");
  fetchText(url)
    .then((text) => {
      if (stopped) return;
      const r = parseReplay(text);
      for (const s of r.skipped.slice(0, 5)) console.warn(`[tera replay] line ${s.line} skipped: ${s.error}`);
      if (r.skipped.length > 5) console.warn(`[tera replay] ${r.skipped.length - 5} more lines skipped`);
      if (!r.frames.length) {
        h.status?.("closed", "replay has no messages");
        return;
      }
      const player = new ReplayPlayer(r, speed);
      h.loaded?.(r, player);
      h.status?.("replay");
      let last: number | null = null;
      let waiting = false;
      const tick = (now: number) => {
        if (stopped) return;
        const dt = last === null ? 0 : Math.min(maxStep, Math.max(0, (now - last) / 1000));
        last = now;
        if (!waiting) {
          const { frames, loop } = player.advance(dt);
          for (const f of frames) deliver(f);
          if (loop) {
            waiting = true;
            run(async () => {
              if (stopped) return;
              await h.loop?.();
              player.restart();
              last = null;
              waiting = false;
            });
          }
        }
        frame(tick);
      };
      frame(tick);
    })
    .catch((err) => {
      if (!stopped) h.status?.("closed", `replay: ${(err as Error).message}`);
    });
  return () => {
    stopped = true;
  };
}

/** The HUD dot: green open, amber connecting, red closed. */
export function liveDot(): { el: HTMLElement; set(s: LiveStatus): void } {
  const el = document.createElement("span");
  el.id = "live-dot";
  el.title = "live feed";
  Object.assign(el.style, {
    position: "fixed", right: "12px", bottom: "12px", width: "9px", height: "9px", borderRadius: "50%",
    boxShadow: "0 0 0 2px rgba(10,12,16,0.5)", pointerEvents: "none", transition: "background 0.3s",
  });
  const colors: Record<LiveStatus, string> = { open: "#9dff3a", connecting: "#ffb23a", closed: "#ff5a4a", replay: "#8fd8e8" };
  const set = (s: LiveStatus) => {
    el.style.background = colors[s];
    el.dataset.status = s;
    el.title = `live feed: ${s}`;
  };
  set("connecting");
  document.body.appendChild(el);
  return { el, set };
}
