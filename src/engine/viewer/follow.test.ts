import { test } from "node:test";
import assert from "node:assert/strict";
import { followCandidates, followLayer, poseFits } from "./follow.ts";
import type { Layer } from "../../schema/index.ts";

const surface: Layer = { id: "surface", name: "Town", floorY: 0, walk: { center: [0, 0], radius: 29 }, spawn: [4, 0, 6] };
const compute: Layer = { id: "compute", name: "Compute", floorY: -17, walk: { center: [0, 0], radius: 11 }, spawn: [-3, -17, 0], height: 4.4 };
const layers = [surface, compute];
const robot = (y: number, x = 2, z = 2) => ({ min: [x - 0.3, y, z - 0.3] as [number, number, number], max: [x + 0.3, y + 0.9, z + 0.3] as [number, number, number] });

test("follow: a robot in a lift shaft is between layers; on a floor it is on that layer", () => {
  assert.equal(followLayer(layers, [2, 0.1, 2])?.id, "surface");
  assert.equal(followLayer(layers, [2, -8, 2]), null);
  assert.equal(followLayer(layers, [2, -12.3, 2]), null, "in the shaft above the ceiling: not in the room yet");
  assert.equal(followLayer(layers, [2, -14, 2]), null, "just under the ceiling: not yet");
  assert.equal(followLayer(layers, [2, -17, 2])?.id, "compute");
});

test("follow: poses fit a room (above the floor, under the ceiling, inside the glass); open sky only needs the floor", () => {
  assert.ok(poseFits(compute, [3, -14, 3]));
  assert.ok(!poseFits(compute, [3, -12.5, 3]), "through the ceiling");
  assert.ok(!poseFits(compute, [12, -15, 3]), "outside the room");
  assert.ok(!poseFits(compute, [3, -16.9, 3]), "under the floor");
  assert.ok(poseFits(surface, [3, 40, 3]));
  assert.ok(poseFits(null, [3, -100, 3]));
});

test("follow: candidates in a room all stay under its ceiling, best first is the current bearing", () => {
  const c = followCandidates(robot(-17), [1, 1, 1], 45, 16 / 9, compute);
  assert.ok(c.length > 8);
  for (const p of c) assert.ok(poseFits(compute, p.position));
  const open = followCandidates(robot(0), [1, 1, 1], 45, 16 / 9, surface);
  const p0 = open[0]!;
  assert.ok(p0.position[0] > p0.target[0] && p0.position[2] > p0.target[2] && p0.position[1] > p0.target[1] + 3, "about 50 deg above, same bearing");
});
