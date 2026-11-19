// Node tests for static batching (batch.ts): baked geometry, joining, going hot, pinning.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BATCH_LAYER, StaticBatcher, bakeGeometry, type BatchCandidate } from "./batch.ts";

const near = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function box(id: string, pos: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial());
  m.position.set(...pos);
  m.scale.set(...scale);
  m.userData.teraId = id;
  m.castShadow = true;
  return m;
}

function setup(n = 3) {
  const scene = new THREE.Scene();
  const meshes = Array.from({ length: n }, (_, i) => box(`b${i}`, [i * 2, 0, 0]));
  for (const m of meshes) scene.add(m);
  const added: THREE.Mesh[] = [], removed: THREE.Mesh[] = [];
  const b = new StaticBatcher({ added: (m) => added.push(m), removed: (m) => removed.push(m) });
  scene.add(b.root);
  const cands = (): BatchCandidate[] =>
    meshes.filter((m) => m.parent).map((m) => ({ id: m.userData.teraId, part: m.userData.teraId, mesh: m, key: "std", tint: null, material: () => new THREE.MeshStandardMaterial() }));
  const run = () => {
    scene.updateMatrixWorld(true);
    b.sync(cands());
  };
  return { scene, meshes, b, added, removed, run };
}

test("bakeGeometry: world positions and normals, indexed, mirrored copies keep their winding", () => {
  const a = box("a", [1, 2, 3], [2, 1, 1]);
  const m = box("m", [0, 0, 0], [-1, 1, 1]); // mirrored
  for (const x of [a, m]) x.updateMatrixWorld(true);
  const g = bakeGeometry([a, m]);
  const ref = a.geometry.clone().applyMatrix4(a.matrixWorld);
  const P = g.attributes.position!, R = ref.attributes.position!;
  for (let i = 0; i < R.count; i++) for (let k = 0; k < 3; k++) near(P.getComponent(i, k), R.getComponent(i, k));
  const N = g.attributes.normal!, RN = ref.attributes.normal!;
  for (let i = 0; i < RN.count; i++) for (let k = 0; k < 3; k++) near(N.getComponent(i, k), RN.getComponent(i, k));
  assert.equal(g.index!.count, a.geometry.index!.count * 2);
  // mirrored: every triangle's geometric normal still agrees with its vertex normals (front faces out)
  const off = a.geometry.index!.count, v = (i: number) => new THREE.Vector3().fromBufferAttribute(P, g.index!.getX(i));
  for (let t = off; t < g.index!.count; t += 3) {
    const n = v(t + 1).sub(v(t)).cross(v(t + 2).sub(v(t))).normalize();
    const vn = new THREE.Vector3().fromBufferAttribute(N, g.index!.getX(t));
    assert.ok(n.dot(vn) > 0.99, `triangle ${t} faces inward`);
  }
});

test("bakeGeometry: per-vertex tint and every copy of an InstancedMesh", () => {
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 3);
  for (let i = 0; i < 3; i++) inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
  inst.updateMatrixWorld(true);
  const g = bakeGeometry([inst], [new THREE.Color(0.25, 0.5, 0.75)]);
  assert.equal(g.attributes.position!.count, 24 * 3);
  near(g.boundingBox!.max.x, 20.5);
  const c = g.attributes.color!;
  assert.deepEqual([c.getX(5), c.getY(5), c.getZ(5)], [0.25, 0.5, 0.75]);
});

test("batcher: still meshes share one batch mesh; originals leave the camera layer but stay pickable", () => {
  const { meshes, b, added, run } = setup();
  run();
  assert.equal(b.stats().batches, 1);
  assert.equal(b.stats().members, 3);
  assert.equal(added.length, 1);
  for (const m of meshes) {
    assert.equal(m.layers.test(new THREE.Camera().layers), false, "not drawn");
    assert.equal(StaticBatcher.batched(m), true);
  }
  const ray = new THREE.Raycaster(new THREE.Vector3(2, 10, 0), new THREE.Vector3(0, -1, 0));
  ray.layers.enable(BATCH_LAYER);
  const hit = ray.intersectObjects([...meshes, b.root], true)[0];
  assert.equal(hit?.object, meshes[1], "the ray hits the original, never the batch");
  const cb = StaticBatcher.casterBox(added[0]!)!;
  near(cb.min.x, -0.5);
  near(cb.max.x, 4.5);
});

