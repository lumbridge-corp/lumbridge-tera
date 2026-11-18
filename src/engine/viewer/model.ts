// The live viewer's data side: camera presets, what a click selects, what the selection card
// says, the flow legend. Everything comes from the world JSON (no network). Pure: testable
// in Node.
import type { CameraPose, Entity, WorldPack } from "../../schema/index.ts";
import type { V3 } from "./flight.ts";

/** "machine-room" → "Machine room", "mr-rack-1" → "Mr rack 1". */
export function pretty(id: string): string {
  const s = id.replace(/^(meter|flow|pipe)\./, "").replace(/[._-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : id;
}

export interface Preset {
  id: string;
  name: string;
  group: "view" | "place";
  /** A fixed pose (world.cameras); places are framed from their bounds at fly time. */
  pose?: CameraPose;
  /** Entity to frame (places). */
  entity?: string;
}

/** Tags that make a group a "place" worth a preset and a selection target. */
export const PLACE_TAGS = ["plot", "building", "machine", "hero"] as const;

/** Every entity with its ancestors, depth first (paths[i] = [root, ..., entity]). */
export function walkPaths(list: Entity[], fn: (path: Entity[]) => void, up: Entity[] = []) {
  for (const e of list) {
    const p = [...up, e];
    fn(p);
    if (e.kind === "group") walkPaths(e.children, fn, p);
  }
}

export function entityPath(list: Entity[], id: string): Entity[] | null {
  let found: Entity[] | null = null;
  walkPaths(list, (p) => { if (!found && p[p.length - 1]!.id === id) found = p; });
  return found;
}

/**
 * The picker: world.cameras first ("default" as "Home", in file order), then every plot
 * (groups tagged "plot") in file order. Keys 1–9 go to the first nine.
 */
export function buildPresets(world: WorldPack): Preset[] {
  const out: Preset[] = [];
  const cams = world.cameras ?? {};
  const seen = new Set<string>();
  for (const [id, pose] of Object.entries(cams)) {
    // Skip a camera identical to one already listed (worlds often alias default = overview).
    const key = JSON.stringify([pose.position, pose.target, pose.fov ?? 45]);
    if (seen.has(key)) {
      // default = overview: keep one entry, under the more telling name.
      const dup = out.find((p) => p.id === "default" && JSON.stringify([p.pose!.position, p.pose!.target, p.pose!.fov ?? 45]) === key);
      if (dup && id === "overview") dup.name = "Overview";
      continue;
    }
    seen.add(key);
    out.push({ id, name: id === "default" ? "Home" : pretty(id), group: "view", pose });
  }
  walkPaths(world.entities, (p) => {
    const e = p[p.length - 1]!;
    if (e.kind === "group" && e.tags?.includes("plot") && e.visible !== false) out.push({ id: `place:${e.id}`, name: pretty(e.id), group: "place", entity: e.id });
  });
  return out;
}

const CONTAINER_TAGS = new Set(["living", "ground"]);

/**
 * What a click on entity `id` selects: the nearest actor, meter or flow on its path; else the
 * nearest group tagged as a place (plot, building, machine, hero); else the nearest tagged group;
 * else the top-level entity. Ground (tag "ground" or a big plane) selects nothing.
 */
export function resolveSelection(world: WorldPack, id: string): string | null {
  const path = entityPath(world.entities, id);
  if (!path) return null;
  const leaf = path[path.length - 1]!;
  if (leaf.tags?.includes("ground")) return null;
  for (let i = path.length - 1; i >= 0; i--) if (["actor", "meter", "flow"].includes(path[i]!.kind)) return path[i]!.id;
  for (let i = path.length - 1; i >= 0; i--) if (path[i]!.kind === "group" && path[i]!.tags?.some((t) => (PLACE_TAGS as readonly string[]).includes(t))) return path[i]!.id;
  for (let i = path.length - 1; i >= 0; i--) if (path[i]!.kind === "group" && path[i]!.tags?.some((t) => !CONTAINER_TAGS.has(t))) return path[i]!.id;
  return path[0]!.id;
}

export interface Card {
  id: string;
  title: string;
  /** "Agent", "Building", "Meter", ... */
  kind: string;
  /** Actor state ("working"), flow style, ... */
  state?: string;
  /** One more line: "heading to lab", "on path tunnel-a". */
  detail?: string;
  color?: string;
  /** 0..1 meters: the entity itself, or up to four meters inside a group. */
  meters: { label: string; value: number }[];
  chips: string[];
}

const pct = (v: number) => Math.min(1, Math.max(0, v));

/** The selection card for an entity, from its JSON alone. */
export function describe(world: WorldPack, id: string): Card | null {
  const path = entityPath(world.entities, id);
  if (!path) return null;
  const e = path[path.length - 1]! as Entity & Record<string, unknown>;
  const tags = e.tags ?? [];
  const nodeName = (n: string) => pretty(n);
  switch (e.kind) {
    case "actor": {
      const a = e as unknown as { label?: string; state?: string; color?: string; move?: { to?: string; path?: string; from?: string } };
      const detail = a.move?.to ? `heading to ${nodeName(a.move.to)}` : a.move?.path ? `on ${nodeName(a.move.path)}` : undefined;
      return { id, title: a.label ?? pretty(id), kind: "Agent", state: a.state ?? "idle", detail, color: a.color, meters: [], chips: tags };
    }
    case "meter": {
      const m = e as unknown as { value: number };
      const unit = tags.find((t) => t !== "meter");
      const owner = [...path].reverse().find((p) => p.kind === "group" && p.tags?.some((t) => (PLACE_TAGS as readonly string[]).includes(t)));
      return { id, title: owner ? `${pretty(owner.id.replace(/^mr-/, ""))}${unit ? ` · ${unit}` : ""}` : pretty(id), kind: "Meter", meters: [{ label: unit ?? "value", value: pct(m.value) }], chips: [] };
    }
    case "flow": {
      const f = e as unknown as { path: string; color?: string; style?: string };
      return { id, title: pretty(id), kind: "Flow", state: f.style ?? "dots", detail: `along ${nodeName(f.path)}`, color: f.color, meters: [], chips: tags.filter((t) => t !== "live-flow") };
    }
    case "group": {
      const kind = tags.includes("machine") ? "Machine" : tags.includes("hero") ? "Landmark" : tags.includes("plot") || tags.includes("building") ? "Building" : "Place";
      const meters: Card["meters"] = [];
      walkPaths(e.children ?? [], (p) => {
        const x = p[p.length - 1]! as Entity & { value?: number };
        if (x.kind === "meter" && meters.length < 4 && x.visible !== false) meters.push({ label: x.tags?.find((t) => t !== "meter") ?? pretty(x.id), value: pct(x.value ?? 0) });
      });
      const title = tags.includes("machine") ? pretty(e.id.replace(/^mr-/, "")) : pretty(e.id);
      return { id, title, kind, meters, chips: tags.filter((t) => !["plot", "part", "building", "machine", "hero"].includes(t) && t !== e.id) };
    }
    default: {
      const kinds: Record<string, string> = { primitive: "Shape", model: "Model", splat: "Splat", text: "Sign", light: "Light", repeat: "Pattern" };
      const t = e as unknown as { text?: string };
      return { id, title: e.kind === "text" && t.text ? t.text.split("\n")[0]! : pretty(id), kind: kinds[e.kind] ?? pretty(e.kind), meters: [], chips: tags };
    }
  }
}

/** Visible actors in the world (the HUD's agent counter). */
export function countAgents(world: WorldPack): number {
  let n = 0;
  walkPaths(world.entities, (p) => {
    if (p[p.length - 1]!.kind === "actor" && p.every((x) => x.visible !== false)) n++;
  });
  return n;
}

export interface LegendItem { label: string; color: string }

/** world.legend (viewer UI only), or null to hide the legend. */
export function legendOf(world: WorldPack): LegendItem[] | null {
  const l = (world as WorldPack & { legend?: LegendItem[] }).legend;
  return l && l.length ? l.slice(0, 8) : null;
}

/** Saved view (localStorage), validated: a bad or foreign value is ignored. */
export function parseSavedView(raw: string | null): { preset?: string; pose?: CameraPose } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { preset?: unknown; pose?: { position?: unknown; target?: unknown; fov?: unknown } };
    const vec = (x: unknown): x is V3 => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === "number" && Number.isFinite(n));
    const out: { preset?: string; pose?: CameraPose } = {};
    if (typeof v.preset === "string") out.preset = v.preset;
    if (v.pose && vec(v.pose.position) && vec(v.pose.target)) out.pose = { position: v.pose.position, target: v.pose.target, fov: typeof v.pose.fov === "number" && v.pose.fov >= 5 && v.pose.fov <= 120 ? v.pose.fov : 45 };
    return out.preset || out.pose ? out : null;
  } catch {
    return null;
  }
}

/** "Lumbridge — the town made of the stack" → name + tagline. */
export function splitTitle(title: string): { name: string; tagline: string } {
  const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(title);
  return m ? { name: m[1]!, tagline: m[2]! } : { name: title, tagline: "" };
}
