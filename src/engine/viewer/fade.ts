// Cross-fades for islands in the live viewer (docs/islands.md "Lazy loading"): when an island swaps
// its impostor for the full world (or back), the old look stays drawn as a ghost and dissolves while
// the new one comes in, so nothing pops.
//
// Materials may be shared between meshes (and with other islands), so a fade never touches a
// mesh's own material: each faded mesh gets a temporary clone (alpha-hashed, so it keeps depth
// writes and needs no sorting; already-transparent glass fades its opacity) and gets its own
// material back at the end. Night emissive and other per-frame material changes made by the
// engine on the originals are copied onto the clones while the fade runs.
import * as THREE from "three";

type Std = THREE.Material & { opacity: number; transparent: boolean; alphaHash?: boolean; emissive?: THREE.Color; emissiveIntensity?: number; color?: THREE.Color };

interface Faded {
  mesh: THREE.Mesh;
  orig: Std;
  clone: Std;
  base: number;
}

const fadeable = (m: THREE.Material | THREE.Material[] | undefined): m is Std =>
  !!m && !Array.isArray(m) && ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial) === true;

/** One running fade of a set of objects from `from` to `to` opacity (0..1). */
export class Fade {
  private items: Faded[] = [];
  private t = 0;
  done = false;
  constructor(root: THREE.Object3D, readonly from: number, readonly to: number, readonly seconds: number, private onEnd?: () => void) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !fadeable(mesh.material)) return;
      const orig = mesh.material;
      const clone = orig.clone() as Std;
      if (!orig.transparent) clone.alphaHash = true;
      clone.opacity = orig.opacity * from;
      this.items.push({ mesh, orig, clone, base: orig.opacity });
      mesh.material = clone;
    });
    if (!this.items.length && seconds > 0) this.t = seconds; // nothing to fade: finish next frame
  }

  /** Advance; true while running. */
  step(dt: number): boolean {
    if (this.done) return false;
    this.t += dt;
    const u = this.seconds > 0 ? Math.min(1, this.t / this.seconds) : 1;
    const k = this.from + (this.to - this.from) * (u * u * (3 - 2 * u));
    for (const f of this.items) {
      if (f.mesh.material !== f.clone) continue; // rebuilt meanwhile: its own material is back
      f.clone.opacity = f.base * k;
      if (f.clone.emissive && f.orig.emissive) f.clone.emissive.copy(f.orig.emissive);
      if (f.orig.emissiveIntensity !== undefined) f.clone.emissiveIntensity = f.orig.emissiveIntensity;
      if (f.clone.color && f.orig.color) f.clone.color.copy(f.orig.color);
    }
    if (u >= 1) this.end();
    return !this.done;
  }

  /** Stop now: every mesh gets its own material back. */
  end() {
    if (this.done) return;
    this.done = true;
    for (const f of this.items) {
      if (f.mesh.material === f.clone) f.mesh.material = f.orig;
      f.clone.dispose();
    }
    this.items = [];
    this.onEnd?.();
  }
}

/**
 * A ghost of `obj`'s children at the same place in the scene (own geometry copies: the engine
 * disposes the originals; materials stay shared until a Fade swaps them): what an island looked
 * like a moment ago, to dissolve while its new look comes in. `drop()` removes and frees it.
 */
export function ghostOf(obj: THREE.Object3D, scene: THREE.Object3D): { root: THREE.Object3D; drop(): void } {
  obj.updateWorldMatrix(true, true);
  const g = new THREE.Group();
  g.name = `ghost:${obj.name || obj.uuid}`;
  for (const c of [...obj.children]) {
    const k = c.clone(true);
    c.matrixWorld.decompose(k.position, k.quaternion, k.scale);
    g.add(k);
  }
  // no lights in a ghost (a doubled lamp for a second, and a light count change recompiles shaders)
  const lights: THREE.Object3D[] = [];
  g.traverse((o) => { if ((o as THREE.Light).isLight) lights.push(o); });
  for (const l of lights) l.removeFromParent();
  const geos: THREE.BufferGeometry[] = [];
  g.traverse((o) => {
    o.castShadow = false; // a ghost only shows itself (no doubled shadows)
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!fadeable(m.material)) { m.visible = false; return; } // screens, text: not faded, not kept
    m.geometry = m.geometry.clone();
    geos.push(m.geometry);
  });
  scene.add(g);
  return { root: g, drop: () => { g.removeFromParent(); for (const x of geos) x.dispose(); } };
}
