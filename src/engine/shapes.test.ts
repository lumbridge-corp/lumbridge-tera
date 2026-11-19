// engine/shapes: segment + prism primitives, radial repeats, skip lists, and the Node bounds
// that measure arcs, cones, capsules, segments and repeat copies correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { radialAngles, repeatCellsOf } from "./repeat-math.ts";
import { primitiveDoubleSided, primitiveGeometry } from "./primitives.ts";
import { partBounds, primitiveBox, rows } from "../mcp/bounds.ts";
import { Entity } from "../schema/index.ts";
import { checkOps } from "../mcp/validate.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearV = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((v, i) => near(v, b[i]!, eps));
const bb = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!; };
const ok = (e: unknown) => Entity.safeParse(e).success;
const prim = (e: object) => ({ id: "p", kind: "primitive", ...e }) as Extract<Entity, { kind: "primitive" }>;

test("schema: segment needs from/to, prism takes a size, from/to only on segments", () => {
  assert.equal(ok({ id: "leg", kind: "primitive", shape: "segment", from: [0, 0, 0], to: [1, 2, 0], radius: 0.04 }), true);
  assert.equal(ok({ id: "leg", kind: "primitive", shape: "segment", from: [0, 0, 0] }), false);
  assert.equal(ok({ id: "leg", kind: "primitive", shape: "segment", from: [1, 1, 1], to: [1, 1, 1] }), false);
  assert.equal(ok({ id: "gable", kind: "primitive", shape: "prism", size: [4, 1.5, 0.3] }), true);
  assert.equal(ok({ id: "b", kind: "primitive", shape: "box", from: [0, 0, 0] }), false);
});

test("schema: repeat is grid (count + step) or radial, never both; skip", () => {
  const of = { kind: "primitive", shape: "box" };
  assert.equal(ok({ id: "r", kind: "repeat", of, radial: { count: 12, radius: 3 } }), true);
  assert.equal(ok({ id: "r", kind: "repeat", of, radial: { count: 12, radius: 3, axis: "z", startDeg: -60, lengthDeg: 120 }, skip: [0, 11] }), true);
  assert.equal(ok({ id: "r", kind: "repeat", of, count: 3, step: [1, 0, 0], skip: [[1, 0, 0]] }), true);
  assert.equal(ok({ id: "r", kind: "repeat", of, count: 3, step: [1, 0, 0], radial: { count: 3, radius: 1 } }), false);
  assert.equal(ok({ id: "r", kind: "repeat", of }), false);
  assert.equal(ok({ id: "r", kind: "repeat", of, count: 3 }), false);
  assert.equal(ok({ id: "r", kind: "repeat", of, radial: { count: 30000, radius: 1 } }), false); // limit
  assert.equal(ok({ id: "r", kind: "repeat", of, radial: { count: 0, radius: 1 } }), false);
});

