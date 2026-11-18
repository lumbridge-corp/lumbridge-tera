import { test } from "node:test";
import assert from "node:assert/strict";
import { EASES, lerpTransform, progress } from "./ease.ts";

test("every ease maps 0 -> 0, 1 -> 1 and is monotonic", () => {
  for (const [name, f] of Object.entries(EASES)) {
    assert.ok(Math.abs(f(0)) < 1e-12, name);
    assert.ok(Math.abs(f(1) - 1) < 1e-12, name);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100);
      assert.ok(v >= prev - 1e-12, `${name} not monotonic at ${i}`);
      prev = v;
    }
  }
});

test("in-out eases are symmetric about the midpoint", () => {
  for (const name of ["inOutQuad", "inOutCubic", "inOutSine"] as const) {
    assert.ok(Math.abs(EASES[name](0.5) - 0.5) < 1e-12, name);
    assert.ok(Math.abs(EASES[name](0.2) + EASES[name](0.8) - 1) < 1e-12, name);
  }
});

test("progress clamps before the start and after the end", () => {
  assert.equal(progress(0, 2, 1, "linear"), 0);
  assert.equal(progress(2.5, 2, 1, "linear"), 0.5);
  assert.equal(progress(9, 2, 1, "linear"), 1);
  assert.equal(progress(2.5, 2, 1, "inQuad"), 0.25);
});

test("lerpTransform moves only the named channels", () => {
  const from = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 };
  const mid = lerpTransform(from, { position: [2, 4, 6] }, 0.5);
  assert.deepEqual(mid, { position: [1, 2, 3], rotation: [0, 0, 0], scale: 1 });
  assert.deepEqual(lerpTransform(from, { rotation: [0, 360, 0] }, 0.25).rotation, [0, 90, 0]);
});

test("lerpTransform handles scalar and vector scale", () => {
  assert.equal(lerpTransform({ scale: 1 }, { scale: 3 }, 0.5).scale, 2);
  assert.deepEqual(lerpTransform({ scale: 1 }, { scale: [3, 1, 1] }, 0.5).scale, [2, 1, 1]);
  assert.deepEqual(lerpTransform(undefined, { position: [1, 1, 1] }, 1), { position: [1, 1, 1] });
});
