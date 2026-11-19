// Flows (light pulses streaming along a path, optionally inside a glass pipe) and meters
// (a 0..1 bar or ring for machine load).
//
// A flow is a handful of InstancedMeshes: bright cores plus soft camera-facing halos,
// additive and untonemapped so they glow without a bloom pass (and bloom only makes them
// better). Pulse i sits at s = (t - i/rate)·speed, so any t gives exact positions.
import * as THREE from "three";
import type { Graph, PathDef } from "../schema/living.ts";
import { flowPulses, hash01, maxPulses, pointAt, samplePath, tangentAt, type Pulse, type Sampled, type V3 } from "./living-math.ts";
import { glowTexture } from "./actors.ts";
import { exactColor, makeExact } from "./exact.ts";

export interface LivingWorld {
  paths: PathDef[];
  graph: Graph | undefined;
}

export interface FlowSpec {
  id: string;
  kind: "flow";
  path: string;
  rate?: number;
  speed?: number;
  color?: string;
  size?: number;
  glow?: boolean;
  style?: "dots" | "dashes" | "comet";
  pipe?: boolean | { radius?: number; color?: string; opacity?: number; collars?: false | { every?: number; max?: number; tube?: number; color?: string } };
}

export interface MeterSpec {
  id: string;
  kind: "meter";
  value: number;
  style?: "bar" | "ring";
  size?: number[];
  color?: string;
  track?: string;
  vertical?: boolean;
}

const TAIL = 14;
const smooth01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;

/** A three.js curve over a sampled path (for TubeGeometry). */
class SampledCurve extends THREE.Curve<THREE.Vector3> {
  private tmp: V3 = [0, 0, 0];
  constructor(private path: Sampled) {
    super();
  }
  override getPoint(u: number, target = new THREE.Vector3()): THREE.Vector3 {
    const p = pointAt(this.path, u * this.path.length * (this.path.closed ? 0.999999 : 1), this.tmp);
    return target.set(p[0], p[1], p[2]);
  }
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _t = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const pos: V3 = [0, 0, 0];
const tan: V3 = [0, 0, 1];

export class FlowObject {
  readonly obj = new THREE.Group();
  private path: Sampled | null = null;
  private pathKey = "";
  private core: THREE.InstancedMesh | null = null;
  private halo: THREE.InstancedMesh | null = null;
  private pipe: THREE.Object3D[] = [];
  private pulses: Pulse[] = [];
  private color = new THREE.Color();

  constructor(public spec: FlowSpec, private warn: (m: string) => void) {}

  /** (Re)build geometry when the path it follows changed. */
  setWorld(w: LivingWorld) {
    const p = w.paths.find((x) => x.id === this.spec.path);
    const key = JSON.stringify(p ?? null);
    if (key === this.pathKey) return;
    this.pathKey = key;
    this.clear();
    if (!p) {
      this.warn(`flow "${this.spec.id}": no path "${this.spec.path}"`);
      this.path = null;
      return;
    }
    this.path = samplePath(p, 0.1);
    this.build();
  }

