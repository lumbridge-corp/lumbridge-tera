// Tools end to end over the MCP protocol (in-memory transport, mock engine page, mock gen worker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Session } from "./session.ts";
import { createServer } from "./tools.ts";
import { mockOpen, type MockPage } from "./testing/mock-page.ts";
import { startMockWorker } from "./testing/mock-gen-worker.ts";
import { encodePng, blank } from "./png.ts";

async function setup(opts: { genUrl?: string; flat?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tera-mcp-srv-")));
  const state: { pages: MockPage[]; flat?: boolean } = { pages: [], flat: opts.flat };
  const session = new Session({ root, openPage: mockOpen(state) });
  const server = createServer(session, { genUrl: opts.genUrl, genPollMs: 5 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const txt = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  return { root, state, session, call, txt, close: async () => { await client.close(); await session.close(); } };
}

test("no world open → helpful error; world_new templates; path guard", async () => {
  const t = await setup();
  try {
    const r = await t.call("snapshot");
    assert.equal(r.isError, true);
    assert.match(t.txt(r), /No world is open\. Call world_new/);
    assert.match(t.txt(await t.call("world_new", { id: "Bad Id", title: "x" })), /lowercase/);
    assert.match(t.txt(await t.call("world_new", { id: "../escape", title: "x" })), /lowercase/);
    for (const template of ["empty", "studio", "demo"]) {
      const r2 = await t.call("world_new", { id: `w-${template}`, title: template, template });
      assert.equal(r2.isError, undefined, t.txt(r2));
      assert.ok(existsSync(join(t.root, `w-${template}`, "world.json")));
    }
    assert.ok(existsSync(join(t.root, "w-demo", "intro.camera.json")));
    assert.match(t.txt(await t.call("world_new", { id: "w-empty", title: "again" })), /already exists/);
    assert.match(t.txt(await t.call("world_open", { path: "../../etc" })), /outside the worlds root/);
    assert.match(t.txt(await t.call("world_open", { path: "/tmp" })), /outside the worlds root|no world\.json/);
    assert.match(t.txt(await t.call("world_open", { path: "w-studio" })), /Opened "w-studio"/);
    assert.match(t.txt(await t.call("world_save", { path: "/etc/x" })), /outside the worlds root/);
  } finally { await t.close(); }
});

test("scene_apply: validation rejects whole batch; engine failure reports index; autosave; diff", async () => {
  const t = await setup();
  try {
    await t.call("world_new", { id: "desk", title: "Desk" });
    const bad = await t.call("scene_apply", { ops: [{ op: "add", entity: { id: "a", kind: "primitive", shape: "box" } }, { op: "add", entity: { id: "b", kind: "primitive", shape: "box", color: "#ff0000" } }] });
    assert.equal(bad.isError, true);
    assert.match(t.txt(bad), /Nothing applied — 1 problem\(s\):\nops\[1\]\.entity\.color: unknown field — for primitives use material\.color/);
    assert.match(t.txt(await t.call("scene_find", { query: "a" })), /^No match|ground|sun|sky/); // "a" not added
    const ok = await t.call("scene_apply", { ops: [
      { op: "add", entity: { id: "table", kind: "primitive", shape: "box", size: [1.2, 0.05, 0.6], transform: { position: [0, 0.725, 0] } } },
      { op: "add", entity: { id: "mug", kind: "primitive", shape: "cylinder", size: [0.04, 0.1], transform: { position: [0.2, 0.8, 0] }, tags: ["kitchen"] } },
    ] });
    assert.equal(t.txt(ok), "Applied 2/2 ops. +table(primitive box) +mug(primitive cylinder)");
    const saved = JSON.parse(readFileSync(join(t.root, "desk", "world.json"), "utf8"));
    assert.ok(saved.entities.some((e: { id: string }) => e.id === "mug"), "autosaved");
    const eng = await t.call("scene_apply", { ops: [{ op: "update", id: "mug", set: { transform: { position: [0, 0.8, 0] } } }, { op: "add", entity: { id: "engine-refuses", kind: "primitive", shape: "box" } }, { op: "remove", id: "engine-refuses" }] });
    assert.equal(eng.isError, true);
    assert.match(t.txt(eng), /Applied 2 of 3; op 2 failed: engine refused\. Ops before it stayed applied\.\nchanges: \+engine-refuses\(primitive box\) ~mug\(transform → pos \[0, 0\.8, 0\]\)/);
    const find = t.txt(await t.call("scene_find", { tag: "kitchen" }));
    assert.match(find, /1 of \d+ entities:\nmug primitive cylinder \[0\.04,0\.1\] pos \[0, 0\.8, 0\] bounds \[-0\.04, 0\.75, -0\.04\]\.\.\[0\.04, 0\.85, 0\.04\]/);
    await t.call("scene_apply", { ops: [{ op: "add", entity: { id: "lamp", kind: "group", children: [{ id: "lamp-base", kind: "primitive", shape: "cylinder" }, { id: "bulb", kind: "light", light: "point" }] } }] });
    assert.match(t.txt(await t.call("scene_find", { query: "lamp" })), /^3 of \d+ entities:\nlamp group[\s\S]*lamp-base[\s\S]*bulb light/);
    assert.match(t.txt(await t.call("scene_find", { query: "lamp", kind: "light" })), /^1 of \d+ entities:\nbulb light/);
    const world = JSON.parse(t.txt(await t.call("world_get")));
    assert.equal(world.id, "desk");
  } finally { await t.close(); }
});

test("snapshot: image + text, camera variants, flat-image warning", async () => {
  const t = await setup({ flat: true });
  try {
    await t.call("world_new", { id: "s", title: "S", template: "studio" });
    await t.call("scene_apply", { ops: [{ op: "add", entity: { id: "box", kind: "primitive", shape: "box", size: [0.5], transform: { position: [0, 0.25, 0] } } }] });
    const r = await t.call("snapshot");
    assert.equal(r.content[0]!.type, "image");
    assert.match(t.txt(r), /^camera default: position \[0, 1\.4, 4\.2\] target \[0, 0\.6, 0\] fov 35 · 5 entities · webgl2 · 1024x576/);
    assert.match(t.txt(r), /WARNING: the image is almost one flat colour/);
    const page = t.state.pages[0]!;
    assert.ok(page.calls.includes("render 1024x576"), "snapshot draws with bridge.render");
    assert.ok(!page.calls.includes("loadScript"), "no one-frame script for a snapshot");
    assert.match(t.txt(await t.call("snapshot", { camera: "hero", width: 320, height: 180 })), /^camera hero: .* 320x180/);
    assert.match(t.txt(await t.call("snapshot", { camera: { focus: "box", view: "top" } })), /^focus box \(top\): position \[0, [\d.]+, 0\] target \[0, 0\.25, 0\]/);
    assert.match(t.txt(await t.call("snapshot", { camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 50 } })), /^pose: position \[1, 2, 3\]/);
    assert.match(t.txt(await t.call("snapshot", { camera: "nope" })), /no camera "nope"\. Named cameras: default, hero, top/);
    assert.match(t.txt(await t.call("snapshot", { camera: { focus: "ghost" } })), /focus: no entity "ghost"/);
    await t.call("camera_set", { position: [3, 3, 3], target: [0, 0, 0], save_as: "corner" });
    assert.match(t.txt(await t.call("snapshot")), /^live camera: position \[3, 3, 3\]/);
    assert.match(t.txt(await t.call("snapshot", { camera: "corner" })), /^camera corner/);
    assert.ok(JSON.parse(readFileSync(join(t.root, "s", "world.json"), "utf8")).cameras.corner);
  } finally { await t.close(); }
});

test("scene_find + focus use engine bounds (models get a size)", async () => {
  const t = await setup();
  try {
    await t.call("world_new", { id: "m", title: "M" });
    await t.call("scene_apply", { ops: [{ op: "add", entity: { id: "chair", kind: "model", src: "assets/chair.glb", transform: { position: [2, 0, 0] } } }] });
    assert.match(t.txt(await t.call("scene_find", { query: "chair" })), /chair model assets\/chair\.glb pos \[2, 0, 0\] bounds \[1\.5, 0, -0\.5\]\.\.\[2\.5, 1, 0\.5\] size \[1, 1, 1\]/);
    assert.match(t.txt(await t.call("snapshot", { camera: { focus: "chair", view: "front" } })), /^focus chair \(front\): position \[2, [\d.]+, [\d.]+\] target \[2, 0\.5, 0\]/);
    assert.ok(t.state.pages[0]!.calls.includes("bounds"));
  } finally { await t.close(); }
});

test("scripts: validate, preview contact sheet, events do not leak into the world", async () => {
  const t = await setup();
  try {
    await t.call("world_new", { id: "d", title: "D", template: "demo" });
    assert.match(t.txt(await t.call("script_validate", { script: "intro.camera.json" })), /^Valid: 8s, 2 shot\(s\), 1280x720 @ 30 fps, 1 event\(s\)\.\n(warnings:\nhard cut at 4s[^\n]*)?$/);
    assert.match(t.txt(await t.call("script_validate", { script: "../../x.json" })), /outside the worlds root/);
    const script = { tera: "camera/v1", fps: 30, width: 640, height: 360, duration: 2, shots: [{ id: "o", start: 0, end: 2, kind: "orbit", center: [0, 1, 0], radius: 5, height: 2, fromDeg: 0, toDeg: 90 }], events: [{ t: 1, ops: [{ op: "remove", id: "ball" }] }] };
    const p = await t.call("script_preview", { script, times: [0, 1, 2], thumb_width: 320 });
    assert.equal(p.content[0]!.type, "image");
    assert.match(t.txt(p), /3 frames at 320x180[\s\S]*t=1s shot o/);
    const w = JSON.parse(t.txt(await t.call("world_get")));
    assert.ok(w.entities.some((e: { id: string }) => e.id === "ball"), "event removal must not persist");
    const bad = await t.call("script_preview", { script: { ...script, fps: 0 } });
    assert.match(t.txt(bad), /script is not valid:\nscript\.fps/);
  } finally { await t.close(); }
});

test("asset_import + gen: unconfigured message, mock worker import + add", async () => {
  const t0 = await setup();
  try {
    await t0.call("world_new", { id: "g", title: "G" });
    const r = await t0.call("gen_model", { prompt: "a mug" });
    assert.equal(r.isError, true);
    assert.match(t0.txt(r), /No gen worker configured\. Set TERA_GEN_URL/);
  } finally { await t0.close(); }
  const w = await startMockWorker(0, 2);
  const t = await setup({ genUrl: w.url });
  try {
    await t.call("world_new", { id: "g", title: "G" });
    const photo = join(t.root, "photo.png");
    writeFileSync(photo, encodePng(blank(4, 4)));
    assert.match(t.txt(await t.call("asset_import", { src: photo })), /Imported: assets\/photo\.png/);
    const s = await t.call("gen_splat", { image: "assets/photo.png", add: true, id: "room", position: [0, 0, -2] });
    assert.match(t.txt(s), /Job j_1 done → assets\/room\.ply\nAdded entity "room"/);
    assert.match(t.txt(await t.call("scene_find", { kind: "splat" })), /room splat assets\/room\.ply pos \[0, 0, -2\] bounds \?/);
    assert.match(t.txt(await t.call("gen_model", { prompt: "a mug" })), /→ assets\/model-j2\.glb\nAdd it with/);
    assert.match(t.txt(await t.call("gen_model", { prompt: "fail please" })), /failed: mock failure requested/);
    assert.match(t.txt(await t.call("gen_splat", { image: "/etc/hostname" })), /outside the worlds root/);
    assert.match(t.txt(await t.call("gen_splat", { image: "assets/nope.png" })), /image not found/);
    const job1 = w.jobs.get("j_1")!.input as { image: string };
    assert.match(job1.image, /^data:image\/png;base64,/);
  } finally { await t.close(); await w.close(); }
});
