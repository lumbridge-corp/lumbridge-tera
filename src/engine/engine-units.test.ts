// Node tests for the engine's pure parts: primitive geometry vs the size convention,
// the colour-sky backdrop, post-effect helpers and the XR rig maths.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { primitiveGeometry } from "./primitives.ts";
import { primitiveHalfExtents } from "../mcp/bounds.ts";
import { backdropColor, FOG_BAND_DEG } from "./backdrop.ts";
import { dofFullBlurDistance, wantsPost, DOF_MAX_BLUR } from "./post.ts";
import { anchorRig, grabRig, rigToWorld, tableRig, type RigState } from "./xr.ts";
import { WorldPack } from "../schema/index.ts";
import { acesFilmic, acesFilmicInverse } from "./tonemap.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearV = (a: THREE.Vector3, b: number[], eps = 1e-6) => [a.x, a.y, a.z].forEach((v, i) => near(v, b[i]!, eps));

test("primitive geometry matches the documented size convention (incl. cone + frustum)", () => {
  const cases: { shape: "box" | "sphere" | "plane" | "cylinder" | "torus" | "cone"; size?: number[] }[] = [
    { shape: "box", size: [1, 2, 3] }, { shape: "box", size: [2] }, { shape: "sphere", size: [0.7] }, { shape: "plane", size: [4, 2] },
    { shape: "cylinder", size: [0.3, 2] }, { shape: "cylinder", size: [0.3, 2, 0.5] }, { shape: "torus", size: [1, 0.2] },
    { shape: "cone", size: [0.5, 1.5] }, { shape: "cone", size: [0.5, 1, 0.8] }, { shape: "cone" },
  ];
  for (const c of cases) {
    const g = primitiveGeometry(c);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const h = primitiveHalfExtents({ id: "x", kind: "primitive", ...c });
    for (let i = 0; i < 3; i++) {
      near(b.max.getComponent(i), h[i]!, 1e-3);
      near(b.min.getComponent(i), -h[i]!, 1e-3); // centred on its position
    }
  }
  // A cone's apex is up, its base down.
  const cone = primitiveGeometry({ shape: "cone", size: [0.5, 2] });
  const pos = cone.attributes.position!;
  let topR = 0, botR = 0;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    if (pos.getY(i) > 0.99) topR = Math.max(topR, r);
    if (pos.getY(i) < -0.99) botR = Math.max(botR, r);
  }
  near(topR, 0, 1e-6);
  near(botR, 0.5, 1e-6);
});

test("schema: cone and environment.post", () => {
  const w = WorldPack.parse({
    tera: "world/v1", id: "p", title: "P",
    environment: { post: { ao: true, bloom: { strength: 0.8, threshold: 0.9 }, dof: { focus: 4, aperture: 0.03 } } },
    entities: [{ id: "c", kind: "primitive", shape: "cone", size: [0.5, 1, 0.2] }],
  });
  assert.equal((w.environment!.post!.dof as { focus: number }).focus, 4);
  assert.equal(WorldPack.safeParse({ tera: "world/v1", id: "p", title: "P", environment: { post: { dof: { focus: -1, aperture: 0 } } }, entities: [] }).success, false);
});

test("backdrop: sky colour without fog; fog colour at and below the horizon, sky above the band", () => {
  const sky = [0.1, 0.2, 0.3], fog = [0.8, 0.8, 0.8];
  assert.deepEqual(backdropColor(0.5, sky), [0.1, 0.2, 0.3]);
  assert.deepEqual(backdropColor(0, sky, fog), [0.8, 0.8, 0.8]);
  assert.deepEqual(backdropColor(-0.7, sky, fog), [0.8, 0.8, 0.8]);
  const high = backdropColor(Math.sin(((FOG_BAND_DEG + 1) * Math.PI) / 180), sky, fog);
  high.forEach((v, i) => near(v, sky[i]!));
  const mid = backdropColor(Math.sin(((FOG_BAND_DEG / 2) * Math.PI) / 180), sky, fog);
  assert.ok(mid[0] < 0.8 && mid[0] > 0.1, "blends in the band");
});

