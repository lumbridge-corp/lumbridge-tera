// Engine polish: scale-free + tilt-shift DOF, bloom defaults, repeat layout, arcs/capsule/
// rounded boxes, light range, crowd lanes and separation. Pure parts only (Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DOF_MAX_BLUR, dofDepthCoc, dofSharpRange, dofTiltCoc, resolveDof } from "./dof.ts";
import { resolveBloom } from "./post.ts";
import { repeatCells, repeatSpan } from "./repeat-math.ts";
import { primitiveDoubleSided, primitiveGeometry } from "./primitives.ts";
import { primitiveHalfExtents, rows } from "../mcp/bounds.ts";
import { actorPose, autoLane, laneRamp, samplePoints, separate, type V3 } from "./living-math.ts";
import { Entity, WorldPack, repeatCount } from "../schema/index.ts";
import { countEntities } from "./timeline.ts";
import { acesFilmic, acesSaturatedInverse } from "./tonemap.ts";
import { checkOps } from "../mcp/validate.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("dof depth: scale-free thin-lens CoC, sharp at the focus plane at any distance", () => {
  // The town overview: focus 106.4 m, aperture 0.004 — sharp at the focus, soft away from it.
  const p = resolveDof({ focus: 106.4, aperture: 0.004 });
  assert.equal(p.maxBlur, DOF_MAX_BLUR);
  near(dofDepthCoc(p, 106.4), 0);
  assert.ok(dofDepthCoc(p, 110) < 1 / 1280, "a 3.6 m band around the focus stays under a pixel at 1280");
  assert.ok(dofDepthCoc(p, 1e6) > 0.0039, "far away blurs by ~aperture");
  // Same look at 1/100 scale: blur depends on d/focus only.
  const small = resolveDof({ focus: 1.064, aperture: 0.004 });
  near(dofDepthCoc(small, 1.2), dofDepthCoc(p, 120), 1e-12);
  // Capped.
  assert.equal(dofDepthCoc(resolveDof({ focus: 10, aperture: 0.5 }), 1000), DOF_MAX_BLUR);
  assert.equal(dofDepthCoc(resolveDof({ focus: 10, aperture: 0.5, maxBlur: 0.02 }), 1000), 0.02);
  const [lo, hi] = dofSharpRange(p, 1 / 1920);
  assert.ok(lo < 106.4 && hi > 106.4 && hi - lo > 4, `sharp range ${lo}..${hi}`);
});

test("dof tiltshift: sharp band on screen, blur grows to `blur` over `falloff`", () => {
  const p = resolveDof({ mode: "tiltshift", center: 0.4, band: 0.2 });
  assert.equal(p.mode, "tiltshift");
  near(dofTiltCoc(p, 0.4), 0);
  near(dofTiltCoc(p, 0.49), 0);
  near(dofTiltCoc(p, 0.31), 0);
  near(dofTiltCoc(p, 0.4 + 0.1 + 0.3), 0.008);
  near(dofTiltCoc(p, 0.0), 0.008 * (() => { const t = 0.3 / 0.3; return t * t * (3 - 2 * t); })());
  assert.ok(dofTiltCoc(p, 0.65) > 0 && dofTiltCoc(p, 0.65) < 0.008);
});

test("bloom defaults: glow source with threshold 0; scene source threshold 1", () => {
  assert.deepEqual(resolveBloom({ strength: 0.6 }), { strength: 0.6, radius: 0.4, threshold: 0, source: "glow" });
  assert.equal(resolveBloom({ strength: 0.6, source: "scene" }).threshold, 1);
  assert.equal(resolveBloom({ strength: 0.6, threshold: 0.85 }).threshold, 0.85);
});

