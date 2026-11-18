// In-memory TeraPage for tests: bridge semantics like the engine (ops, load/seek replay),
// no browser. PNGs are small images whose colour encodes the camera pose.
import type { TeraBridge } from "../../bridge/types.ts";
import type { CameraPose, CameraScript, Entity, Op, WorldPack } from "../../schema/index.ts";
import { evaluateCamera } from "../../camera/evaluate.ts";
import { blank, encodePng } from "../png.ts";
import type { OpenOptions, TeraPage } from "../page.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deepMerge } from "../validate.ts";
import { rows } from "../bounds.ts";

export interface MockPage extends TeraPage { calls: string[]; opts: OpenOptions; flat: boolean }

function find(list: Entity[], id: string): Entity | undefined {
  for (const e of list) {
    if (e.id === id) return e;
    if (e.kind === "group") { const f = find(e.children, id); if (f) return f; }
  }
}

export function mockOpen(state: { pages: MockPage[]; flat?: boolean } = { pages: [] }) {
  return async (opts: OpenOptions = {}): Promise<TeraPage> => {
    let world: WorldPack | null = null, loaded: WorldPack | null = null, script: CameraScript | null = null;
    let pose: CameraPose = { position: [0, 0, 5], target: [0, 0, 0] };
    let size: [number, number] = [opts.width ?? 1280, opts.height ?? 720];
    const calls: string[] = [];
    const applyOp = (op: Op) => {
      if (!world) throw new Error("no world loaded");
      if (op.op === "add") { if (find(world.entities, op.entity.id)) throw new Error(`id ${op.entity.id} already exists`); world.entities.push(structuredClone(op.entity)); }
      else if (op.op === "update") {
        const i = world.entities.findIndex((e) => e.id === op.id);
        if (i < 0) throw new Error(`no entity ${op.id}`);
        world.entities[i] = deepMerge(world.entities[i]!, op.set);
      } else if (op.op === "remove") {
        if (op.id === "engine-refuses") throw new Error("engine refused");
        if (!find(world.entities, op.id)) throw new Error(`no entity ${op.id}`);
        world.entities = world.entities.filter((e) => e.id !== op.id);
      } else if (op.op === "sky") world.sky = deepMerge(world.sky ?? {}, op.set) as WorldPack["sky"];
      else if (op.op === "env") world.environment = deepMerge(world.environment ?? {}, op.set);
    };
    const bridge: TeraBridge = {
      version: "bridge/v1",
      async load(w) { calls.push("load"); loaded = structuredClone(w); world = structuredClone(w); if (w.cameras?.default) pose = w.cameras.default; return { ok: true, warnings: [] }; },
      async apply(ops) {
        calls.push("apply");
        let applied = 0;
        try { for (const op of ops) { applyOp(op); applied++; } return { ok: true, applied }; }
        catch (e) { return { ok: false, applied, error: `op ${applied}: ${(e as Error).message}` }; }
      },
      async get() { if (!world) throw new Error("no world loaded"); return structuredClone(world); },
      async setCamera(p) { pose = p; },
      async setSize(w, h) { size = [w, h]; },
      async loadScript(s) { calls.push("loadScript"); script = s; size = [s.width, s.height]; return { ok: true, warnings: [] }; },
      async seek(t) {
        calls.push(`seek ${t}`);
        if (!script) throw new Error("no script loaded");
        world = structuredClone(loaded);
        for (const ev of script.events ?? []) if (ev.t <= t) ev.ops.forEach(applyOp);
        pose = evaluateCamera(script, t);
      },
      async render(p, w, h) {
        calls.push(w ? `render ${w}x${h}` : "render");
        if (!world) throw new Error("no world loaded");
        if (p) pose = p;
        if (w && h) size = [w, h];
      },
      async bounds(ids) {
        calls.push("bounds");
        if (!world) throw new Error("no world loaded");
        const all = new Map(rows(world.entities).map((r) => [r.id, r.bounds]));
        const out: Record<string, { min: [number, number, number]; max: [number, number, number] } | null> = {};
        for (const id of ids ?? all.keys()) {
          if (!all.has(id)) throw new Error(`bounds: no entity "${id}"`);
          // Pretend the engine measured models: a 1 m cube at the entity (tests check the overlay).
          const r = rows(world.entities).find((x) => x.id === id)!;
          out[id] = all.get(id) ?? (r.kind === "model" ? { min: [r.position[0] - 0.5, r.position[1], r.position[2] - 0.5], max: [r.position[0] + 0.5, r.position[1] + 1, r.position[2] + 0.5] } : null);
        }
        return out;
      },
      async capture() {
        const img = blank(size[0], size[1], [Math.abs(Math.round(pose.position[0] * 20)) % 256, 120, 80, 255]);
        if (!state.flat) for (let i = 0; i < img.data.length; i += 4 * 7) { img.data[i] = (i * 13) % 255; img.data[i + 1] = (i * 7) % 255; }
        return encodePng(img).toString("base64");
      },
      async info() { return { renderer: "webgl2", entities: world?.entities.length ?? 0, ready: !!world }; },
    };
    if (opts.worldDir) await bridge.load(JSON.parse(readFileSync(join(opts.worldDir, "world.json"), "utf8")));
    const page: MockPage = { bridge, calls, opts, flat: !!state.flat, png: async () => Buffer.from(await bridge.capture(), "base64"), close: async () => { calls.push("close"); } };
    state.pages.push(page);
    return page;
  };
}