test("post helpers", () => {
  assert.equal(wantsPost(undefined), false);
  assert.equal(wantsPost({}), false);
  assert.equal(wantsPost({ ao: false }), false);
  assert.equal(wantsPost({ ao: true }), true);
  assert.equal(wantsPost({ dof: { focus: 2, aperture: 0.02 } }), true);
  // blur = aperture·|1 − focus/d| reaches the cap at d = focus / (1 − cap/aperture)
  near(dofFullBlurDistance(2 * DOF_MAX_BLUR, 10), 10);
  assert.ok(dofFullBlurDistance(0) > 1e5);
  assert.ok(dofFullBlurDistance(DOF_MAX_BLUR / 2, 10) > 1e5, "never reaches the cap");
});

test("XR rig: anchor, table placement, grab keeps the world glued to the hands", () => {
  const s: RigState = { pos: new THREE.Vector3(1, 0, 2), yaw: Math.PI / 2, k: 2 };
  // world = pos + R(yaw)·k·real
  nearV(rigToWorld(s, new THREE.Vector3(1, 0, 0)), [1, 0, 0]);
  const w = new THREE.Vector3(3, 1, -4), real = new THREE.Vector3(0.2, 1.5, -0.3);
  nearV(rigToWorld({ pos: anchorRig(w, real, 0.3, 5), yaw: 0.3, k: 5 }, real), [3, 1, -4]);

  // Tabletop: a 20 m town becomes 1 m; its bottom centre lands on the table spot.
  const box = new THREE.Box3(new THREE.Vector3(-10, 0, -6), new THREE.Vector3(10, 3, 6));
  const at = new THREE.Vector3(0, 0.8, -0.9);
  const t = tableRig(box, at, 1, 0);
  near(t.k, 20);
  nearV(rigToWorld(t, at), [0, 0, 0]);
  // Facing: with the user turned 90° left (yaw +90°), world -Z is still straight ahead of them.
  const turned = tableRig(box, at, 1, Math.PI / 2);
  const ahead = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const dir = rigToWorld(turned, at.clone().add(ahead)).sub(rigToWorld(turned, at)).normalize();
  nearV(dir, [0, 0, -1]);

  // One hand: the world point under the hand follows it.
  const start: RigState = { pos: new THREE.Vector3(0, 0, 0), yaw: 0, k: 10 };
  const a0 = new THREE.Vector3(0, 1, -0.5), a1 = new THREE.Vector3(0.3, 1.1, -0.4);
  const held = rigToWorld(start, a0);
  nearV(rigToWorld(grabRig(start, a0, a0, a1, a1), a1), [held.x, held.y, held.z]);
  // Two hands spreading to double distance: the world looks twice as big (k halves), the midpoint stays glued.
  const b0 = new THREE.Vector3(0.2, 1, -0.5), b1 = new THREE.Vector3(0.4, 1, -0.5);
  const a2 = new THREE.Vector3(0, 1, -0.5);
  const g = grabRig(start, a0, b0, a2, b1);
  near(g.k, 5);
  const mid0 = rigToWorld(start, a0.clone().add(b0).multiplyScalar(0.5));
  nearV(rigToWorld(g, a2.clone().add(b1).multiplyScalar(0.5)), [mid0.x, mid0.y, mid0.z]);
  // Two hands turning: the world turns with them.
  const r1 = new THREE.Vector3(0.1, 1, -0.6), r2 = new THREE.Vector3(0.1, 1, -0.4); // rotated 90° about the midpoint
  const rot = grabRig(start, a0, b0, r1, r2);
  near(rot.k, 10);
  near(Math.abs(rot.yaw), Math.PI / 2, 1e-6);
});

test("ACES inverse: tone-mapping the inverse gives the target colour back", () => {
  for (const exposure of [1, 1.5, 0.7]) for (const c of [[0.012, 0.018, 0.033], [0.5, 0.45, 0.4], [0.8, 0.79, 0.76], [0.1, 0.25, 0.5]] as [number, number, number][]) {
    const back = acesFilmic(acesFilmicInverse(c, exposure), exposure);
    back.forEach((v, i) => near(v, c[i]!, 2e-3));
  }
});