test("radial layout: angles, outward turn, axes, skip keeps the others in place", () => {
  const c = repeatCellsOf({ radial: { count: 4, radius: 2 } });
  nearV(c[0]!.position, [0, 0, 2]); nearV(c[1]!.position, [2, 0, 0]); nearV(c[2]!.position, [0, 0, -2]); nearV(c[3]!.position, [-2, 0, 0]);
  // basis turns local +Z (column 3) to point away from the axis
  const out = (b: number[]) => [b[2]!, b[5]!, b[8]!];
  nearV(out(c[1]!.basis!), [1, 0, 0]); nearV(out(c[3]!.basis!), [-1, 0, 0]);
  assert.deepEqual(radialAngles({ count: 3, radius: 1, startDeg: -60, lengthDeg: 120 }), [-60, 0, 60]);
  assert.deepEqual(radialAngles({ count: 4, radius: 1 }), [0, 90, 180, 270]);
  assert.deepEqual(radialAngles({ count: 1, radius: 1, lengthDeg: 90 }), [0]);
  // around z: 0 = +X, 90 = +Y (torus convention); around x: 0 = +Y, 90 = +Z
  const z = repeatCellsOf({ radial: { count: 4, radius: 1, axis: "z" } });
  nearV(z[0]!.position, [1, 0, 0]); nearV(z[1]!.position, [0, 1, 0]);
  const up = (b: number[]) => [b[1]!, b[4]!, b[7]!]; // local +Y runs along the axis
  nearV(up(z[0]!.basis!), [0, 0, 1]);
  const x = repeatCellsOf({ radial: { count: 4, radius: 1, axis: "x" } });
  nearV(x[0]!.position, [0, 1, 0]); nearV(x[1]!.position, [0, 0, 1]); nearV(up(x[0]!.basis!), [1, 0, 0]);
  // basis is a rotation (orthonormal, det +1)
  for (const cell of [...c, ...z, ...x]) {
    const b = cell.basis!;
    near(b[0]! * (b[4]! * b[8]! - b[5]! * b[7]!) - b[1]! * (b[3]! * b[8]! - b[5]! * b[6]!) + b[2]! * (b[3]! * b[7]! - b[4]! * b[6]!), 1);
  }
  // skip: grid [i,j,k] and copy indices; the rest keep their jittered places
  const j = { seed: 4, position: 0.1 };
  const all = repeatCellsOf({ count: [3, 2, 1], step: [1, 1, 0], jitter: j });
  const some = repeatCellsOf({ count: [3, 2, 1], step: [1, 1, 0], jitter: j, skip: [[1, 1, 0], 0] });
  assert.deepEqual(some.map((s) => s.index), [1, 2, 3, 5]);
  assert.deepEqual(some[3]!.position, all[5]!.position);
  assert.equal(repeatCellsOf({ radial: { count: 8, radius: 1 }, skip: [2, 3] }).length, 6);
});

test("segment + prism geometry", () => {
  const s = bb(primitiveGeometry({ shape: "segment", from: [0, 0, 0], to: [0, 2, 0], radius: 0.1 }));
  near(s.min.y, 0); near(s.max.y, 2); near(s.max.x, 0.1, 1e-3);
  const d = bb(primitiveGeometry({ shape: "segment", from: [1, 0, 0], to: [3, 0, 0], radius: 0.05 }));
  near(d.min.x, 1); near(d.max.x, 3); near(d.max.y, 0.05, 1e-3);
  assert.equal(primitiveDoubleSided({ shape: "segment" }), false);
  assert.equal(primitiveDoubleSided({ shape: "segment", open: true }), true);
  const g = primitiveGeometry({ shape: "prism", size: [4, 1.5, 0.3] });
  const p = bb(g);
  nearV(p.min.toArray(), [-2, -0.75, -0.15]); nearV(p.max.toArray(), [2, 0.75, 0.15]);
  assert.equal(g.attributes.position!.count, 24); // 2 triangles + 3 quads, flat
  // front face normal +Z, slopes face up and out
  const n = g.attributes.normal!;
  nearV([n.getX(0), n.getY(0), n.getZ(0)], [0, 0, 1]);
  assert.ok(n.getY(12) > 0 && n.getX(12) > 0, "right slope faces up/right");
});

