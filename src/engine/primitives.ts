// Primitive geometry. Size meanings (CONTRACT section 1), every shape centred on its
// position:
//   box [w,h,d] (one number = cube)      sphere [r]
//   plane [w,d] lying flat in XZ          cylinder [r,h] along Y (optional 3rd = bottom radius)
//   torus [R,tube] in the XY plane        cone [rBottom,h] along Y, apex up (optional 3rd = top radius → frustum)
//   capsule [r,h] along Y, h = total height (ends included)
// Options: arc {start,length} degrees (cylinder/cone around Y from +Z toward +X; torus in its
// plane from +X toward +Y), open (cylinder/cone without caps), inner (hollow cylinder with
// solid walls), radius (rounded box edges).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Entity } from "../schema/index.ts";

export type PrimitiveEntity = Extract<Entity, { kind: "primitive" }>;
type GeoSpec = Pick<PrimitiveEntity, "shape" | "size"> & Partial<Pick<PrimitiveEntity, "arc" | "open" | "inner" | "radius">>;

const DEG = Math.PI / 180;

/** Arc in radians [start, length], or null for a full sweep. */
function arcOf(e: GeoSpec): [number, number] | null {
  if (!e.arc || e.arc.length >= 360) return null;
  return [(e.arc.start ?? 0) * DEG, e.arc.length * DEG];
}

/** True when the surface has visible insides (open tube, cut shell without walls): draw both sides. */
export function primitiveDoubleSided(e: GeoSpec): boolean {
  if (e.shape !== "cylinder" && e.shape !== "cone") return false;
  if (e.shape === "cylinder" && e.inner) return false;
  return !!e.open || !!arcOf(e);
}

/**
 * A hollow cylinder (or a sector of one) with solid walls: an annulus extruded along Y.
 * Angles use the cylinder convention (θ = 0 on +Z, 90° on +X).
 */
function hollowCylinder(R: number, r: number, h: number, arc: [number, number] | null): THREE.BufferGeometry {
  const rr = Math.min(r, R * 0.999);
  const shape = new THREE.Shape();
  // Shape (a, b) maps to world (x = a, z = −b) after rotateX(−90°); θ → φ = θ − 90°.
  const seg = Math.max(8, Math.ceil(96 * ((arc?.[1] ?? 2 * Math.PI) / (2 * Math.PI))));
  if (!arc) {
    shape.absarc(0, 0, R, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, rr, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  } else {
    const p0 = arc[0] - Math.PI / 2, p1 = p0 + arc[1];
    shape.moveTo(Math.cos(p0) * R, Math.sin(p0) * R);
    shape.absarc(0, 0, R, p0, p1, false);
    shape.lineTo(Math.cos(p1) * rr, Math.sin(p1) * rr);
    shape.absarc(0, 0, rr, p1, p0, true);
    shape.closePath();
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: seg, steps: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2, 0);
  return g;
}

export function primitiveGeometry(e: GeoSpec): THREE.BufferGeometry {
  const s = e.size ?? [];
  const arc = arcOf(e);
  switch (e.shape) {
    case "box": {
      const x = s[0] ?? 1, y = s[1] ?? x, z = s[2] ?? x;
      if (e.radius) return new RoundedBoxGeometry(x, y, z, 4, Math.min(e.radius, x / 2, y / 2, z / 2) * 0.999);
      return new THREE.BoxGeometry(x, y, z);
    }
    case "sphere":
      return new THREE.SphereGeometry(s[0] ?? 0.5, 64, 32);
    case "plane":
      return new THREE.PlaneGeometry(s[0] ?? 10, s[1] ?? s[0] ?? 10).rotateX(-Math.PI / 2);
    case "cylinder": {
      const r = s[0] ?? 0.5, h = s[1] ?? 1;
      if (e.inner) return hollowCylinder(r, e.inner, h, arc);
      return new THREE.CylinderGeometry(r, s[2] ?? r, h, 64, 1, !!e.open, arc?.[0] ?? 0, arc?.[1] ?? Math.PI * 2);
    }
    case "torus": {
      const g = new THREE.TorusGeometry(s[0] ?? 1, s[1] ?? 0.3, 32, arc ? Math.max(8, Math.ceil(128 * (arc[1] / (2 * Math.PI)))) : 128, arc?.[1] ?? Math.PI * 2);
      if (arc && arc[0]) g.rotateZ(arc[0]);
      return g;
    }
    case "cone":
      // CylinderGeometry(radiusTop, radiusBottom, height): a top radius of 0 is a cone.
      return new THREE.CylinderGeometry(s[2] ?? 0, s[0] ?? 0.5, s[1] ?? 1, 64, 1, !!e.open, arc?.[0] ?? 0, arc?.[1] ?? Math.PI * 2);
    case "capsule": {
      const r = s[0] ?? 0.25, h = Math.max(s[1] ?? 1, 2 * r);
      return new THREE.CapsuleGeometry(r, h - 2 * r, 12, 48);
    }
  }
}