test("batcher: a moved, rebuilt or hidden member goes hot (its own mesh again) and the batch is rebuilt", () => {
  const { meshes, b, removed, run } = setup();
  run();
  meshes[0]!.position.x = 50;
  run();
  assert.equal(b.stats().members, 2);
  assert.equal(b.stats().hot, 1);
  assert.equal(StaticBatcher.batched(meshes[0]!), false);
  assert.equal(meshes[0]!.layers.mask, 1, "back on the camera layer");
  assert.equal(removed.length, 1);
  // hot for good: still and back in place, it stays its own mesh
  meshes[0]!.position.x = 0;
  run();
  assert.equal(b.stats().members, 2);
  meshes[1]!.visible = false;
  run();
  assert.equal(b.stats().members, 1);
  meshes[2]!.removeFromParent();
  run();
  assert.equal(b.stats().members, 0);
  assert.equal(b.stats().batches, 0);
});

test("batcher: hold takes a subtree out for a while; once back it is watched every frame", () => {
  const { scene, meshes, b, run } = setup();
  let t = 0;
  b.clock = () => t;
  const g = new THREE.Group();
  g.userData.teraId = "cabin";
  scene.add(g);
  g.add(meshes[2]!);
  run();
  assert.equal(b.stats().members, 3);
  b.hold(g);
  assert.equal(b.stats().members, 2);
  assert.equal(StaticBatcher.batched(meshes[2]!), false);
  t = 1000;
  run();
  assert.equal(b.stats().members, 2, "still held");
  t = 3500;
  scene.updateMatrixWorld(true);
  assert.equal(b.tick(), true, "the hold ran out: sync wanted");
  run();
  assert.equal(b.stats().members, 3, "back in its batch");
  assert.equal(meshes[2]!.matrixAutoUpdate, true, "a watched member keeps its own matrix updates");
  // a material swap (a cross-fade) holds it out again, before the frame is drawn
  const own = meshes[2]!.material;
  meshes[2]!.material = new THREE.MeshStandardMaterial();
  assert.equal(b.tick(), false);
  assert.equal(b.stats().members, 2);
  meshes[2]!.material = own;
  t = 7000;
  run();
  assert.equal(b.stats().members, 3);
  // the first move takes it out for good
  g.position.x = 3;
  scene.updateMatrixWorld(true);
  b.tick();
  assert.equal(b.stats().members, 2);
  assert.equal(b.stats().hot, 1);
  t = 20000;
  run();
  assert.equal(b.stats().members, 2, "a mover stays out");
});

test("batcher: a new world (load) starts over: new meshes with the old ids join, they do not go hot", () => {
  const { scene, meshes, b, run } = setup();
  run();
  b.reset();
  assert.equal(b.stats().batches, 0);
  // the same ids, rebuilt (a live snapshot loads the world again)
  for (const [i, m] of meshes.entries()) {
    m.removeFromParent();
    const n = box(m.userData.teraId, [i * 2, 0, 0]);
    meshes[i] = n;
    scene.add(n);
  }
  run();
  assert.equal(b.stats().members, 3);
  assert.equal(b.stats().hot, 0);
});

test("batcher: pin takes a subtree out for good (it is about to be animated)", () => {
  const { scene, meshes, b, run } = setup();
  const g = new THREE.Group();
  g.userData.teraId = "car";
  scene.add(g);
  g.add(meshes[2]!);
  run();
  assert.equal(b.stats().members, 3);
  b.pin(g);
  assert.equal(b.stats().members, 2);
  assert.equal(StaticBatcher.batched(meshes[2]!), false);
  run();
  assert.equal(b.stats().members, 2, "still out after the next sync");
  b.reset();
  run();
  assert.equal(b.stats().members, 3, "a new world forgets the hot list");
});
