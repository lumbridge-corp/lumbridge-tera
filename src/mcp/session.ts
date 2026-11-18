// One MCP session = one open world in one headless engine page (started lazily).
// The world folder on disk is kept in step with the page: every successful
// scene_apply is saved to world.json, so render and other tools always see it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type CameraPose, type CameraScript, type Entity, type Vec3, WorldPack } from "../schema/index.ts";
import { fmt, fmtV, rows, sceneBounds, type Box, type Row } from "./bounds.ts";
import { contactSheet, imageStats } from "./png.ts";
import { guardPath, worldsRoot } from "./paths.ts";
import { openTera, worldBase, type OpenTera, type TeraPage } from "./page.ts";
import { render as renderVideo, type RenderResult } from "../render/render.ts";
import { createWorld, type Template } from "./templates.ts";
import { checkOps, checkScript, formatZod, indexEntities, type ScriptCheck } from "./validate.ts";

export type View = "front" | "back" | "left" | "right" | "top" | "iso";
export type CameraArg = string | CameraPose | { focus: string | string[]; view?: View; fov?: number };

export interface SessionOptions {
  root?: string;
  openPage?: OpenTera;
  autosave?: boolean;
  /** Start the engine page as soon as a world opens (default true). */
  prewarm?: boolean;
  /** Render implementation (tests inject a fake). */
  render?: typeof renderVideo;
}

export class ToolError extends Error {}

const r2 = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1000) / 1000) as Vec3;

export class Session {
  readonly root: string;
  worldDir: string | null = null;
  private tp: TeraPage | null = null;
  private starting: Promise<TeraPage> | null = null;
  private base: WorldPack | null = null; // what the page's loadedWorld is (seek replays from it)
  private pageWorldStale = false; // page world differs from `base` (ops applied or script events ran)
  private pose: CameraPose | null = null;
  private readonly open: OpenTera;
  private readonly autosave: boolean;
  private readonly prewarm: boolean;
  private readonly renderFn?: typeof renderVideo;

  constructor(opts: SessionOptions = {}) {
    this.root = opts.root ?? worldsRoot();
    this.open = opts.openPage ?? openTera;
    this.autosave = opts.autosave ?? process.env.TERA_AUTOSAVE !== "0";
    this.prewarm = opts.prewarm ?? true;
    this.renderFn = opts.render;
  }

  // ------------------------------------------------------------ worlds

