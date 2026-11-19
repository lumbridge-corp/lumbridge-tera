// Sky + environment: background, image-based light, the sun (light + disc), exposure
// and fog. Everything is plain textures and basic materials, so it renders the same on
// WebGPU and WebGL.
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { WorldPack } from "../schema/index.ts";
import { parseSkyTime, sunDirection, sunPosition } from "./solar.ts";
import { Backdrop, exactColor } from "./backdrop.ts";
import { DEFAULT_SKY, gradientImage, hexToLinear, skyState, sunLight, sunSkyImage, type SkyParams } from "./skyModel.ts";
import type { RealSkyRig, SkyInfo } from "./realSky.ts";
import { nightness, NIGHT_RAMP, parseRealTime } from "./astro.ts";

/** What the engine passes the sky each frame (real skies only use it). */
export interface SkyFrame {
  /** Sky time in ms (UTC), already including script time / the live clock. */
  ms: number;
  viewportH: number;
  /** Seconds of page time (twinkle). */
  wall: number;
  /** Render mode: finish everything this frame. */
  sync: boolean;
  /** Live: time running fast or being scrubbed. */
  fast: boolean;
}

const SKY_W = 1024, SKY_H = 512;
/** Sun intensity at noon (three physical units, lux-ish). */
const SUN_NOON = 4.5;
/** IBL strength under a sun sky: the sky image is the fill, the sun light is the key. */
const SUN_SKY_IBL = 0.55;
const SUN_DISTANCE = 4000;

