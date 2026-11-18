import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CameraScript, Ease } from "../schema/index.ts";
import { catmull, evaluateCamera, frameCount, frameTime } from "./evaluate.ts";
import { EASES, ease } from "./ease.ts";

const demo = CameraScript.parse(JSON.parse(readFileSync(new URL("../../worlds/demo/intro.camera.json", import.meta.url), "utf8")));

const close = (a: number[], b: number[], eps = 1e-9, msg?: string) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]!) <= eps, msg ?? `${JSON.stringify(a)} != ${JSON.stringify(b)}`));
const len = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));

function script(over: Partial<CameraScript>): CameraScript {
  return CameraScript.parse({ tera: "camera/v1", fps: 30, width: 640, height: 360, duration: 10, ...over });
}

test("eases: endpoints, monotone, symmetric in-out", () => {
  for (const name of Ease.options) {
    assert.equal(ease(name, 0), 0, name);
    assert.ok(Math.abs(ease(name, 1) - 1) < 1e-12, name);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = ease(name, i / 100);
      assert.ok(v >= prev - 1e-12, `${name} not monotone`);
      prev = v;
    }
    assert.equal(ease(name, -1), 0);
    assert.ok(Math.abs(ease(name, 2) - 1) < 1e-12);
  }
  for (const n of ["inOutQuad", "inOutCubic", "inOutSine"] as const) assert.ok(Math.abs(EASES[n](0.5) - 0.5) < 1e-12, n);
  assert.ok(ease("inCubic", 0.25) < 0.25 && ease("outCubic", 0.25) > 0.25);
});

test("demo: first and last keys are hit exactly, fov interpolates", () => {
  assert.deepEqual(evaluateCamera(demo, 0), { position: [14, 8, 16], target: [0, 0.8, 0], fov: 38 });
  assert.deepEqual(evaluateCamera(demo, 4).position, [5, 2.5, 6.5]);
  const mid = evaluateCamera(demo, 2).fov!;
  assert.ok(mid > 38 && mid < 45);
});

test("demo: orbit end pose and hold past the end", () => {
  const end = evaluateCamera(demo, 8);
  const r = (140 * Math.PI) / 180;
  close(end.position, [8 * Math.cos(r), 0.8 + 2.2, 8 * Math.sin(r)]);
  assert.deepEqual(end.target, [0, 0.8, 0]);
  assert.deepEqual(evaluateCamera(demo, 99), end);
});

test("two keys with catmull is a straight line (reflected ends)", () => {
  const s = script({ shots: [{ id: "a", start: 0, end: 4, kind: "keys", path: "catmull", keys: [{ t: 0, position: [0, 0, 0], target: [0, 0, -1] }, { t: 4, position: [8, 4, 0], target: [0, 0, -1] }] }] });
  for (const t of [0.5, 1, 2, 3.3]) close(evaluateCamera(s, t).position, [2 * t, t, 0], 1e-9);
});

test("catmull passes through every key and stays smooth", () => {
  const keys = [
    { t: 0, position: [0, 2, 10], target: [0, 0, 0], fov: 40 },
    { t: 2, position: [10, 3, 0], target: [0, 0, 0], fov: 50 },
    { t: 4, position: [0, 4, -10], target: [0, 1, 0], fov: 50 },
    { t: 6, position: [-10, 2, 0], target: [0, 0, 0], fov: 40 },
  ] as { t: number; position: [number, number, number]; target: [number, number, number]; fov: number }[];
  const s = script({ shots: [{ id: "a", start: 0, end: 6, kind: "keys", path: "catmull", ease: "linear", keys }] });
  for (const k of keys) {
    const p = evaluateCamera(s, k.t);
    close(p.position, k.position, 1e-9);
    close(p.target, k.target, 1e-9);
    assert.ok(Math.abs(p.fov! - k.fov) < 1e-9);
  }
  // no velocity spikes: per-frame step lengths stay within a small ratio of each other
  const steps: number[] = [];
  for (let n = 1; n <= 180; n++) steps.push(len(evaluateCamera(s, frameTime(n, 30)).position, evaluateCamera(s, frameTime(n - 1, 30)).position));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! / steps[i - 1]! < 1.25 && steps[i]! / steps[i - 1]! > 0.8, `jerk at frame ${i}: ${steps[i - 1]} -> ${steps[i]}`);
  // it curves: the midpoint of 0→2 is outside the straight chord
  const mid = evaluateCamera(s, 1).position;
  assert.ok(len(mid, [5, 2.5, 5]) > 0.5);
});

test("centripetal catmull: no cusp or overshoot with uneven spacing", () => {
  const p0 = [0, 0], p1 = [1, 0], p2 = [1.05, 0], p3 = [5, 0];
  for (let i = 0; i <= 20; i++) {
    const x = catmull(p0, p1, p2, p3, i / 20)[0]!;
    assert.ok(x >= 1 - 1e-9 && x <= 1.05 + 1e-9, `overshoot ${x}`);
  }
  // coincident points do not produce NaN
  assert.ok(catmull([0, 0], [0, 0], [0, 0], [1, 1], 0.5).every(Number.isFinite));
});

