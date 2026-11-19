// The real sky's objects (sky.mode "real"): stars, the Milky Way, planets, the moon, the sun
// disc and satellites, on domes around the camera. Plain instanced quads with basic materials
// (no custom shaders), so it draws the same on WebGPU and WebGL2.
//
// Every quad faces the dome centre (the camera), so a star is a round dot from anywhere; star
// and satellite dots keep a constant size in pixels (recomputed when the field of view or the
// viewport changes). Brightness follows magnitude against the sky's limiting magnitude, so the
// sky fills in through twilight. Twinkling is live mode only; render mode is a pure function
// of the sky time and the camera.
import * as THREE from "three";
import { applyM3, brightLimb, catalogToWorld, equatorialToWorld, lstDeg, planetPosition, PLANET_NAMES, radecToVec, type M3, type PlanetName, type V3 } from "./astro.ts";
import { milkyWay, starColor, type StarTable } from "./stars.ts";
import { satMagnitude, type SatFrame, type SatRecord } from "./satellites.ts";

/** Dome radii (m): all inside the camera's far plane (3000), outside any world. */
const R_MILKY = 1900, R_STARS = 1850, R_PLANETS = 1800, R_SATS = 1750, R_MOON = 1700, R_SUN = 1650;

/** Display intensity of a point of magnitude m (compressed: the eye and a screen can't do 10 stops). */
export function magIntensity(m: number): number {
  return Math.pow(10, -0.4 * m * 0.55) * 1.3;
}
/** On-screen diameter in CSS px of a point of magnitude m (bright stars read bigger). */
export function magPixels(m: number): number {
  return 2.3 + 1.25 * Math.max(0, 4.2 - m) ** 1.1;
}
/** Visibility of a point of magnitude m against limiting magnitude `limit` (0..1, smooth). */
export function magVisible(m: number, limit: number): number {
  const t = Math.min(1, Math.max(0, (limit + 0.4 - m) / 1.4));
  return t * t * (3 - 2 * t);
}