test("bounds: arcs are sectors, cones/capsules/segments/prisms measured", () => {
  const half = primitiveBox(prim({ shape: "cylinder", size: [1, 2], arc: { start: 0, length: 180 } }));
  nearV(half.min, [0, -1, -1]); nearV(half.max, [1, 1, 1]);
  const quarter = primitiveBox(prim({ shape: "cylinder", size: [2, 1], arc: { start: -45, length: 90 }, open: true }));
  near(quarter.min[2], Math.SQRT1_2 * 2); near(quarter.max[2], 2); near(quarter.max[0], Math.SQRT1_2 * 2);
  const ring = primitiveBox(prim({ shape: "cylinder", size: [2, 0.5], inner: 1.5, arc: { start: 0, length: 90 } }));
  nearV(ring.min, [0, -0.25, 0]); nearV(ring.max, [2, 0.25, 2]);
  const t = primitiveBox(prim({ shape: "torus", size: [1, 0.1], arc: { length: 180 } }));
  nearV(t.min, [-1.1, -0.1, -0.1]); nearV(t.max, [1.1, 1.1, 0.1]);
  const cone = primitiveBox(prim({ shape: "cone", size: [0.5, 2] }));
  nearV(cone.min, [-0.5, -1, -0.5]);
  const cap = primitiveBox(prim({ shape: "capsule", size: [0.3, 1.2] }));
  nearV(cap.max, [0.3, 0.6, 0.3]);
  const seg = primitiveBox(prim({ shape: "segment", from: [0, 0, 0], to: [0, 3, 0], radius: 0.1 }));
  nearV(seg.min, [-0.1, 0, -0.1]); nearV(seg.max, [0.1, 3, 0.1]);
  const pr = primitiveBox(prim({ shape: "prism", size: [4, 1.5, 0.3] }));
  nearV(pr.max, [2, 0.75, 0.15]);
});

test("bounds: radial + skipped repeats in rows and partBounds (text estimated)", () => {
  const cols = { id: "cols", kind: "repeat", transform: { position: [10, 0, 0] }, radial: { count: 4, radius: 2 },
    of: { id: "c", kind: "primitive", shape: "box", size: [0.2, 3, 0.2], transform: { position: [0, 1.5, 0] } } } as Entity;
  const r = rows([cols]);
  nearV(r[0]!.bounds!.min, [7.9, 0, -2.1]); nearV(r[0]!.bounds!.max, [12.1, 3, 2.1]);
  assert.match(r[0]!.detail, /4 × primitive box \(radial 4 around y, r 2, 0\.\.270 deg\)/);
  // half ring: copies only at 0..180 → z from -2 to 2, x only positive
  const arcCols = { ...cols, radial: { count: 3, radius: 2, lengthDeg: 180 } } as Entity;
  const b = partBounds([arcCols])!;
  near(b.min[0], 10 - 0.1); near(b.max[0], 12.1);
  // skip drops a copy from the box
  const row = { id: "row", kind: "repeat", count: 3, step: [1, 0, 0], skip: [2], of: { id: "x", kind: "primitive", shape: "box", size: [0.5, 0.5, 0.5] } } as Entity;
  near(partBounds([row])!.max[0], 1.25);
  const sign = { id: "s", kind: "text", text: "Mail", size: 0.5, transform: { position: [0, 3, 0] } } as Entity;
  const sb = partBounds([sign])!;
  near(sb.max[0], 0.5 * 0.62 * 4 / 2); near(sb.max[1], 3.3);
});

test("MCP hints for the new shapes", () => {
  const world = { tera: "world/v1" as const, id: "w", title: "W", entities: [] };
  assert.equal(checkOps([{ op: "add", entity: { id: "brace", kind: "primitive", shape: "segment", from: [0, 0, 0], to: [1, 1, 0] } }], world).ok, true);
  const bad = checkOps([{ op: "add", entity: { id: "brace", kind: "primitive", shape: "segment", points: [[0, 0, 0], [1, 1, 0]] } }], world);
  assert.match(bad.errors[0]!.messages.join("\n"), /from/);
  const both = checkOps([{ op: "add", entity: { id: "r", kind: "repeat", count: 3, step: [1, 0, 0], radial: { count: 3, radius: 1 }, of: { kind: "primitive", shape: "box" } } }], world);
  assert.match(both.errors[0]!.messages.join("\n"), /either radial or count \+ step/);
});

test("flow pipe collars: false or { every, max, tube, color }", () => {
  const flow = (pipe: unknown) => Entity.safeParse({ id: "f", kind: "flow", path: "p", pipe }).success;
  assert.equal(flow({ radius: 0.1, collars: false }), true);
  assert.equal(flow({ collars: { every: 3, max: 10, tube: 0.07, color: "#8a9096" } }), true);
  assert.equal(flow({ collars: { max: 1 } }), false);
  assert.equal(flow({ collars: true }), false);
});