  private clear() {
    for (const o of [this.core, this.halo, ...this.pipe]) {
      if (!o) continue;
      o.removeFromParent();
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | undefined;
        if (mat) mat.dispose();
      });
    }
    this.core = this.halo = null;
    this.pipe = [];
  }

  dispose() {
    this.clear();
  }

  private get rate() { return this.spec.rate ?? 2; }
  private get speed() { return this.spec.speed ?? 3; }
  private get size() { return this.spec.size ?? 0.08; }
  private get style() { return this.spec.style ?? "dots"; }

  private build() {
    const path = this.path!;
    this.color.set(this.spec.color ?? "#9dff3a");
    const n = maxPulses(path.length, this.rate, this.speed, path.closed);
    const coreGeo = this.style === "dashes" ? new THREE.CapsuleGeometry(1, 5, 4, 10) : new THREE.IcosahedronGeometry(1, 2);
    // Cores: per-pulse colours pre-compensated for tone mapping (exact.ts), so they stay saturated on both backends.
    const coreMat = new THREE.MeshBasicMaterial({ color: "#ffffff", ...additive, toneMapped: true });
    coreMat.userData.glow = true;
    const core = new THREE.InstancedMesh(coreGeo, coreMat, n);
    core.frustumCulled = false;
    core.setColorAt(0, _c);
    core.renderOrder = 6;
    this.core = core;
    this.obj.add(core);
    const haloPer = this.style === "comet" ? TAIL : this.style === "dashes" ? 3 : 1;
    if (this.spec.glow !== false || this.style === "comet") {
      const haloMat = new THREE.MeshBasicMaterial({ color: "#ffffff", map: glowTexture(), ...additive });
      haloMat.userData.glow = true;
      const halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, n * haloPer);
      halo.frustumCulled = false;
      halo.setColorAt(0, _c);
      halo.renderOrder = 7;
      this.halo = halo;
      this.obj.add(halo);
    }
    if (this.spec.pipe) this.buildPipe(path);
  }

  private buildPipe(path: Sampled) {
    const def = typeof this.spec.pipe === "object" ? this.spec.pipe : {};
    const r = def.radius ?? Math.max(this.size * 2.6, 0.12);
    const curve = new SampledCurve(path);
    const segs = Math.min(2000, Math.max(16, Math.ceil(path.length / 0.12)));
    // Glass: a faint, glossy shell (front faces) plus its inside (back faces, fainter).
    const glassColor = def.color ?? "#cfe9ff";
    const op = def.opacity ?? 0.16;
    const shell = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, r, 20, path.closed),
      new THREE.MeshStandardMaterial({ color: glassColor, transparent: true, opacity: op, roughness: 0.04, metalness: 0.1, depthWrite: false, side: THREE.FrontSide }),
    );
    shell.renderOrder = 8;
    const inner = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, r * 0.985, 20, path.closed),
      makeExact(new THREE.MeshBasicMaterial({ ...additive, side: THREE.BackSide }), this.color.clone().multiplyScalar(0.05)),
    );
    inner.renderOrder = 5;
    // A faint light core along the axis: the pipe reads as "lit" between pulses.
    const axis = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, r * 0.16, 8, path.closed),
      makeExact(new THREE.MeshBasicMaterial({ ...additive }), this.color.clone().multiplyScalar(0.18)),
    );
    axis.renderOrder = 5;
    // Collars: dark metal rings every ~2.4 m that make it read as a pipe. `collars` tunes them
    // (false = none; every / max: a long run spreads at most `max` rings; tube; color).
    this.pipe = [inner, axis, shell];
    for (const o of this.pipe) this.obj.add(o);
    if (def.collars === false) return;
    const cd = def.collars ?? {};
    const step = Math.max(cd.every ?? 2.4, cd.max ? path.length / (cd.max - 1) : 0);
    const count = Math.max(2, Math.floor(path.length / step) + 1);
    const collar = new THREE.InstancedMesh(
      new THREE.TorusGeometry(r * 1.04, r * (cd.tube ?? 0.13), 10, 28),
      new THREE.MeshStandardMaterial({ color: cd.color ?? "#3a404a", roughness: 0.35, metalness: 0.85 }),
      count,
    );
    for (let i = 0; i < count; i++) {
      const s = path.closed ? (i * path.length) / count : Math.min(path.length, 0.15 + i * ((path.length - 0.3) / (count - 1)));
      pointAt(path, s, pos);
      tangentAt(path, s, tan, 0.1);
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _t.set(tan[0], tan[1], tan[2]));
      collar.setMatrixAt(i, _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(1, 1, 1)));
    }
    collar.castShadow = true;
    collar.receiveShadow = true;
    this.pipe.push(collar);
    this.obj.add(collar);
  }

  update(t: number, camera: THREE.Camera) {
    const path = this.path, core = this.core;
    if (!path || !core) return;
    const L = path.length, size = this.size, speed = this.speed;
    const pulses = flowPulses(L, this.rate, speed, t, path.closed, this.pulses);
    // Halos face the camera in the flow's local space.
    camera.getWorldQuaternion(_q);
    this.obj.getWorldQuaternion(_qi).invert();
    const bill = _qi.multiply(_q).clone();
    const style = this.style;
    let h = 0;
    const halo = this.halo;
    const haloAt = (s: number, scale: number, bright: number) => {
      if (!halo) return;
      pointAt(path, s, pos);
      halo.setMatrixAt(h, _m.compose(_p.set(pos[0], pos[1], pos[2]), bill, _s.setScalar(scale)));
      halo.setColorAt(h, _c.copy(this.color).multiplyScalar(bright));
      h++;
    };
    pulses.forEach((pl, k) => {
      const j = 0.85 + 0.3 * hash01(pl.i, 11);
      const bright = (0.75 + 0.25 * hash01(pl.i, 23)) * (path.closed ? 1 : smooth01(pl.s / 0.6) * smooth01((L - pl.s) / 0.6));
      pointAt(path, pl.s, pos);
      tangentAt(path, pl.s, tan, 0.08);
      _t.set(tan[0], tan[1], tan[2]);
      const r = size * j;
      if (style === "dashes") {
        _q.setFromUnitVectors(UP, _t);
        core.setMatrixAt(k, _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(r * 0.6, r * 0.6, r * 0.6)));
      } else core.setMatrixAt(k, _m.compose(_p.set(pos[0], pos[1], pos[2]), _q.identity(), _s.setScalar(r * (style === "comet" ? 1.1 : 1))));
      // Core: white-hot centre tinted towards the flow colour.
      core.setColorAt(k, exactColor(_c.copy(this.color).lerp(WHITE, style === "dots" ? 0.45 : 0.25).multiplyScalar(bright * 1.25), _c));
      if (style === "dots") haloAt(pl.s, r * 9, bright * 0.9);
      else if (style === "dashes") for (let d = -1; d <= 1; d++) haloAt(pl.s + d * r * 1.6, r * 7, bright * 0.8);
      else for (let d = 0; d < TAIL; d++) {
        const f = 1 - d / TAIL;
        const sd = pl.s - d * r * 1.5;
        if (!path.closed && sd < 0) break;
        haloAt(sd, r * (d === 0 ? 10 : 7 * f + 1.5), bright * (d === 0 ? 1 : 0.7 * f * f));
      }
    });
    core.count = pulses.length;
    core.instanceMatrix.needsUpdate = true;
    if (core.instanceColor) core.instanceColor.needsUpdate = true;
    if (halo) {
      halo.count = h;
      halo.instanceMatrix.needsUpdate = true;
      if (halo.instanceColor) halo.instanceColor.needsUpdate = true;
    }
  }
}

