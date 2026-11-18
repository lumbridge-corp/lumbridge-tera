import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_LABELS, labelFit, screenPx } from "./label-fit.ts";

const H = 0.24;

test("label-fit: a tag never draws taller than maxPx, however close", () => {
  for (const d of [0.3, 0.6, 1, 2, 3, 5]) {
    const f = labelFit(H, d, 45, 900);
    assert.ok(f.px <= LIVE_LABELS.maxPx + 1e-9, `depth ${d}: ${f.px}px`);
  }
  // 2 m away at 45° on a 900 px viewport the raw tag is ~65 px; fitted it is 22.
  assert.ok(screenPx(H, 2, 45, 900) > 60);
  assert.equal(Math.round(labelFit(H, 2, 45, 900).px), LIVE_LABELS.maxPx);
});

test("label-fit: far tags keep world size until they get too small, then fade", () => {
  const mid = labelFit(H, 12, 45, 900); // ~11 px: readable, unscaled
  assert.equal(mid.scale, 1);
  assert.ok(mid.opacity > 0.5);
  const far = labelFit(H, 60, 45, 900); // ~2 px
  assert.equal(far.opacity, 0);
});

test("label-fit: hidden at and behind the camera, fades in over near..nearFull", () => {
  assert.equal(labelFit(H, -1, 45, 900).opacity, 0);
  assert.equal(labelFit(H, 0, 45, 900).opacity, 0);
  assert.equal(labelFit(H, 0.5, 45, 900).opacity, 0);
  const a = labelFit(H, 1.4, 45, 900).opacity, b = labelFit(H, 2, 45, 900).opacity;
  assert.ok(a > 0 && a < b && b < 1);
  assert.equal(labelFit(H, 3, 45, 900).opacity, 1);
});

test("label-fit: deterministic (same inputs, same output)", () => {
  assert.deepEqual(labelFit(H, 4.2, 38, 1080), labelFit(H, 4.2, 38, 1080));
});
