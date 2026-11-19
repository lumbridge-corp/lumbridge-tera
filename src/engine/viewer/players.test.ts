import { test } from "node:test";
import assert from "node:assert/strict";
import type { Layer } from "../../schema/index.ts";
import { WorldPack } from "../../schema/index.ts";
import {
  FLY, Interp, WALK, clampCamera, clampToDisc, flyStep, followPose, groundDir, hash01, headingOf, layerAt, planRide, rideAt, sortLayers, spawnPoint, tagOpacity, visibleTags, walkStep,
  type Body, type MoveInput,
} from "./players.ts";
import { worldLayers } from "./play.ts";

const surface: Layer = { id: "surface", name: "Town", floorY: 0, walk: { center: [0, 0], radius: 29 }, spawn: [4, 0, 6] };
const compute: Layer = { id: "compute", name: "Compute", floorY: -17.1, walk: { center: [0, 0], radius: 11 }, spawn: [3, -17.1, 3], height: 13 };
const LAYERS = [compute, surface];
const still: MoveInput = { x: 0, y: 0, z: 0, fast: false };
const fwd: MoveInput = { x: 0, y: 0, z: 1, fast: false };
const body = (p: [number, number, number]): Body => ({ position: p, velocity: [0, 0, 0], heading: 0 });
const run = (b: Body, n: number, f: (b: Body) => Body) => { for (let i = 0; i < n; i++) b = f(b); return b; };
const ease = (u: number) => u;

test("layers: sorted top to bottom, the layer a point is in", () => {
  assert.deepEqual(sortLayers(LAYERS).map((l) => l.id), ["surface", "compute"]);
  assert.equal(layerAt(LAYERS, [0, 0, 0])?.id, "surface");
  assert.equal(layerAt(LAYERS, [2, -15, 2])?.id, "compute");
  assert.equal(layerAt(LAYERS, [2, -2, 2]), null, "between floors, above compute's ceiling");
  assert.equal(layerAt(LAYERS, [40, 0, 0]), null, "outside the walk disc");
  assert.equal(layerAt(LAYERS, [20, -16, 0]), null, "under the town, outside compute");
});

test("camera-relative directions: forward follows the yaw, right is to the right", () => {
  const [fx, fz] = groundDir(fwd, 0);
  assert.ok(Math.abs(fx) < 1e-9 && Math.abs(fz - 1) < 1e-9);
  const [rx, rz] = groundDir({ x: 1, y: 0, z: 0, fast: false }, 0);
  assert.ok(Math.abs(rx + 1) < 1e-9 && Math.abs(rz) < 1e-9, "looking +Z, right is -X (right-handed)");
  assert.equal(Math.round(headingOf(1, 0)), 90);
  const [dx, dz] = groundDir({ x: 1, y: 0, z: 1, fast: false }, 0);
  assert.ok(Math.abs(Math.hypot(dx, dz) - 1) < 1e-9, "diagonals are not faster");
});

test("walk: eases up to walking speed, runs with shift, stays on the floor", () => {
  let b = body([0, 3, 0]);
  b = run(b, 120, (x) => walkStep(x, fwd, 0, 1 / 60, surface));
  assert.equal(b.position[1], 0, "on the floor");
  assert.ok(Math.abs(b.velocity[2] - WALK.speed) < 0.05, `speed ${b.velocity[2]}`);
  const r = run(b, 120, (x) => walkStep(x, { ...fwd, fast: true }, 0, 1 / 60, surface));
  assert.ok(Math.abs(r.velocity[2] - WALK.run) < 0.1);
  const s = run(r, 240, (x) => walkStep(x, still, 0, 1 / 60, surface));
  assert.ok(Math.hypot(s.velocity[0], s.velocity[2]) < 0.01, "stops when the keys are up");
  assert.ok(Math.abs(s.heading) < 1 || Math.abs(s.heading - 360) < 1, "faces where it walked");
});