test("schema: new post, material, primitive and light fields", () => {
  const w = WorldPack.parse({
    tera: "world/v1", id: "p", title: "P",
    environment: { post: { bloom: { strength: 0.5 }, dof: { mode: "tiltshift", center: 0.45 } } },
    entities: [
      { id: "pane", kind: "primitive", shape: "box", size: [2, 2, 0.04], material: { glass: true, color: "#e6f2f0" } },
      { id: "strip", kind: "primitive", shape: "box", size: [2, 0.05, 0.05], material: { color: "#ffa000", glow: 3, glowExact: true } },
      { id: "arch", kind: "primitive", shape: "cylinder", size: [2, 0.5], inner: 1.6, arc: { start: -90, length: 180 } },
      { id: "vault", kind: "primitive", shape: "cylinder", size: [3, 8], open: true, arc: { length: 180 } },
      { id: "pill", kind: "primitive", shape: "capsule", size: [0.3, 1.2] },
      { id: "soft", kind: "primitive", shape: "box", size: [1, 1, 1], radius: 0.1 },
      { id: "lamp", kind: "light", light: "point", intensity: 5, distance: 6, decay: 1.5 },
    ],
  });
  assert.equal(w.entities.length, 7);
  const bad = (e: unknown) => WorldPack.safeParse({ tera: "world/v1", id: "p", title: "P", entities: [e] }).success === false;
  assert.ok(bad({ id: "a", kind: "primitive", shape: "torus", arc: { length: 0 } }));
  assert.ok(bad({ id: "a", kind: "primitive", shape: "torus", arc: { length: 400 } }));
  assert.ok(bad({ id: "l", kind: "light", light: "point", distance: -1 }));
  assert.ok(WorldPack.safeParse({ tera: "world/v1", id: "p", title: "P", environment: { post: { dof: { mode: "tiltshift", center: 2 } } }, entities: [] }).success === false);
});

test("schema: repeat — one entity, template id optional, limits and forbidden kinds", () => {
  const shelf = Entity.parse({
    id: "books", kind: "repeat", count: [40, 3, 1], step: [0.05, 0.4, 0],
    of: { kind: "primitive", shape: "box", size: [0.04, 0.3, 0.2] },
    jitter: { seed: 3, scale: 0.1, color: 0.5 },
  }) as Extract<Entity, { kind: "repeat" }>;
  assert.equal(shelf.of.id, "item");
  assert.equal(repeatCount(shelf.count), 120);
  assert.equal(countEntities([shelf]), 1, "counts as one entity for budgets");
  assert.equal(Entity.safeParse({ id: "r", kind: "repeat", count: 2, step: [1, 0, 0], of: { id: "x", kind: "light", light: "point" } }).success, false);
  assert.equal(Entity.safeParse({ id: "r", kind: "repeat", count: 2, step: [1, 0, 0], of: { id: "x", kind: "actor" } }).success, false);
  assert.equal(Entity.safeParse({ id: "r", kind: "repeat", count: [300, 100, 1], step: [1, 0, 0], of: { id: "x", kind: "primitive", shape: "box" } }).success, false);
  // Nested repeats multiply.
  assert.equal(Entity.safeParse({ id: "r", kind: "repeat", count: 200, step: [1, 0, 0], of: { id: "x", kind: "repeat", count: 200, step: [0, 0, 1], of: { id: "y", kind: "primitive", shape: "box" } } }).success, false);
  assert.equal(Entity.safeParse({ id: "r", kind: "repeat", count: 0, step: [1, 0, 0], of: { id: "x", kind: "primitive", shape: "box" } }).success, false);
});

test("repeat layout: grid order, deterministic jitter, span", () => {
  const cells = repeatCells([3, 2, 1], [1, 2, 0]);
  assert.equal(cells.length, 6);
  assert.deepEqual(cells[1]!.position, [1, 0, 0]);
  assert.deepEqual(cells[3]!.position, [0, 2, 0]);
  assert.ok(cells.every((c) => c.scale === 1 && c.tint === null));
  const j = { seed: 7, position: 0.1, rotation: 15, scale: 0.2, color: 1 };
  const a = repeatCells(50, [0.5, 0, 0], j), b = repeatCells(50, [0.5, 0, 0], j);
  assert.deepEqual(a, b, "same seed, same layout");
  assert.notDeepEqual(a, repeatCells(50, [0.5, 0, 0], { ...j, seed: 8 }));
  for (const c of a) {
    assert.ok(Math.abs(c.position[0] - c.index * 0.5) <= 0.1 && Math.abs(c.position[2]) <= 0.1 && c.position[1] === 0);
    assert.ok(Math.abs(c.rotation[1]) <= 15 && c.rotation[0] === 0);
    assert.ok(c.scale >= 0.8 && c.scale <= 1.2);
    assert.ok(c.tint && Math.abs(c.tint[2]) <= 0.18);
  }
  assert.ok(new Set(a.map((c) => c.scale.toFixed(4))).size > 40, "copies differ");
  assert.deepEqual(repeatSpan([4, 1, 2], [1, 0, -2], { position: [0.1, 0, 0] }), { min: [-0.1, 0, -2], max: [3.1, 0, 0] });
});

