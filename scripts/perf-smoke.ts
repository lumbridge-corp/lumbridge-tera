// Live-viewer performance smoke: per named camera, the frame rate, GPU draw calls per frame
// and what the scene holds (meshes, distinct materials, shadow casters, shadow-casting lights).
// Fails when a camera goes over a draw-call budget or under an fps floor.
//
//   node scripts/perf-smoke.ts [--world <dir served at /world/>] [--url /world/<path of world.json>] [--cameras a,b,c] [--pose name=x,y,z:tx,ty,tz]
//       [--quality high,medium] [--renderer auto|webgpu|webgl2] [--size 1920x1080]
//       [--seconds 4] [--settle 2.5] [--calls <max draw calls>] [--fps <min fps>] [--json <out>] [--no-build]
//
// Default: the repo's living world, every camera it names, high + medium. fps is measured with
// the frame-rate limit off (--disable-frame-rate-limit, no vsync), so numbers above 60 are real.
// The fps floor is only checked when --fps is given (a shared GPU makes it noisy); draw calls are
// deterministic for a camera and checked against --calls (default 200 for the living world: about 130 batched, 300 without).
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const many = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));

const worldDir = resolve(opt("world", join(REPO_ROOT, "worlds", "living")));
const url = opt("url", "/world/world.json");
const custom = args.includes("--world");
const qualities = opt("quality", "high,medium").split(",");
const renderer = opt("renderer", "auto");
const [W, H] = opt("size", "1920x1080").split("x").map(Number) as [number, number];
const seconds = Number(opt("seconds", "4"));
const settle = Number(opt("settle", "2.5"));
const maxCalls = Number(opt("calls", custom ? "0" : "200"));
const minFps = Number(opt("fps", "0"));
const camerasOpt = opt("cameras", "");
const query = opt("query", ""); // extra viewer flags, e.g. batch=0
const poses = many("pose").map((p) => {
  const [name, rest] = p.split("=") as [string, string];
  const [a, b] = rest.split(":").map((s) => s.split(",").map(Number)) as [number[], number[]];
  return { name, position: a, target: b };
});

if (!args.includes("--no-build")) ensureBuilt();
const { server, origin } = await startStaticServer(worldDir);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [...chromeArgs(), "--disable-frame-rate-limit", "--disable-gpu-vsync", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});