  listWorlds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, "world.json")))
      .map((d) => d.name);
  }

  requireWorld(): string {
    if (!this.worldDir) {
      const have = this.listWorlds();
      throw new ToolError(`No world is open. Call world_new { id, title, template } or world_open { path }.${have.length ? ` Worlds in ${this.root}: ${have.join(", ")}` : ""}`);
    }
    return this.worldDir;
  }

  rel(p: string): string {
    return relative(this.root, p) || ".";
  }

  async newWorld(id: string, title: string, template: Template): Promise<WorldPack> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ToolError(`id "${id}" must be lowercase letters, digits and dashes, e.g. "desk-scene"`);
    const dir = guardPath(this.root, id);
    const w = createWorld(dir, id, title, template);
    await this.switchTo(dir);
    return w;
  }

  async openWorld(path: string): Promise<WorldPack> {
    let dir = guardPath(this.root, path);
    if (basename(dir) === "world.json") dir = dirname(dir);
    const file = join(dir, "world.json");
    if (!existsSync(file)) throw new ToolError(`no world.json in ${this.rel(dir)}. Worlds here: ${this.listWorlds().join(", ") || "(none)"}`);
    const w = this.readWorldFile(file);
    await this.switchTo(dir);
    return w;
  }

  private readWorldFile(file: string): WorldPack {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ToolError(`${file} is not valid JSON: ${(e as Error).message}`); }
    const r = WorldPack.safeParse(raw);
    if (!r.success) throw new ToolError(`${file} is not a valid world/v1:\n${formatZod(r.error).join("\n")}`);
    return r.data;
  }

  private async switchTo(dir: string) {
    if (this.starting) await this.starting.catch(() => {});
    await this.closePage();
    this.worldDir = dir;
    this.pose = null;
    // Warm the engine page in the background so the first snapshot/apply is quick.
    if (this.prewarm) void this.page().catch(() => {});
  }

  /** Current world: from the page when running, else from disk. */
  async world(): Promise<WorldPack> {
    const dir = this.requireWorld();
    if (!this.tp) return this.readWorldFile(join(dir, "world.json"));
    await this.restoreIfStale();
    return this.tp.bridge.get();
  }

  async save(path?: string): Promise<string> {
    const dir = this.requireWorld();
    const w = await this.world();
    if (!path) {
      writeFileSync(join(dir, "world.json"), JSON.stringify(w, null, 2) + "\n");
      return dir;
    }
    let to = guardPath(this.root, path);
    if (basename(to) === "world.json") to = dirname(to);
    if (existsSync(join(to, "world.json")) && to !== dir) throw new ToolError(`${this.rel(to)} already has a world.json; pick a new folder`);
    mkdirSync(to, { recursive: true });
    const assets = join(dir, "assets");
    if (existsSync(assets) && to !== dir) cpSync(assets, join(to, "assets"), { recursive: true });
    writeFileSync(join(to, "world.json"), JSON.stringify(w, null, 2) + "\n");
    // Save-as switches the session to the new folder (the page keeps its state).
    this.worldDir = to;
    if (this.tp) await this.closePage();
    return to;
  }

  // ------------------------------------------------------------ page

  async page(): Promise<TeraPage> {
    const dir = this.requireWorld();
    if (this.tp) return this.tp;
    if (!this.starting) {
      this.starting = (async () => {
        const tp = await this.open({ worldDir: dir, width: 1024, height: 576, mode: "render" });
        this.tp = tp;
        this.base = await tp.bridge.get();
        this.pageWorldStale = false;
        return tp;
      })().finally(() => (this.starting = null));
    }
    return this.starting;
  }

  async closePage() {
    const tp = this.tp;
    this.tp = null;
    this.base = null;
    if (tp) await tp.close().catch(() => {});
  }

  /** After script playback the page holds event-mutated state; put the world back. */
  private async restoreIfStale() {
    if (this.tp && this.pageWorldStale && this.base) {
      await this.tp.bridge.load(this.base, worldBase(this.tp));
      this.pageWorldStale = false;
    }
  }

  /** Make the page's loaded world (what seek replays from) equal the current world. */
  private async syncBase(tp: TeraPage) {
    const cur = await tp.bridge.get();
    if (JSON.stringify(cur) !== JSON.stringify(this.base)) {
      await tp.bridge.load(cur, worldBase(tp));
      this.base = cur;
    }
    this.pageWorldStale = false;
  }

  // ------------------------------------------------------------ ops

  async apply(rawOps: unknown): Promise<{ ok: boolean; applied: number; total: number; error?: string; diff: string; validation?: string[] }> {
    const tp = await this.page();
    await this.restoreIfStale();
    const before = await tp.bridge.get();
    const check = checkOps(rawOps, before);
    const total = Array.isArray(rawOps) ? rawOps.length : 0;
    if (!check.ok) {
      return { ok: false, applied: 0, total, diff: "", validation: check.errors.flatMap((e) => e.messages) };
    }
    const res = await tp.bridge.apply(check.ops);
    const after = await tp.bridge.get();
    if (res.applied > 0 && this.autosave) writeFileSync(join(this.requireWorld(), "world.json"), JSON.stringify(after, null, 2) + "\n");
    return { ok: res.ok, applied: res.applied, total, error: res.error, diff: diffWorlds(before, after) };
  }

  /**
   * Rows with the engine's real world-space boxes (models, splats, text included) when
   * the page runs; falls back to the JSON estimate (exact for primitives) when it cannot.
   */
  async rowsOf(w: WorldPack): Promise<Row[]> {
    const all = rows(w.entities);
    try {
      const tp = await this.page();
      const boxes = await tp.bridge.bounds();
      for (const r of all) {
        const b = boxes[r.id];
        if (b) r.bounds = { min: b.min, max: b.max };
      }
    } catch { /* engine unavailable: JSON bounds */ }
    return all;
  }

  async find(q: { query?: string; tag?: string; kind?: string }): Promise<{ rows: Row[]; total: number }> {
    const w = await this.world();
    const all = await this.rowsOf(w);
    const query = q.query?.toLowerCase();
    // Query matches id/detail/tags; a matching group brings its descendants. Then kind/tag filter.
    const matched = new Set<string>();
    for (const r of all) {
      const self = !query || r.id.toLowerCase().includes(query) || r.detail.toLowerCase().includes(query) || r.tags?.some((t) => t.toLowerCase().includes(query));
      if (self || (r.parent && matched.has(r.parent))) matched.add(r.id);
    }
    const hit = all.filter((r) => matched.has(r.id) && (!q.kind || r.kind === q.kind) && (!q.tag || r.tags?.includes(q.tag)));
    return { rows: hit, total: all.length };
  }

  // ------------------------------------------------------------ camera + snapshot

  async resolveCamera(arg: CameraArg | undefined, world: WorldPack): Promise<{ pose: CameraPose; label: string }> {
    if (arg === undefined) {
      if (this.pose) return { pose: this.pose, label: "live camera" };
      if (world.cameras?.default) return { pose: world.cameras.default, label: "camera default" };
      return { pose: frame(world.entities, null, "iso", undefined, await this.rowsOf(world)), label: "auto framing" };
    }
    if (typeof arg === "string") {
      if (arg === "auto") return { pose: frame(world.entities, null, "iso", undefined, await this.rowsOf(world)), label: "auto framing (all objects)" };
      const c = world.cameras?.[arg];
      if (!c) throw new ToolError(`no camera "${arg}". Named cameras: ${Object.keys(world.cameras ?? {}).join(", ") || "(none)"}; or pass "auto", a pose {position, target, fov}, or {focus: "<entity id>", view}`);
      return { pose: c, label: `camera ${arg}` };
    }
    if ("focus" in arg) {
      const ids = Array.isArray(arg.focus) ? arg.focus : [arg.focus];
      const all = indexEntities(world.entities);
      const missing = ids.filter((i) => !all.has(i));
      if (missing.length) throw new ToolError(`focus: no entity ${missing.map((m) => `"${m}"`).join(", ")}`);
      return { pose: frame(world.entities, new Set(ids), arg.view ?? "iso", arg.fov, await this.rowsOf(world)), label: `focus ${ids.join("+")} (${arg.view ?? "iso"})` };
    }
    return { pose: arg, label: "pose" };
  }

  async setCamera(pose: CameraPose, saveAs?: string): Promise<void> {
    this.pose = pose;
    if (saveAs) {
      const tp = await this.page();
      await this.restoreIfStale();
      const w = await tp.bridge.get();
      w.cameras = { ...(w.cameras ?? {}), [saveAs]: pose };
      await tp.bridge.load(w, worldBase(tp));
      this.base = w;
      if (this.autosave) writeFileSync(join(this.requireWorld(), "world.json"), JSON.stringify(w, null, 2) + "\n");
    }
  }

  async snapshot(o: { width?: number; height?: number; camera?: CameraArg }): Promise<{ png: Buffer; text: string }> {
    const tp = await this.page();
    await this.restoreIfStale();
    const world = await tp.bridge.get();
    const width = even(o.width ?? 1024), height = even(o.height ?? 576);
    const { pose, label } = await this.resolveCamera(o.camera, world);
    // Draw the edited world as it is now: no reload, no one-frame script.
    await tp.bridge.render(pose, width, height);
    const png = await tp.png();
    const info = await tp.bridge.info();
    let text = `${label}: position ${fmtV(pose.position)} target ${fmtV(pose.target)} fov ${pose.fov ?? 45} · ${countEntities(world.entities)} entities · ${info.renderer} · ${width}x${height}`;
    try {
      const st = imageStats(png);
      if (st.std < 4 || st.distinct < 6) text += `\nWARNING: the image is almost one flat colour — the camera may be inside an object, too close, or facing away from the scene. Try camera "auto" or {focus: "<id>"}.`;
    } catch { /* stats are a hint only */ }
    return { png, text };
  }

  // ------------------------------------------------------------ scripts

  readScriptArg(script: unknown): unknown {
    if (typeof script !== "string") return script;
    const file = guardPath(this.root, script, this.requireWorld());
    if (!existsSync(file)) throw new ToolError(`no script file ${this.rel(file)}`);
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ToolError(`${script} is not valid JSON: ${(e as Error).message}`); }
  }

  async validateScript(script: unknown): Promise<ScriptCheck> {
    const dir = this.requireWorld();
    const world = await this.world();
    return checkScript(this.readScriptArg(script), world, (rel) => {
      if (/^https?:\/\//.test(rel)) return true;
      try { return existsSync(guardPath(this.root, rel, dir)); } catch { return false; }
    });
  }

  private async scriptOrThrow(script: unknown): Promise<CameraScript> {
    const c = await this.validateScript(script);
    if (!c.ok || !c.script) throw new ToolError(`script is not valid:\n${c.errors.join("\n")}`);
    return c.script;
  }

  async preview(script: unknown, times: number[] | undefined, thumbWidth = 480): Promise<{ png: Buffer; text: string }> {
    const s = await this.scriptOrThrow(script);
    const ts = (times?.length ? times : spread(s.duration, 6)).map((t) => Math.min(Math.max(0, t), s.duration));
    if (ts.length > 16) throw new ToolError("at most 16 times per contact sheet");
    const tp = await this.page();
    await this.restoreIfStale();
    await this.syncBase(tp);
    const w = even(Math.min(thumbWidth, s.width)), h = even(Math.round((w * s.height) / s.width));
    await tp.bridge.loadScript({ ...s, width: w, height: h });
    this.pageWorldStale = true;
    const frames: { png: Buffer; label: string }[] = [];
    try {
      for (const t of ts) {
        await tp.bridge.seek(t);
        frames.push({ png: await tp.png(), label: `t=${fmt(t)}s` });
      }
    } finally {
      await this.restoreIfStale();
    }
    const shotAt = (t: number) => s.shots.find((x) => t >= x.start && t <= x.end)?.id ?? "(hold)";
    const text = `contact sheet: ${ts.length} frames at ${w}x${h}, left→right, top→bottom\n` + ts.map((t) => `t=${fmt(t)}s shot ${shotAt(t)}`).join("\n");
    return { png: contactSheet(frames), text };
  }

  /** Render with the render host's frame-exact pipeline. It reads world.json from disk. */
  async render(o: { script: unknown; out?: string; size?: string; fps?: number; from?: number; to?: number; onProgress?: (done: number, total: number) => void }): Promise<RenderResult> {
    const dir = this.requireWorld();
    const s = await this.scriptOrThrow(o.script);
    let width: number | undefined, height: number | undefined;
    if (o.size) {
      const m = /^(\d+)x(\d+)$/.exec(o.size.trim());
      if (!m) throw new ToolError(`size must look like 1920x1080 (got "${o.size}")`);
      width = even(+m[1]!); height = even(+m[2]!);
    }
    const name = o.out ?? `renders/${typeof o.script === "string" ? basename(o.script).replace(/(\.camera)?\.json$/, "") : "render"}.mp4`;
    const out = guardPath(this.root, name.endsWith(".mp4") ? name : `${name}.mp4`, dir);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out.replace(/\.mp4$/, ".camera.json"), JSON.stringify({ ...s, ...(width ? { width, height } : {}), ...(o.fps ? { fps: o.fps } : {}) }, null, 2) + "\n");
    // The renderer loads world.json; make sure it holds the current world.
    if (this.tp) writeFileSync(join(dir, "world.json"), JSON.stringify(await this.world(), null, 2) + "\n");
    return (this.renderFn ?? renderVideo)({ worldDir: dir, script: s, out, width, height, fps: o.fps, from: o.from, to: o.to, onProgress: (p) => o.onProgress?.(p.done, p.total) });
  }

  async close() {
    if (this.starting) await this.starting.catch(() => {});
    await this.closePage();
  }
}

