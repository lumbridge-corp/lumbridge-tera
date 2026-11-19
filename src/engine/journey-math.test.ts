import { test } from "node:test";
import assert from "node:assert/strict";
import { journeyAt, journeyPlan, journeyPose, queueOffset, queuePlaces, type StopVisit } from "./journey-math.ts";
import { samplePoints, travel, type V3 } from "./living-math.ts";
import { ActorMove } from "../schema/living.ts";
import { WorldPack } from "../schema/index.ts";
import { livingRefErrors } from "../schema/living.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("journey plan: legs, arrivals, dwells, total", () => {
  const p = journeyPlan([6, 4, 10], [{ to: "a", dwell: 2 }, { to: "b", dwell: 3, state: "idle" }], 2);
  assert.deepEqual(p.marks, [6, 10, 20]);
  const T = (L: number) => travel(L, 2, 0).T;
  close(p.arrive[0]!, T(6));
  close(p.depart[0]!, T(6) + 2);
  close(p.arrive[1]!, T(6) + 2 + T(4));
  close(p.depart[1]!, T(6) + 2 + T(4) + 3);
  close(p.total, T(6) + 2 + T(4) + 3 + T(10));
  assert.deepEqual(p.state, ["working", "idle"]);
});

test("journeyAt: walking, dwelling at each stop, done", () => {
  const p = journeyPlan([6, 4, 10], [{ to: "a", dwell: 2 }, { to: "b", dwell: 3 }], 2);
  assert.equal(journeyAt(p, -1).phase, "before");
  const w = journeyAt(p, 1);
  assert.equal(w.phase, "walking");
  assert.ok(w.s > 0 && w.s < 6);
  const d0 = journeyAt(p, p.arrive[0]! + 1);
  assert.deepEqual([d0.phase, d0.stop, d0.s], ["dwelling", 0, 6]);
  close(d0.since, 1);
  const w1 = journeyAt(p, p.depart[0]! + 0.5);
  assert.equal(w1.phase, "walking");
  assert.ok(w1.s > 6 && w1.s < 10);
  assert.deepEqual([journeyAt(p, p.arrive[1]! + 0.1).stop, journeyAt(p, p.arrive[1]! + 0.1).s], [1, 10]);
  const end = journeyAt(p, p.total + 5);
  assert.deepEqual([end.phase, end.s], ["done", 20]);
  // monotonic along the route
  let last = -1;
  for (let t = 0; t <= p.total + 1; t += 0.1) {
    const s = journeyAt(p, t).s;
    assert.ok(s >= last - 1e-9);
    last = s;
  }
});

test("journeyPose: pure function of t; stands at the stop node doing the stop's state, then rests", () => {
  // out along +x to a stop at (6,0,0), back to the start
  const route = samplePoints([[0, 0, 0], [6, 0, 0], [0, 0, 0]] as V3[]);
  const p = journeyPlan([6, 6], [{ to: "s", dwell: 4 }], 1.5);
  const at = (t: number) => journeyPose(route, p, "idle", t, 0.3);
  assert.deepEqual(at(3.3), at(3.3));
  const d = at(p.arrive[0]! + 2);
  assert.equal(d.phase, "working");
  close(d.pos[0], 6, 1e-6);
  close(d.pos[2], 0, 1e-6); // no lane offset at a stop
  close(d.yaw, Math.PI / 2, 1e-3); // faces the way it came in (+x), not the average of both legs
  const walking = at(1);
  assert.equal(walking.phase, "walking");
  assert.ok(Math.abs(walking.pos[2]) > 0.01, "keeps to its lane between stops");
  const done = at(p.total + 1);
  assert.equal(done.phase, "idle");
  close(done.pos[0], 0, 1e-6);
});

test("queue places: first on the node, later arrivals around it, places reused after leaving", () => {
  const v: StopVisit[] = [
    { key: "a", node: "n", a: 0, b: 10 },
    { key: "b", node: "n", a: 1, b: 5 },
    { key: "c", node: "n", a: 2, b: 12 },
    { key: "d", node: "n", a: 6, b: 8 }, // b left at 5: d takes place 1
    { key: "e", node: "m", a: 1, b: 9 }, // another node: its own queue
  ];
  const q = queuePlaces(v);
  assert.equal(q.get("a@0"), 0);
  assert.equal(q.get("b@1"), 1);
  assert.equal(q.get("c@2"), 2);
  assert.equal(q.get("d@6"), 1);
  assert.equal(q.get("e@1"), 0);
  // order of the input does not matter
  assert.deepEqual([...queuePlaces([...v].reverse()).entries()].sort(), [...q.entries()].sort());
});

test("queue offsets: on the node for place 0, ~0.75 m out and distinct for the next places", () => {
  assert.deepEqual(queueOffset(0, 0), [0, 0, 0]);
  const seen = new Set<string>();
  for (let k = 1; k <= 12; k++) {
    const o = queueOffset(k, 0.7);
    assert.ok(Math.hypot(o[0], o[2]) >= 0.74);
    const key = o.map((x) => x.toFixed(2)).join(",");
    assert.ok(!seen.has(key), `place ${k} overlaps another`);
    seen.add(key);
  }
  // place 1 stands behind the node, on the side the actor came from
  const o1 = queueOffset(1, 0); // walking +z into the node
  assert.ok(o1[2] < -0.7);
});

test("schema: move.stops needs `to`, no loop; unknown stop nodes are reported", () => {
  assert.ok(ActorMove.safeParse({ to: "home", stops: [{ to: "lab", dwell: 2 }] }).success);
  assert.ok(!ActorMove.safeParse({ path: "p", stops: [{ to: "lab", dwell: 2 }] }).success);
  assert.ok(!ActorMove.safeParse({ to: "home", loop: true, stops: [{ to: "lab", dwell: 2 }] }).success);
  assert.ok(!ActorMove.safeParse({ to: "home", stops: [{ to: "lab", dwell: -1 }] }).success);
  const world = WorldPack.parse({
    tera: "world/v1",
    id: "j",
    title: "journeys",
    graph: { nodes: [{ id: "home", position: [0, 0, 0] }, { id: "lab", position: [5, 0, 0] }], edges: [["home", "lab"]] },
    entities: [{ id: "bot", kind: "actor", move: { to: "home", stops: [{ to: "lab", dwell: 2 }, { to: "nowhere", dwell: 1 }] }, trail: { seconds: 2 }, card: { kind: "Journey", facts: [{ label: "model", value: "m" }] } }],
  });
  const errs = livingRefErrors(world.entities[0] as never, world as never);
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /nowhere/);
});
