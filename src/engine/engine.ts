// The engine: a scene graph kept in step with a world document.
//
// The world is JSON (WorldPack). `sync(world)` reconciles the scene to it: entities
// whose JSON is unchanged keep their objects (only transform / visibility are
// re-applied), changed ones are rebuilt, missing ones removed. Assets come from a
// cache, so rebuilding is cheap. seek(t) = sync(worldAt(base, events, t)) + camera +
// one final frame.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { CameraScript as CameraScriptSchema, WorldPack as WorldPackSchema } from "../schema/index.ts";
import type { CameraPose, CameraScript, Ease, Entity, Op, Transform, WorldPack } from "../schema/index.ts";
import { evaluateCamera } from "../camera/evaluate.ts";
import { applyOp, countEntities, findEntity, hasSplats, worldAt } from "./timeline.ts";
import { lerpTransform, progress, type AnimTo } from "./ease.ts";
import { createRenderer, webgpuAvailable, type Backend, type RendererHandle } from "./renderer.ts";
import { SkyRig, type SkyFrame } from "./sky.ts";
import { parseRealTime } from "./astro.ts";
import { EASES } from "./ease.ts";
import type { SkyInfo } from "./realSky.ts";
import { buildText } from "./text.ts";
import { primitiveDoubleSided, primitiveGeometry, type PrimitiveEntity } from "./primitives.ts";
import { makeExact, setExactExposure } from "./exact.ts";
import { repeatCellsOf, type Cell } from "./repeat-math.ts";
import { createPost, wantsPost, type PostPipeline } from "./post.ts";
import { XrController, dispatchSelect, type XrHost, type XrMode, type XrOptions } from "./xr.ts";
import type { Box } from "../bridge/types.ts";
import { instantiate, loadGLTF, loadSplats, spark } from "./assets.ts";
import { Living, isLiving } from "./living.ts";
import { LIVE_LABELS } from "./label-fit.ts";

export type RendererPref = "auto" | "webgpu" | "webgl2";

export interface EngineOptions {
  /** Live-mode WebXR (forces the WebGL2 renderer). */
  xr?: XrOptions;
  /**
   * Fit actor name tags to the screen (label-fit.ts: max on-screen size, fade when tiny or
   * right at the camera). Default: on in live mode, off in render mode (rendered video keeps its
   * pixels; `?labels=fit` turns it on there, still deterministic).
   */
  labelFit?: boolean;
  /** Live mode: sky time override for a real sky (`?time=` ISO or "now"). */
  skyTime?: string;
  /** Live mode: sky time scale override (`?timeScale=`). */
  skyTimeScale?: number;
}

/** Live-mode clock of a real sky: anchored sky time + rate, with an optional eased jump. */
interface SkyClock {
  /** sky.time string it was anchored for ("" before the first world). */
  key: string;
  anchorSky: number;
  anchorWall: number;
  rate: number;
  tween: { from: number; to: number; t0: number; duration: number; ease: Ease } | null;
  /** Wall time (ms) of the last scrub, for the "fast" flag. */
  scrubbedAt: number;
}

/** A night-lit material: emissive at day and at night (linear rgb × intensity). */
interface NightMat { mat: THREE.MeshStandardMaterial; day: THREE.Color; night: THREE.Color }
interface NightLight { light: THREE.Light; base: number; night: boolean }

/** Live viewer quality knobs (viewer/quality.ts); never used in render mode. */
export interface LiveQuality {
  pixelRatio: number;
  post: boolean;
  /** Shadow map size cap in texels, 0 = as authored. */
  shadowCap: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

interface Node {
  entity: Entity;
  sig: string;
  obj: THREE.Object3D;
  /** Objects parented to the scene root on this node's behalf (light targets). */
  extra: THREE.Object3D[];
  mixer?: THREE.AnimationMixer;
  splat?: SplatMesh;
  disposed: boolean;
}

interface Tween {
  from: Transform | undefined;
  to: AnimTo;
  t0: number;
  duration: number;
  ease: Ease | undefined;
}

const deg = THREE.MathUtils.degToRad;
const SPLAT_EXT = /\.(spz|ply|splat|ksplat)(\?|#|$)/i;

function signature(e: Entity): string {
  return JSON.stringify({ ...e, transform: undefined, visible: undefined, tags: undefined, children: undefined });
}

function applyTransform(o: THREE.Object3D, t: Transform | undefined, visible: boolean | undefined) {
  const tr = t ?? {};
  if (tr.position) o.position.fromArray(tr.position);
  // Hemisphere and directional lights take their direction from position: never zero
  // (a zero direction is NaN on the WebGPU path and turns every lit pixel black).
  else if ((o as THREE.HemisphereLight).isHemisphereLight || (o as THREE.DirectionalLight).isDirectionalLight) o.position.set(0, 1, 0);
  else o.position.set(0, 0, 0);
  if (tr.rotation) o.rotation.set(deg(tr.rotation[0]), deg(tr.rotation[1]), deg(tr.rotation[2]));
  else o.rotation.set(0, 0, 0);
  if (tr.scale === undefined) o.scale.set(1, 1, 1);
  else if (typeof tr.scale === "number") o.scale.setScalar(tr.scale);
  else o.scale.fromArray(tr.scale);
  o.visible = visible ?? true;
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    // Model copies inside a repeat share their geometry with the asset cache.
    for (let x: THREE.Object3D | null = c; x && x !== o.parent; x = x.parent) if (x.userData.teraShared) return;
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture && v.userData.shared !== true) v.dispose();
      mat.dispose();
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The material of a primitive (glass, exact glow or standard PBR). */
export function primitiveMaterial(e: Pick<PrimitiveEntity, "material">): THREE.Material {
  const m = e.material ?? {};
  const opacity = m.opacity ?? 1;
  if (m.glass) {
    // Transmission glass: the room behind it stays contrasty (no milky veil), the tint comes
    // from color, and the physical fresnel reflects the sky environment at grazing angles,
    // so edges and frames read. Drawn in three's transmissive pass (after opaque, before
    // transparent), so sorting is right on both backends.
    const mat = new THREE.MeshPhysicalMaterial({
      color: m.color ?? GLASS_TINT, roughness: m.roughness ?? 0, metalness: 0, transmission: 1, thickness: 0, ior: 1.5,
      specularIntensity: 1, envMapIntensity: 1.6, wireframe: m.wireframe ?? false,
      // No depth: transparent things behind the pane (flows, veils, labels) are not in the
      // transmission image, so they must still draw over it rather than vanish.
      depthWrite: false,
    });
    mat.userData.teraGlass = true;
    return mat;
  }
  if (m.glowExact) {
    const hex = m.emissive ?? m.color ?? "#cccccc";
    const mat = makeExact(new THREE.MeshBasicMaterial({ transparent: opacity < 1, opacity, depthWrite: opacity >= 1, wireframe: m.wireframe ?? false }), hex);
    // What bloom sees: the compensated (still saturated) colour scaled by glow, so the halo
    // keeps the hue instead of adding white-hot light on top of the strip.
    mat.userData.glowColor = mat.color.clone().multiplyScalar((m.glow ?? 1.5) / 3);
    return mat;
  }
  const std = new THREE.MeshStandardMaterial({
    color: m.color ?? "#cccccc",
    roughness: m.roughness ?? 0.6,
    metalness: m.metalness ?? 0,
    emissive: m.emissive ?? (m.glow ? m.color ?? "#cccccc" : "#000000"),
    emissiveIntensity: m.glow ?? (m.emissive ? 1.5 : 1),
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    wireframe: m.wireframe ?? false,
  });
  if (m.night) {
    // night look (CONTRACT.md: material.night): the engine fades emissive between these
    const day = std.emissive.clone().multiplyScalar(std.emissiveIntensity);
    const night = new THREE.Color(m.night.emissive ?? m.emissive ?? m.color ?? "#ffd9a0").multiplyScalar(m.night.intensity ?? 1.5);
    std.userData.teraNight = { day, night };
  }
  return std;
}

const GLASS_TINT = "#dfecea";

/**
 * Glass edges: a faint light outline along the sharp edges (box panes, cut arcs), so a pane
 * reads as a pane from any angle instead of vanishing. Not pickable.
 */
function glassEdges(geo: THREE.BufferGeometry, tint: string | undefined): THREE.LineSegments {
  const color = new THREE.Color(tint ?? GLASS_TINT).lerp(new THREE.Color("#ffffff"), 0.4);
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
  lines.raycast = () => {};
  lines.renderOrder = 1;
  return lines;
}

/** A primitive's mesh flags (shadows) from its JSON. */
function primitiveFlags(mesh: THREE.Mesh, e: PrimitiveEntity) {
  const m = e.material ?? {};
  const solid = !m.glass && !m.glowExact;
  mesh.castShadow = e.shape !== "plane" && (m.opacity ?? 1) > 0.3 && solid;
  mesh.receiveShadow = solid;
}

function matrixOf(t: Transform | undefined, out = new THREE.Matrix4()): THREE.Matrix4 {
  const p = t?.position ?? [0, 0, 0], r = t?.rotation ?? [0, 0, 0];
  const s = t?.scale === undefined ? [1, 1, 1] : typeof t.scale === "number" ? [t.scale, t.scale, t.scale] : t.scale;
  return out.compose(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(r[0]), deg(r[1]), deg(r[2]))), new THREE.Vector3(s[0], s[1], s[2]));
}