test("walk: never leaves the walk disc", () => {
  let b = body([0, 0, 0]);
  b = run(b, 2000, (x) => walkStep(x, { ...fwd, fast: true }, 0.4, 1 / 30, surface));
  assert.ok(Math.hypot(b.position[0], b.position[2]) <= surface.walk.radius - WALK.radius + 1e-6);
  const [x, z] = clampToDisc(compute, 50, 0);
  assert.ok(Math.abs(Math.hypot(x, z) - (11 - WALK.radius)) < 1e-9);
});

test("walk: a wall stops the body and it slides along it", () => {
  // a wall at x = 2 (anything crossing it is blocked)
  const wall = (a: number[], b: number[]) => (a[0]! < 2) !== (b[0]! < 2);
  let b = body([0, 0, 0]);
  const diag = { x: -1, y: 0, z: 1, fast: false }; // yaw 0: right = -X, so x:-1 walks toward +X
  b = run(b, 300, (x) => walkStep(x, diag, 0, 1 / 60, surface, wall));
  assert.ok(b.position[0] < 2, `stopped before the wall: x ${b.position[0]}`);
  assert.ok(b.position[2] > 3, `slid along it: z ${b.position[2]}`);
});

test("fly: climbs, never below the floor of the layer it is in, never through the compute ceiling", () => {
  const up = { x: 0, y: 1, z: 0, fast: false }, down = { x: 0, y: -1, z: 0, fast: false };
  let b = body([0, 2, 0]);
  b = run(b, 200, (x) => flyStep(x, down, 0, 0, 1 / 60, LAYERS));
  assert.ok(Math.abs(b.position[1] - FLY.margin) < 1e-6, `held at the town floor: ${b.position[1]}`);
  b = run(b, 120, (x) => flyStep(x, up, 0, 0, 1 / 60, LAYERS));
  assert.ok(b.position[1] > 5);
  let c = body([2, -15, 2]);
  c = run(c, 400, (x) => flyStep(x, up, 0, 0, 1 / 60, LAYERS));
  assert.ok(c.position[1] <= -17.1 + 13 - FLY.margin + 1e-6, `under the machine room ceiling: ${c.position[1]}`);
  c = run(c, 600, (x) => flyStep(x, down, 0, 0, 1 / 60, LAYERS));
  assert.ok(Math.abs(c.position[1] - (-17.1 + FLY.margin)) < 1e-6, `on the machine room floor: ${c.position[1]}`);
  const fast = run(body([0, 30, 0]), 300, (x) => flyStep(x, { ...fwd, fast: true }, 0, 0, 1 / 60, LAYERS));
  assert.ok(Math.abs(fast.velocity[2] - FLY.speed * FLY.boost) < 0.5, "shift boosts");
});

test("fly: solid geometry (the rock) stops it", () => {
  const rock = (_a: number[], b: number[]) => b[1]! < 10 && Math.hypot(b[0]!, b[2]!) > 40;
  let b = body([45, 20, 0]);
  b = run(b, 600, (x) => flyStep(x, { x: 0, y: -1, z: 0, fast: false }, 0, 0, 1 / 60, LAYERS, rock));
  assert.ok(b.position[1] >= 10 - 0.2, `stopped above the rock: ${b.position[1]}`);
});

test("follow camera: behind and above the head; kept between floor and ceiling", () => {
  const p = followPose([0, 0, 0], 0, -0.3, 5);
  assert.ok(p.position[2] < 0 && p.position[1] > WALK.eye, "behind (looking +Z) and above");
  assert.deepEqual(p.target, [0, WALK.eye, 0]);
  const c = clampCamera([0, -20, 0], compute);
  assert.ok(c[1] >= -17.1 + 0.25);
  assert.ok(clampCamera([0, 10, 0], compute)[1] <= -17.1 + 13);
});

