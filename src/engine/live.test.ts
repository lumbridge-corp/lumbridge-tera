import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, parseLiveMessage } from "./live.ts";
import { WorldPack, livingRefErrors } from "../schema/index.ts";
import { applyOps, worldAt } from "./timeline.ts";

const world = {
  tera: "world/v1",
  id: "town",
  title: "Town",
  entities: [],
  paths: [{ id: "street", points: [[0, 0, 0], [10, 0, 0]] }],
  graph: { nodes: [{ id: "a", position: [0, 0, 0] }, { id: "b", position: [10, 0, 0] }], edges: [["a", "b"]] },
};

test("live: ops message parses and validates every op", () => {
  const m = parseLiveMessage(JSON.stringify({ type: "ops", seq: 4, ops: [
    { op: "add", entity: { id: "w1", kind: "actor", style: "worker", label: "agent-1", move: { to: "b", speed: 1.5 } } },
    { op: "update", id: "w1", set: { state: "working" } },
    { op: "path", set: { id: "loop", points: [[0, 0, 0], [1, 0, 0]], closed: true } },
  ] }));
  assert.equal(m.type, "ops");
  if (m.type === "ops") {
    assert.equal(m.ops.length, 3);
    assert.equal(m.seq, 4);
  }
});

test("live: snapshot message carries a valid world", () => {
  const m = parseLiveMessage({ type: "snapshot", world });
  assert.equal(m.type, "snapshot");
  if (m.type === "snapshot") assert.equal(m.world.paths?.[0]?.id, "street");
});

test("live: bad input is an error, never a throw", () => {
  assert.equal(parseLiveMessage("{nope").type, "error");
  assert.equal(parseLiveMessage(JSON.stringify({ type: "dance" })).type, "error");
  const badOp = parseLiveMessage(JSON.stringify({ type: "ops", ops: [{ op: "add", entity: { id: "x", kind: "actor", move: { path: "p", to: "b" } } }] }));
  assert.equal(badOp.type, "error");
  if (badOp.type === "error") assert.match(badOp.error, /ops\[0\]/);
  const badWorld = parseLiveMessage({ type: "snapshot", world: { ...world, id: "Bad Id" } });
  assert.equal(badWorld.type, "error");
  assert.equal(parseLiveMessage({ type: "ping" }).type, "ping");
});

test("live: reconnect backoff grows and caps", () => {
  const mid = () => 0.5;
  assert.equal(backoff(0, mid), 500);
  assert.equal(backoff(1, mid), 1000);
  assert.equal(backoff(3, mid), 4000);
  assert.equal(backoff(20, mid), 10000);
  assert.ok(backoff(0, () => 0) >= 400 && backoff(0, () => 1) <= 600);
});

test("schema: living entities and world-level paths/graph parse", () => {
  const w = WorldPack.parse({
    ...world,
    entities: [
      { id: "w1", kind: "actor", move: { path: "street", loop: true, dwell: 2 }, state: "working" },
      { id: "f1", kind: "flow", path: "street", rate: 4, speed: 6, style: "comet", pipe: { radius: 0.2 } },
      { id: "m1", kind: "meter", value: 0.42, style: "ring" },
      { id: "box", kind: "primitive", shape: "box", material: { color: "#335577", glow: 2 } },
    ],
  });
  assert.equal(w.entities.length, 4);
  assert.equal(WorldPack.safeParse({ ...world, entities: [{ id: "m", kind: "meter", value: 1.5 }] }).success, false);
  assert.deepEqual(livingRefErrors({ id: "f2", kind: "flow", path: "nowhere" }, w).length, 1);
  assert.deepEqual(livingRefErrors({ id: "a2", kind: "actor", move: { to: "b" } }, w), []);
});

test("ops: path and graph ops edit the world, replay in scripts", () => {
  const w = WorldPack.parse(world);
  const r = applyOps(w, [
    { op: "path", set: { id: "street", points: [[0, 0, 0], [0, 0, 5]] } },
    { op: "path", set: { id: "tunnel", points: [[0, -5, 0], [20, -5, 0]] } },
    { op: "graph", nodes: [{ id: "c", position: [5, 0, 5] }], edges: [["b", "c"], ["c", "b"]] },
  ]);
  assert.deepEqual(r, { ok: true, applied: 3 });
  assert.equal(w.paths!.length, 2);
  assert.deepEqual(w.paths![0]!.points[1], [0, 0, 5]);
  assert.equal(w.graph!.edges.length, 2); // duplicate (either direction) ignored
  const bad = applyOps(w, [{ op: "graph", edges: [["a", "zzz"]] }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /no graph node "zzz"/);
  assert.equal(w.graph!.edges.length, 2); // untouched on failure
  const later = worldAt(WorldPack.parse(world), [{ t: 3, ops: [{ op: "graph", removeNodes: ["b"] }] }], 4).world;
  assert.equal(later.graph!.nodes.length, 1);
  assert.equal(later.graph!.edges.length, 0);
});