const cellMove = (c: Cell) => {
  const [x, y, z] = c.position, b = c.basis;
  return b ? new THREE.Matrix4().set(b[0]!, b[1]!, b[2]!, x, b[3]!, b[4]!, b[5]!, y, b[6]!, b[7]!, b[8]!, z, 0, 0, 0, 1) : new THREE.Matrix4().makeTranslation(x, y, z);
};
const cellJitter = (c: Cell) =>
  new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(c.rotation[0]), deg(c.rotation[1]), deg(c.rotation[2]))), new THREE.Vector3(c.scale, c.scale, c.scale));
const addTint = (a: Cell["tint"], b: Cell["tint"]): Cell["tint"] => (!a ? b : !b ? a : [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 3000);
  handle: RendererHandle | null = null;
  controls: OrbitControls | null = null;
  readonly sky: SkyRig;

  private nodes = new Map<string, Node>();
  private pending = new Set<Promise<unknown>>();
  private warnings: string[] = [];
  private base: WorldPack | null = null;
  private current: WorldPack | null = null;
  private baseUrl = location.href;
  private script: CameraScript | null = null;
  private scriptT: number | null = null;
  private time = 0;
  private size = { w: 1280, h: 720 };
  private sparkRenderer: SparkRenderer | null = null;
  private tweens = new Map<string, Tween>();
  private lastTick = 0;
  private pendingSkyTween: { duration: number; ease: Ease } | null = null;
  private post: PostPipeline | null = null;
  private postKey = "";
  readonly xr: XrController | null = null;
  private xrPresenting: XrMode | null = null;
  /** Actors, flows and meters (living.ts). */
  readonly living: Living;
  /** Asset loads started / finished since the page opened (the live loading bar). */
  readonly loadStats = { started: 0, done: 0 };
  private frameHooks = new Set<(dt: number) => void>();
  private paused = false;
  private quality: LiveQuality = { pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2), post: true, shadowCap: 0 };
  /** Live clock of a real sky (render mode derives sky time from the world + script time). */
  private skyClock: SkyClock = { key: "", anchorSky: 0, anchorWall: 0, rate: 1, tween: null, scrubbedAt: -Infinity };
  /** Wall clock at load: "now" in render mode (fixed for the whole render, so frames agree). */
  private loadNow = Date.now();
  private nightMats = new Set<NightMat>();
  private nightLights = new Set<NightLight>();
  private nightApplied = -1;
  private lastSkyEvent: { n: number; night: boolean; at: number } | null = null;
  private skyOpts: { time?: string; timeScale?: number };

  constructor(
    private host: HTMLElement,
    readonly renderMode: boolean,
    readonly pref: RendererPref,
    opts: EngineOptions = {},
  ) {
    this.sky = new SkyRig(this.scene);
    this.sky.live = !renderMode;
    this.sky.track = (p) => this.track(p);
    this.skyOpts = { time: opts.skyTime, timeScale: opts.skyTimeScale };
    if (opts.xr && !renderMode) {
      this.xr = new XrController(this.xrHost(), opts.xr);
      this.pref = "webgl2"; // the safe XR path (Spark splats are WebGL2 too)
      this.sky.sun.shadow.mapSize.set(2048, 2048);
    }
    this.living = new Living(this.scene, renderMode, {
      resolve: (src) => this.resolve(src),
      track: (p) => this.track(p),
      warn: (m) => this.warn(m),
      loadModel: (url) => loadGLTF(url).then((g) => instantiate(g)),
    });
    if (opts.labelFit ?? !renderMode) this.living.actors.labelFit = LIVE_LABELS;
  }

  // ---------------------------------------------------------------- renderer

  get backend(): Backend {
    return this.handle?.backend ?? "webgl2";
  }

  private async chooseBackend(world: WorldPack | null): Promise<Backend> {
    if (this.pref === "webgl2") return "webgl2";
    if (this.pref === "webgpu") {
      if (!(await webgpuAvailable())) throw new Error("renderer=webgpu requested but WebGPU is not available");
      return "webgpu";
    }
    if (world && hasSplats(world.entities)) return "webgl2";
    return (await webgpuAvailable()) ? "webgpu" : "webgl2";
  }

  async ensureBackend(b: Backend) {
    if (this.handle?.backend === b) return;
    this.post?.dispose();
    this.post = null;
    this.postKey = "";
    let next: RendererHandle;
    try {
      next = await createRenderer(b, this.renderMode ? 1 : this.quality.pixelRatio);
    } catch (err) {
      if (b === "webgpu" && this.pref === "auto") next = await createRenderer("webgl2", this.renderMode ? 1 : this.quality.pixelRatio);
      else throw err;
    }
    const old = this.handle;
    if (this.sparkRenderer) {
      this.sparkRenderer.removeFromParent();
      this.sparkRenderer.dispose();
      this.sparkRenderer = null;
    }
    if (old) {
      old.renderer.setAnimationLoop(null);
      old.canvas.remove();
      old.dispose();
    }
    this.handle = next;
    next.renderer.toneMappingExposure = this.current?.environment?.exposure ?? 1;
    this.host.appendChild(next.canvas);
    next.renderer.setSize(this.size.w, this.size.h, true);
    if (!this.renderMode) {
      const target = this.controls?.target.clone();
      this.controls?.dispose();
      this.controls = new OrbitControls(this.camera, next.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      if (target) this.controls.target.copy(target);
      this.startLoop();
      this.listenForClicks(next.canvas);
    }
    if (this.xr && next.webgl) {
      const button = await this.xr.attach(next.webgl);
      if (!button.isConnected) document.body.appendChild(button);
    }
    // Splats need Spark's renderer, which is tied to the WebGL renderer.
    if (this.current && hasSplats(this.current.entities)) for (const n of this.nodes.values()) if (n.entity.kind === "splat") n.sig = "";
  }

  private async ensureSpark(): Promise<SparkRenderer | null> {
    const gl = this.handle?.webgl;
    if (!gl) return null;
    if (!this.sparkRenderer) {
      const S = await spark();
      if (this.sparkRenderer) return this.sparkRenderer;
      this.sparkRenderer = new S.SparkRenderer({ renderer: gl, autoUpdate: !this.renderMode, minSortIntervalMs: 0 });
      this.sparkRenderer.userData.tera = "sky";
      this.scene.add(this.sparkRenderer);
    }
    return this.sparkRenderer;
  }

  setSize(w: number, h: number) {
    this.size = { w, h };
    this.handle?.renderer.setSize(w, h, true);
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.living.actors.viewportH = h;
  }

  setPose(p: CameraPose) {
    this.camera.position.fromArray(p.position);
    this.camera.fov = p.fov ?? 45;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(new THREE.Vector3().fromArray(p.target));
    this.camera.updateMatrixWorld();
    this.controls?.target.fromArray(p.target);
  }

  // ---------------------------------------------------------------- world

  private resolve = (src: string) => new URL(src, this.baseUrl).href;

  private warn(msg: string) {
    this.warnings.push(msg);
    console.warn(`[tera] ${msg}`);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    this.loadStats.started++;
    const done = () => {
      this.loadStats.done++;
      this.pending.delete(p);
    };
    p.then(done, done);
    return p;
  }

  async load(w: WorldPack, baseUrl?: string): Promise<{ ok: true; warnings: string[] }> {
    const res = WorldPackSchema.safeParse(w);
    if (!res.success) throw new Error("invalid world: " + res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    this.warnings = [];
    this.sky.warnings = [];
    if (baseUrl) this.baseUrl = new URL(baseUrl, location.href).href;
    this.base = structuredClone(res.data);
    this.script = null;
    this.scriptT = null;
    this.time = 0;
    this.tweens.clear();
    this.loadNow = Date.now();
    this.skyClock.key = "";
    for (const n of this.nodes.values()) this.disposeNode(n);
    this.nodes.clear();
    await this.ensureBackend(await this.chooseBackend(this.base));
    await this.sync(structuredClone(this.base));
    const cam = this.base.cameras?.default;
    if (cam) this.setPose(cam);
    await this.settle();
    return { ok: true, warnings: [...this.warnings, ...this.sky.warnings] };
  }

  get(): WorldPack {
    if (!this.base) throw new Error("no world loaded");
    return structuredClone(this.base);
  }

  /** Apply ops to the world (the base the script replays from). */
  async apply(ops: Op[]): Promise<{ ok: boolean; applied: number; error?: string }> {
    if (!this.base) return { ok: false, applied: 0, error: "no world loaded" };
    let applied = 0, error: string | undefined;
    const now = performance.now() / 1000;
    for (const op of ops) {
      const before = op.op === "animate" ? structuredClone(findEntity(this.base.entities, op.id)?.entity.transform) : undefined;
      try {
        applyOp(this.base, op);
      } catch (err) {
        error = `op ${applied} (${(op as { op?: string }).op ?? "?"}): ${(err as Error).message}`;
        break;
      }
      if (op.op === "animate" && !this.renderMode) this.tweens.set(op.id, { from: before, to: op.to, t0: now, duration: op.duration, ease: op.ease });
      if (op.op === "sky" && op.duration && !this.renderMode && "time" in op.set) this.pendingSkyTween = { duration: op.duration, ease: op.ease ?? "inOutCubic" };
      applied++;
    }
    const world = this.script && this.scriptT !== null ? worldAt(this.base, this.script.events, this.scriptT).world : structuredClone(this.base);
    await this.sync(world);
    return error ? { ok: false, applied, error } : { ok: true, applied };
  }

  loadScript(s: CameraScript): { ok: true; warnings: string[] } {
    const res = CameraScriptSchema.safeParse(s);
    if (!res.success) throw new Error("invalid camera script: " + res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const warnings: string[] = [];
    if (this.base && res.data.world && res.data.world !== this.base.id) warnings.push(`script was written for world "${res.data.world}", loaded world is "${this.base.id}"`);
    if (this.base) {
      // Dry-run the whole timeline so broken events surface now, not mid-render.
      const end = worldAt(this.base, res.data.events, Number.POSITIVE_INFINITY);
      warnings.push(...end.errors);
    }
    this.script = res.data;
    this.scriptT = null;
    this.setSize(res.data.width, res.data.height);
    return { ok: true, warnings };
  }

  async seek(t: number) {
    if (!this.base) throw new Error("no world loaded");
    if (!this.script) throw new Error("no script loaded");
    const { world, errors } = worldAt(this.base, this.script.events, t);
    for (const e of errors) this.warn(e);
    await this.sync(world);
    this.scriptT = t;
    this.time = t;
    for (const n of this.nodes.values()) n.mixer?.setTime(t);
    this.setPose(evaluateCamera(this.script, t));
    await this.settle();
    await this.finalFrame();
  }

  async capture(): Promise<string> {
    if (!this.handle) throw new Error("no renderer");
    await this.settle();
    await this.finalFrame();
    return this.handle.renderPNG(() => this.draw());
  }

  /**
   * Draw the current world (base + applied ops, no script events) now, optionally from
   * `pose` at width x height, and resolve when the pixels are final. capture() then
   * returns them.
   */
  async render(pose?: CameraPose, width?: number, height?: number) {
    if (!this.base) throw new Error("no world loaded");
    if ((width === undefined) !== (height === undefined)) throw new Error("render: give both width and height, or neither");
    if (width !== undefined && height !== undefined) {
      if (!(width >= 1 && height >= 1 && width <= 8192 && height <= 8192)) throw new Error(`render: bad size ${width}x${height}`);
      this.setSize(Math.round(width), Math.round(height));
    }
    if (pose) this.setPose(pose);
    if (this.scriptT !== null) {
      // Leave script time: show the world as edited, not as the script left it.
      this.scriptT = null;
      await this.sync(structuredClone(this.base));
    }
    await this.settle();
    await this.finalFrame();
  }

  /** World-space axis-aligned boxes of entities (all when `ids` is omitted); null = no extent (lights, empty groups, unloaded assets). */
  async bounds(ids?: string[]): Promise<Record<string, Box | null>> {
    if (!this.base) throw new Error("no world loaded");
    await this.settle();
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const out: Record<string, Box | null> = {};
    for (const id of ids ?? [...this.nodes.keys()]) {
      const n = this.nodes.get(id);
      if (!n) throw new Error(`bounds: no entity "${id}"`);
      const b = this.boxOf(n.obj);
      out[id] = b.isEmpty() ? null : { min: [r4(b.min.x), r4(b.min.y), r4(b.min.z)], max: [r4(b.max.x), r4(b.max.y), r4(b.max.z)] };
    }
    return out;
  }

  private boxOf(root: THREE.Object3D, box = new THREE.Box3()): THREE.Box3 {
    const tmp = new THREE.Box3();
    const visit = (o: THREE.Object3D) => {
      if ((o as THREE.Light).isLight || o.userData.tera === "sky") return;
      const splat = o as unknown as { packedSplats?: unknown; getBoundingBox?: (centersOnly?: boolean) => THREE.Box3 };
      if (splat.packedSplats && splat.getBoundingBox) {
        box.union(tmp.copy(splat.getBoundingBox(false)).applyMatrix4(o.matrixWorld));
        return; // a SplatMesh's children are internal
      }
      const sprite = o as THREE.Sprite;
      if (sprite.isSprite) {
        // Faces the camera: the quad's corners as seen from the current camera.
        const c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        const s = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        for (const x of [-sprite.center.x, 1 - sprite.center.x]) for (const y of [-sprite.center.y, 1 - sprite.center.y])
          box.expandByPoint(c.clone().addScaledVector(right, x * s.x).addScaledVector(up, y * s.y));
      } else if ((o as THREE.InstancedMesh).isInstancedMesh) {
        const m = o as THREE.InstancedMesh;
        if (!m.boundingBox) m.computeBoundingBox();
        box.union(tmp.copy(m.boundingBox!).applyMatrix4(o.matrixWorld));
      } else if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh;
        m.computeBoundingBox();
        box.union(tmp.copy(m.boundingBox!).applyMatrix4(o.matrixWorld));
      } else if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) {
        const g = (o as THREE.Mesh).geometry;
        if (g) {
          if (!g.boundingBox) g.computeBoundingBox();
          box.union(tmp.copy(g.boundingBox!).applyMatrix4(o.matrixWorld));
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(root);
    return box;
  }

  info() {
    const w = this.current ?? this.base;
    return { renderer: this.backend, entities: w ? countEntities(w.entities) : 0, ready: this.base !== null && this.pending.size === 0, sky: this.skyInfo() };
  }

  /** Day/night state: nightness 0..1 (environment.nightLights.ramp on the sun's elevation), sun/moon, sky time. */
  skyInfo(): SkyInfo {
    return { ...this.sky.info };
  }

  // ---------------------------------------------------------------- sky time

  /** Sky time (ms, UTC) of a real sky right now: world time + script time (render) or the live clock. */
  skyTimeMs(): number | null {
    const sky = this.current?.sky;
    if (!sky || sky.mode !== "real") return null;
    if (this.renderMode || this.scriptT !== null) {
      const base = parseRealTime(sky.time, sky.lon, this.loadNow);
      return base + (this.scriptT ?? 0) * 1000 * (sky.timeScale ?? 1);
    }
    const c = this.skyClock;
    const key = `${sky.time ?? "now"}|${sky.lon}`;
    const wall = performance.now();
    if (c.key !== key) {
      const from = c.key ? this.liveSkyMs(wall) : null;
      const firstLoad = !c.key;
      c.key = key;
      const t = firstLoad && this.skyOpts.time ? this.skyOpts.time : sky.time;
      let to: number;
      try {
        to = parseRealTime(t, sky.lon, Date.now());
      } catch {
        to = parseRealTime(sky.time, sky.lon, Date.now());
      }
      c.rate = this.skyOpts.timeScale ?? sky.timeScale ?? 1;
      const tw = this.pendingSkyTween;
      this.pendingSkyTween = null;
      if (tw && from !== null) {
        c.tween = { from, to, t0: wall, duration: tw.duration * 1000, ease: tw.ease };
        c.anchorSky = to;
        c.anchorWall = wall + tw.duration * 1000;
      } else {
        c.tween = null;
        c.anchorSky = to;
        c.anchorWall = wall;
      }
    }
    return this.liveSkyMs(wall);
  }

  private liveSkyMs(wall: number): number {
    const c = this.skyClock;
    if (c.tween) {
      const u = (wall - c.tween.t0) / c.tween.duration;
      if (u < 1) return c.tween.from + (c.tween.to - c.tween.from) * EASES[c.tween.ease](Math.max(0, u));
      c.tween = null;
    }
    return c.anchorSky + (wall - c.anchorWall) * c.rate;
  }

  /** Live mode: the sky clock (for the viewer's time control). null without a real sky. */
  skyClockState(): { ms: number; rate: number; following: boolean; lat: number; lon: number; timezone?: string } | null {
    const sky = this.current?.sky;
    const ms = this.skyTimeMs();
    if (!sky || sky.mode !== "real" || ms === null) return null;
    return { ms, rate: this.skyClock.rate, following: this.skyClock.rate === 1 && Math.abs(ms - Date.now()) < 90_000, lat: sky.lat, lon: sky.lon, timezone: sky.timezone };
  }

  /** Live mode: put the sky at `ms` (keeps running at the current rate). `scrub` marks a drag in progress. */
  setSkyTime(ms: number, scrub = false) {
    if (this.renderMode) return;
    this.skyTimeMs(); // anchor first
    const c = this.skyClock;
    c.tween = null;
    c.anchorSky = ms;
    c.anchorWall = performance.now();
    if (scrub) c.scrubbedAt = performance.now();
  }

  /** Live mode: sky seconds per page second. */
  setSkyRate(rate: number) {
    if (this.renderMode) return;
    const ms = this.skyTimeMs();
    if (ms === null) return;
    const c = this.skyClock;
    c.anchorSky = ms;
    c.anchorWall = performance.now();
    c.rate = rate;
  }

  /** Live mode: follow the wall clock again. */
  skyNow() {
    this.setSkyTime(Date.now());
    this.setSkyRate(1);
  }

  // ---------------------------------------------------------------- reconcile

  private async sync(world: WorldPack) {
    if (this.pref === "auto" && this.backend === "webgpu" && hasSplats(world.entities)) await this.ensureBackend("webgl2");
    setExactExposure(world.environment?.exposure ?? 1);
    this.living.setWorld(world);
    const seen = new Set<string>();
    const walk = (list: Entity[], parent: THREE.Object3D) => {
      for (const e of list) {
        seen.add(e.id);
        const sig = signature(e);
        let n = this.nodes.get(e.id);
        if (!n || n.sig !== sig) {
          if (n) this.disposeNode(n);
          n = this.build(e, sig);
          this.nodes.set(e.id, n);
        }
        n.entity = e;
        if (isLiving(e)) this.living.upsert(e);
        if (n.obj.parent !== parent) parent.add(n.obj);
        applyTransform(n.obj, e.transform, e.visible);
        if (e.kind === "group") walk(e.children, n.obj);
      }
    };
    walk(world.entities, this.scene);
    if (this.xrPresenting === "ar") for (const n of this.nodes.values()) if (n.obj.userData.ground) n.obj.visible = false;
    for (const [id, n] of this.nodes) if (!seen.has(id)) {
      this.disposeNode(n);
      this.nodes.delete(id);
    }
    this.current = world;
    if (this.handle) {
      await this.track(this.sky.apply(world, this.resolve, this.handle.renderer, this.handle.backend === "webgpu"));
      await this.updatePost(world);
    }
    if (this.quality.shadowCap) this.applyShadowCaps(); // lights built by this sync
  }

  /** (Re)build the post pipeline when environment.post or the renderer changed. */
  private async updatePost(world: WorldPack) {
    const h = this.handle;
    if (!h) return;
    const want = world.environment?.post;
    const key = wantsPost(want) ? JSON.stringify(want) : "";
    if (key === this.postKey) return;
    this.postKey = key;
    this.post?.dispose();
    this.post = null;
    if (!key || !want) return;
    this.post = await createPost(h, this.scene, this.camera, want, this.size, (m) => this.warn(m));
    if (this.post) {
      const skipped = (["ao", "bloom", "dof"] as const).filter((k) => (k === "ao" ? want.ao : want[k]) && !this.post!.active.includes(k));
      if (skipped.length) this.warn(`post: ${skipped.join(", ")} not available on ${h.backend}, skipped`);
    }
  }

  /** One frame through the post pipeline (or straight to the canvas). XR always draws directly. */
  private draw() {
    const h = this.handle!;
    if (this.post && this.quality.post && !this.xrPresenting) this.post.render();
    else h.renderer.render(this.scene, this.camera);
  }

  private disposeNode(n: Node) {
    n.disposed = true;
    if (this.nightMats.size || this.nightLights.size) {
      const objs = new Set<THREE.Object3D>();
      n.obj.traverse((o) => objs.add(o));
      for (const x of this.nightMats) if ([...objs].some((o) => (o as THREE.Mesh).material === x.mat)) this.nightMats.delete(x);
      for (const l of this.nightLights) if (objs.has(l.light)) this.nightLights.delete(l);
    }
    n.obj.removeFromParent();
    for (const x of n.extra) x.removeFromParent();
    n.mixer?.stopAllAction();
    if (isLiving(n.entity)) this.living.remove(n.entity);
    // Only this node's own resources: children belong to their own nodes, and model /
    // splat data is shared through the asset cache.
    if (n.entity.kind === "primitive" || n.entity.kind === "text" || n.entity.kind === "repeat") disposeObject(n.obj);
    if (n.entity.kind === "light") (n.obj as THREE.Light).dispose();
  }

  private build(e: Entity, sig: string): Node {
    const node: Node = { entity: e, sig, obj: new THREE.Group(), extra: [], disposed: false };
    switch (e.kind) {
      case "primitive": {
        const mat = primitiveMaterial(e);
        if (primitiveDoubleSided(e)) mat.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(primitiveGeometry(e), mat);
        primitiveFlags(mesh, e);
        if (e.material?.glass) mesh.add(glassEdges(mesh.geometry, e.material.color));
        // Ground: hidden in AR passthrough, a teleport floor (not a selection) in VR.
        if (e.tags?.includes("ground") || (e.shape === "plane" && Math.max(e.size?.[0] ?? 10, e.size?.[1] ?? e.size?.[0] ?? 10) > 8)) mesh.userData.ground = true;
        node.obj = mesh;
        break;
      }
      case "model": {
        const g = node.obj;
        const url = this.resolve(e.src);
        this.track(
          loadGLTF(url).then(
            (gltf) => {
              if (node.disposed) return;
              const inst = instantiate(gltf);
              inst.traverse((o) => {
                if ((o as THREE.Mesh).isMesh) {
                  o.castShadow = true;
                  o.receiveShadow = true;
                }
              });
              g.add(inst);
              if (e.animation) {
                const clip = THREE.AnimationClip.findByName(gltf.animations, e.animation);
                if (!clip) this.warn(`model "${e.id}": no animation "${e.animation}" (has: ${gltf.animations.map((a) => a.name).join(", ") || "none"})`);
                else {
                  node.mixer = new THREE.AnimationMixer(inst);
                  node.mixer.clipAction(clip).play();
                  node.mixer.setTime(this.time);
                }
              }
            },
            (err) => this.warn(`model "${e.id}" (${e.src}): ${(err as Error).message ?? err}`),
          ),
        );
        break;
      }
      case "splat": {
        const g = node.obj;
        if (!SPLAT_EXT.test(e.src)) this.warn(`splat "${e.id}": ${e.src} is not .spz/.ply/.splat/.ksplat`);
        const url = this.resolve(e.src);
        this.track(
          (async () => {
            const sr = await this.ensureSpark();
            if (!sr) {
              this.warn(`splat "${e.id}" not drawn: splats need the WebGL2 renderer (Spark.js), current is ${this.backend}`);
              return;
            }
            const S = await spark();
            const packed = await loadSplats(url);
            if (node.disposed) return;
            const mesh = new S.SplatMesh({ packedSplats: packed });
            await mesh.initialized;
            if (node.disposed) return;
            g.add(mesh);
            node.splat = mesh;
          })().catch((err) => this.warn(`splat "${e.id}" (${e.src}): ${(err as Error).message ?? err}`)),
        );
        break;
      }
      case "text":
        node.obj = buildText(e);
        break;
      case "light": {
        const c = e.color ?? "#ffffff", i = e.intensity ?? 1;
        let light: THREE.Light;
        if (e.light === "directional" || e.light === "spot") {
          const l = e.light === "directional" ? new THREE.DirectionalLight(c, i) : new THREE.SpotLight(c, i, e.distance ?? 0, Math.PI / 6, 0.45, e.decay ?? 2);
          l.target.position.fromArray(e.target ?? [0, 0, 0]);
          this.scene.add(l.target);
          node.extra.push(l.target);
          if (e.castShadow) {
            l.castShadow = true;
            l.shadow.mapSize.set(2048, 2048);
            l.shadow.bias = -0.0002;
            if (l instanceof THREE.SpotLight) l.shadow.normalBias = 0.02;
          }
          light = l;
        } else if (e.light === "point") {
          const l = new THREE.PointLight(c, i, e.distance ?? 0, e.decay ?? 2);
          if (e.castShadow) {
            l.castShadow = true;
            l.shadow.mapSize.set(1024, 1024);
            l.shadow.bias = -0.0005;
            l.shadow.normalBias = 0.02;
          }
          light = l;
        } else if (e.light === "hemisphere") {
          const sky = new THREE.Color(c);
          light = new THREE.HemisphereLight(sky, sky.clone().multiplyScalar(0.25).lerp(new THREE.Color("#3b3328"), 0.5), i);
        } else light = new THREE.AmbientLight(c, i);
        node.obj = light;
        break;
      }
      case "group":
        break;
      case "repeat":
        node.obj = this.buildRepeat(e, node);
        break;
      case "actor":
      case "flow":
      case "meter":
        node.obj = this.living.build(e);
        break;
    }
    node.obj.name = e.id;
    node.obj.userData.teraId = e.id;
    if (e.kind === "light" && (e.night || e.day)) this.nightLights.add({ light: node.obj as THREE.Light, base: (node.obj as THREE.Light).intensity, night: !!e.night });
    if (e.kind === "primitive" || e.kind === "repeat") this.registerNightMats(node.obj);
    this.nightApplied = -1;
    return node;
  }

  private registerNightMats(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      const info = m && !Array.isArray(m) ? (m.userData.teraNight as { day: THREE.Color; night: THREE.Color } | undefined) : undefined;
      if (info) this.nightMats.add({ mat: m as THREE.MeshStandardMaterial, day: info.day, night: info.night });
    });
  }

  /** Fade night-lit materials and night/day lights to `n` (0 day … 1 night). */
  private applyNight(n: number) {
    if (Math.abs(n - this.nightApplied) < 5e-4) return;
    this.nightApplied = n;
    for (const x of this.nightMats) {
      x.mat.emissive.copy(x.day).lerp(x.night, n);
      x.mat.emissiveIntensity = 1;
    }
    for (const l of this.nightLights) l.light.intensity = l.base * (l.night ? n : 1 - n);
  }

  /** `tera:sky` on window (+ CSS variable --tera-nightness and data-tera-night on <html>) when day/night changes. */
  private emitSky(info: SkyInfo) {
    const last = this.lastSkyEvent;
    const now = performance.now();
    if (last && last.night === info.isNight && Math.abs(last.n - info.nightness) < 0.005) return;
    if (last && !this.renderMode && last.night === info.isNight && now - last.at < 200) return;
    this.lastSkyEvent = { n: info.nightness, night: info.isNight, at: now };
    const root = document.documentElement;
    root.style.setProperty("--tera-nightness", info.nightness.toFixed(3));
    root.dataset.teraNight = info.isNight ? "1" : "0";
    window.dispatchEvent(new CustomEvent("tera:sky", { detail: { nightness: info.nightness, sunElevation: info.sunElevation, isNight: info.isNight, moonIllumination: info.moonIllumination, time: info.time } }));
  }

  /**
   * A repeat: every primitive in the copied entity becomes ONE InstancedMesh with a matrix
   * (and colour, when jittered) per copy, so a 400-book shelf is a handful of draw calls.
   * Models and text are cloned per copy (they share geometry and materials).
   */
  private buildRepeat(e: Extract<Entity, { kind: "repeat" }>, node: Node): THREE.Object3D {
    const root = new THREE.Group();
    interface Leaf { e: Entity; mats: THREE.Matrix4[]; tints: Cell["tint"][] }
    const leaves = new Map<Entity, Leaf>();
    // copy = parent · cell offset · the template's own transform · jitter (rotation/scale about the copy's origin)
    const visit = (x: Entity, parent: THREE.Matrix4, jitter: THREE.Matrix4 | null, tint: Cell["tint"]) => {
      if (x.visible === false) return;
      const M = parent.clone().multiply(matrixOf(x.transform));
      if (jitter) M.multiply(jitter);
      if (x.kind === "group") for (const c of x.children) visit(c, M, null, tint);
      else if (x.kind === "repeat") for (const c of repeatCellsOf(x)) visit(x.of, M.clone().multiply(cellMove(c)), cellJitter(c), addTint(tint, c.tint));
      else {
        let l = leaves.get(x);
        if (!l) leaves.set(x, (l = { e: x, mats: [], tints: [] }));
        l.mats.push(M);
        l.tints.push(tint);
      }
    };
    for (const c of repeatCellsOf(e)) visit(e.of, cellMove(c), cellJitter(c), c.tint);
    const base = new THREE.Color(), col = new THREE.Color();
    for (const l of leaves.values()) {
      const x = l.e;
      if (x.kind === "primitive") {
        const mat = primitiveMaterial(x);
        if (primitiveDoubleSided(x)) mat.side = THREE.DoubleSide;
        const mesh = new THREE.InstancedMesh(primitiveGeometry(x), mat, l.mats.length);
        primitiveFlags(mesh, x);
        base.copy((mat as THREE.MeshStandardMaterial).color ?? col.setRGB(1, 1, 1));
        const tinted = l.tints.some((t) => t);
        l.mats.forEach((m, i) => {
          mesh.setMatrixAt(i, m);
          if (!tinted) return;
          const t = l.tints[i];
          // Instance colour multiplies the material colour: ratio of jittered to base.
          col.copy(base);
          if (t) col.offsetHSL(t[0], t[1], t[2]);
          const ratio = (a: number, b: number) => (b < 1e-4 ? 1 : Math.min(4, Math.max(0, a / b)));
          mesh.setColorAt(i, col.setRGB(ratio(col.r, base.r), ratio(col.g, base.g), ratio(col.b, base.b)));
        });
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        root.add(mesh);
      } else if (x.kind === "text") {
        const proto = buildText(x);
        for (const m of l.mats) {
          const o = proto.clone();
          o.matrixAutoUpdate = true;
          m.decompose(o.position, o.quaternion, o.scale);
          root.add(o);
        }
      } else if (x.kind === "model") {
        const url = this.resolve(x.src);
        this.track(
          loadGLTF(url).then(
            (gltf) => {
              if (node.disposed) return;
              for (const m of l.mats) {
                const inst = instantiate(gltf);
                inst.userData.teraShared = true;
                inst.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
                const holder = new THREE.Group();
                m.decompose(holder.position, holder.quaternion, holder.scale);
                holder.add(inst);
                root.add(holder);
              }
            },
            (err) => this.warn(`repeat "${e.id}" model (${x.src}): ${(err as Error).message ?? err}`),
          ),
        );
      }
    }
    return root;
  }

  /** Wait until every asset load started so far (and any it started) has finished. */
  async settle() {
    for (let i = 0; i < 100 && this.pending.size; i++) await Promise.allSettled([...this.pending]);
    await document.fonts?.ready;
  }

  // ---------------------------------------------------------------- frames

  private casterBox = new THREE.Box3();
  private tmpBox = new THREE.Box3();

  /** Per-frame upkeep before drawing: matrices, sun disc, shadow frusta fitted to the casters. */
  private prepareFrame() {
    this.camera.updateMatrixWorld();
    this.living.update(this.camera, this.renderMode || this.scriptT !== null ? this.time : undefined);
    this.scene.updateMatrixWorld();
    const skyMs = this.sky.isReal ? this.skyTimeMs() : null;
    if (skyMs !== null) {
      const c = this.skyClock;
      const live = !this.renderMode && this.scriptT === null;
      const frame: SkyFrame = {
        ms: skyMs,
        viewportH: this.size.h,
        wall: performance.now() / 1000,
        sync: !live,
        fast: live && (Math.abs(c.rate) > 40 || c.tween !== null || performance.now() - c.scrubbedAt < 300),
      };
      this.sky.update(this.camera, frame);
      // auto exposure (a gentle lift at night), kept in step with exact glow colours
      const h = this.handle;
      const mul = this.sky.real?.exposureMul ?? 1;
      if (h) {
        const eff = Math.round((this.current?.environment?.exposure ?? 1) * mul * 100) / 100;
        if (h.renderer.toneMappingExposure !== eff) {
          h.renderer.toneMappingExposure = eff;
          setExactExposure(eff);
        }
      }
    } else this.sky.update(this.camera);
    const info = this.sky.info;
    this.applyNight(info.nightness);
    if (info.mode === "real" || info.mode === "sun") this.emitSky(info);
    const box = this.casterBox.makeEmpty();
    const lights: THREE.DirectionalLight[] = [];
    this.scene.traverseVisible((o) => {
      if (o.userData.tera === "sky" && o !== this.sky.sun) return;
      if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.Light).castShadow) lights.push(o as THREE.DirectionalLight);
      else if ((o as THREE.Mesh).isMesh && o.castShadow) box.union(this.tmpBox.setFromObject(o));
    });
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    for (const l of lights) {
      if (l === this.sky.sun) {
        this.sky.placeSun(sphere.center, sphere.radius);
        this.sky.sun.updateMatrixWorld();
        this.sky.sun.target.updateMatrixWorld();
      }
      fitDirectionalShadow(l, box);
    }
  }

  private async finalFrame() {
    const h = this.handle;
    if (!h) throw new Error("no renderer");
    this.prepareFrame();
    await h.renderer.compileAsync(this.scene, this.camera);
    this.draw();
    const sr = this.sparkRenderer;
    if (sr && [...this.nodes.values()].some((n) => n.splat)) {
      // Spark sorts splats in a worker; wait until the order matches this camera.
      for (let i = 0; i < 200; i++) {
        await sr.update({ scene: this.scene, camera: this.camera });
        if (!sr.sorting && !sr.sortDirty) break;
        await sleep(2);
      }
      this.draw();
    }
    await h.finish();
  }

  private startLoop() {
    const h = this.handle;
    if (!h) return;
    this.lastTick = performance.now();
    h.renderer.setAnimationLoop((_time: number, frame?: XRFrame) => {
      const nowMs = performance.now();
      const dt = Math.min(0.1, (nowMs - this.lastTick) / 1000);
      this.lastTick = nowMs;
      if (this.xrPresenting) this.xr?.update(dt, frame);
      else this.controls?.update();
      const now = nowMs / 1000;
      for (const [id, tw] of this.tweens) {
        const n = this.nodes.get(id);
        if (!n) {
          this.tweens.delete(id);
          continue;
        }
        const u = progress(now, tw.t0, tw.duration, tw.ease ?? "inOutCubic");
        applyTransform(n.obj, lerpTransform(tw.from, tw.to, u), n.entity.visible);
        if (u >= 1) this.tweens.delete(id);
      }
      for (const n of this.nodes.values()) n.mixer?.update(dt);
      for (const fn of this.frameHooks) fn(dt);
      this.prepareFrame();
      this.draw();
    });
  }

  // ---------------------------------------------------------------- live viewer hooks

  /** Live mode: run `fn(dt)` every drawn frame, after orbit controls, before drawing. Returns an unsubscribe. */
  onFrame(fn: (dt: number) => void): () => void {
    this.frameHooks.add(fn);
    return () => this.frameHooks.delete(fn);
  }

  /** Live mode: stop drawing (hidden tab) or start again. XR sessions are never paused. */
  setPaused(paused: boolean) {
    if (this.renderMode || paused === this.paused) return;
    this.paused = paused;
    if (paused && !this.xrPresenting) this.handle?.renderer.setAnimationLoop(null);
    else if (!paused) this.startLoop();
  }

  /** The world as currently shown (base + ops), not a copy: read only. */
  shown(): WorldPack | null {
    return this.current;
  }

  /** Live mode: canvas sharpness, post effects and shadow sizes (viewer/quality.ts). */
  async setQuality(q: LiveQuality) {
    if (this.renderMode) return;
    const prev = this.quality;
    this.quality = { ...q, pixelRatio: Math.min(2, Math.max(0.5, q.pixelRatio)) };
    const h = this.handle;
    if (h && prev.pixelRatio !== this.quality.pixelRatio) {
      h.renderer.setPixelRatio(this.quality.pixelRatio);
      h.renderer.setSize(this.size.w, this.size.h, true);
      // The WebGL post chain sizes its targets from the pixel ratio it was built with.
      if (this.post && this.current) {
        this.postKey = "";
        await this.updatePost(this.current);
      }
    }
    if (prev.shadowCap !== this.quality.shadowCap) this.applyShadowCaps();
  }

  /** Pick what is under a canvas point: the nearest entity mesh or actor. */
  pickAt(clientX: number, clientY: number): { id: string; point: THREE.Vector3 } | null {
    const canvas = this.handle?.canvas;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.roots(), true).find((x) => x.object.visible && this.entityOf(x.object));
    const actor = this.living.actors.pick(ray.ray);
    if (actor && (!hit || actor.distance < hit.distance)) return { id: actor.id, point: actor.point };
    return hit ? { id: this.entityOf(hit.object)!, point: hit.point } : null;
  }

  /** Is the straight line from a to b blocked by solid geometry? (Glass and see-through things don't count.) */
  obstructed(a: [number, number, number], b: [number, number, number]): boolean {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const len = from.distanceTo(to);
    if (len < 1e-3) return false;
    const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize(), 0.05, len);
    return ray.intersectObjects(this.roots(), true).some((x) => {
      if (!x.object.visible) return false;
      const m = (x.object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mat = Array.isArray(m) ? m[0] : m;
      return !!mat && !mat.userData.teraGlass && !(mat.transparent && mat.opacity < 0.6) && !(x.object as THREE.Line).isLine && !(x.object as THREE.Sprite).isSprite;
    });
  }

  /** World box to frame an entity (actors included, at their current pose); null = no extent. */
  focusBox(id: string): THREE.Box3 | null {
    const a = this.living.actors.box(id);
    if (a) return a;
    const n = this.nodes.get(id);
    if (!n) return null;
    this.scene.updateMatrixWorld(true);
    const b = this.boxOf(n.obj);
    return b.isEmpty() ? null : b;
  }

  /** Shadow map sizes under the XR budget and the live quality cap (the smaller wins). */
  private applyShadowCaps() {
    const caps = [this.xrPresenting ? 1024 : 0, this.renderMode ? 0 : this.quality.shadowCap].filter((c) => c > 0);
    const cap = caps.length ? Math.min(...caps) : 0;
    this.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (!l.isLight || !l.shadow) return;
      l.userData.mapSize ??= l.shadow.mapSize.x;
      const want = cap ? Math.min(cap, l.userData.mapSize) : l.userData.mapSize;
      if (l.shadow.mapSize.x === want && l.shadow.mapSize.y === want) return;
      l.shadow.mapSize.set(want, want);
      l.shadow.map?.dispose();
      l.shadow.map = null;
    });
  }

  // ---------------------------------------------------------------- picking + XR

  /** Entity id owning an object (nearest ancestor that is an entity). */
  entityOf(o: THREE.Object3D | null): string | null {
    for (let x = o; x; x = x.parent) if (typeof x.userData.teraId === "string" && this.nodes.get(x.userData.teraId)?.obj === x) return x.userData.teraId;
    return null;
  }

  /** Top-level entity objects. */
  private roots(): THREE.Object3D[] {
    return [...this.nodes.values()].filter((n) => n.obj.parent === this.scene).map((n) => n.obj);
  }

  /** Box of the content without big flat ground planes (tabletop framing). */
  contentBox(): THREE.Box3 | null {
    this.scene.updateMatrixWorld(true);
    const all = new THREE.Box3();
    for (const o of this.roots()) {
      const b = this.boxOf(o);
      if (b.isEmpty()) continue;
      const s = b.getSize(new THREE.Vector3());
      if (s.y < 0.05 && Math.max(s.x, s.z) > 8) continue;
      all.union(b);
    }
    return all.isEmpty() ? null : all;
  }

  /** Desktop live mode: a click (not a drag) on an entity fires `tera:select`. */
  private listenForClicks(canvas: HTMLCanvasElement) {
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const hit = this.pickAt(e.clientX, e.clientY);
      if (hit) dispatchSelect(hit.id, hit.point, "mouse");
      else window.dispatchEvent(new CustomEvent("tera:deselect"));
    });
  }

  private xrHost(): XrHost {
    return {
      scene: this.scene,
      camera: this.camera,
      pickables: () => this.roots(),
      contentBox: () => this.contentBox(),
      defaultPose: () => {
        const c = this.base?.cameras?.default;
        return c ? { position: new THREE.Vector3().fromArray(c.position), target: new THREE.Vector3().fromArray(c.target) } : { position: new THREE.Vector3(0, 1.6, 4), target: new THREE.Vector3(0, 1, 0) };
      },
      entityOf: (o) => this.entityOf(o),
      onPresenting: (on, mode) => this.setXrPresenting(on ? mode : null),
      hud: (msg) => {
        const el = document.getElementById("hud");
        if (el) el.textContent = msg;
      },
    };
  }

  /** XR budget path: no post, capped shadows, and in AR no sky, fog or ground. */
  private setXrPresenting(mode: XrMode | null) {
    this.xrPresenting = mode;
    if (this.sky.real) this.sky.real.night.xr = !!mode;
    this.controls && (this.controls.enabled = !mode);
    this.applyShadowCaps();
    const ar = mode === "ar";
    if (ar) {
      this.arSaved = { background: this.scene.background, fog: this.scene.fog };
      this.scene.background = null;
      this.scene.fog = null;
    } else if (this.arSaved) {
      this.scene.background = this.arSaved.background;
      this.scene.fog = this.arSaved.fog;
      this.arSaved = null;
    }
    for (const o of this.scene.children) if (o.userData.tera === "sky" && !(o as THREE.Light).isLight && o !== this.sparkRenderer) o.visible = !ar;
    for (const n of this.nodes.values()) if (n.obj.userData.ground) n.obj.visible = ar ? false : (n.entity.visible ?? true);
  }

  private arSaved: { background: THREE.Scene["background"]; fog: THREE.Scene["fog"] } | null = null;
}