/** Counts GPU draws (WebGL2 draw* and WebGPU render-pass draw*) per animation frame. */
const COUNTER = () => {
  const c = { draws: 0 };
  (window as unknown as { __teraDraws: typeof c }).__teraDraws = c;
  const wrap = (proto: object | undefined, names: string[]) => {
    if (!proto) return;
    for (const n of names) {
      const f = (proto as Record<string, unknown>)[n];
      if (typeof f !== "function") continue;
      (proto as Record<string, unknown>)[n] = function (this: unknown, ...a: unknown[]) {
        c.draws++;
        return (f as (...x: unknown[]) => unknown).apply(this, a);
      };
    }
  };
  const g = globalThis as unknown as Record<string, { prototype: object } | undefined>;
  wrap(g.WebGL2RenderingContext?.prototype, ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
  wrap(g.GPURenderPassEncoder?.prototype, ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
  wrap(g.GPURenderBundleEncoder?.prototype, ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
};

interface Row { quality: string; camera: string; backend: string; fps: number; p95ms: number; calls: number; meshes: number; instanced: number; materials: number; casters: number; shadowLights: string; triangles: number; batches: string; dpr: number }

async function measure(page: Page, camera: string): Promise<Row> {
  await page.waitForTimeout(settle * 1000);
  return page.evaluate(async (secs) => {
    const w = window as unknown as { __teraDraws: { draws: number }; teraEngine: any; teraViewer: any };
    const e = w.teraEngine;
    const dts: number[] = [];
    const calls: number[] = [];
    let last = performance.now(), lastDraws = w.__teraDraws.draws;
    await new Promise<void>((done) => {
      const t0 = last;
      const tick = () => {
        const now = performance.now();
        dts.push(now - last);
        calls.push(w.__teraDraws.draws - lastDraws);
        last = now;
        lastDraws = w.__teraDraws.draws;
        if (now - t0 < secs * 1000) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    dts.shift(); calls.shift();
    const sorted = [...dts].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1]!;
    const callsSorted = [...calls].sort((a, b) => a - b);
    let meshes = 0, instanced = 0, casters = 0, triangles = 0;
    const mats = new Set<unknown>();
    const shadowLights: string[] = [];
    e.scene.traverseVisible((o: any) => {
      if (o.isLight && o.castShadow) shadowLights.push(`${o.type.replace("Light", "")}${o.shadow?.mapSize?.x ?? ""}`);
      if (!o.isMesh || (o.layers.mask & 1) === 0) return; // not drawn (batched originals)
      meshes++;
      if (o.isInstancedMesh) instanced++;
      if (o.castShadow) casters++;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
      const g = o.geometry;
      const n = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
      triangles += n * (o.isInstancedMesh ? o.count : 1);
    });
    const counts: Record<string, number> = {};
    for (const s of shadowLights) counts[s] = (counts[s] ?? 0) + 1;
    return {
      fps: Math.round(10000 / med) / 10,
      p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10,
      calls: callsSorted[callsSorted.length >> 1]!,
      meshes, instanced, materials: mats.size, casters,
      shadowLights: Object.entries(counts).map(([k, v]) => `${v}x${k}`).join(" ") || "-",
      triangles: Math.round(triangles),
      backend: e.backend,
      batches: e.batcher ? `${e.batcher.stats().batches}/${e.batcher.stats().members}` : "-",
      dpr: e.handle?.renderer?.getPixelRatio?.() ?? 0,
    };
  }, seconds).then((r) => ({ quality: "", camera, ...r }) as Row);
}

const rows: Row[] = [];
const load0 = loadavg()[0]!;
for (const quality of qualities) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  await ctx.addInitScript(COUNTER);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${origin}/?world=${encodeURIComponent(url)}&quality=${quality}&renderer=${renderer}&idle=100000${query ? "&" + query : ""}`);
  await page.waitForFunction(() => (window as any).teraViewer?.state().firstLoaded, undefined, { timeout: 120_000 });
  const presets: string[] = await page.evaluate(() => (window as any).teraViewer.state().presets);
  const cams = camerasOpt ? camerasOpt.split(",").filter(Boolean) : presets;
  for (const cam of cams) {
    if (!presets.includes(cam)) {
      console.log(`  (no camera "${cam}" in this world, skipped)`);
      continue;
    }
    await page.evaluate((c) => (window as any).teraViewer.selectPreset(c, false), cam);
    rows.push({ ...(await measure(page, cam)), quality });
  }
  if (quality === qualities[0] && !query.includes("batch=0")) {
    // batching must survive a reload (a live snapshot) and let a live op reach a batched entity
    const check = await page.evaluate(async () => {
      const e = (window as any).teraEngine;
      if (!e.batcher) return "no batcher";
      await e.load(e.get());
      const st = e.batcher.stats();
      if (!st.members) return `after a reload nothing is batched (${JSON.stringify(st)})`;
      const id = [...e.batcher.members.values()].find((m: any) => m.part === m.id)?.id;
      if (!id) return null;
      const ent = await e.apply([{ op: "update", id, set: { material: { color: "#ff00ff" } } }]);
      const n = e.nodes.get(id);
      if (!ent?.ok || !n || (n.obj.layers.mask & 1) === 0 || n.obj.material.color.getHexString() !== "ff00ff") return `an update op on batched "${id}" did not reach the screen`;
      return null;
    });
    if (check) {
      console.log(`FAIL live ops: ${check}`);
      process.exitCode = 1;
    } else console.log("PASS reload keeps batching; an update op on a batched entity draws on its own");
  }
  for (const p of poses) {
    await page.evaluate((pp) => (window as any).teraEngine.setPose(pp), { position: p.position, target: p.target, fov: 45 });
    rows.push({ ...(await measure(page, p.name)), quality });
  }
  await ctx.close();
}
await browser.close();
server.close();

const load1 = loadavg()[0]!;
console.log(`perf smoke: ${W}x${H}, renderer ${renderer}, load avg ${load0.toFixed(2)} → ${load1.toFixed(2)} (${cpus().length} cpus)`);
console.log(["quality", "camera", "backend", "fps", "p95 ms", "calls", "meshes", "inst", "mats", "casters", "shadow lights", "tris", "batches"].join("\t"));
let failed = 0;
for (const r of rows) {
  const bad: string[] = [];
  if (maxCalls && r.calls > maxCalls) bad.push(`calls ${r.calls} > ${maxCalls}`);
  if (minFps && r.fps < minFps) bad.push(`fps ${r.fps} < ${minFps}`);
  if (bad.length) failed++;
  console.log([r.quality, r.camera, r.backend, r.fps, r.p95ms, r.calls, r.meshes, r.instanced, r.materials, r.casters, r.shadowLights, r.triangles, r.batches].join("\t") + (bad.length ? `\tOVER BUDGET: ${bad.join(", ")}` : ""));
}
const out = opt("json", "");
if (out) writeFileSync(out, JSON.stringify({ size: [W, H], renderer, load: [load0, load1], rows }, null, 2));
if (failed) {
  console.log(`\n${failed} camera(s) over budget`);
  process.exitCode = 1;
} else console.log(`\nperf budget ok${maxCalls ? ` (≤ ${maxCalls} draw calls${minFps ? `, ≥ ${minFps} fps` : ""})` : ""}`);
