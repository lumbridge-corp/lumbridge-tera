// sky.mode "real": the sky at a real time and place (CONTRACT.md section 1, docs/sky.md).
//
// Owns everything time-dependent about a real sky: the sun and moon (astro.ts), the sky image
// used as background + image-based light (skyModel.ts RealSkyModel), the key light (the sun by
// day, the moon by night, through the SkyRig's one shadow-casting directional light), the night
// objects (nightSky.ts), satellites (satellites.ts), fog tinting and the night state the rest
// of the engine reads (night lights, the bridge, the `tera:sky` event, auto exposure).
//
// Render mode: update(t) is a pure function of the sky time and the camera — the sky image is
// rebuilt synchronously when the sun or moon has moved, satellites are propagated exactly.
// Live mode: the sky image is rebuilt in row slices across frames (a few ms each) and
// swapped when done, satellites are interpolated between keyframes, bright stars twinkle.
import * as THREE from "three";
import type { RealSky as RealSkyDef } from "../schema/index.ts";
import { altAz, dirFromAltAz, limitingMagnitude, moonPosition, nightness, NIGHT_RAMP, skyDarkness, smoothstep, solarPosition, type V3 } from "./astro.ts";
import { RealSkyModel, realSkyRows, skyState, sunLight, DEFAULT_SKY, hexToLinear } from "./skyModel.ts";
import { NightSky, type NightState } from "./nightSky.ts";
import { LiveSatellites, fixesAt, makeObserver, parseSatellites, type Observer, type SatFrame, type SatRecord } from "./satellites.ts";
import { loadStars } from "./stars.ts";

/** Sun light at noon (matches mode "sun"). */
const SUN_NOON = 4.5;
/** Full moon high in the sky: a soft cool key, enough to model the town in blue. */
const MOON_FULL = 0.34;
/** Seconds of motion a satellite trail shows. */
const TRAIL_S = 1.5;
const MOON_COLOR: V3 = [0.56, 0.68, 1.0];
/** IBL strength by day (as mode "sun") and at night (the night sky image is very dark; lift it so shadows read blue, not black). */
const IBL_DAY = 0.55, IBL_NIGHT = 6;

export interface SkyInfo {
  mode: "real" | "sun" | "color" | "hdri";
  /** 0 day … 1 night (environment.nightLights.ramp on the sun's elevation). */
  nightness: number;
  isNight: boolean;
  sunElevation: number | null;
  sunAzimuth: number | null;
  moonElevation?: number;
  moonAzimuth?: number;
  /** Fraction of the moon lit, 0..1. */
  moonIllumination?: number;
  /** Sky time, ISO (real/sun skies). */
  time?: string;
  /** Satellites drawn this frame. */
  satellites?: number;
  phase?: string;
}

export interface RealOptions {
  live: boolean;
}

interface ImageJob {
  w: number;
  h: number;
  row: number;
  data: Float32Array;
  half: Uint16Array;
  model: RealSkyModel;
  fog?: V3;
  key: SkyKey;
}
interface SkyKey { sun: V3; moon: V3; moonLight: number }

const angleBetween = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

/** Resolved settings of a real sky (defaults applied). */
export function resolveReal(s: RealSkyDef) {
  const stars = s.stars === false ? null : { magnitudeLimit: (typeof s.stars === "object" ? s.stars.magnitudeLimit : undefined) ?? 6.5, milkyWay: (typeof s.stars === "object" ? s.stars.milkyWay : undefined) ?? true };
  return {
    lat: s.lat,
    lon: s.lon,
    moon: s.moon !== false,
    moonScale: (typeof s.moon === "object" ? s.moon.scale : undefined) ?? 1,
    stars,
    planets: s.planets !== false,
    sats: s.satellites ? { src: s.satellites.src, groups: s.satellites.groups, max: s.satellites.max ?? 12000, minElevation: s.satellites.minElevation ?? 0, visibleOnly: s.satellites.visibleOnly ?? true } : null,
    cityGlow: s.cityGlow ?? 0.15,
    exposureAuto: s.exposureAuto ?? true,
  };
}

