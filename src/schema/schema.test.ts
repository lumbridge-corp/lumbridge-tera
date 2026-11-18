import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CameraScript, WorldPack } from "./index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("demo world parses", () => {
  const w = WorldPack.parse(read("../../worlds/demo/world.json"));
  assert.equal(w.id, "demo");
});

test("demo camera script parses", () => {
  const s = CameraScript.parse(read("../../worlds/demo/intro.camera.json"));
  assert.equal(s.shots.length, 2);
});

test("overlapping shots are rejected", () => {
  const bad = read("../../worlds/demo/intro.camera.json");
  bad.shots[1].start = 3;
  assert.equal(CameraScript.safeParse(bad).success, false);
});
