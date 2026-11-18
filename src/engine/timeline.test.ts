import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldPack } from "../schema/index.ts";
import { applyOp, applyOps, countEntities, findEntity, hasSplats, worldAt } from "./timeline.ts";

const base = (): WorldPack => ({
  tera: "world/v1",
  id: "t",
  title: "T",
  entities: [
    { id: "box", kind: "primitive", shape: "box", transform: { position: [0, 0, 0] }, material: { color: "#ff0000", roughness: 0.5 } },
    { id: "grp", kind: "group", children: [{ id: "kid", kind: "text", text: "hi" }] },
  ],
});

test("add, nested add, update deep-merges, remove", () => {
  const w = base();
  applyOp(w, { op: "add", entity: { id: "s", kind: "primitive", shape: "sphere" } });
  applyOp(w, { op: "add", parent: "grp", entity: { id: "k2", kind: "primitive", shape: "torus" } });
  applyOp(w, { op: "update", id: "box", set: { material: { color: "#00ff00" } } });
  const box = findEntity(w.entities, "box")!.entity;
  assert.deepEqual(box.kind === "primitive" && box.material, { color: "#00ff00", roughness: 0.5 });
  assert.equal(countEntities(w.entities), 5);
  applyOp(w, { op: "remove", id: "kid" });
  assert.equal(findEntity(w.entities, "kid"), undefined);
});

test("bad ops throw readable errors and leave the world untouched", () => {
  const w = base();
  const before = JSON.stringify(w);
  assert.throws(() => applyOp(w, { op: "add", entity: { id: "box", kind: "primitive", shape: "box" } }), /already exists/);
  assert.throws(() => applyOp(w, { op: "remove", id: "nope" }), /no entity/);
  assert.throws(() => applyOp(w, { op: "update", id: "box", set: { material: { roughness: 7 } } }), /roughness/);
  assert.throws(() => applyOp(w, { op: "add", parent: "box", entity: { id: "x", kind: "text", text: "x" } }), /not a group/);
  assert.equal(JSON.stringify(w), before);
});

test("applyOps stops at the first failure and keeps earlier ops", () => {
  const w = base();
  const r = applyOps(w, [
    { op: "add", entity: { id: "a", kind: "primitive", shape: "box" } },
    { op: "remove", id: "missing" },
    { op: "add", entity: { id: "b", kind: "primitive", shape: "box" } },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.applied, 1);
  assert.match(r.error!, /op 1/);
  assert.ok(findEntity(w.entities, "a"));
  assert.equal(findEntity(w.entities, "b"), undefined);
});

test("sky: same mode merges, a new mode replaces", () => {
  const w = base();
  applyOp(w, { op: "sky", set: { mode: "sun", time: "2026-11-17T16:30:00-08:00", lat: 37, lon: -122 } });
  applyOp(w, { op: "sky", set: { time: "2026-11-17T09:00:00-08:00" } });
  assert.deepEqual(w.sky, { mode: "sun", time: "2026-11-17T09:00:00-08:00", lat: 37, lon: -122 });
  applyOp(w, { op: "sky", set: { mode: "color", color: "#101010" } });
  assert.deepEqual(w.sky, { mode: "color", color: "#101010" });
  applyOp(w, { op: "env", set: { fog: { color: "#ffffff", near: 1, far: 9 } } });
  applyOp(w, { op: "env", set: { exposure: 1.2 } });
  assert.deepEqual(w.environment, { fog: { color: "#ffffff", near: 1, far: 9 }, exposure: 1.2 });
});

test("worldAt replays events <= t and interpolates animate in script time", () => {
  const events = [
    { t: 6, ops: [{ op: "animate" as const, id: "box", to: { position: [0, 4, 0] as [number, number, number] }, duration: 2, ease: "linear" as const }] },
    { t: 2, ops: [{ op: "add" as const, entity: { id: "late", kind: "primitive" as const, shape: "box" as const } }] },
  ];
  const b = base();
  const pos = (t: number) => {
    const e = findEntity(worldAt(b, events, t).world.entities, "box")!.entity;
    return e.transform?.position;
  };
  assert.equal(findEntity(worldAt(b, events, 1).world.entities, "late"), undefined);
  assert.ok(findEntity(worldAt(b, events, 2).world.entities, "late"));
  assert.deepEqual(pos(5), [0, 0, 0]);
  assert.deepEqual(pos(6), [0, 0, 0]);
  assert.deepEqual(pos(7), [0, 2, 0]);
  assert.deepEqual(pos(8), [0, 4, 0]);
  assert.deepEqual(pos(100), [0, 4, 0]);
  // Seeking backwards is exact: the base is never mutated.
  assert.deepEqual(pos(6.5), [0, 1, 0]);
  assert.deepEqual(b.entities[0]!.transform?.position, [0, 0, 0]);
});

test("worldAt reports failing events and keeps going", () => {
  const r = worldAt(base(), [{ t: 0, ops: [{ op: "remove", id: "ghost" }, { op: "remove", id: "box" }] }], 1);
  assert.equal(r.errors.length, 1);
  assert.equal(findEntity(r.world.entities, "box"), undefined);
});

test("hasSplats looks inside groups", () => {
  const w = base();
  assert.equal(hasSplats(w.entities), false);
  applyOp(w, { op: "add", parent: "grp", entity: { id: "sp", kind: "splat", src: "a.spz" } });
  assert.equal(hasSplats(w.entities), true);
});
