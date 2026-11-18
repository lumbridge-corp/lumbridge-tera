import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorldPack } from "../schema/index.ts";
import { validate } from "./validate.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const demoScript = read("../../worlds/demo/intro.camera.json");
const demoWorld = WorldPack.parse(read("../../worlds/demo/world.json"));
const base = { tera: "camera/v1", fps: 30, width: 640, height: 360, duration: 4, shots: [{ id: "a", start: 0, end: 4, kind: "orbit", center: [0, 0, 0], radius: 5, height: 2, fromDeg: 0, toDeg: 90 }] };

test("demo script is valid against the demo world", () => {
  const r = validate(demoScript, demoWorld);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.frames, 240);
});

test("schema errors come back as path: message", () => {
  const r = validate({ ...base, fps: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("fps:")), r.errors.join());
});

test("keys outside shot and overlapping shots are errors", () => {
  const r = validate({ ...base, shots: [{ id: "k", start: 0, end: 2, kind: "keys", keys: [{ t: 3, position: [0, 0, 5], target: [0, 0, 0] }] }, { id: "o", start: 1, end: 4, kind: "orbit", center: [0, 0, 0], radius: 1, height: 0, fromDeg: 0, toDeg: 1 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("outside")));
  assert.ok(r.errors.some((e) => e.includes("overlaps")));
});

test("unknown entity ids in events, adds then updates, removes then updates", () => {
  const r = validate(
    {
      ...base,
      events: [
        { t: 1, ops: [{ op: "update", id: "ghost", set: {} }] },
        { t: 2, ops: [{ op: "add", entity: { id: "new", kind: "group", children: [{ id: "kid", kind: "primitive", shape: "box" }] } }, { op: "animate", id: "kid", to: { position: [0, 1, 0] }, duration: 1 }] },
        { t: 3, ops: [{ op: "remove", id: "new" }, { op: "update", id: "kid", set: {} }, { op: "add", entity: { id: "cube", kind: "primitive", shape: "box" } }] },
      ],
    },
    demoWorld,
  );
  assert.deepEqual(r.errors, [
    'events[0] (t=1) op 0: update unknown entity "ghost"',
    'events[2] (t=3) op 1: update unknown entity "kid"',
    'events[2] (t=3) op 2: add "cube" but that id already exists',
  ]);
});

test("events are checked in time order, not array order", () => {
  const r = validate({ ...base, events: [{ t: 3, ops: [{ op: "remove", id: "late" }] }, { t: 1, ops: [{ op: "add", entity: { id: "late", kind: "primitive", shape: "box" } }] }] }, demoWorld);
  assert.deepEqual(r.errors, []);
});

test("warnings: world mismatch, frames not whole, gaps, late events, cut shots", () => {
  const r = validate(
    { ...base, world: "other", duration: 4.01, shots: [{ ...base.shots[0], end: 2 }, { ...base.shots[0], id: "b", start: 3, end: 5 }], events: [{ t: 9, ops: [] }] },
    demoWorld,
  );
  assert.equal(r.ok, true);
  const w = r.warnings.join("\n");
  for (const s of ['written for world "other"', "not a whole number", "gap 2s–3s", "never fires", "it is cut"]) assert.ok(w.includes(s), `missing warning: ${s}\n${w}`);
});

test("no world: events unchecked is a warning", () => {
  const r = validate({ ...base, events: [{ t: 1, ops: [{ op: "remove", id: "x" }] }] });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes("not checked")));
});

test("audio missing is an error only when a file check is given", () => {
  const s = { ...base, audio: { src: "narration.wav" } };
  assert.ok(validate(s).ok);
  const r = validate(s, undefined, { fileExists: () => false });
  assert.deepEqual(r.errors, ['audio.src "narration.wav" not found']);
  assert.ok(validate(s, undefined, { fileExists: () => true }).ok);
});

test("odd size is an error (yuv420p)", () => {
  assert.ok(validate({ ...base, width: 641 }).errors.some((e) => e.includes("even")));
});

test("key with position == target is an error", () => {
  const r = validate({ ...base, shots: [{ id: "k", start: 0, end: 4, kind: "keys", keys: [{ t: 0, position: [1, 1, 1], target: [1, 1, 1] }] }] });
  assert.ok(r.errors.some((e) => e.includes("position == target")));
});