function pointTexture(): THREE.DataTexture {
  const n = 64, data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1, r = Math.hypot(x, y);
    const a = r >= 1 ? 0 : Math.min(1, Math.exp(-((r / 0.36) ** 2)) + 0.1 * Math.exp(-((r / 0.62) ** 2))) * (1 - r ** 8);
    const k = (j * n + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255;
    data[k + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Trail texture: transparent tail (u = 0) to bright head (u = 1), soft across. */
function trailTexture(): THREE.DataTexture {
  const w = 64, h = 16, data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const u = (i + 0.5) / w, v = ((j + 0.5) / h) * 2 - 1;
    const a = Math.pow(u, 1.6) * Math.exp(-((v / 0.45) ** 2));
    const k = (j * w + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255;
    data[k + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function glowTexture(): THREE.DataTexture {
  const n = 128, data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot((i + 0.5) / n * 2 - 1, (j + 0.5) / n * 2 - 1);
    const a = r >= 1 ? 0 : (Math.exp(-((r / 0.09) ** 2)) * 0.6 + Math.exp(-((r / 0.3) ** 2)) * 0.3 + 0.1 * (1 - r) ** 3) * (1 - r ** 4);
    const k = (j * n + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255;
    data[k + 3] = Math.round(Math.min(1, a) * 255);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const additive = (map: THREE.Texture, opts: Partial<THREE.MeshBasicMaterialParameters> = {}) =>
  new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, ...opts });

const QUAD = new THREE.PlaneGeometry(1, 1);

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _p = new THREE.Vector3();

/** Matrix of a quad on a dome at unit direction (dx,dy,dz), facing the centre, `sx` × `sy` big, with its +X along `xHint` when given. */
function domeQuad(out: THREE.Matrix4, dx: number, dy: number, dz: number, r: number, sx: number, sy: number, xHint?: THREE.Vector3) {
  _z.set(-dx, -dy, -dz);
  if (xHint) _x.copy(xHint).addScaledVector(_z, -xHint.dot(_z));
  else _x.set(-dz, 0, dx); // horizontal, perpendicular to the direction
  if (_x.lengthSq() < 1e-12) _x.set(1, 0, 0).addScaledVector(_z, -_z.x);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _p.set(dx * r, dy * r, dz * r);
  return out.set(_x.x * sx, _y.x * sy, _z.x, _p.x, _x.y * sx, _y.y * sy, _z.y, _p.y, _x.z * sx, _y.z * sy, _z.z, _p.z, 0, 0, 0, 1);
}

const markSky = (o: THREE.Object3D) => {
  o.userData.tera = "sky";
  o.frustumCulled = false;
  o.raycast = () => {};
};

// ---------------------------------------------------------------- stars

/** Magnitude bins: each is one instanced draw whose brightness fades as a whole. */
const BINS = [-Infinity, 0.5, 1.5, 2.5, 3.25, 4, 4.5, 5, 5.5, 6, Infinity];
const TWINKLE_BINS = 3; // bins brighter than 2.5 twinkle (live mode)

interface StarBin {
  mesh: THREE.InstancedMesh;
  mat: THREE.MeshBasicMaterial;
  mag: number; // representative magnitude
  idx: number[]; // catalogue indices
  base: Float32Array; // rgb per star (intensity × colour)
}

export interface NightOptions {
  stars: boolean;
  magnitudeLimit: number;
  milkyWay: boolean;
  moon: boolean;
  moonScale: number;
  planets: boolean;
  satellites: boolean;
  visibleOnly: boolean;
  maxStars: number;
}

export interface NightState {
  ms: number;
  lat: number;
  lon: number;
  sunDir: V3;
  sunElevation: number;
  /** 0 day … 1 astronomical night. */
  darkness: number;
  /** Naked-eye limiting magnitude of the sky right now. */
  limit: number;
  moonDir: V3;
  moonElevation: number;
  moonIlluminated: number;
  moonDiameter: number;
  /** How much the moon washes out faint things (0..1). */
  moonWash: number;
  cityGlow: number;
  /** Sun disc colour (linear, max 1) and strength 0..1, from the atmosphere. */
  sunColor: V3;
  sunStrength: number;
}

export class NightSky {
  readonly root = new THREE.Group();
  /** Equatorial (J2000) frame: stars and the Milky Way; its matrix is set per update. */
  private readonly celestial = new THREE.Group();
  private bins: StarBin[] = [];
  private stars: StarTable | null = null;
  private milky: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  private milkyJob: { data: Uint8Array; row: number; tex: THREE.DataTexture } | null = null;
  private readonly planets: THREE.InstancedMesh;
  private readonly planetMat: THREE.MeshBasicMaterial;
  private readonly moonLit: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly moonDark: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly moonGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly moonTex: THREE.DataTexture;
  private moonKey = "";
  private readonly sunDisc: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly sunGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private satHeads: THREE.InstancedMesh | null = null;
  private satTrails: THREE.InstancedMesh | null = null;
  private sizeKey = "";
  private pxAngle = 0.001; // radians per CSS px
  private readonly point = pointTexture();
  private readonly trail = trailTexture();
  private readonly glow = glowTexture();
  opts: NightOptions = { stars: true, magnitudeLimit: 6.5, milkyWay: true, moon: true, moonScale: 1, planets: true, satellites: true, visibleOnly: true, maxStars: 10000 };
  /** Live mode: twinkle the bright stars. */
  twinkle = false;
  /** Visible satellites last frame (for info()). */
  satVisible = 0;
  /** XR budget: stars to magnitude 5 (~1 600) and at most 1 500 satellites. */
  xr = false;

  constructor() {
    markSky(this.root);
    markSky(this.celestial);
    this.root.name = "__nightsky";
    this.celestial.matrixAutoUpdate = false;
    this.root.add(this.celestial);

    this.planetMat = additive(this.point, { vertexColors: false });
    this.planets = new THREE.InstancedMesh(QUAD, this.planetMat, PLANET_NAMES.length);
    this.planets.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PLANET_NAMES.length * 3), 3);
    this.planets.renderOrder = -8;
    markSky(this.planets);
    this.root.add(this.planets);

    this.moonTex = new THREE.DataTexture(new Uint8Array(MOON_TEX * MOON_TEX * 4), MOON_TEX, MOON_TEX, THREE.RGBAFormat);
    this.moonTex.colorSpace = THREE.SRGBColorSpace;
    this.moonTex.magFilter = this.moonTex.minFilter = THREE.LinearFilter;
    this.moonDark = new THREE.Mesh(QUAD, new THREE.MeshBasicMaterial({ map: this.moonTex, color: "#000000", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    this.moonLit = new THREE.Mesh(QUAD, additive(this.moonTex));
    this.moonGlow = new THREE.Mesh(QUAD, additive(this.glow));
    this.moonDark.renderOrder = -6;
    this.moonLit.renderOrder = -5;
    this.moonGlow.renderOrder = -4;
    this.sunDisc = new THREE.Mesh(QUAD, additive(sunTexture()));
    this.sunGlow = new THREE.Mesh(QUAD, additive(this.glow));
    this.sunGlow.renderOrder = -3;
    this.sunDisc.renderOrder = -2;
    for (const o of [this.moonDark, this.moonLit, this.moonGlow, this.sunDisc, this.sunGlow]) {
      markSky(o);
      o.matrixAutoUpdate = false;
      this.root.add(o);
    }
  }

  /** Star catalogue (async loaded once). */
  setStars(t: StarTable) {
    if (this.stars === t) return;
    this.stars = t;
    for (const b of this.bins) {
      b.mesh.removeFromParent();
      b.mesh.dispose();
      b.mat.dispose();
    }
    this.bins = [];
    for (let k = 0; k < BINS.length - 1; k++) {
      const lo = BINS[k]!, hi = BINS[k + 1]!;
      const idx: number[] = [];
      for (let i = 0; i < t.count; i++) if (t.mag[i]! >= lo && t.mag[i]! < hi) idx.push(i);
      if (!idx.length) continue;
      const mat = additive(this.point);
      const mesh = new THREE.InstancedMesh(QUAD, mat, idx.length);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 3), 3);
      const base = new Float32Array(idx.length * 3);
      idx.forEach((s, j) => {
        const c = starColor(t.bv[s]!), I = magIntensity(t.mag[s]!);
        base[j * 3] = c[0] * I; base[j * 3 + 1] = c[1] * I; base[j * 3 + 2] = c[2] * I;
      });
      (mesh.instanceColor.array as Float32Array).set(base);
      mesh.renderOrder = -9;
      markSky(mesh);
      this.celestial.add(mesh);
      this.bins.push({ mesh, mat, mag: Number.isFinite(hi) ? (Number.isFinite(lo) ? (lo + hi) / 2 : hi - 0.6) : lo + 0.3, idx, base });
    }
    this.sizeKey = "";
  }

  /** Milky Way texture in the equatorial frame; built in slices (`budgetMs` per call, Infinity = now). */
  private buildMilky(budgetMs: number) {
    const W = 1024, H = 512;
    if (!this.milky) {
      const data = new Uint8Array(W * H * 4);
      const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.BackSide, color: 0x000000 });
      this.milky = new THREE.Mesh(new THREE.SphereGeometry(R_MILKY, 96, 48), mat);
      this.milky.renderOrder = -10;
      markSky(this.milky);
      this.milky.visible = false;
      this.celestial.add(this.milky);
      this.milkyJob = { data, row: 0, tex };
    }
    const job = this.milkyJob;
    if (!job) return;
    const t0 = performance.now();
    const c: V3 = [0, 0, 0];
    const enc = (v: number) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    while (job.row < H) {
      const j = job.row++;
      const v = 1 - (j + 0.5) / H;
      const sv = Math.sin(Math.PI * v), cv = Math.cos(Math.PI * v);
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const e: V3 = [-Math.cos(2 * Math.PI * u) * sv, cv, Math.sin(2 * Math.PI * u) * sv];
        // sphere-local y is the third equatorial axis here: the mesh is rotated below
        const eq: V3 = [e[0], -e[2], e[1]];
        milkyWay(eq, c);
        const k = (j * W + i) * 4;
        job.data[k] = enc(c[0] * 0.55); job.data[k + 1] = enc(c[1] * 0.55); job.data[k + 2] = enc(c[2] * 0.55); job.data[k + 3] = 255;
      }
      if (performance.now() - t0 > budgetMs) return;
    }
    job.tex.needsUpdate = true;
    this.milkyJob = null;
    // sphere-local (x, y, z) = equatorial (x, z, −y): rotate +90° about X
    this.milky.rotation.set(Math.PI / 2, 0, 0);
    this.milky.updateMatrix();
    this.milky.visible = true;
  }

  /** Per-star quad sizes for the current field of view / viewport (only when they change). */
  private resize(camera: THREE.PerspectiveCamera, viewportH: number) {
    const key = `${camera.fov.toFixed(2)}|${viewportH}`;
    if (key === this.sizeKey || !this.stars) return;
    this.sizeKey = key;
    // CSS px → radians at the screen centre; never below what 1440 px of height would give
    this.pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(360, viewportH);
    const t = this.stars;
    for (const b of this.bins) {
      b.idx.forEach((s, j) => {
        const size = magPixels(t.mag[s]!) * this.pxAngle * R_STARS;
        domeQuad(_m, t.dir[s * 3]!, t.dir[s * 3 + 1]!, t.dir[s * 3 + 2]!, R_STARS, size, size, _UP_EQ);
        b.mesh.setMatrixAt(j, _m);
      });
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Satellite catalogue for the instanced layers (null = none). */
  setSatellites(sats: SatRecord[] | null) {
    for (const m of [this.satHeads, this.satTrails]) {
      if (!m) continue;
      m.removeFromParent();
      m.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.satHeads = this.satTrails = null;
    this.satRecords = sats;
    if (!sats || !sats.length) return;
    const n = Math.min(sats.length, 20000);
    this.satHeads = new THREE.InstancedMesh(QUAD, additive(this.point), n);
    this.satTrails = new THREE.InstancedMesh(QUAD, additive(this.trail), n);
    for (const m of [this.satHeads, this.satTrails]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.count = 0;
      m.renderOrder = -7;
      markSky(m);
      this.root.add(m);
    }
  }
  private satRecords: SatRecord[] | null = null;

  /**
   * Update for this frame. `wall` = seconds of page time (twinkle only, live mode). `budget` =
   * ms allowed for background builds this frame (Infinity in render mode: build everything now).
   */
  update(camera: THREE.PerspectiveCamera, viewportH: number, s: NightState, sats: SatFrame | null, wall: number, budget: number) {
    camera.getWorldPosition(this.root.position);
    this.root.updateMatrix();
    this.resize(camera, viewportH);
    const o = this.opts;
    const dark = s.darkness;

    // celestial frame: J2000 → world at this time and place
    const M = catalogToWorld(s.ms, s.lat, s.lon);
    this.celestial.matrix.set(M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0, 0, 0, 0, 1);
    this.celestial.matrixWorldNeedsUpdate = true;

    // stars by magnitude bin
    const limit = Math.min(o.magnitudeLimit, s.limit);
    for (const b of this.bins) {
      const v = o.stars && !(this.xr && b.mag > 5) ? magVisible(b.mag, limit) : 0;
      b.mesh.visible = v > 0.003;
      b.mat.color.setScalar(v);
    }
    if (this.twinkle) this.twinkleStars(wall, M);

    // Milky Way: only under a properly dark, moon-free, city-free sky
    if (o.milkyWay && dark > 0.4) {
      if (this.milkyJob || !this.milky) this.buildMilky(budget);
      if (this.milky) {
        const k = Math.max(0, (dark - 0.55) / 0.45) ** 1.5 * (1 - 0.85 * s.moonWash) * (1 - 0.9 * s.cityGlow);
        this.milky.material.color.setScalar(k * 0.2);
        this.milky.visible = !this.milkyJob && k > 0.004;
      }
    } else if (this.milky) this.milky.visible = false;

    this.updatePlanets(s, limit);
    this.updateMoon(camera, s);
    this.updateSun(s);
    this.updateSatellites(s, sats, limit);
  }

  private twinkleStars(wall: number, M: M3) {
    const t = this.stars;
    if (!t) return;
    for (let k = 0; k < Math.min(TWINKLE_BINS, this.bins.length); k++) {
      const b = this.bins[k]!;
      const col = b.mesh.instanceColor!.array as Float32Array;
      b.idx.forEach((s, j) => {
        // scintillation grows toward the horizon (more air)
        const y = M[3] * t.dir[s * 3]! + M[4] * t.dir[s * 3 + 1]! + M[5] * t.dir[s * 3 + 2]!;
        const amp = 0.08 + 0.32 * (1 - Math.min(1, Math.max(0, y)) ** 0.5);
        const n = Math.sin(wall * 9.1 + s * 1.7) * 0.5 + Math.sin(wall * 15.3 + s * 4.1) * 0.3 + Math.sin(wall * 23.7 + s * 0.3) * 0.2;
        const f = 1 + amp * n;
        col[j * 3] = b.base[j * 3]! * f; col[j * 3 + 1] = b.base[j * 3 + 1]! * f; col[j * 3 + 2] = b.base[j * 3 + 2]! * f;
      });
      b.mesh.instanceColor!.needsUpdate = true;
    }
  }

  private updatePlanets(s: NightState, limit: number) {
    if (!this.opts.planets) {
      this.planets.visible = false;
      return;
    }
    this.planets.visible = true;
    const E = equatorialToWorld(lstDeg(s.ms, s.lon), s.lat);
    const col = this.planets.instanceColor!.array as Float32Array;
    PLANET_NAMES.forEach((name, i) => {
      const p = planetPosition(name, s.ms);
      const d = applyM3(E, radecToVec(p.ra, p.dec));
      const size = (magPixels(p.mag) + 1) * this.pxAngle * R_PLANETS;
      domeQuad(_m, d[0], d[1], d[2], R_PLANETS, size, size);
      this.planets.setMatrixAt(i, _m);
      // planets show a little earlier than stars of the same magnitude (steady light)
      const v = magVisible(p.mag, limit + 0.6) * magIntensity(p.mag);
      const c = PLANET_TINT[name];
      col[i * 3] = c[0] * v; col[i * 3 + 1] = c[1] * v; col[i * 3 + 2] = c[2] * v;
    });
    this.planets.instanceMatrix.needsUpdate = true;
    this.planets.instanceColor!.needsUpdate = true;
  }

  private updateMoon(camera: THREE.PerspectiveCamera, s: NightState) {
    const show = this.opts.moon && s.moonElevation > -2;
    for (const o of [this.moonLit, this.moonDark, this.moonGlow]) o.visible = show;
    if (!show) return;
    const md = s.moonDir;
    const limb = brightLimb(md, s.sunDir);
    // celestial north projected on the disc, in the disc's (limb, up) frame
    const ncp = applyM3(equatorialToWorld(lstDeg(s.ms, s.lon), s.lat), [0, 0, 1]);
    _z.set(-md[0], -md[1], -md[2]);
    _x.set(limb[0], limb[1], limb[2]);
    _y.crossVectors(_z, _x);
    const psi = Math.atan2(ncp[0] * _y.x + ncp[1] * _y.y + ncp[2] * _y.z, ncp[0] * _x.x + ncp[1] * _x.y + ncp[2] * _x.z);
    const phaseAngle = Math.acos(Math.max(-1, Math.min(1, 2 * s.moonIlluminated - 1)));
    const key = `${phaseAngle.toFixed(3)}|${psi.toFixed(2)}`;
    if (key !== this.moonKey) {
      this.moonKey = key;
      drawMoon(this.moonTex.image.data as Uint8Array, phaseAngle, psi);
      this.moonTex.needsUpdate = true;
    }
    const size = R_MOON * 2 * Math.tan(THREE.MathUtils.degToRad(s.moonDiameter * this.opts.moonScale) / 2) * (MOON_TEX / MOON_DISC);
    const xh = new THREE.Vector3(limb[0], limb[1], limb[2]);
    domeQuad(this.moonLit.matrix, md[0], md[1], md[2], R_MOON, size, size, xh);
    domeQuad(this.moonDark.matrix, md[0], md[1], md[2], R_MOON + 1, size, size, xh);
    const g = size * 9;
    domeQuad(this.moonGlow.matrix, md[0], md[1], md[2], R_MOON - 1, g, g);
    for (const o of [this.moonLit, this.moonDark, this.moonGlow]) o.matrixWorldNeedsUpdate = true;
    // brightness: pale by day, bright by night; low moons dim and warm (more air)
    const air = Math.max(0, Math.min(1, (s.moonElevation + 1) / 12));
    const warm: V3 = [1, 0.86 + 0.14 * air, 0.7 + 0.3 * air];
    const gain = (0.3 + 1.25 * s.darkness ** 1.4) * (0.35 + 0.65 * air);
    this.moonLit.material.color.setRGB(warm[0] * gain, warm[1] * gain, warm[2] * gain, THREE.LinearSRGBColorSpace);
    this.moonDark.material.opacity = Math.min(1, s.darkness * 1.2);
    const glow = s.moonIlluminated ** 2 * s.darkness * air * 0.07;
    this.moonGlow.material.color.setRGB(0.75 * glow, 0.82 * glow, glow, THREE.LinearSRGBColorSpace);
    void camera;
  }

  private updateSun(s: NightState) {
    const show = s.sunElevation > -1.2;
    this.sunDisc.visible = this.sunGlow.visible = show;
    if (!show) return;
    const d = s.sunDir;
    const size = R_SUN * 2 * Math.tan(THREE.MathUtils.degToRad(0.533) / 2) * 1.25;
    domeQuad(this.sunDisc.matrix, d[0], d[1], d[2], R_SUN, size, size);
    const g = size * 26;
    domeQuad(this.sunGlow.matrix, d[0], d[1], d[2], R_SUN + 1, g, g);
    this.sunDisc.matrixWorldNeedsUpdate = this.sunGlow.matrixWorldNeedsUpdate = true;
    const c = s.sunColor, k = 30 * Math.max(0.04, s.sunStrength) + 4;
    const fade = Math.min(1, (s.sunElevation + 1.2) / 1.5);
    this.sunDisc.material.color.setRGB(c[0] * k * fade, c[1] * k * fade, c[2] * k * fade, THREE.LinearSRGBColorSpace);
    const gk = 0.55 * fade;
    this.sunGlow.material.color.setRGB(c[0] * gk, c[1] * 0.8 * gk, c[2] * 0.62 * gk, THREE.LinearSRGBColorSpace);
  }

  private updateSatellites(s: NightState, f: SatFrame | null, limit: number) {
    const heads = this.satHeads, trails = this.satTrails, recs = this.satRecords;
    this.satVisible = 0;
    if (!heads || !trails || !recs || !f || !this.opts.satellites) {
      if (heads) heads.count = 0;
      if (trails) trails.count = 0;
      return;
    }
    const hc = heads.instanceColor!.array as Float32Array, tc = trails.instanceColor!.array as Float32Array;
    const visibleOnly = this.opts.visibleOnly;
    let n = 0;
    const head = new THREE.Vector3(), tail = new THREE.Vector3();
    const cap = this.xr ? Math.min(1500, heads.instanceMatrix.count) : heads.instanceMatrix.count;
    for (let i = 0; i < f.count && n < cap; i++) {
      const rec = recs[f.index[i]!]!;
      const mag = satMagnitude(f.rangeKm[i]!, f.shadow[i]!, rec.stdMag);
      let I: number, r = 1, g = 0.97, b = 0.92;
      if (Number.isFinite(mag)) {
        // horizon extinction: ~1.5 mag at 5° up
        const el = Math.asin(Math.max(0, Math.min(1, f.dir[i * 3 + 1]!)));
        const ext = 0.25 / Math.max(0.09, Math.sin(el));
        I = magIntensity(mag + ext) * magVisible(mag + ext, limit);
      } else I = 0;
      if (!visibleOnly) {
        // the "data" view: every object above the horizon, eclipsed ones as faint blue dots
        if (I < 0.035) { I = 0.035; r = 0.55; g = 0.7; b = 1; }
      }
      if (I < 0.004) continue;
      const dx = f.dir[i * 3]!, dy = f.dir[i * 3 + 1]!, dz = f.dir[i * 3 + 2]!;
      const size = Math.max(rec.low ? 3.2 : 2.7, Number.isFinite(mag) ? magPixels(mag) * 0.9 : 0) * this.pxAngle * R_SATS;
      domeQuad(_m, dx, dy, dz, R_SATS, size, size);
      heads.setMatrixAt(n, _m);
      hc[n * 3] = r * I * 1.2; hc[n * 3 + 1] = g * I * 1.2; hc[n * 3 + 2] = b * I * 1.2;
      // trail: from the earlier position to the head, on the dome
      head.set(dx, dy, dz);
      tail.set(f.tail[i * 3]!, f.tail[i * 3 + 1]!, f.tail[i * 3 + 2]!);
      const ang = head.angleTo(tail);
      if (ang > 1e-5) {
        const mid = head.clone().add(tail).normalize();
        const along = head.clone().sub(tail).normalize();
        const len = ang * R_SATS;
        domeQuad(_m, mid.x, mid.y, mid.z, R_SATS + 1, len, size * 0.8, along);
        trails.setMatrixAt(n, _m);
        const tk = 0.45 * I;
        tc[n * 3] = r * tk; tc[n * 3 + 1] = g * tk; tc[n * 3 + 2] = b * tk;
      } else {
        trails.setMatrixAt(n, _m.makeScale(0, 0, 0));
        tc[n * 3] = tc[n * 3 + 1] = tc[n * 3 + 2] = 0;
      }
      n++;
    }
    heads.count = trails.count = n;
    heads.instanceMatrix.needsUpdate = trails.instanceMatrix.needsUpdate = true;
    heads.instanceColor!.needsUpdate = trails.instanceColor!.needsUpdate = true;
    this.satVisible = n;
  }

  dispose() {
    this.setSatellites(null);
    for (const b of this.bins) { b.mesh.dispose(); b.mat.dispose(); }
    this.milky?.geometry.dispose();
    this.milky?.material.map?.dispose();
    this.milky?.material.dispose();
    for (const t of [this.point, this.trail, this.glow, this.moonTex]) t.dispose();
  }
}

const _UP_EQ = new THREE.Vector3(0, 0, 1); // star quads: +X toward celestial north (any is fine for round dots)

const PLANET_TINT: Record<PlanetName, V3> = {
  mercury: [1, 0.9, 0.82],
  venus: [1, 0.97, 0.88],
  mars: [1, 0.55, 0.35],
  jupiter: [1, 0.93, 0.8],
  saturn: [1, 0.88, 0.66],
};

// ---------------------------------------------------------------- the moon's face

const MOON_TEX = 256;
/** Disc diameter inside the texture (the rest is margin for antialiasing). */
const MOON_DISC = 240;

interface Mare { lat: number; lon: number; rLat: number; rLon: number; depth: number }
// Approximate positions and extents of the near side's maria (selenographic degrees), so the
// procedural face reads as the real moon (the "man in the moon"), plus bright rayed craters.
const MARIA: Mare[] = [
  { lat: 33, lon: -16, rLat: 13, rLon: 17, depth: 0.42 }, // Imbrium
  { lat: 28, lon: 17, rLat: 9, rLon: 10, depth: 0.45 }, // Serenitatis
  { lat: 8.5, lon: 31, rLat: 10, rLon: 13, depth: 0.45 }, // Tranquillitatis
  { lat: 17, lon: 59, rLat: 7, rLon: 9, depth: 0.45 }, // Crisium
  { lat: -8, lon: 51, rLat: 9, rLon: 8, depth: 0.38 }, // Fecunditatis
  { lat: -15, lon: 35, rLat: 6, rLon: 6, depth: 0.36 }, // Nectaris
  { lat: -21, lon: -17, rLat: 9, rLon: 11, depth: 0.34 }, // Nubium
  { lat: -24, lon: -39, rLat: 6, rLon: 6, depth: 0.38 }, // Humorum
  { lat: 18, lon: -57, rLat: 26, rLon: 16, depth: 0.36 }, // Oceanus Procellarum
  { lat: 2, lon: -38, rLat: 12, rLon: 10, depth: 0.3 }, // southern Procellarum
  { lat: 7, lon: -31, rLat: 6, rLon: 9, depth: 0.3 }, // Insularum
  { lat: 56, lon: 1, rLat: 4, rLon: 34, depth: 0.32 }, // Frigoris
  { lat: 13, lon: 4, rLat: 4, rLon: 5, depth: 0.3 }, // Vaporum
  { lat: -10, lon: -22, rLat: 5, rLon: 6, depth: 0.25 }, // Cognitum
];
const CRATERS = [
  { lat: -43.3, lon: -11.2, r: 2.6, rays: 1 }, // Tycho
  { lat: 9.6, lon: -20.1, r: 2.4, rays: 0.6 }, // Copernicus
  { lat: 8.1, lon: -38, r: 1.5, rays: 0.45 }, // Kepler
  { lat: 23.7, lon: -47.4, r: 1.4, rays: 0.3 }, // Aristarchus (the brightest spot)
];

let albedoCache: Float32Array | null = null;
/** Albedo map of the near side in a north-up disc frame (x right = lunar east toward Crisium). */
function moonAlbedo(): Float32Array {
  if (albedoCache) return albedoCache;
  const n = MOON_DISC, a = new Float32Array(n * n);
  const D = Math.PI / 180;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * 2 - 1, y = 1 - ((j + 0.5) / n) * 2;
    const rr = x * x + y * y;
    if (rr > 1) continue;
    const lat = Math.asin(y), lon = Math.asin(Math.max(-1, Math.min(1, x / Math.cos(lat))));
    const latD = lat / D, lonD = lon / D;
    let v = 0.78;
    for (const m of MARIA) {
      const d = ((latD - m.lat) / m.rLat) ** 2 + ((lonD - m.lon) / m.rLon) ** 2;
      // ragged edges from noise on the radius
      const edge = 1 + 0.35 * (vn(latD * 0.21 + m.lon, lonD * 0.21 - m.lat) - 0.5);
      v -= m.depth * (1 - smooth01((Math.sqrt(d) - 0.65 * edge) / (0.55 * edge)));
    }
    v = Math.max(0.28, v);
    // highlands texture and a scatter of small craters
    v *= 0.88 + 0.24 * vn(latD * 0.5, lonD * 0.5) * vn(latD * 1.7 + 3, lonD * 1.7 - 2);
    for (const c of CRATERS) {
      const dd = Math.hypot(latD - c.lat, (lonD - c.lon) * Math.cos(c.lat * D));
      v += 0.35 * Math.exp(-((dd / c.r) ** 2));
      if (c.rays) {
        const ang = Math.atan2(latD - c.lat, lonD - c.lon);
        const ray = Math.pow(Math.max(0, Math.sin(ang * 7 + c.lat) * Math.sin(ang * 11 - c.lon)), 6);
        v += 0.12 * c.rays * ray * Math.exp(-dd / 28) * (dd > c.r ? 1 : 0);
      }
    }
    a[j * n + i] = Math.min(1.15, v);
  }
  albedoCache = a;
  return a;
}
function smooth01(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
function vn(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a: number, b: number) => {
    let q = (a * 374761393 + b * 668265263) | 0;
    q = (q ^ (q >>> 13)) * 1274126177;
    return ((q ^ (q >>> 16)) >>> 0) / 4294967295;
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
}

/**
 * The moon's face for a phase angle (0 = full, π = new) with the lit limb toward texture +x
 * and celestial north at angle `psi` in the texture frame. Lommel–Seeliger lighting (the
 * flat-looking full moon), a soft terminator, earthshine on the dark side of a crescent.
 */
function drawMoon(out: Uint8Array, phaseAngle: number, psi: number) {
  const alb = moonAlbedo();
  const n = MOON_TEX, d = MOON_DISC, off = (n - d) / 2;
  const sx = Math.sin(phaseAngle), sz = Math.cos(phaseAngle);
  const nx = Math.cos(psi), ny = Math.sin(psi); // north in the texture frame
  const ex = ny, ey = -nx; // "right" in the north-up frame
  const earthshine = 0.035 * ((1 + Math.cos(phaseAngle)) / 2 < 0.5 ? (1 - (1 + Math.cos(phaseAngle)) / 2) ** 2 : 0.25);
  const enc = (v: number) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 4;
    const x = ((i + 0.5 - off) / d) * 2 - 1, y = ((j + 0.5 - off) / d) * 2 - 1; // texture row 0 = bottom (uv y=0)
    const rr = x * x + y * y;
    const r = Math.sqrt(rr);
    const edge = Math.min(1, Math.max(0, (1 - r) * d * 0.5 + 0.5));
    if (edge <= 0) { out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0; continue; }
    const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, rr)));
    // albedo lookup in the north-up frame
    const ax = x * ex + y * ey, ay = x * nx + y * ny;
    const ai = Math.min(d - 1, Math.max(0, Math.floor((ax + 1) / 2 * d))), aj = Math.min(d - 1, Math.max(0, Math.floor((1 - (ay + 1) / 2) * d)));
    const A = alb[aj * d + ai] || 0.7;
    const mu0 = x * sx + nz * sz;
    const ls = mu0 > 0 ? (2 * mu0) / (mu0 + nz + 1e-4) : 0;
    const term = smooth01((mu0 + 0.015) / 0.07);
    const lit = A * Math.min(1.4, ls) * term * 0.85;
    const v = lit + A * earthshine * (1 - term);
    out[k] = enc(v); out[k + 1] = enc(v); out[k + 2] = enc(v * 0.97);
    out[k + 3] = Math.round(edge * 255);
  }
}

function sunTexture(): THREE.DataTexture {
  const n = 64, data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
    const r = Math.hypot(x, y) * 1.25; // disc radius 0.8 of the quad
    const k = (j * n + i) * 4;
    // limb darkening (u = 0.6) and a soft edge
    const mu = Math.sqrt(Math.max(0, 1 - Math.min(1, r * r)));
    const L = r < 1 ? 1 - 0.6 * (1 - mu) : 0;
    const a = Math.min(1, Math.max(0, (1 - r) * 20));
    data[k] = data[k + 1] = data[k + 2] = Math.round(255 * L);
    data[k + 3] = Math.round(255 * a);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export { MOON_TEX };
