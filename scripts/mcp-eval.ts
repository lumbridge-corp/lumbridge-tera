// tera-mcp smoke eval: drives the real server over stdio with the official MCP client
// (no LLM) and asserts each step. See scripts/mcp-eval.md.
//   node scripts/mcp-eval.ts [--keep] [--out dir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockWorker } from "../src/mcp/testing/mock-gen-worker.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : join(repo, "out", "mcp-eval");
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "tera-eval-"));
const worker = await startMockWorker(0, 2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "src/mcp/server.ts")],
  env: { ...(process.env as Record<string, string>), TERA_WORLDS: root, TERA_GEN_URL: worker.url },
  stderr: "inherit",
});
const client = new Client({ name: "tera-eval", version: "0.0.1" });
await client.connect(transport);

let step = 0;
const results: { step: string; ms: number; ok: boolean; note?: string }[] = [];
async function call(name: string, a: Record<string, unknown> = {}, expectError = false): Promise<CallToolResult> {
  const t0 = Date.now();
  const label = `${++step}. ${name}`;
  const r = (await client.callTool({ name, arguments: a }, undefined, { timeout: 600_000 })) as CallToolResult;
  const txt = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  const ok = expectError ? r.isError === true : !r.isError;
  results.push({ step: label, ms: Date.now() - t0, ok, note: txt.split("\n")[0]?.slice(0, 110) });
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (${Date.now() - t0} ms)\n     ${txt.split("\n").slice(0, 3).join("\n     ")}`);
  assert.ok(ok, `${label}: ${txt}`);
  return r;
}
const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
function savePng(r: CallToolResult, name: string) {
  const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
  assert.ok(img, "no image content");
  assert.equal(img.mimeType, "image/png");
  const buf = Buffer.from(img.data, "base64");
  assert.ok(buf.subarray(1, 4).toString() === "PNG", "not a PNG");
  writeFileSync(join(outDir, name), buf);
  return buf;
}

try {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  const want = ["asset_import", "camera_set", "gen_model", "gen_splat", "render", "scene_apply", "scene_find", "script_preview", "script_validate", "snapshot", "world_get", "world_new", "world_open", "world_save"];
  assert.deepEqual(names, want);
  console.log(`PASS tools/list: ${names.length} tools`);

  await call("world_new", { id: "eval-studio", title: "Eval studio", template: "studio" });
  const applied = await call("scene_apply", {
    ops: [
      { op: "add", entity: { id: "plinth", kind: "primitive", shape: "box", size: [1.2, 0.4, 0.8], transform: { position: [0, 0.2, 0] }, material: { color: "#30343c", roughness: 0.5 } } },
      { op: "add", entity: { id: "orb", kind: "primitive", shape: "sphere", size: [0.25], transform: { position: [-0.25, 0.65, 0] }, material: { color: "#ff7a45", roughness: 0.3 } } },
      { op: "add", entity: { id: "ring", kind: "primitive", shape: "torus", size: [0.18, 0.05], transform: { position: [0.3, 0.63, 0], rotation: [0, 30, 0] }, material: { color: "#7fb3ff", metalness: 0.6, roughness: 0.25 } } },
    ],
  });
  assert.match(textOf(applied), /Applied 3\/3 ops\. \+plinth\(primitive box\) \+orb\(primitive sphere\) \+ring\(primitive torus\)/);

  // a bad batch is rejected whole, with exact indices and hints
  const bad = await call("scene_apply", { ops: [
    { op: "update", id: "orb", set: { material: { color: "#00ff00" } } },
    { op: "add", entity: { id: "cube", kind: "primitive", shape: "box", position: [0, 1, 0] } },
    { op: "remove", id: "nope" },
  ] }, true);
  assert.match(textOf(bad), /ops\[1\]\.entity\.position: unknown field — put it in transform\.position/);
  assert.match(textOf(bad), /ops\[2\]\.id: no entity "nope"/);

  // rotation-only update keeps the position (deep merge), whatever the engine's merge does
  const rot = await call("scene_apply", { ops: [{ op: "update", id: "ring", set: { transform: { rotation: [0, 45, 0] } } }] });
  assert.match(textOf(rot), /~ring\(transform → pos \[0\.3, 0\.63, 0\]\)/);

  const found = await call("scene_find", { kind: "primitive" });
  assert.match(textOf(found), /plinth primitive box .* bounds \[-0\.6, 0, -0\.4\]\.\.\[0\.6, 0\.4, 0\.4\]/);

  const snap = await call("snapshot", {});
  const png = savePng(snap, "01-studio-default.png");
  assert.ok(png.length > 5000, "snapshot suspiciously small");
  assert.match(textOf(snap), /camera default: position .* entities · (webgl2|webgpu) · 1024x576/);
  savePng(await call("snapshot", { camera: { focus: "ring", view: "front" }, width: 640, height: 360 }), "02-focus-ring.png");

  const script = {
    tera: "camera/v1", world: "eval-studio", fps: 30, width: 640, height: 360, duration: 2,
    shots: [{ id: "orbit", start: 0, end: 2, kind: "orbit", center: [0, 0.5, 0], radius: 2.6, height: 0.9, fromDeg: 60, toDeg: 120, fov: 35, ease: "inOutSine" }],
    events: [{ t: 1, ops: [{ op: "update", id: "orb", set: { material: { color: "#45d483" } } }] }],
  };
  const v = await call("script_validate", { script });
  assert.match(textOf(v), /^Valid: 2s, 1 shot/);
  const badScript = await call("script_validate", { script: { ...script, width: 641, shots: [{ ...script.shots[0], kind: "spiral" }] } }, true);
  assert.match(textOf(badScript), /script\.shots\[0\]\.kind: must be one of "keys", "orbit"/);

  savePng(await call("script_preview", { script, times: [0, 0.5, 1, 1.5, 2] }), "03-contact-sheet.png");

  // events must not leak into the saved world
  const after = JSON.parse(textOf(await call("world_get")));
  assert.equal(after.entities.find((e: { id: string }) => e.id === "orb").material.color, "#ff7a45");

  const rendered = await call("render", { script, out: "renders/eval.mp4" });
  const mp4 = join(root, "eval-studio", "renders", "eval.mp4");
  assert.ok(existsSync(mp4) && statSync(mp4).size > 1000, "mp4 missing");
  assert.match(textOf(rendered), /60 frames at 640x360 @ 30 fps/);
  try {
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,pix_fmt", "-of", "csv=p=0", mp4]).toString().trim();
    assert.equal(probe, "640,360,yuv420p,60");
    console.log(`PASS ffprobe ${probe}`);
  } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
  writeFileSync(join(outDir, "eval.mp4"), readFileSync(mp4));

  // assets + gen (mock worker)
  const pngPath = join(outDir, "01-studio-default.png");
  const imp = await call("asset_import", { src: pngPath, as: "ref.png" });
  assert.match(textOf(imp), /Imported: assets\/ref\.png/);
  await call("asset_import", { src: "/etc/passwd" }, true);
  const gen = await call("gen_model", { image: "assets/ref.png", id: "gen-thing", add: true, position: [0, 0.4, 0.6] });
  assert.match(textOf(gen), /→ assets\/gen-thing\.glb[\s\S]*Added entity "gen-thing"/);
  await call("world_open", { path: "../outside" }, true);

  // living world: a path, a street graph, a robot walking A → B, a flow in a glass pipe, a meter
  await call("world_new", { id: "eval-living", title: "Eval living" });
  const liv = await call("scene_apply", { ops: [
    { op: "path", set: { id: "pipe", points: [[-3, 0.6, -2], [3, 0.6, -2]] } },
    { op: "graph", nodes: [{ id: "a", position: [-3, 0, 1] }, { id: "b", position: [3, 0, 1] }, { id: "c", position: [0, 0, 3] }], edges: [["a", "c"], ["c", "b"]] },
    { op: "add", entity: { id: "bot", kind: "actor", label: "eval-bot", state: "working", transform: { position: [-3, 0, 1] }, move: { to: "b", speed: 1.5 } } },
    { op: "add", entity: { id: "stream", kind: "flow", path: "pipe", rate: 4, speed: 3, color: "#9dff3a", style: "comet", pipe: true } },
    { op: "add", entity: { id: "load", kind: "meter", value: 0.7, transform: { position: [0, 1.5, -2] } } },
  ] });
  assert.match(textOf(liv), /Applied 5\/5 ops/);
  const badRef = await call("scene_apply", { ops: [{ op: "add", entity: { id: "lost", kind: "actor", move: { to: "nowhere" } } }] }, true);
  assert.match(textOf(badRef), /no graph node "nowhere"/);
  assert.match(textOf(await call("scene_find", { kind: "actor" })), /bot actor worker "eval-bot" move to b working/);
  savePng(await call("snapshot", { camera: { position: [0, 3, 8], target: [0, 0.6, 0], fov: 45 } }), "05-living.png");

  // polish: a repeat shelf (one entity), glass, an arch, a capsule, tilt-shift DOF; a bad repeat template is explained
  const pol = await call("scene_apply", { ops: [
    { op: "add", entity: { id: "books", kind: "repeat", transform: { position: [-1, 0.15, -1] }, count: [30, 2, 1], step: [0.06, 0.35, 0],
      of: { kind: "primitive", shape: "box", size: [0.05, 0.3, 0.2], material: { color: "#b0603a" } }, jitter: { seed: 2, scale: 0.1, color: 0.8 } } },
    { op: "add", entity: { id: "pane", kind: "primitive", shape: "box", size: [2, 1.2, 0.03], transform: { position: [0, 0.6, -0.5] }, material: { glass: true } } },
    { op: "add", entity: { id: "arch", kind: "primitive", shape: "cylinder", size: [0.8, 0.2], inner: 0.6, arc: { start: -90, length: 180 }, transform: { position: [1.5, 0, 0], rotation: [-90, 0, 0] } } },
    { op: "add", entity: { id: "pill", kind: "primitive", shape: "capsule", size: [0.2, 0.8], transform: { position: [-1.8, 0.4, 0.5] } } },
    { op: "env", set: { post: { dof: { mode: "tiltshift", center: 0.55, band: 0.25 }, bloom: { strength: 0.5 } } } },
  ] });
  assert.match(textOf(pol), /Applied 5\/5 ops/);
  assert.match(textOf(await call("scene_find", { kind: "repeat" })), /books repeat 60 × primitive box/);
  const badRep = await call("scene_apply", { ops: [{ op: "add", entity: { id: "lamps", kind: "repeat", count: 3, step: [1, 0, 0], of: { kind: "light", light: "point" } } }] }, true);
  assert.match(textOf(badRep), /repeat cannot copy a light/);
  savePng(await call("snapshot", { camera: { position: [0, 2.2, 4.5], target: [0, 0.5, -0.5], fov: 45 } }), "06-polish.png");

  console.log(`\nALL PASS (${results.length} tool calls). Images in ${outDir}`);
} finally {
  await client.close().catch(() => {});
  await worker.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`worlds kept in ${root}`);
}
