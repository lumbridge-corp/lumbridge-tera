import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { guardPath, safeName } from "./paths.ts";
import { blank, contactSheet, decodePng, encodePng, imageStats } from "./png.ts";
import { rows } from "./bounds.ts";
import { checkOps, checkScript } from "./validate.ts";
import { importAsset } from "./assets.ts";
import { runJob, pickOutput } from "./gen.ts";
import { startMockWorker } from "./testing/mock-gen-worker.ts";
import { diffWorlds, frame } from "./session.ts";
import type { WorldPack } from "../schema/index.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "tera-mcp-test-")));

test("path guard refuses traversal, absolute escapes and symlink escapes", () => {
  const root = tmp();
  assert.equal(guardPath(root, "a/b"), join(root, "a/b"));
  assert.equal(guardPath(root, join(root, "x")), join(root, "x"));
  assert.throws(() => guardPath(root, "../evil"), /outside the worlds root/);
  assert.throws(() => guardPath(root, "a/../../evil"), /outside the worlds root/);
  assert.throws(() => guardPath(root, "/etc/passwd"), /outside the worlds root/);
  assert.throws(() => guardPath(root, "~/x"), /outside the worlds root/);
  assert.throws(() => guardPath(root, ""), /empty/);
  const outside = tmp();
  symlinkSync(outside, join(root, "link"));
  assert.throws(() => guardPath(root, "link/new-file"), /outside the worlds root/);
  assert.equal(safeName("my chair!.glb"), "my-chair-.glb");
  assert.throws(() => safeName(".."), /usable/);
});

test("png encode/decode round trip and contact sheet", () => {
  const img = blank(40, 20, [10, 200, 30, 255]);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 40);
  assert.deepEqual([...back.data.subarray(0, 4)], [10, 200, 30, 255]);
  const sheet = decodePng(contactSheet([0, 1, 2, 3, 4].map((t) => ({ png: encodePng(img), label: `t=${t}s` }))));
  assert.equal(sheet.width, 3 * 40 + 4 * 6); // 5 frames → 3 columns
  assert.equal(sheet.height, 2 * 20 + 3 * 6);
  assert.ok(imageStats(encodePng(img)).std < 1);
});

test("bounds: primitives centred on position, rotation and groups", () => {
  const r = rows([
    { id: "table", kind: "primitive", shape: "box", size: [1.2, 0.05, 0.6], transform: { position: [0, 0.75, 0] } },
    { id: "rot", kind: "primitive", shape: "box", size: [2, 1, 1], transform: { rotation: [0, 90, 0] } },
    { id: "g", kind: "group", transform: { position: [5, 0, 0] }, children: [{ id: "ball", kind: "primitive", shape: "sphere", size: [0.5], transform: { position: [0, 1, 0] } }] },
    { id: "m", kind: "model", src: "assets/x.glb" },
  ]);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.deepEqual(by.table!.bounds!.max.map((v) => +v.toFixed(3)), [0.6, 0.775, 0.3]);
  assert.deepEqual(by.rot!.bounds!.max.map((v) => +v.toFixed(3)), [0.5, 0.5, 1]);
  assert.deepEqual(by.ball!.position, [5, 1, 0]);
  assert.deepEqual(by.g!.bounds!.min.map((v) => +v.toFixed(3)), [4.5, 0.5, -0.5]);
  assert.equal(by.m!.bounds, null);
  const pose = frame([by.table as never].length ? [{ id: "table", kind: "primitive", shape: "box", size: [1.2, 0.05, 0.6], transform: { position: [0, 0.75, 0] } }] : [], new Set(["table"]), "front");
  assert.deepEqual(pose.target, [0, 0.75, 0]);
  assert.ok(pose.position[2] > 0.6);
});

const world: WorldPack = {
  tera: "world/v1", id: "w", title: "W",
  entities: [{ id: "cube", kind: "primitive", shape: "box" }, { id: "g", kind: "group", children: [{ id: "kid", kind: "primitive", shape: "sphere" }] }],
};