export class RealSkyRig {
  readonly night = new NightSky();
  private cfg: ReturnType<typeof resolveReal> | null = null;
  private obs: Observer | null = null;
  private sats: SatRecord[] | null = null;
  private live: LiveSatellites | null = null;
  private satKey = "";
  private job: ImageJob | null = null;
  private shownKey: SkyKey | null = null;
  private lastImageMs = -Infinity;
  private nowMs = 0;
  private fogHex: string | undefined;
  private ramp: [number, number] = NIGHT_RAMP;
  /** Latest computed state. */
  info: SkyInfo = { mode: "real", nightness: 0, isNight: false, sunElevation: null, sunAzimuth: null };
  /** Exposure multiplier for auto exposure (1 by day). */
  exposureMul = 1;
  warnings: string[] = [];

  constructor(
    private host: {
      scene: THREE.Scene;
      sun: THREE.DirectionalLight;
      setTexture(tex: THREE.Texture): void;
      setSunDir(d: V3): void;
      resolve(src: string): string;
      track<T>(p: Promise<T>): Promise<T>;
    },
    private opts: RealOptions,
  ) {
    this.night.twinkle = opts.live;
  }

  /** New (structural) settings. Time is not part of this: it comes with every update. */
  async configure(sky: RealSkyDef, fog: string | undefined, ramp: [number, number] | undefined) {
    const cfg = resolveReal(sky);
    this.cfg = cfg;
    this.fogHex = fog;
    this.ramp = ramp ?? NIGHT_RAMP;
    this.obs = makeObserver(cfg.lat, cfg.lon);
    this.shownKey = null; // fog or place may have changed: rebuild the image
    this.job = null;
    const n = this.night;
    n.opts = {
      ...n.opts,
      stars: !!cfg.stars,
      magnitudeLimit: cfg.stars?.magnitudeLimit ?? 6.5,
      milkyWay: cfg.stars?.milkyWay ?? false,
      moon: cfg.moon,
      moonScale: cfg.moonScale,
      planets: cfg.planets,
      satellites: !!cfg.sats,
      visibleOnly: cfg.sats?.visibleOnly ?? true,
    };
    if (!n.root.parent) this.host.scene.add(n.root);
    const jobs: Promise<unknown>[] = [];
    if (cfg.stars) jobs.push(this.host.track(loadStars().then((t) => n.setStars(t))));
    const satKey = JSON.stringify(cfg.sats ?? null) + `|${cfg.lat},${cfg.lon}`;
    if (satKey !== this.satKey) {
      this.satKey = satKey;
      this.sats = null;
      this.live = null;
      n.setSatellites(null);
      if (cfg.sats?.src) {
        const url = this.host.resolve(cfg.sats.src);
        const groups = cfg.sats.groups, max = cfg.sats.max;
        jobs.push(this.host.track(
          fetch(url)
            .then((r) => {
              if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
              return r.text();
            })
            .then((text) => {
              if (this.satKey !== satKey) return;
              const res = parseSatellites(text, groups, max);
              if (res.skipped) this.warnings.push(`sky satellites: ${res.skipped} element sets skipped (unreadable or rejected by SGP4)`);
              if (!res.sats.length) this.warnings.push(`sky satellites: no element sets in ${cfg.sats!.src}${groups ? ` for groups ${groups.join(", ")}` : ""}`);
              this.sats = res.sats;
              n.setSatellites(res.sats);
            })
            .catch((err) => this.warnings.push(`sky satellites ${cfg.sats!.src}: ${(err as Error).message}`)),
        ));
      } else if (cfg.sats) this.warnings.push('sky satellites: no "src" given (the engine never fetches element sets on its own)');
    } else if (this.sats) n.setSatellites(this.sats);
    await Promise.all(jobs);
  }

  detach() {
    this.night.root.removeFromParent();
    this.job = null;
    this.shownKey = null;
  }