test("ease warps the whole key range: inOutCubic starts slow, ends slow, does not stop at middle keys", () => {
  const keys = [0, 1, 2, 3].map((i) => ({ t: i * 2, position: [i * 4, 1, 0] as [number, number, number], target: [0, 0, -5] as [number, number, number] }));
  const s = script({ shots: [{ id: "a", start: 0, end: 6, kind: "keys", path: "linear", ease: "inOutCubic", keys }] });
  const step = (t: number) => len(evaluateCamera(s, t + 1 / 30).position, evaluateCamera(s, t).position);
  assert.ok(step(0) < step(3) / 10, "start not slow");
  assert.ok(step(6 - 1 / 30) < step(3) / 10, "end not slow");
  assert.ok(step(2) > step(0) * 5 && step(4 - 1 / 30) > step(0) * 5, "stops at a middle key");
  close(evaluateCamera(s, 3).position, [6, 1, 0], 1e-9); // symmetric ease: halfway in time = halfway in path
});

test("linear path follows straight segments", () => {
  const s = script({ shots: [{ id: "a", start: 0, end: 2, kind: "keys", path: "linear", keys: [{ t: 0, position: [0, 0, 0], target: [0, 0, -1] }, { t: 1, position: [1, 0, 0], target: [0, 0, -1] }, { t: 2, position: [1, 1, 0], target: [0, 0, -1] }] }] });
  close(evaluateCamera(s, 0.5).position, [0.5, 0, 0]);
  close(evaluateCamera(s, 1.5).position, [1, 0.5, 0]);
});

test("fov: missing fovs inherit, default 45, orbit default 45", () => {
  const s = script({
    shots: [
      { id: "a", start: 0, end: 2, kind: "keys", keys: [{ t: 0, position: [0, 0, 5], target: [0, 0, 0] }, { t: 2, position: [1, 0, 5], target: [0, 0, 0], fov: 60 }] },
      { id: "b", start: 2, end: 4, kind: "keys", keys: [{ t: 2, position: [0, 0, 5], target: [0, 0, 0] }] },
      { id: "c", start: 4, end: 6, kind: "orbit", center: [0, 0, 0], radius: 3, height: 1, fromDeg: 0, toDeg: 90 },
    ],
  });
  assert.equal(evaluateCamera(s, 0).fov, 60); // inherits the next defined
  assert.equal(evaluateCamera(s, 1).fov, 60);
  assert.equal(evaluateCamera(s, 3).fov, 45);
  assert.equal(evaluateCamera(s, 5).fov, 45);
});

test("target interpolates", () => {
  const s = script({ shots: [{ id: "a", start: 0, end: 2, kind: "keys", keys: [{ t: 0, position: [0, 0, 10], target: [-2, 0, 0] }, { t: 2, position: [0, 0, 10], target: [2, 0, 0] }] }] });
  close(evaluateCamera(s, 1).target, [0, 0, 0], 1e-9);
});

test("holds: before first shot, in gaps, before first key and after last key in a shot", () => {
  const s = script({
    shots: [
      { id: "a", start: 1, end: 3, kind: "keys", keys: [{ t: 1.5, position: [0, 0, 5], target: [0, 0, 0] }, { t: 2.5, position: [4, 0, 5], target: [0, 0, 0] }] },
      { id: "b", start: 5, end: 7, kind: "orbit", center: [0, 0, 0], radius: 2, height: 0, fromDeg: 0, toDeg: 180 },
    ],
  });
  assert.deepEqual(evaluateCamera(s, 0).position, [0, 0, 5]); // before first shot
  assert.deepEqual(evaluateCamera(s, 1.2).position, [0, 0, 5]); // before first key
  assert.deepEqual(evaluateCamera(s, 2.8).position, [4, 0, 5]); // after last key
  assert.deepEqual(evaluateCamera(s, 4).position, [4, 0, 5]); // gap holds end of a
  close(evaluateCamera(s, 6).position, [0, 0, 2]); // orbit at 90°
  close(evaluateCamera(s, 9).position, [-2, 0, 0]); // after the end holds the orbit end
});

test("orbit eases angle", () => {
  const s = script({ shots: [{ id: "o", start: 0, end: 2, kind: "orbit", center: [1, 1, 1], radius: 2, height: 3, fromDeg: 0, toDeg: 90, ease: "inQuad" }] });
  const p = evaluateCamera(s, 1);
  const r = ((90 * 0.25) * Math.PI) / 180;
  close(p.position, [1 + 2 * Math.cos(r), 4, 1 + 2 * Math.sin(r)]);
  assert.deepEqual(p.target, [1, 1, 1]);
});

test("deterministic and order-independent", () => {
  const shuffled = { ...demo, shots: [...demo.shots].reverse() };
  for (let n = 0; n < frameCount(demo); n += 7) assert.deepEqual(evaluateCamera(shuffled, n / 30), evaluateCamera(demo, n / 30));
  assert.equal(frameCount(demo), 240);
  assert.equal(frameCount({ duration: 1.01, fps: 30 }), 30);
});