test("op checks: exact indices, unknown fields with hints, ids", () => {
  const c = checkOps([
    { op: "add", entity: { id: "a", kind: "primitive", shape: "box", position: [0, 1, 0], material: { color: "red" } } },
    { op: "add", entity: { id: "cube", kind: "primitive", shape: "box" } },
    { op: "update", id: "ghost", set: {} },
    { op: "update", id: "cube", set: { material: { color: "#zzzzzz" } } },
    { op: "explode" },
    { op: "add", entity: { id: "b", kind: "primitive", shape: "pyramid" } },
    { op: "add", entity: { id: "c", kind: "primitive", shape: "box" }, parent: "cube" },
    { op: "remove", id: "kid" },
  ], world);
  const all = c.errors.flatMap((e) => e.messages).join("\n");
  assert.equal(c.ok, false);
  assert.deepEqual(c.errors.map((e) => e.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.match(all, /ops\[0\]\.entity\.material\.color: colour must be #rrggbb/);
  assert.match(all, /ops\[1\]: id "cube" already exists/);
  assert.match(all, /ops\[2\]\.id: no entity "ghost"\. Known ids: cube, g, kid/);
  assert.match(all, /ops\[3\]\.set\.material\.color: colour must be #rrggbb/);
  assert.match(all, /ops\[4\]\.op: must be one of "add", "update"/);
  assert.match(all, /ops\[5\]\.entity\.shape: got "pyramid", must be one of/);
  assert.match(all, /ops\[6\]\.parent: "cube" is a primitive, not a group/);
  assert.equal(checkOps([{ op: "env", set: { post: { ao: true, dof: { focus: 3, aperture: 0.02 } } } }, { op: "env", set: { post: null, fog: null } }], world).ok, true);
  assert.match(checkOps([{ op: "env", set: { post: { dof: { focus: 0 } } } }], world).errors[0]!.messages.join("\n"), /post\.dof/);
  const pos = checkOps([{ op: "add", entity: { id: "a", kind: "primitive", shape: "box", position: [0, 1, 0] } }], world);
  assert.match(pos.errors[0]!.messages[0]!, /ops\[0\]\.entity\.position: unknown field — put it in transform\.position/);
  assert.equal(checkOps([{ op: "add", entity: { id: "n", kind: "primitive", shape: "box" } }, { op: "update", id: "n", set: { transform: { position: [0, 1, 0] } } }, { op: "remove", id: "n" }], world).ok, true);
  assert.equal(checkOps({ op: "add" }, world).ok, false);
  const placed: WorldPack = { ...world, entities: [{ id: "mug", kind: "primitive", shape: "cylinder", transform: { position: [1, 0.8, 0], rotation: [0, 0, 0] } }] };
  const rot = checkOps([{ op: "update", id: "mug", set: { transform: { rotation: [0, 30, 0] } } }], placed);
  assert.deepEqual(rot.ops[0], { op: "update", id: "mug", set: { transform: { position: [1, 0.8, 0], rotation: [0, 30, 0] } } }, "update sends merged transform");
});

test("script checks: schema errors with paths, even size, warnings", () => {
  const base = { tera: "camera/v1", fps: 30, width: 640, height: 360, duration: 4, shots: [{ id: "a", start: 1, end: 3, kind: "keys", keys: [{ t: 1, position: [0, 1, 5], target: [0, 0, 0] }] }] };
  const ok = checkScript(base, world);
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some((w) => /first shot starts at 1s/.test(w)));
  assert.ok(ok.warnings.some((w) => /holds the last pose/.test(w)));
  assert.ok(ok.warnings.some((w) => /one key: a static shot/.test(w)));
  const ghost = checkScript({ ...base, events: [{ t: 2, ops: [{ op: "remove", id: "ghost" }] }] }, world);
  assert.match(ghost.errors.join(), /remove unknown entity "ghost"/);
  const cut = checkScript({ ...base, shots: [base.shots[0], { id: "orb", start: 3, end: 4, kind: "orbit", center: [0, 0, 0], radius: 5, height: 1, fromDeg: 0, toDeg: 30 }] }, world);
  assert.ok(cut.warnings.some((w) => /hard cut at 3s: a ends at \[0, 1, 5\] but orb starts at \[5, 1, 0\].*θ=90 is \+Z/.test(w)), cut.warnings.join("\n"));
  const smooth = checkScript({ ...base, shots: [base.shots[0], { id: "orb", start: 3, end: 4, kind: "orbit", center: [0, 0, 0], radius: 5, height: 1, fromDeg: 90, toDeg: 120 }] }, world);
  assert.ok(!smooth.warnings.some((w) => /hard cut/.test(w)), smooth.warnings.join("\n"));
  const odd = checkScript({ ...base, width: 641 }, world);
  assert.match(odd.errors.join(), /even width and height/);
  const bad = checkScript({ ...base, shots: [{ ...base.shots[0], keys: [{ t: 9, position: [0, 0], target: [0, 0, 0] }] }] }, world);
  assert.match(bad.errors.join("\n"), /script\.shots\[0\]\.keys\[0\]\.position/);
  const audio = checkScript({ ...base, audio: { src: "missing.wav" } }, world, () => false);
  assert.match(audio.errors.join(), /audio\.src "missing\.wav" not found/);
});

test("diff summary", () => {
  const after: WorldPack = structuredClone(world);
  after.entities.push({ id: "new", kind: "primitive", shape: "sphere" });
  (after.entities[0] as { transform?: unknown }).transform = { position: [1, 0, 0] };
  after.entities.splice(1, 1);
  assert.equal(diffWorlds(world, after), "+new(primitive sphere) ~cube(transform → pos [1, 0, 0]) -g -kid");
});

test("asset import: allowlist, size cap, rename, URL download with cap", async () => {
  const dir = tmp(), src = tmp();
  writeFileSync(join(src, "chair.glb"), "glTF....");
  writeFileSync(join(src, "evil.sh"), "rm -rf /");
  writeFileSync(join(src, "big.png"), Buffer.alloc(2000));
  assert.deepEqual(await importAsset(dir, join(src, "chair.glb"), undefined), { path: "assets/chair.glb", bytes: 8, reused: false });
  assert.equal((await importAsset(dir, join(src, "chair.glb"), undefined)).reused, true);
  writeFileSync(join(src, "chair2.glb"), "different");
  assert.equal((await importAsset(dir, join(src, "chair2.glb"), "chair.glb")).path, "assets/chair-1.glb");
  await assert.rejects(importAsset(dir, join(src, "evil.sh"), undefined), /not allowed/);
  await assert.rejects(importAsset(dir, join(src, "evil.sh"), "evil.png"), /not allowed/);
  await assert.rejects(importAsset(dir, join(src, "big.png"), undefined, { maxBytes: 1000 }), /over the/);
  await assert.rejects(importAsset(dir, "file:///etc/passwd", "x.png"), /only local paths and http/);
  const server = createServer((req, res) => { res.writeHead(200); res.end(Buffer.alloc(req.url === "/big.glb" ? 5000 : 10)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await importAsset(dir, `http://127.0.0.1:${port}/files/tree.glb?x=1`, undefined)).path, "assets/tree.glb");
    await assert.rejects(importAsset(dir, `http://127.0.0.1:${port}/big.glb`, undefined, { maxBytes: 1000 }), /limit/);
  } finally { server.close(); }
});

test("gen client against the mock worker: success, failure, unreachable", async () => {
  const w = await startMockWorker(0, 3);
  try {
    const seen: string[] = [];
    const r = await runJob(w.url, "image_to_model", { prompt: "a mug" }, undefined, { pollMs: 5, onProgress: (_p, s) => void seen.push(s) });
    assert.deepEqual(seen, ["queued", "running", "done"]);
    assert.equal(pickOutput("image_to_model", r.outputs).format, "glb");
    assert.throws(() => pickOutput("image_to_splat", r.outputs), /need one of spz/);
    await assert.rejects(runJob(w.url, "image_to_model", { prompt: "please fail" }, undefined, { pollMs: 5 }), /failed: mock failure/);
  } finally { await w.close(); }
  await assert.rejects(runJob("http://127.0.0.1:9", "image_to_model", { prompt: "x" }, undefined), /not reachable/);
  mkdirSync(tmp(), { recursive: true });
});