test("repeat bounds in the MCP rows", () => {
  const r = rows([{ id: "fence", kind: "repeat", transform: { position: [10, 0, 0] }, count: [5, 1, 1], step: [2, 0, 0], of: { id: "post", kind: "primitive", shape: "box", size: [0.2, 1, 0.2], transform: { position: [0, 0.5, 0] } } } as Entity]);
  assert.equal(r.length, 1);
  const b = r[0]!.bounds!;
  [9.9, 0, -0.1].forEach((v, i) => near(b.min[i]!, v, 1e-9));
  [18.1, 1, 0.1].forEach((v, i) => near(b.max[i]!, v, 1e-9));
  assert.match(r[0]!.detail, /5 × primitive box/);
});

test("MCP checkOps: repeat add + template errors explained", () => {
  const world = { tera: "world/v1" as const, id: "w", title: "W", entities: [] };
  assert.equal(checkOps([{ op: "add", entity: { id: "row", kind: "repeat", count: [10, 1, 1], step: [1, 0, 0], of: { kind: "primitive", shape: "box" } } }], world).ok, true);
  const bad = checkOps([{ op: "add", entity: { id: "row", kind: "repeat", count: 3, step: [1, 0, 0], of: { id: "l", kind: "light", light: "point" } } }], world);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]!.messages.join("\n"), /repeat cannot copy a light/);
  const typo = checkOps([{ op: "add", entity: { id: "pane", kind: "primitive", shape: "box", material: { transmission: 1 } } }], world);
  assert.match(typo.errors[0]!.messages.join("\n"), /material\.transmission: unknown field — use material\.glass: true/);
});

test("primitives: capsule, rounded box, arcs, open and hollow cylinders", () => {
  const bb = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!; };
  const cap = bb(primitiveGeometry({ shape: "capsule", size: [0.3, 1.2] }));
  near(cap.max.y, 0.6, 1e-6); near(cap.min.y, -0.6, 1e-6); near(cap.max.x, 0.3, 1e-3);
  const h = primitiveHalfExtents({ id: "c", kind: "primitive", shape: "capsule", size: [0.3, 1.2] });
  assert.deepEqual(h, [0.3, 0.6, 0.3]);
  const rb = bb(primitiveGeometry({ shape: "box", size: [1, 2, 3], radius: 0.2 }));
  near(rb.max.x, 0.5, 1e-6); near(rb.max.y, 1, 1e-6); near(rb.max.z, 1.5, 1e-6);
  // Half cylinder from +Z (0°) toward +X (180° sweep covers x >= 0).
  const half = bb(primitiveGeometry({ shape: "cylinder", size: [1, 2], arc: { start: 0, length: 180 } }));
  near(half.min.x, 0, 1e-6); near(half.max.x, 1, 1e-6); near(half.min.z, -1, 1e-6); near(half.max.z, 1, 1e-6);
  // Hollow arch: annulus sector, inner radius respected, centred in Y, same angle convention.
  const arch = primitiveGeometry({ shape: "cylinder", size: [2, 0.5], inner: 1.5, arc: { start: 0, length: 180 } });
  const ab = bb(arch);
  near(ab.min.y, -0.25, 1e-6); near(ab.max.y, 0.25, 1e-6); near(ab.min.x, 0, 1e-6); near(ab.max.x, 2, 1e-3);
  const pos = arch.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    assert.ok(r > 1.5 - 1e-4 && r < 2 + 1e-4, `vertex radius ${r}`);
  }
  // Torus arc starts on +X and sweeps toward +Y; start rotates it.
  const t = bb(primitiveGeometry({ shape: "torus", size: [1, 0.1], arc: { length: 180 } }));
  near(t.min.y, 0, 1e-3); near(t.max.y, 1.1, 1e-3);
  const t2 = bb(primitiveGeometry({ shape: "torus", size: [1, 0.1], arc: { start: 180, length: 180 } }));
  near(t2.max.y, 0, 1e-3); near(t2.min.y, -1.1, 1e-3);
  assert.equal(primitiveDoubleSided({ shape: "cylinder", open: true }), true);
  assert.equal(primitiveDoubleSided({ shape: "cylinder", arc: { length: 90 } }), true);
  assert.equal(primitiveDoubleSided({ shape: "cylinder", inner: 0.5, arc: { length: 90 } }), false);
  assert.equal(primitiveDoubleSided({ shape: "cylinder", arc: { length: 360 } }), false);
});

