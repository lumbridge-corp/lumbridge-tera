import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplayPlayer, backoff, connectReplay, parseLiveMessage, parseReplay, replaySpeed } from "./live.ts";
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

// ---------------------------------------------------------------- replay (?replay=)

const opsLine = (t: number, id: string) => JSON.stringify({ t, msg: { type: "ops", ops: [{ op: "update", id, set: { state: "working" } }] } });

test("replay: parses JSONL, sorts by t, skips malformed lines without throwing", () => {
  const text = [
    JSON.stringify({ tera: "replay/v1", duration: 10, title: "a day" }),
    opsLine(2, "b"),
    "{not json",
    opsLine(0, "a"),
    JSON.stringify({ t: -1, msg: { type: "ops", ops: [] } }), // negative t
    JSON.stringify({ msg: { type: "ops", ops: [] } }), // no t
    JSON.stringify({ t: 3, msg: { type: "dance" } }), // unknown message
    JSON.stringify({ t: 4, msg: { type: "ops", ops: [{ op: "explode" }] } }), // bad op
    JSON.stringify({ t: 5, msg: { type: "ping" } }), // ignored, not skipped
    opsLine(2, "c"), // tie with b: file order kept
    opsLine(12, "late"), // past the loop length
    "",
  ].join("\n");
  const r = parseReplay(text);
  assert.equal(r.duration, 10);
  assert.equal(r.title, "a day");
  assert.deepEqual(r.frames.map((f) => f.t), [0, 2, 2]);
  assert.deepEqual(r.frames.map((f) => (f.msg.type === "ops" ? (f.msg.ops[0] as { id: string }).id : "")), ["a", "b", "c"]);
  assert.deepEqual(r.skipped.map((s) => s.line), [3, 5, 6, 7, 8]);
  assert.match(r.skipped.find((s) => s.line === 8)!.error, /ops\[0\]/);
  // without a header the loop is as long as the last message; garbage in → empty, no throw
  assert.equal(parseReplay([opsLine(0, "a"), opsLine(7.5, "b")].join("\n")).duration, 7.5);
  assert.deepEqual(parseReplay("nonsense\n\n{}").frames, []);
});

test("replay: the player hands out frames at their time, scaled by speed", () => {
  const r = parseReplay([opsLine(0, "a"), opsLine(1, "b"), opsLine(2.5, "c"), JSON.stringify({ t: 4, msg: { type: "ping" } })].join("\n"));
  assert.equal(r.duration, 2.5);
  const p = new ReplayPlayer(r, 1);
  assert.equal(p.advance(0).frames.length, 1); // t = 0 frames immediately
  assert.equal(p.advance(0.99).frames.length, 0);
  assert.equal(p.advance(0.02).frames.length, 1); // b at 1.0
  const fast = new ReplayPlayer(r, 2);
  fast.advance(0);
  assert.equal(fast.advance(0.5).frames.length, 1); // 0.5 s real = 1 s recording
  assert.equal(replaySpeed("4"), 4);
  assert.equal(replaySpeed("0"), 1);
  assert.equal(replaySpeed(null), 1);
  assert.equal(replaySpeed("1000"), 32);
  assert.equal(replaySpeed("abc"), 1);
});

test("replay: loop point delivers the rest once, waits for restart, then starts over", () => {
  const r = parseReplay([JSON.stringify({ tera: "replay/v1", duration: 3 }), opsLine(0, "a"), opsLine(2.9, "b")].join("\n"));
  const p = new ReplayPlayer(r);
  p.advance(0);
  const end = p.advance(5); // a long step crosses the end: b is still delivered
  assert.equal(end.loop, true);
  assert.equal(end.frames.length, 1);
  assert.deepEqual(p.advance(1), { frames: [], loop: false }); // parked at the end until restart
  p.restart();
  assert.equal(p.loops, 1);
  assert.equal(p.t, 0);
  assert.equal(p.advance(0).frames.length, 1); // a again
});

test("replay: connectReplay plays through the live handlers in order, loops, skips bad lines", async () => {
  const text = [JSON.stringify({ tera: "replay/v1", duration: 1 }), JSON.stringify({ t: 0, msg: { type: "snapshot", world } }), "garbage", opsLine(0.5, "w1")].join("\n");
  const seen: string[] = [];
  const statuses: string[] = [];
  let cb: ((now: number) => void) | null = null;
  let now = 0;
  const step = async (ms: number) => {
    now += ms;
    const f = cb!;
    cb = null;
    f(now);
    await new Promise((r) => setTimeout(r, 0));
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const stop = connectReplay("x.jsonl", {
    ops: async (ops) => void seen.push(`ops:${(ops[0] as { id: string }).id}`),
    snapshot: async (w) => void seen.push(`snapshot:${w.id}`),
    status: (s) => void statuses.push(s),
    loop: async () => void seen.push("loop"),
  }, 1, { fetchText: async () => text, frame: (f) => void (cb = f), maxStep: 0.25 });
  await new Promise((r) => setTimeout(r, 0));
  await step(16); // first frame: t = 0
  for (let i = 0; i < 8; i++) await step(100); // 0.25 s cap per frame does not matter here
  for (let i = 0; i < 3; i++) await step(100);
  await step(16); // after restart: t = 0 again
  stop();
  console.warn = origWarn;
  assert.deepEqual(statuses, ["connecting", "replay"]);
  assert.deepEqual(seen.slice(0, 4), ["snapshot:town", "ops:w1", "loop", "snapshot:town"]);
});

test("replay: a hidden tab (a long gap between frames) never jumps more than maxStep", () => {
  const r = parseReplay([opsLine(0, "a"), opsLine(10, "b")].join("\n"));
  const p = new ReplayPlayer(r);
  p.advance(0);
  // connectReplay clamps dt; the player itself is exact
  assert.equal(p.advance(Math.min(0.25, 60)).frames.length, 0);
  assert.ok(Math.abs(p.t - 0.25) < 1e-9);
});