test("remote interpolation: between states, holds the last one, resets on teleport", () => {
  const it = new Interp(0.1);
  it.push({ t: 1, position: [0, 0, 0], heading: 350 });
  it.push({ t: 1.1, position: [1, 0, 0], heading: 10 });
  const mid = it.at(1.15)!;
  assert.ok(Math.abs(mid.position[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.heading - 0) < 1e-6 || Math.abs(mid.heading - 360) < 1e-6, `short way round: ${mid.heading}`);
  assert.ok(Math.abs(mid.speed - 10) < 1e-6);
  assert.deepEqual(it.at(5)!.position, [1, 0, 0]);
  assert.equal(it.at(5)!.speed, 0);
  it.reset({ t: 6, position: [9, 9, 9], heading: 0 });
  assert.deepEqual(it.at(7)!.position, [9, 9, 9]);
});

test("name tags: fade with distance, nearest 8 only", () => {
  assert.equal(tagOpacity(3), 1);
  assert.equal(tagOpacity(30), 1);
  assert.equal(tagOpacity(190), 0);
  assert.ok(tagOpacity(130) > 0 && tagOpacity(130) < 1);
  const list = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, dist: 2 + i }));
  const s = visibleTags(list);
  assert.equal(s.size, 8);
  assert.ok(s.has("p0") && !s.has("p11"));
  assert.equal(visibleTags([{ id: "far", dist: 190 }]).size, 0);
});

test("spawn points: inside the disc, different per player, on the floor", () => {
  const a = spawnPoint(surface, hash01("a")), b = spawnPoint(surface, hash01("b"));
  assert.notDeepEqual(a, b);
  for (const p of [a, b]) assert.ok(Math.hypot(p[0] - 4, p[2] - 6) < 2.5 && p[1] === 0);
});

test("layer travel: with a lift, walk in, ride, walk out; without, one flight", () => {
  const r = planRide([5, 0, 5], compute, 0.3, { x: 1, z: 1 });
  assert.equal(r.legs.length, 3);
  assert.deepEqual(r.legs[1]!.from.slice(0, 1), [1]);
  assert.equal(r.legs[1]!.to[1], -17.1);
  const mid = rideAt(r, r.legs[0]!.duration + r.legs[1]!.duration / 2, ease);
  assert.equal(mid.leg, 1);
  assert.ok(mid.carDy !== null && Math.abs(mid.carDy + 8.55) < 1e-6, `half way down: ${mid.carDy}`);
  const end = rideAt(r, r.total + 1, ease);
  assert.ok(end.done && end.position[1] === -17.1);
  const f = planRide([5, 0, 5], compute, 0.3, null);
  assert.equal(f.legs.length, 1);
  assert.ok(rideAt(f, f.total / 2, ease).position[1] > -17.1 / 2, "the flight arcs up");
  assert.ok(planRide([5, 0, 5], compute, 0.3, { x: 1, z: 1 }, true).total < r.total / 2, "reduced motion is short");
});

test("schema: layers parse; duplicate ids and spawns outside the disc are rejected", () => {
  const w = { tera: "world/v1", id: "t", title: "t", entities: [], layers: [surface, compute] };
  assert.ok(WorldPack.safeParse(w).success);
  assert.equal(WorldPack.safeParse({ ...w, layers: [surface, surface] }).success, false);
  assert.equal(WorldPack.safeParse({ ...w, layers: [{ ...surface, spawn: [100, 0, 0] }] }).success, false);
  assert.equal(WorldPack.safeParse({ ...w, layers: [{ ...surface, spawn: [0, -1, 0] }] }).success, false);
  assert.equal(WorldPack.safeParse({ ...w, layers: [{ ...surface, walk: { center: [0, 0], radius: 0 } }] }).success, false);
  assert.equal(WorldPack.safeParse({ ...w, layers: Array.from({ length: 9 }, (_, i) => ({ ...surface, id: `l${i}` })) }).success, false);
  assert.deepEqual(WorldPack.parse(w).layers?.map((l) => l.id), ["surface", "compute"], "kept on parse");
});

test("worlds without layers walk on one implicit ground layer", () => {
  const w = WorldPack.parse({ tera: "world/v1", id: "t", title: "t", entities: [], cameras: { default: { position: [10, 5, 10], target: [2, 0, 1] } } });
  const ls = worldLayers(w, { min: [-10, -1, -10], max: [10, 6, 10] });
  assert.equal(ls.length, 1);
  assert.equal(ls[0]!.floorY, 0);
  assert.deepEqual(ls[0]!.spawn, [2, 0, 1]);
  assert.equal(worldLayers({ ...w, layers: [compute, surface] }, null)[0]!.id, "surface");
});