  /**
   * Bring the sky to time `ms`. `camera` and `viewportH` size the star dots; `wall` (seconds of
   * page time) drives twinkling; `fast` = live time running fast or being scrubbed (cheaper sky
   * image, satellites hidden). `sync` = render mode (everything finished before returning).
   */
  update(ms: number, camera: THREE.PerspectiveCamera, viewportH: number, wall: number, sync: boolean, fast = false) {
    const cfg = this.cfg;
    if (!cfg || !this.obs) return;
    this.nowMs = ms;
    const sun = solarPosition(ms, cfg.lat, cfg.lon);
    const sunDir = dirFromAltAz(sun.azimuth, sun.elevation);
    const moon = moonPosition(ms, cfg.lat, cfg.lon);
    const moonDir = dirFromAltAz(moon.azimuth, moon.elevation);
    const moonUp = smoothstep(-1, 8, moon.elevation);
    const moonLight = cfg.moon ? moon.illuminated ** 1.4 * moonUp : 0;
    const nightK = nightness(sun.elevation, this.ramp);
    const dark = skyDarkness(sun.geometric);

    // ---- sky image (background + IBL)
    const key: SkyKey = { sun: sunDir, moon: moonDir, moonLight };
    const fogLin = this.fogHex ? this.fogNow(hexToLinear(this.fogHex), sunDir, nightK) : undefined;
    if (fogLin) {
      if (this.host.scene.fog instanceof THREE.Fog) this.host.scene.fog.color.setRGB(fogLin[0], fogLin[1], fogLin[2], THREE.LinearSRGBColorSpace);
    }
    const moved = (k: SkyKey | null, tolSun: number, tolMoon: number) =>
      !k || angleBetween(k.sun, key.sun) > tolSun || angleBetween(k.moon, key.moon) > tolMoon || Math.abs(k.moonLight - key.moonLight) > 0.02;
    if (sync) {
      // render mode: exact whenever anything visible moved (a video at real speed rebuilds
      // almost never: the sun moves 0.004° a second)
      if (moved(this.shownKey, 0.0005, 0.002)) this.buildNow(key, fogLin, 1024, 512, sunDir, moonDir, moonLight);
    } else {
      const far = moved(this.shownKey, 0.06, 0.12);
      if (far) {
        const huge = moved(this.shownKey, 0.25, 1);
        if (huge || fast) {
          // big jump (load, scrub): a quick small image now, the full one in slices after
          this.buildNow(key, fogLin, 256, 128, sunDir, moonDir, moonLight);
          this.job = null;
        }
        if (!this.job || moved(this.job.key, 0.02, 0.05)) this.startJob(key, fogLin, fast ? 512 : 1024, fast ? 256 : 512, sunDir, moonDir, moonLight);
      } else if (!this.job && moved(this.shownKey, 0.0015, 0.004) && ms - this.lastImageMs > 30_000) {
        this.startJob(key, fogLin, 1024, 512, sunDir, moonDir, moonLight);
      }
      if (this.job) this.stepJob(3);
    }

    // ---- key light: the sun by day, the moon by night (one shadow map)
    const sl = sunLight(skyState(sunDir, DEFAULT_SKY));
    const sunI = SUN_NOON * sl.strength;
    const moonI = cfg.moon ? MOON_FULL * moon.illuminated ** 1.5 * moonUp : 0;
    const L = this.host.sun;
    if (sunI >= moonI) {
      L.color.setRGB(sl.color[0], sl.color[1], sl.color[2], THREE.LinearSRGBColorSpace);
      L.intensity = sunI;
      this.host.setSunDir(sunDir);
    } else {
      L.color.setRGB(MOON_COLOR[0], MOON_COLOR[1], MOON_COLOR[2], THREE.LinearSRGBColorSpace);
      L.intensity = moonI;
      this.host.setSunDir(moonDir);
    }
    // the night lift follows how dark the sky really is (not the night-lights ramp), so twilight stays luminous, not grey
    this.host.scene.environmentIntensity = IBL_DAY + (IBL_NIGHT - IBL_DAY) * dark ** 1.3;
    this.exposureMul = cfg.exposureAuto ? 1 + 0.25 * nightK : 1;

    // ---- night objects
    const s: NightState = {
      ms,
      lat: cfg.lat,
      lon: cfg.lon,
      sunDir,
      sunElevation: sun.elevation,
      darkness: dark,
      limit: limitingMagnitude(sun.geometric, moonLight, cfg.cityGlow),
      moonDir,
      moonElevation: moon.elevation,
      moonIlluminated: moon.illuminated,
      moonDiameter: moon.diameter,
      moonWash: moonLight,
      cityGlow: cfg.cityGlow,
      sunColor: sl.color,
      sunStrength: sl.strength,
    };
    let frame: SatFrame | null = null;
    if (this.sats && this.sats.length && cfg.sats) {
      if (sync) frame = fixesAt(this.sats, this.obs, ms, cfg.sats.minElevation, TRAIL_S);
      else if (!fast) {
        this.live ??= new LiveSatellites(this.sats, this.obs, cfg.sats.minElevation, TRAIL_S);
        frame = this.live.frame(ms);
      }
    }
    this.night.update(camera, viewportH, s, frame, wall, sync ? Infinity : 4);

    const az = altAz(sunDir).azimuth;
    this.info = {
      mode: "real",
      nightness: nightK,
      isNight: nightK >= 0.5,
      sunElevation: sun.elevation,
      sunAzimuth: az,
      moonElevation: moon.elevation,
      moonAzimuth: moon.azimuth,
      moonIllumination: moon.illuminated,
      time: new Date(ms).toISOString(),
      satellites: this.night.satVisible,
      phase: sun.geometric >= 6 ? "day" : sun.geometric >= -0.833 ? "golden" : sun.geometric >= -6 ? "civil" : sun.geometric >= -12 ? "nautical" : sun.geometric >= -18 ? "astronomical" : "night",
    };
  }

