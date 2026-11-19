// Presence: who else is in the world, where, and how they move (protocol "players/v1",
// docs/players.md). The client knows no server: it talks through a pluggable transport
// (webSocketTransport(url) for a real server, anything with send/close for tests or other
// carriers). The viewer opens it with `?presence=<ws url or path>`; without the flag
// nothing is sent anywhere.
//
// Client → server: { type: "state", layer, position: [x,y,z], heading, mode } — at most
// `rateHz` per second while moving, and a heartbeat every `heartbeatMs` when standing still.
// Server → client: welcome / join / states / leave / reject (parsePresenceMessage).

export type V3 = [number, number, number];
export type PlayerMode = "walk" | "fly" | "orbit";

export interface PlayerState {
  layer: string;
  position: V3;
  heading: number;
  mode: PlayerMode;
}
export interface Player extends PlayerState {
  id: string;
  name: string;
  color: string;
}
export interface You {
  id: string;
  name: string;
  color: string;
}

export type PresenceMessage =
  | { type: "welcome"; you: You; players: Player[]; resume: PlayerState | null; max: number | null }
  | { type: "join"; player: Player }
  | { type: "states"; players: ({ id: string } & PlayerState)[] }
  | { type: "leave"; id: string }
  | { type: "reject"; reason: string }
  | { type: "ignore" };

const MODES = new Set<PlayerMode>(["walk", "fly", "orbit"]);
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const LAYER = /^[a-z0-9][a-z0-9-_.]{0,31}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_PLAYERS = 64;

const num = (v: unknown, lim = 1e5): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
function vec(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map((x) => num(x));
  return out.every((x) => x !== null) ? (out as V3) : null;
}
// control, zero-width, bidi-override and line-separator characters
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");
/** A display name: printable, trimmed, ≤ 32 characters (never trusted as HTML). */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return s ? [...s].slice(0, 32).join("") : null;
}
function state(o: Record<string, unknown>): PlayerState | null {
  const position = vec(o.position), heading = num(o.heading, 1e4);
  if (typeof o.layer !== "string" || !LAYER.test(o.layer) || !position || heading === null) return null;
  const mode = MODES.has(o.mode as PlayerMode) ? (o.mode as PlayerMode) : "orbit";
  return { layer: o.layer, position, heading: ((heading % 360) + 360) % 360, mode };
}
function player(v: unknown): Player | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = state(o), name = cleanName(o.name);
  if (!s || typeof o.id !== "string" || !ID.test(o.id) || !name) return null;
  return { id: o.id, name, color: typeof o.color === "string" && COLOR.test(o.color) ? o.color : "#9aa0a6", ...s };
}

/** Parse one server message defensively. Unknown or malformed messages become { type: "ignore" }. */
export function parsePresenceMessage(raw: string): PresenceMessage {
  if (typeof raw !== "string" || raw.length > 256 * 1024) return { type: "ignore" };
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return { type: "ignore" }; }
  if (!m || typeof m !== "object") return { type: "ignore" };
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "welcome": {
      const y = o.you as Record<string, unknown> | undefined;
      const name = cleanName(y?.name);
      if (!y || typeof y.id !== "string" || !ID.test(y.id) || !name) return { type: "ignore" };
      const players = (Array.isArray(o.players) ? o.players : []).slice(0, MAX_PLAYERS).map(player).filter((p): p is Player => !!p && p.id !== y.id);
      const resume = o.resume && typeof o.resume === "object" ? state(o.resume as Record<string, unknown>) : null;
      return { type: "welcome", you: { id: y.id, name, color: typeof y.color === "string" && COLOR.test(y.color) ? y.color : "#9aa0a6" }, players, resume, max: num(o.max, 1e4) };
    }
    case "join": {
      const p = player(o.player);
      return p ? { type: "join", player: p } : { type: "ignore" };
    }
    case "states": {
      const list = (Array.isArray(o.players) ? o.players : []).slice(0, MAX_PLAYERS).flatMap((v) => {
        if (!v || typeof v !== "object") return [];
        const r = v as Record<string, unknown>;
        const s = state(r);
        return s && typeof r.id === "string" && ID.test(r.id) ? [{ id: r.id, ...s }] : [];
      });
      return { type: "states", players: list };
    }
    case "leave":
      return typeof o.id === "string" && ID.test(o.id) ? { type: "leave", id: o.id } : { type: "ignore" };
    case "reject":
      return { type: "reject", reason: typeof o.reason === "string" ? o.reason.slice(0, 32) : "rejected" };
    default:
      return { type: "ignore" };
  }
}

// ---------------------------------------------------------------- transport

export interface TransportHandlers {
  open(): void;
  message(text: string): void;
  close(code?: number): void;
}
export interface Transport {
  send(text: string): void;
  close(): void;
}
/** Opens one connection; the client calls it again (after a backoff) when the connection closes. */
export type TransportFactory = (h: TransportHandlers) => Transport;

