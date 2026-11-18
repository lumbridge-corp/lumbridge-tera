import { test } from "node:test";
import assert from "node:assert/strict";
import { actorPose, flowPulses, flowRate, maxPulses, nearestNode, pointAt, roundCorners, route, samplePoints, tangentAt, travel, type V3 } from "./living-math.ts";
import type { Graph } from "../schema/living.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const closeV = (a: V3, b: V3, eps = 1e-6) => a.forEach((v, i) => close(v, b[i]!, eps));

test("polyline sampling: length, points by arc length, clamping", () => {
  const p = samplePoints([[0, 0, 0], [3, 0, 0], [3, 0, 4]]);
  close(p.length, 7);
  closeV(pointAt(p, 1.5), [1.5, 0, 0]);
  closeV(pointAt(p, 5), [3, 0, 2]);
  closeV(pointAt(p, -1), [0, 0, 0]);
  closeV(pointAt(p, 99), [3, 0, 4]);
  closeV(tangentAt(p, 1), [1, 0, 0]);
  closeV(tangentAt(p, 6), [0, 0, 1]);
});

test("closed paths wrap", () => {
  const sq = samplePoints([[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]], { closed: true });
  close(sq.length, 8);
  closeV(pointAt(sq, 9), [1, 0, 0]);
  closeV(pointAt(sq, -1), [0, 0, 1]);
});

test("smooth paths pass through their points and are longer than the chord", () => {
  const pts: V3[] = [[0, 0, 0], [4, 0, 2], [8, 0, 0], [12, 0, 3]];
  const s = samplePoints(pts, { smooth: true });
  assert.ok(s.length > 12);
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < s.cum.length; i++) best = Math.min(best, Math.hypot(s.pts[i * 3]! - p[0], s.pts[i * 3 + 1]! - p[1], s.pts[i * 3 + 2]! - p[2]));
    assert.ok(best < 1e-9, `control point ${p} not on curve (${best})`);
  }
});

test("roundCorners keeps the ends and cuts the corner", () => {
  const r = roundCorners([[0, 0, 0], [4, 0, 0], [4, 0, 4]], 1);
  closeV(r[0]!, [0, 0, 0]);
  closeV(r[r.length - 1]!, [4, 0, 4]);
  const s = samplePoints(r);
  assert.ok(s.length < 8 && s.length > 7);
});

const graph: Graph = {
  nodes: [
    { id: "a", position: [0, 0, 0] },
    { id: "b", position: [10, 0, 0] },
    { id: "c", position: [5, 0, 1] },
    { id: "d", position: [5, 0, -20] },
    { id: "lonely", position: [50, 0, 50] },
  ],
  edges: [["a", "c"], ["c", "b"], ["a", "d"], { from: "d", to: "b" }],
};

test("route takes the shortest way through the graph", () => {
  const r = route(graph, [], "a", "b")!;
  assert.deepEqual(r, [[0, 0, 0], [5, 0, 1], [10, 0, 0]]);
  assert.equal(route(graph, [], "a", "lonely"), null);
  assert.equal(nearestNode(graph, [9, 0, 1]), "b");
});

test("route follows an edge's named path, in walking direction", () => {
  const g: Graph = { nodes: [{ id: "x", position: [0, 0, 0] }, { id: "y", position: [0, 0, 10] }], edges: [{ from: "y", to: "x", path: "arc" }] };
  const paths = [{ id: "arc", points: [[0, 0, 10], [3, 0, 5], [0, 0, 0]] as V3[] }];
  assert.deepEqual(route(g, paths, "x", "y"), [[0, 0, 0], [3, 0, 5], [0, 0, 10]]);
});

test("travel: trapezoid profile, continuous, ends at rest", () => {
  const { T } = travel(10, 2, 0);
  close(T, 10 / 2 + 0.6);
  let prev = 0;
  for (let t = 0; t <= T + 0.01; t += 0.05) {
    const r = travel(10, 2, t);
    assert.ok(r.s >= prev - 1e-9 && r.s <= 10 + 1e-9);
    prev = r.s;
  }
  close(travel(10, 2, T).s, 10);
  close(travel(10, 2, T / 2).v, 2);
  // Too short to reach full speed: triangle profile.
  const short = travel(0.3, 2, 0);
  close(travel(0.3, 2, short.T).s, 0.3);
});

