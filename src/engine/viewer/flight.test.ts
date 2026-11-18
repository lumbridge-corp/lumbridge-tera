import { test } from "node:test";
import assert from "node:assert/strict";
import { Flight, angleDelta, fitAspect, flightDuration, flightPose, framePose, outwardDir, type Pose } from "./flight.ts";

const A: Pose = { position: [20, 10, 0], target: [0, 0, 0], fov: 45 };
const B: Pose = { position: [-5, 3, 12], target: [-5, 0, 2], fov: 35 };
const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

test("flight: starts at A, ends exactly at B", () => {
  const s = flightPose(A, B, 0), e = flightPose(A, B, 1);
  assert.ok(close(s.position, A.position) && close(s.target, A.target));
  assert.ok(close(e.position, B.position) && close(e.target, B.target));
  assert.equal(e.fov, 35);
  const f = new Flight(A, B, 10);
  assert.deepEqual(f.at(10 + f.duration + 0.01), { pose: B, done: true });
  assert.equal(f.at(10).done, false);
});

test("flight: swings around the target, never through it", () => {
  // Opposite sides of the same target: a straight line would pass through the middle.
  const P: Pose = { position: [10, 2, 0], target: [0, 0, 0], fov: 45 };
  const Q: Pose = { position: [-10, 2, 0], target: [0, 0, 0], fov: 45 };
  for (let u = 0; u <= 1; u += 0.1) {
    const p = flightPose(P, Q, u).position;
    assert.ok(Math.hypot(p[0], p[1], p[2]) > 9.9, `u=${u}`);
  }
});

test("flight: azimuth takes the short way round", () => {
  assert.ok(Math.abs(angleDelta(3, -3) - (2 * Math.PI - 6)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3, 3) + (2 * Math.PI - 6)) < 1e-9);
});

test("flight: duration grows with the trip, stays in 0.8–2.2 s; reduced motion is short", () => {
  const near: Pose = { ...A, position: [20, 10, 0.5] };
  assert.equal(flightDuration(A, A), 0.8);
  assert.ok(flightDuration(A, near) < flightDuration(A, B));
  assert.ok(flightDuration(A, B) <= 2.2);
  assert.equal(flightDuration(A, B, true), 0.3);
});

test("flight: framePose fits a box and keeps a minimum distance", () => {
  const box = { min: [-1, 0, -1] as [number, number, number], max: [1, 2, 1] as [number, number, number] };
  const p = framePose(box, [0, 0, 1], 45, 16 / 9, 3);
  assert.deepEqual(p.target, [0, 1, 0]);
  const d = Math.hypot(p.position[0], p.position[1] - 1, p.position[2]);
  assert.ok(d >= 3 && d < 6, `distance ${d}`);
  const tiny = framePose({ min: [0, 0, 0], max: [0.1, 0.1, 0.1] }, [1, 1, 0], 45, 1, 3);
  assert.ok(Math.abs(Math.hypot(tiny.position[0] - 0.05, tiny.position[1] - 0.05, tiny.position[2] - 0.05) - 3) < 1e-9);
});

test("flight: outwardDir points away from the centre and up", () => {
  const d = outwardDir([0, 0, 0], [10, 0, 0], 30);
  assert.ok(d[0] > 0.8 && d[1] > 0.45 && Math.abs(d[2]) < 1e-9);
});

test("flight: fitAspect pulls back on portrait screens only, capped", () => {
  const P: Pose = { position: [0, 0, 10], target: [0, 0, 0], fov: 45 };
  assert.deepEqual(fitAspect(P, 16 / 9), P);
  assert.deepEqual(fitAspect(P, 2.4), P);
  const tall = fitAspect(P, 390 / 844);
  assert.ok(tall.position[2] > 10 && tall.position[2] <= 15 + 1e-9, String(tall.position[2]));
  assert.deepEqual(tall.target, P.target);
  const square = fitAspect(P, 1).position[2];
  assert.ok(square > 10 && square <= tall.position[2]);
});