/** A WebSocket transport. `url` may be ws(s)://… or a path / http(s) URL resolved against the page. */
export function webSocketTransport(url: string, base: string = globalThis.location?.href ?? "http://localhost/"): TransportFactory {
  const u = new URL(url, base);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  return (h) => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(u.href);
    } catch {
      queueMicrotask(() => h.close());
      return { send() {}, close() {} };
    }
    ws.onopen = () => h.open();
    ws.onmessage = (ev) => { if (typeof ev.data === "string") h.message(ev.data); };
    ws.onclose = (ev) => h.close(ev.code);
    ws.onerror = () => ws?.close();
    return {
      send: (t) => { if (ws?.readyState === 1) ws.send(t); },
      close: () => ws?.close(),
    };
  };
}

// ---------------------------------------------------------------- client

export type PresenceStatus = "connecting" | "open" | "closed";
export interface PresenceEvents {
  status?(s: PresenceStatus): void;
  welcome?(you: You, resume: PlayerState | null): void;
  join?(p: Player): void;
  move?(id: string, s: PlayerState, now: number): void;
  leave?(id: string): void;
  reject?(reason: string): void;
}
export interface PresenceOptions {
  rateHz?: number; // most states per second (default 10)
  heartbeatMs?: number; // resend an unchanged state this often (default 4000)
  now?: () => number; // ms
  /** Reconnect delay after n failures (ms). */
  backoff?: (n: number) => number;
  /** Stop reconnecting after this close code (e.g. the server refused us). Default: 4401/4403/1008. */
  fatal?: (code: number | undefined) => boolean;
}

const defaultBackoff = (n: number) => Math.min(15_000, 600 * 2 ** n) * (0.8 + Math.random() * 0.4);

export class PresenceClient {
  readonly players = new Map<string, Player>();
  you: You | null = null;
  status: PresenceStatus = "closed";
  private t: Transport | null = null;
  private stopped = false;
  private fails = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private local: PlayerState | null = null;
  private sentKey = "";
  private sentAt = -Infinity;
  private readonly o: Required<Omit<PresenceOptions, "backoff" | "fatal">> & Pick<PresenceOptions, "backoff" | "fatal">;

  private factory: TransportFactory;
  private ev: PresenceEvents;
  constructor(factory: TransportFactory, ev: PresenceEvents = {}, opts: PresenceOptions = {}) {
    this.factory = factory;
    this.ev = ev;
    this.o = { rateHz: 10, heartbeatMs: 4000, now: () => performance.now(), ...opts };
  }

  start(): this {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.t?.close();
    this.t = null;
    this.setStatus("closed");
  }

  private setStatus(s: PresenceStatus) {
    if (s === this.status) return;
    this.status = s;
    this.ev.status?.(s);
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    let opened = false;
    this.t = this.factory({
      open: () => {
        opened = true;
        this.fails = 0;
        this.setStatus("open");
        this.sentKey = "";
        this.sentAt = -Infinity;
        this.flush(true);
      },
      message: (text) => this.handle(parsePresenceMessage(text)),
      close: (code) => {
        this.t = null;
        for (const id of [...this.players.keys()]) { this.players.delete(id); this.ev.leave?.(id); }
        this.setStatus("closed");
        if (this.stopped) return;
        const fatal = this.o.fatal ?? ((c) => c === 1008 || c === 4401 || c === 4403);
        if (fatal(code)) { this.stopped = true; return; }
        if (!opened) this.fails++;
        this.timer = setTimeout(() => this.connect(), (this.o.backoff ?? defaultBackoff)(this.fails));
      },
    });
  }

  private handle(m: PresenceMessage) {
    const now = this.o.now() / 1000;
    switch (m.type) {
      case "welcome":
        this.you = m.you;
        for (const id of [...this.players.keys()]) { this.players.delete(id); this.ev.leave?.(id); }
        this.ev.welcome?.(m.you, m.resume);
        for (const p of m.players) this.addPlayer(p, now);
        return;
      case "join":
        if (m.player.id !== this.you?.id) this.addPlayer(m.player, now);
        return;
      case "states":
        for (const s of m.players) {
          const p = this.players.get(s.id);
          if (!p) continue;
          Object.assign(p, { layer: s.layer, position: s.position, heading: s.heading, mode: s.mode });
          this.ev.move?.(s.id, s, now);
        }
        return;
      case "leave":
        if (this.players.delete(m.id)) this.ev.leave?.(m.id);
        return;
      case "reject":
        this.ev.reject?.(m.reason);
        return;
    }
  }

  private addPlayer(p: Player, now: number) {
    if (this.players.size >= MAX_PLAYERS && !this.players.has(p.id)) return;
    const had = this.players.has(p.id);
    this.players.set(p.id, p);
    if (!had) this.ev.join?.(p);
    this.ev.move?.(p.id, p, now);
  }

  /** The local player's state (call every frame; sending is throttled). */
  update(s: PlayerState) {
    this.local = s;
    this.flush(false);
  }

  private flush(force: boolean) {
    if (!this.t || this.status !== "open" || !this.local) return;
    const now = this.o.now();
    const s = this.local;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const msg = { type: "state", layer: s.layer, position: s.position.map(r2), heading: Math.round(s.heading * 10) / 10, mode: s.mode };
    const key = JSON.stringify(msg);
    const due = now - this.sentAt >= 1000 / this.o.rateHz;
    const changed = key !== this.sentKey;
    if (force || (changed && due) || now - this.sentAt >= this.o.heartbeatMs) {
      this.t.send(key);
      this.sentKey = key;
      this.sentAt = now;
    }
  }
}