// ---------------------------------------------------------------- helpers

function even(n: number): number {
  const v = Math.max(16, Math.min(4096, Math.round(n)));
  return v % 2 ? v + 1 : v;
}

function spread(duration: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => +((duration * i) / (n - 1)).toFixed(3));
}

export function countEntities(list: Entity[]): number {
  return list.reduce((n, e) => n + 1 + (e.kind === "group" ? countEntities(e.children) : 0), 0);
}

const DIRS: Record<View, Vec3> = {
  front: [0, 0.25, 1], back: [0, 0.25, -1], left: [-1, 0.25, 0], right: [1, 0.25, 0], top: [0, 1, 0.001], iso: [0.75, 0.55, 1],
};

/** A pose that fits the bounds of `ids` (or every solid object) in view. */
export function frame(entities: Entity[], ids: Set<string> | null, view: View, fov = 40, all: Row[] = rows(entities)): CameraPose {
  let b: Box | null = null;
  if (ids) {
    for (const r of all) if (ids.has(r.id)) {
      const rb = r.bounds ?? { min: [r.position[0] - 0.5, r.position[1] - 0.5, r.position[2] - 0.5], max: [r.position[0] + 0.5, r.position[1] + 0.5, r.position[2] + 0.5] };
      b = b ? { min: rb.min.map((v, i) => Math.min(v, b!.min[i]!)) as Vec3, max: rb.max.map((v, i) => Math.max(v, b!.max[i]!)) as Vec3 } : rb;
    }
  } else b = sceneBounds(entities, { skipGround: true, rows: all });
  if (!b) b = { min: [-1, 0, -1], max: [1, 1, 1] };
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const radius = Math.max(0.15, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
  const dist = (radius / Math.sin(((fov / 2) * Math.PI) / 180)) * 1.05;
  const d = DIRS[view];
  const len = Math.hypot(...d);
  return { position: r2([c[0] + (d[0] / len) * dist, c[1] + (d[1] / len) * dist, c[2] + (d[2] / len) * dist]), target: r2(c), fov };
}

/** One line: +added ~changed(fields) -removed, plus sky/env/camera changes. */
export function diffWorlds(a: WorldPack, b: WorldPack): string {
  const ia = indexEntities(a.entities), ib = indexEntities(b.entities);
  const parts: string[] = [];
  for (const [id, e] of ib) if (!ia.has(id)) parts.push(`+${id}(${e.kind}${e.kind === "primitive" ? " " + e.shape : ""})`);
  for (const [id, e] of ib) {
    const old = ia.get(id);
    if (!old || JSON.stringify(old) === JSON.stringify(e)) continue;
    const keys = new Set([...Object.keys(old), ...Object.keys(e)]);
    const changed = [...keys].filter((k) => k !== "children" && JSON.stringify((old as Record<string, unknown>)[k]) !== JSON.stringify((e as Record<string, unknown>)[k]));
    if (!changed.length) continue;
    const pos = changed.includes("transform") ? ` → pos ${fmtV(e.transform?.position ?? [0, 0, 0])}` : "";
    parts.push(`~${id}(${changed.join(",")}${pos})`);
  }
  for (const id of ia.keys()) if (!ib.has(id)) parts.push(`-${id}`);
  if (JSON.stringify(a.sky) !== JSON.stringify(b.sky)) parts.push("sky changed");
  if (JSON.stringify(a.environment) !== JSON.stringify(b.environment)) parts.push("environment changed");
  return parts.length ? parts.join(" ") : "no visible change";
}