test("crowds: lanes keep walkers right of the centre line, opposite walkers pass apart", () => {
  const route = samplePoints([[0, 0, 0], [20, 0, 0]] as V3[], {});
  // Walking +X (Y up): right-hand side is +Z (forward × up).
  const a = actorPose(route, { speed: 1 }, "idle", 10, 0.3);
  near(a.pos[2], 0.3, 1e-9);
  near(laneRamp(route, 0), 0); near(laneRamp(route, 10), 1);
  const start = actorPose(route, { speed: 1 }, "idle", 0, 0.3);
  near(start.pos[2], 0, 1e-9); // eases in from the start point: no jump
  // A back-and-forth walker comes back on the other side of the line (its own right).
  const back = actorPose(route, { speed: 1, loop: true }, "idle", 30, 0.3);
  assert.ok(back.yaw < 0 && back.pos[2] < -0.29, `returning walker z ${back.pos[2]}`);
  for (let s = 1; s < 1000; s++) { const l = autoLane(s); assert.ok(l >= 0.25 && l <= 0.45); }
});

test("crowds: separation is stateless, symmetric and leaves standing actors alone", () => {
  const pos: V3[] = [[0, 0, 0], [0.2, 0, 0], [5, 0, 0], [5.1, 0, 0]];
  const copy = pos.map((p) => p.slice() as V3);
  separate(pos, [0.55, 0.55, 0.55, 0.55], [true, true, false, false]);
  near(pos[1]![0] - pos[0]![0], 0.55, 1e-9);
  near((pos[0]![0] + pos[1]![0]) / 2, 0.1, 1e-9);
  assert.deepEqual(pos[2], copy[2]); // two standing actors: untouched
  separate(copy, [0.55, 0.55, 0.55, 0.55], [true, true, false, false]);
  assert.deepEqual(copy, pos, "same input, same output");
  const mixed: V3[] = [[0, 0, 0], [0.3, 0, 0]];
  separate(mixed, [0.55, 0.55], [false, true]);
  assert.deepEqual(mixed[0], [0, 0, 0]);
  near(mixed[1]![0], 0.55, 1e-9);
  // Exactly coincident: pushed apart in a deterministic direction.
  const same: V3[] = [[1, 0, 1], [1, 0, 1]];
  separate(same, [0.5, 0.5], [true, true]);
  near(Math.hypot(same[0]![0] - same[1]![0], same[0]![2] - same[1]![2]), 0.5, 1e-9);
});

test("exact glow: reachable colours land exactly; too-saturated ones keep hue and saturation", () => {
  const amber: [number, number, number] = [1, 0.352, 0]; // #ffa000
  const a = acesSaturatedInverse(amber);
  const back = acesFilmic(a.color);
  assert.equal(a.scale, 1);
  back.forEach((v, i) => near(v, amber[i]!, 0.035));
  const lime: [number, number, number] = [0.479, 1, 0.045]; // #b8ff3c: plain inverse washes it to ~(0.85, 0.97, 0.64)
  const l = acesSaturatedInverse(lime);
  assert.ok(l.scale < 1 && l.scale > 0.3, `scale ${l.scale}`);
  const shown = acesFilmic(l.color);
  shown.forEach((v, i) => near(v, lime[i]! * l.scale, 0.035));
  assert.ok(shown[2] / shown[1] < 0.1, "still saturated");
});
