// The `color` sky backdrop: a camera-centred dome drawn first, unlit, not tone mapped,
// so the background pixels are exactly the sky colour on WebGPU and WebGL2 alike (a
// THREE.Color background is tone mapped on WebGPU but not on WebGL2).
//
// With fog, the dome fades to the fog colour at the horizon and below it, the way
// infinitely far geometry would be fogged, so a fogged floor meets the background
// without a seam (studio cycloramas).
import * as THREE from "three";
import { acesFilmicInverse } from "./tonemap.ts";

/** Elevation (degrees) over which the horizon fog band fades into the sky colour. */
export const FOG_BAND_DEG = 22;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Backdrop colour (linear RGB) for a view direction with vertical component `y`
 * (sine of the elevation). Without fog it is the sky colour everywhere.
 */
export function backdropColor(y: number, sky: readonly number[], fog?: readonly number[]): [number, number, number] {
  if (!fog) return [sky[0]!, sky[1]!, sky[2]!];
  const el = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  const k = smooth(0, FOG_BAND_DEG, el); // 0 at and below the horizon, 1 high up
  return [fog[0]! + (sky[0]! - fog[0]!) * k, fog[1]! + (sky[1]! - fog[1]!) * k, fog[2]! + (sky[2]! - fog[2]!) * k];
}

export class Backdrop {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private key = "";

  constructor() {
    const geo = new THREE.SphereGeometry(50, 48, 96);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(geo.attributes.position!.count * 3), 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false, depthTest: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "__backdrop";
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.userData.tera = "sky";
  }

  /**
   * Colours as #rrggbb; fog optional. `toneMappedAt` = exposure when the backend tone-maps
   * unlit materials too (WebGPU): the colours are pre-inverted so they still land exactly.
   */
  set(sky: string, fog?: string, toneMappedAt?: number) {
    const key = `${sky}|${fog ?? ""}|${toneMappedAt ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    const s = new THREE.Color(sky), f = fog ? new THREE.Color(fog) : null;
    const pos = this.mesh.geometry.attributes.position!, col = this.mesh.geometry.attributes.color!;
    const r = this.mesh.geometry.parameters.radius;
    for (let i = 0; i < pos.count; i++) {
      // Blend in display-linear space first, then pre-invert, so the band matches across backends too.
      let c = backdropColor(pos.getY(i) / r, [s.r, s.g, s.b], f ? [f.r, f.g, f.b] : undefined);
      if (toneMappedAt !== undefined) c = acesFilmicInverse(c, toneMappedAt);
      col.setXYZ(i, c[0], c[1], c[2]);
    }
    col.needsUpdate = true;
  }

  follow(camera: THREE.Camera) {
    camera.getWorldPosition(this.mesh.position);
    this.mesh.updateMatrixWorld();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** A colour that shows as `hex` after the renderer's output transform (see tonemap.ts). */
export function exactColor(hex: string, toneMappedAt?: number): THREE.Color {
  const c = new THREE.Color(hex);
  if (toneMappedAt === undefined) return c;
  const [r, g, b] = acesFilmicInverse([c.r, c.g, c.b], toneMappedAt);
  return c.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}
