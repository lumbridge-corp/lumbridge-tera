import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, QualityGovernor, initialLevel, levelIndex, median, pixelRatioAt } from "./quality.ts";

const feed = (g: QualityGovernor, fps: number, seconds: number) => {
  const changes: number[] = [];
  for (let t = 0; t < seconds; t += 1 / fps) {
    const n = g.frame(1 / fps);
    if (n !== null) changes.push(n);
  }
  return changes;
};

test("quality: DPR is capped at 2 and by level", () => {
  assert.equal(pixelRatioAt(0, 3), 2);
  assert.equal(pixelRatioAt(0, 1), 1);
  assert.equal(pixelRatioAt(1, 3), 1.5);
  assert.equal(pixelRatioAt(LEVELS.length - 1, 2), 0.75);
  assert.ok(LEVELS.every((l) => l.dprCap <= 2));
});

test("quality: phones start one step down, desktops at high", () => {
  assert.equal(initialLevel({ coarsePointer: true, minScreenSide: 390, dpr: 3 }), 1);
  assert.equal(initialLevel({ coarsePointer: false, minScreenSide: 900, dpr: 2 }), 0);
  assert.equal(levelIndex("low"), 2);
  assert.equal(levelIndex("nope"), -1);
});

test("quality: a fast device stays at high and settles", () => {
  const g = new QualityGovernor(0);
  assert.deepEqual(feed(g, 60, 6), []);
  assert.equal(g.settled, true);
  assert.equal(g.level, 0);
});

test("quality: a slow device steps down (two steps under 24 fps), never back up", () => {
  const g = new QualityGovernor(0);
  const c = feed(g, 20, 3);
  assert.deepEqual(c, [2]);
  assert.equal(LEVELS[g.level]!.post, false);
  feed(g, 60, 10);
  assert.equal(g.level, 2);
});

test("quality: 35 fps steps one level at a time, stops at the last", () => {
  const g = new QualityGovernor(0);
  feed(g, 35, 30);
  assert.equal(g.level, LEVELS.length - 1);
});

test("quality: the warm-up second is ignored and long frames are dropped", () => {
  const g = new QualityGovernor(0);
  for (let i = 0; i < 4; i++) assert.equal(g.frame(0.2), null); // 0.8 s of 5 fps: warm-up
  assert.equal(g.frame(3), null); // a tab switch
  assert.deepEqual(feed(g, 60, 3), []);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("quality: once settled only a sustained slump steps down", () => {
  const g = new QualityGovernor(0);
  feed(g, 60, 5);
  assert.ok(g.settled);
  assert.deepEqual(feed(g, 38, 6), []); // 38 fps: fine once settled
  assert.equal(feed(g, 25, 12).length, 1);
});