function floatToHalfTexture(data: Float32Array, w: number, h: number): THREE.DataTexture {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]!);
  const tex = new THREE.DataTexture(half, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.08, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.3, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SkyRig {
  readonly sun = new THREE.DirectionalLight("#ffffff", 0);
  private readonly sunTarget = new THREE.Object3D();
  private readonly disc: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private sunOn = false;
  private skyKey = "";
  private texture: THREE.Texture | null = null;
  private hdrCache = new Map<string, Promise<THREE.DataTexture>>();
  /** Colour-mode background (exact colour on both backends, fogged at the horizon). */
  readonly backdrop = new Backdrop();
  warnings: string[] = [];
  /** Atmosphere parameters for the sun sky. */
  params: SkyParams = { ...DEFAULT_SKY };
  /** The real sky (mode "real"), created on first use. */
  real: RealSkyRig | null = null;
  private realOn = false;
  /** Day/night state of a sun sky (mode "sun"): its nightness, for night lights. */
  private sunInfo: SkyInfo = { mode: "color", nightness: 0, isNight: false, sunElevation: null, sunAzimuth: null };
  /** Hooks into the engine (asset tracking for the real sky's async loads). */
  track: <T>(p: Promise<T>) => Promise<T> = (p) => p;
  live = false;

  constructor(private scene: THREE.Scene) {
    this.sun.name = "__sun";
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.target = this.sunTarget;
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ color: "#ffffff", fog: false, depthWrite: false }),
    );
    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: "#ffffff", fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }),
    );
    for (const o of [this.disc, this.glow]) {
      o.renderOrder = -1;
      o.frustumCulled = false;
      o.userData.tera = "sky";
    }
    this.sun.userData.tera = "sky";
  }

  /** True while the sun light is active (sun sky, sun above the horizon). */
  get sunActive() { return this.sunOn; }

  /** Apply sky + environment. Returns a promise for async parts (HDRI loads). */
  async apply(world: WorldPack, resolve: (src: string) => string, renderer: { toneMappingExposure: number }, toneMapsAll = false) {
    const env = world.environment ?? {};
    renderer.toneMappingExposure = env.exposure ?? 1;
    const fog = env.fog;
    const sky = world.sky ?? { mode: "color" as const, color: "#20242c" };
    // WebGPU tone-maps the fog colour (WebGL2 does not). Under a colour sky, pre-invert fog and
    // backdrop so both land on the exact hex on both backends. (Sun/HDRI skies are tone-mapped
    // images on both backends, so their fog stays as is to match their horizon.)
    const exact = toneMapsAll && sky.mode === "color" ? renderer.toneMappingExposure : undefined;
    if (fog) {
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(exactColor(fog.color, exact));
        this.scene.fog.near = fog.near;
        this.scene.fog.far = fog.far;
      } else this.scene.fog = new THREE.Fog(exactColor(fog.color, exact), fog.near, fog.far);
    } else this.scene.fog = null;

    // Sun and colour skies blend into the fog at the horizon, so they depend on the fog colour too.
    const ramp = env.nightLights?.ramp ?? NIGHT_RAMP;
    if (sky.mode === "real") {
      // time is not structural: it arrives every frame (SkyFrame.ms)
      const { time: _t, timeScale: _s, timezone: _z, ...rest } = sky;
      const key = JSON.stringify({ real: rest, fog: fog?.color, ramp });
      if (key === this.skyKey) return;
      this.skyKey = key;
      this.setSunEnabled(false);
      this.setBackdrop(null, undefined, undefined);
      this.realOn = true;
      // loaded on demand: worlds without a real sky never download the catalogue code or SGP4
      if (!this.real) {
        const { RealSkyRig } = await this.track(import("./realSky.ts"));
        if (this.skyKey !== key) return;
        this.real ??= new RealSkyRig({
        scene: this.scene,
        sun: this.sun,
        setTexture: (t) => this.setTexture(t, true),
        setSunDir: (d) => this.sunDir.set(d[0], d[1], d[2]),
        resolve,
        track: (p) => this.track(p),
      }, { live: this.live });
      }
      // the key light stays in the scene day and night (no shader recompiles at sunset)
      for (const o of [this.sun, this.sunTarget]) if (!o.parent) this.scene.add(o);
      this.real.warnings = [];
      await this.real.configure(sky, fog?.color, ramp);
      this.warnings.push(...this.real.warnings);
      return;
    }
    if (this.realOn) {
      this.realOn = false;
      this.real?.detach();
      for (const o of [this.sun, this.sunTarget]) o.removeFromParent();
      this.sun.intensity = 0;
    }
    const key = JSON.stringify(sky.mode === "sun" ? { sky, params: this.params, fog: fog?.color } : sky.mode === "color" ? { sky, fog: fog?.color, exact } : sky);
    if (sky.mode === "sun") {
      const el = sunPosition(parseSkyTime(sky.time, sky.lon), sky.lat, sky.lon).elevation;
      const n = nightness(el, ramp);
      this.sunInfo = { mode: "sun", nightness: n, isNight: n >= 0.5, sunElevation: el, sunAzimuth: null, time: new Date(parseRealTime(sky.time, sky.lon, 0)).toISOString() };
    } else this.sunInfo = { mode: sky.mode, nightness: 0, isNight: false, sunElevation: null, sunAzimuth: null };
    if (key === this.skyKey) return;
    this.skyKey = key;
    this.setSunEnabled(false);
    this.setBackdrop(sky.mode === "color" ? sky.color : null, fog?.color, exact);
    this.scene.environmentIntensity = sky.mode === "sun" ? SUN_SKY_IBL : 1;

    if (sky.mode === "color") {
      const c = hexToLinear(sky.color);
      const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      // Studio IBL keyed to the backdrop, never so dark that PBR materials turn to tar.
      const k = Math.max(1, 0.06 / Math.max(lum, 1e-4));
      const top: [number, number, number] = [c[0] * k * 1.6 + 0.02, c[1] * k * 1.6 + 0.02, c[2] * k * 1.6 + 0.025];
      const mid: [number, number, number] = [c[0] * k, c[1] * k, c[2] * k];
      const bot: [number, number, number] = [c[0] * k * 0.35, c[1] * k * 0.35, c[2] * k * 0.35];
      this.setTexture(floatToHalfTexture(gradientImage(top, mid, bot, 128, 64), 128, 64), false);
      this.scene.background = null; // the backdrop dome draws the background
      return;
    }
    if (sky.mode === "hdri") {
      const url = resolve(sky.src);
      let p = this.hdrCache.get(url);
      if (!p) {
        p = new HDRLoader().loadAsync(url).then((t) => {
          t.mapping = THREE.EquirectangularReflectionMapping;
          t.userData.cached = true;
          return t;
        });
        this.hdrCache.set(url, p);
      }
      try {
        const tex = await p;
        if (this.skyKey !== key) return;
        this.setTexture(tex, true);
      } catch (err) {
        this.hdrCache.delete(url);
        this.warnings.push(`sky hdri ${sky.src}: ${(err as Error).message}`);
        this.scene.background = new THREE.Color("#20242c");
      }
      return;
    }
    // sun
    const pos = sunPosition(parseSkyTime(sky.time, sky.lon), sky.lat, sky.lon);
    const dir = sunDirection(pos);
    this.sunDir.set(dir[0], dir[1], dir[2]);
    this.setTexture(floatToHalfTexture(sunSkyImage(dir, SKY_W, SKY_H, this.params, fog ? hexToLinear(fog.color) : undefined), SKY_W, SKY_H), true);
    const s = skyState(dir, this.params);
    const { color, strength } = sunLight(s);
    if (strength > 0.001) {
      this.sun.color.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
      this.sun.intensity = SUN_NOON * strength;
      const discRGB = new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace).multiplyScalar(40 * strength + 2);
      (this.disc.material as THREE.MeshBasicMaterial).color.copy(discRGB);
      (this.glow.material as THREE.SpriteMaterial).color.setRGB(color[0] * 0.9, color[1] * 0.75, color[2] * 0.6, THREE.LinearSRGBColorSpace);
      this.setSunEnabled(true);
    }
  }

  private setTexture(tex: THREE.Texture, background: boolean) {
    if (this.texture && this.texture !== tex && this.texture.userData.cached !== true) this.texture.dispose();
    this.texture = tex;
    this.scene.environment = tex;
    if (background) this.scene.background = tex;
  }

  private setBackdrop(color: string | null, fog: string | undefined, exact: number | undefined) {
    const m = this.backdrop.mesh;
    if (color === null) {
      m.removeFromParent();
      return;
    }
    this.backdrop.set(color, fog, exact);
    if (!m.parent) this.scene.add(m);
  }

  private setSunEnabled(on: boolean) {
    this.sunOn = on;
    for (const o of [this.sun, this.sunTarget, this.disc, this.glow]) {
      if (on && !o.parent) this.scene.add(o);
      if (!on && o.parent) o.removeFromParent();
    }
  }

  /** True while a real sky is active. */
  get isReal() { return this.realOn; }

  /** Day/night state for night lights, the bridge and the tera:sky event. */
  get info(): SkyInfo {
    return this.realOn && this.real ? this.real.info : this.sunInfo;
  }

  /** Per frame: keep the disc on the sky dome around the camera; a real sky follows `frame.ms`. */
  update(camera: THREE.PerspectiveCamera, frame?: SkyFrame) {
    if (this.backdrop.mesh.parent) this.backdrop.follow(camera);
    if (this.realOn && this.real && frame) {
      this.real.update(frame.ms, camera, frame.viewportH, frame.wall, frame.sync, frame.fast);
      return;
    }
    if (!this.sunOn) return;
    const p = camera.position.clone().addScaledVector(this.sunDir, SUN_DISTANCE);
    this.disc.position.copy(p);
    this.disc.lookAt(camera.position);
    const r = SUN_DISTANCE * Math.tan(THREE.MathUtils.degToRad(0.4));
    this.disc.scale.setScalar(r);
    this.glow.position.copy(p);
    this.glow.scale.setScalar(r * 22);
  }

  /** Point the sun light along the sun direction, centred on `center`. */
  placeSun(center: THREE.Vector3, radius: number) {
    this.sunTarget.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDir, radius * 2 + 10);
  }
}
