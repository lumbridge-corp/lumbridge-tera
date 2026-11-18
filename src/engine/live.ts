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
import { LiveMessage } from "../schema/living.ts";
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

export type LiveStatus = "connecting" | "open" | "closed";

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

/** The HUD dot: green open, amber connecting, red closed. */
export function liveDot(): { el: HTMLElement; set(s: LiveStatus): void } {
  const el = document.createElement("span");
  el.id = "live-dot";
  el.title = "live feed";
  Object.assign(el.style, {
    position: "fixed", right: "12px", bottom: "12px", width: "9px", height: "9px", borderRadius: "50%",
    boxShadow: "0 0 0 2px rgba(10,12,16,0.5)", pointerEvents: "none", transition: "background 0.3s",
  });
  const colors: Record<LiveStatus, string> = { open: "#9dff3a", connecting: "#ffb23a", closed: "#ff5a4a" };
  const set = (s: LiveStatus) => {
    el.style.background = colors[s];
    el.dataset.status = s;
    el.title = `live feed: ${s}`;
  };
  set("connecting");
  document.body.appendChild(el);
  return { el, set };
}