/** Green → amber → red by load. */
export function loadColor(v: number, out = new THREE.Color()): THREE.Color {
  const g = new THREE.Color("#7dff4a"), a = new THREE.Color("#ffb52e"), r = new THREE.Color("#ff4d3d");
  return v < 0.6 ? out.copy(g).lerp(a, v / 0.6) : out.copy(a).lerp(r, Math.min(1, (v - 0.6) / 0.4));
}

export class MeterObject {
  readonly obj = new THREE.Group();
  private fill: THREE.Mesh;
  private shown: number;
  private ringValue = -1;
  private fillMat: THREE.MeshBasicMaterial;
  private fillTarget: THREE.Color;

  constructor(public spec: MeterSpec, private animate: boolean, previous?: number) {
    this.shown = previous ?? spec.value;
    const s = spec.size ?? [];
    const trackMat = new THREE.MeshStandardMaterial({ color: spec.track ?? "#1b1f26", roughness: 0.6, metalness: 0.3 });
    this.fillMat = makeExact(new THREE.MeshBasicMaterial(), "#ffffff");
    this.fillTarget = new THREE.Color();
    if ((spec.style ?? "bar") === "bar") {
      const len = s[0] ?? 1, th = s[1] ?? 0.08;
      const track = new THREE.Mesh(new THREE.BoxGeometry(len + th * 0.5, th * 1.5, th * 1.5), trackMat);
      const geo = new THREE.BoxGeometry(1, th, th * 1.6);
      geo.translate(0.5, 0, 0);
      this.fill = new THREE.Mesh(geo, this.fillMat);
      this.fill.position.x = -len / 2;
      this.fill.userData.len = len;
      const g = new THREE.Group();
      g.add(track, this.fill);
      if (spec.vertical) g.rotation.z = Math.PI / 2;
      this.obj.add(g);
    } else {
      const R = s[0] ?? 0.5, th = s[1] ?? 0.06;
      this.obj.add(new THREE.Mesh(new THREE.TorusGeometry(R, th * 0.8, 10, 64), trackMat));
      this.fill = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMat);
      this.fill.userData.R = R;
      this.fill.userData.th = th;
      this.obj.add(this.fill);
    }
    this.draw();
  }

  get value() { return this.shown; }

  update(dt: number) {
    const target = this.spec.value;
    if (this.animate && Math.abs(target - this.shown) > 1e-4) this.shown += (target - this.shown) * (1 - Math.exp(-dt / 0.3));
    else this.shown = target;
    this.draw();
  }

  private draw() {
    const v = Math.max(0, Math.min(1, this.shown));
    if (this.spec.color) this.fillTarget.set(this.spec.color);
    else loadColor(v, this.fillTarget);
    exactColor(this.fillTarget, this.fillMat.color);
    if (this.fill.userData.len !== undefined) {
      this.fill.scale.x = Math.max(1e-4, v * this.fill.userData.len);
      return;
    }
    if (Math.abs(v - this.ringValue) < 0.002) return;
    this.ringValue = v;
    this.fill.geometry.dispose();
    // Ring fills clockwise from 12 o'clock.
    const g = new THREE.TorusGeometry(this.fill.userData.R, this.fill.userData.th, 10, 96, Math.max(1e-3, v) * Math.PI * 2);
    g.rotateZ(Math.PI / 2);
    g.rotateY(Math.PI);
    this.fill.geometry = g;
  }

  dispose() {
    this.obj.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}