  /**
   * The fog colour now: the authored colour by day (dimmed with the light), sinking at night into
   * the colour of the low sky all around (sampled 6–14° up, so a sunset's glow or a city's
   * orange does not turn the whole distance brown).
   */
  private fogNow(fog: V3, sunDir: V3, nightK: number): V3 {
    const model = new RealSkyModel({ sun: sunDir, moon: [0, -1, 0], moonLight: 0, cityGlow: 0 });
    const h: V3 = [0, 0, 0], acc: V3 = [0, 0, 0], low: V3 = [0, 0, 0];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      model.radiance([Math.cos(a), 0.03, Math.sin(a)], h);
      low[0] += h[0] / 12; low[1] += h[1] / 12; low[2] += h[2] / 12;
      for (const y of [0.1, 0.24]) {
        const c = Math.sqrt(1 - y * y);
        model.radiance([Math.cos(a) * c, y, Math.sin(a) * c], h);
        acc[0] += h[0] / 24; acc[1] += h[1] / 24; acc[2] += h[2] / 24;
      }
    }
    // daylight reference: the horizon of a high sun is ~0.35 in luminance
    const lum = 0.2126 * low[0] + 0.7152 * low[1] + 0.0722 * low[2];
    const k = Math.min(1, lum / 0.35);
    const d = smoothstep(0, 1, nightK);
    return [fog[0] * k * (1 - d) + acc[0] * d, fog[1] * k * (1 - d) + acc[1] * d, fog[2] * k * (1 - d) + acc[2] * d];
  }

  private buildNow(key: SkyKey, fog: V3 | undefined, w: number, h: number, sun: V3, moon: V3, moonLight: number) {
    const job = this.makeJob(key, fog, w, h, sun, moon, moonLight);
    this.job = job;
    this.stepJob(Infinity);
  }

  private startJob(key: SkyKey, fog: V3 | undefined, w: number, h: number, sun: V3, moon: V3, moonLight: number) {
    this.job = this.makeJob(key, fog, w, h, sun, moon, moonLight);
  }

  private makeJob(key: SkyKey, fog: V3 | undefined, w: number, h: number, sun: V3, moon: V3, moonLight: number): ImageJob {
    const model = new RealSkyModel({ sun, moon, moonLight, cityGlow: this.cfg?.cityGlow ?? 0 });
    return { w, h, row: 0, data: new Float32Array(w * 4), half: new Uint16Array(w * h * 4), model, fog, key };
  }

  /** Build rows for up to `budgetMs`; swap the texture in when the image is complete. */
  private stepJob(budgetMs: number) {
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    const toHalf = THREE.DataUtils.toHalfFloat;
    while (job.row < job.h) {
      realSkyRows(job.model, job.w, job.h, job.data, job.row, job.row + 1, job.fog);
      const o = job.row * job.w * 4;
      for (let i = 0; i < job.w * 4; i++) job.half[o + i] = toHalf(job.data[i]!);
      job.row++;
      if (performance.now() - t0 > budgetMs) break;
    }
    if (job.row < job.h) return;
    this.finishJob(job);
  }

  private finishJob(job: ImageJob) {
    const tex = new THREE.DataTexture(job.half, job.w, job.h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.host.setTexture(tex);
    this.shownKey = job.key;
    this.lastImageMs = this.nowMs;
    this.job = null;
  }
}