const _corner = new THREE.Vector3();
const _target = new THREE.Vector3();

/** Fit an orthographic shadow frustum around `box` as seen from the light. */
function fitDirectionalShadow(l: THREE.DirectionalLight, box: THREE.Box3) {
  const cam = l.shadow.camera;
  cam.position.setFromMatrixPosition(l.matrixWorld);
  _target.setFromMatrixPosition(l.target.matrixWorld);
  cam.lookAt(_target);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    minX = Math.min(minX, _corner.x); maxX = Math.max(maxX, _corner.x);
    minY = Math.min(minY, _corner.y); maxY = Math.max(maxY, _corner.y);
    minZ = Math.min(minZ, _corner.z); maxZ = Math.max(maxZ, _corner.z);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04 + 0.1;
  cam.left = minX - pad;
  cam.right = maxX + pad;
  cam.bottom = minY - pad;
  cam.top = maxY + pad;
  cam.near = -maxZ - pad; // may be negative: fine for an orthographic frustum
  cam.far = -minZ + pad;
  cam.updateProjectionMatrix();
  const texel = (cam.right - cam.left) / l.shadow.mapSize.x;
  l.shadow.normalBias = texel * 1.2;
  l.shadow.bias = -0.0001;
  l.shadow.radius = 4;
}