test("actor pose is a pure function of t (determinism)", () => {
  const r = samplePoints([[0, 0, 0], [6, 0, 0], [6, 0, 6]]);
  const move = { speed: 1.5, loop: true, dwell: 2, startT: 1 };
  for (const t of [0, 0.5, 1.3, 4.7, 9.9, 23.1]) {
    const a = actorPose(r, move, "working", t), b = actorPose(r, move, "working", t);
    assert.deepEqual(a, b);
  }
  // Out-of-order evaluation (seeking backwards) gives the same answer.
  const forward = [0, 3, 6, 9].map((t) => actorPose(r, move, "working", t));
  const backward = [9, 6, 3, 0].map((t) => actorPose(r, move, "working", t)).reverse();
  assert.deepEqual(forward, backward);
});

test("actor walks, faces its direction, works at the ends, comes back", () => {
  const r = samplePoints([[0, 0, 0], [0, 0, 6]]);
  const move = { speed: 2, loop: true, dwell: 3 };
  const T = travel(6, 2, 0).T;
  const mid = actorPose(r, move, "working", T / 2);
  assert.equal(mid.phase, "walking");
  close(mid.pos[2], 3, 1e-6);
  close(mid.yaw, 0, 1e-6); // facing +Z
  const atEnd = actorPose(r, move, "working", T + 1);
  assert.equal(atEnd.phase, "working");
  closeV(atEnd.pos, [0, 0, 6]);
  const back = actorPose(r, move, "working", T + 3 + T / 2);
  assert.equal(back.phase, "walking");
  close(Math.abs(back.yaw), Math.PI, 1e-6); // facing -Z on the way back
  closeV(actorPose(r, move, "working", 2 * (T + 3) + 0.0001).pos, [0, 0, 0], 1e-3);
});

test("actor one-shot route: idle before start, arrives and stays", () => {
  const r = samplePoints([[0, 0, 0], [4, 0, 0]]);
  const move = { speed: 1, startT: 2 };
  assert.equal(actorPose(r, move, "idle", 1).phase, "idle");
  closeV(actorPose(r, move, "idle", 1).pos, [0, 0, 0]);
  const done = actorPose(r, move, "working", 100);
  assert.equal(done.phase, "working");
  closeV(done.pos, [4, 0, 0]);
  close(actorPose(r, move, "idle", 4).yaw, Math.PI / 2, 1e-6); // facing +X
});

test("actor on a closed path loops forever at speed", () => {
  const sq = samplePoints([[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]], { closed: true });
  const p = actorPose(sq, { speed: 2, offset: 1 }, "idle", 50);
  assert.equal(p.phase, "walking");
  close(p.speed, 1);
  const s = 1 + 0.5 * 2 * 0.6 + 2 * (50 - 0.6);
  closeV(p.pos, pointAt(sq, s));
});

test("flow pulses: exact, steady from t=0, evenly spaced, seekable", () => {
  const L = 12, rate = 3, speed = 4;
  const a = flowPulses(L, rate, speed, 0).map((p) => ({ ...p }));
  assert.ok(a.length >= Math.floor((L / speed) * rate), "flow is already full at t=0");
  for (const t of [0, 0.37, 5, 100.25]) {
    const p = flowPulses(L, rate, speed, t).map((x) => ({ ...x }));
    assert.deepEqual(p, flowPulses(L, rate, speed, t).map((x) => ({ ...x })));
    for (const x of p) {
      assert.ok(x.s >= 0 && x.s <= L);
      close(x.s, (t - x.i / rate) * speed, 1e-9);
    }
    const ss = p.map((x) => x.s).sort((u, v) => u - v);
    for (let i = 1; i < ss.length; i++) close(ss[i]! - ss[i - 1]!, speed / rate, 1e-9);
    assert.ok(p.length <= maxPulses(L, rate, speed));
  }
  // A pulse keeps its index while it travels.
  const before = flowPulses(L, rate, speed, 2).find((p) => p.s > 3 && p.s < 5)!;
  const after = flowPulses(L, rate, speed, 2.5).find((p) => p.i === before.i)!;
  close(after.s - before.s, 0.5 * speed, 1e-9);
});

test("closed flows tile the loop with no seam", () => {
  const L = 10, speed = 3, rate = 2.2;
  const r = flowRate(L, rate, speed, true);
  const n = (L / speed) * r;
  close(n, Math.round(n), 1e-9);
  const p = flowPulses(L, rate, speed, 7.3, true);
  assert.equal(p.length, Math.round(n));
});
