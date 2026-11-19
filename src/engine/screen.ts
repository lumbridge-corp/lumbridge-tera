// Screens (material.screen, the `screen` op; CONTRACT.md section 1 "Screens"): a box whose
// +Z face, or a plane whose +Y face, shows a picture that changes at runtime.
//
// - video: a same-origin mp4 in a muted, looping <video> → VideoTexture. Live mode plays it
//   only while the screen is on screen (and the page draws); render mode seeks it to the
//   script time (mod its duration) and waits for the frame, so renders are deterministic.
// - image: a texture, cover-fitted to the face.
// - youtube: a card drawn into a canvas: the thumbnail (cover), a soft gradient, the title,
//   the channel and a LIVE / play / pause badge. No third-party player or request: the
//   thumbnail URL is whatever the world gives (`thumb`, else the screen's `youtubeThumb`).
// - panel: a small calm dashboard drawn into a canvas (title, status pill, rows of bars and
//   values, a sparkline); every word and number comes from the world / the screen op.
// - off (or no content): dark glass.
// The face is a dark glossy standard material: the picture is its emissive map (sRGB), and the
// sky environment gives the subtle glare (`glare` scales it). Same materials on WebGPU and WebGL2.
import * as THREE from "three";
import type { PrimitiveEntity } from "./primitives.ts";
import type { ScreenContent } from "../schema/index.ts";
import { cardLayout, coverFit, coverRect, faceAspect, panelLayout, resolveScreen, youtubeThumbUrl, type ResolvedScreen } from "./screen-math.ts";

export interface ScreenHost {
  resolve(src: string): string;
  track<T>(p: Promise<T>): Promise<T>;
  warn(msg: string): void;
  renderMode: boolean;
}

const FONT_STACK = `"Inter", "Helvetica Neue", "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
const GLASS = "#060708"; // the panel itself: near-black glass
const BEZEL = "#16181b";
/** How much a screen feeds the glow-only bloom pass (a lit screen, not a lamp). */
const GLOW_SCALE = 0.12;
/** Live mode: videos further than this (m) from the camera pause. */
const PLAY_DISTANCE = 160;

interface ScreenState {
  id: string;
  mesh: THREE.Mesh;
  face: THREE.MeshStandardMaterial;
  video: HTMLVideoElement | null;
  texture: THREE.Texture | null;
  ready: Promise<void> | null;
  disposed: boolean;
}

/** The face material: dark glossy glass, the picture (if any) as its emissive map. */
function faceMaterial(s: ResolvedScreen, tex: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: GLASS,
    roughness: 0.18 - s.glare * 0.12, // glossier with more glare
    metalness: 0,
    emissive: tex ? "#ffffff" : "#000000",
    emissiveMap: tex,
    emissiveIntensity: tex ? s.brightness : 0,
    envMapIntensity: 0.25 + s.glare * 2.2,
  });
  mat.userData.teraScreen = true;
  mat.userData.glowScale = GLOW_SCALE;
  return mat;
}

function bezelMaterial(m: NonNullable<PrimitiveEntity["material"]>): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: m.color ?? BEZEL, roughness: m.roughness ?? 0.4, metalness: m.metalness ?? 0.25 });
}

function fit(tex: THREE.Texture, srcAspect: number, face: number) {
  const f = coverFit(srcAspect, face);
  tex.repeat.set(f.repeat[0], f.repeat[1]);
  tex.offset.set(f.offset[0], f.offset[1]);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
}

const once = (el: EventTarget, ok: string, fail: string | null, ms: number) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(() => { done(); rej(new Error(`timed out waiting for ${ok}`)); }, ms);
    const onOk = () => { done(); res(); };
    const onFail = () => { done(); rej(new Error(fail ?? "error")); };
    const done = () => { clearTimeout(t); el.removeEventListener(ok, onOk); if (fail) el.removeEventListener(fail, onFail); };
    el.addEventListener(ok, onOk);
    if (fail) el.addEventListener(fail, onFail);
  });

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`could not load ${url}`));
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw the youtube card (thumbnail or a calm dark backdrop, gradient, text, badge). */
export function drawCard(canvas: HTMLCanvasElement, c: Extract<ScreenContent, { kind: "youtube" }>, thumb: HTMLImageElement | null) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  if (thumb) {
    const r = coverRect(thumb.naturalWidth || thumb.width, thumb.naturalHeight || thumb.height, w, h);
    ctx.drawImage(thumb, r.x, r.y, r.w, r.h);
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#1d2126");
    g.addColorStop(1, "#0c0e10");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const font = (px: number, weight = 600) => `${weight} ${px}px ${FONT_STACK}`;
  const measure = (text: string, px: number) => { ctx.font = font(px); return ctx.measureText(text).width; };
  const L = cardLayout(w, h, c, measure);
  if (L.shadeTop < h) {
    const g = ctx.createLinearGradient(0, L.shadeTop, 0, h);
    g.addColorStop(0, "rgba(6,7,9,0)");
    g.addColorStop(0.45, "rgba(6,7,9,0.5)");
    g.addColorStop(1, "rgba(6,7,9,0.86)");
    ctx.fillStyle = g;
    ctx.fillRect(0, L.shadeTop, w, h - L.shadeTop);
  }
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = Math.round(h * 0.01);
  if (L.title) {
    ctx.fillStyle = "#f7f7f5";
    ctx.font = font(L.title.px, 650);
    L.title.lines.forEach((line, i) => ctx.fillText(line, L.title!.x, L.title!.y + i * L.title!.lineH));
  }
  if (L.channel) {
    ctx.fillStyle = "rgba(240,240,236,0.74)";
    ctx.font = font(L.channel.px, 500);
    ctx.fillText(L.channel.text, L.channel.x, L.channel.y);
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  const b = L.badge;
  if (b) {
    if (b.kind === "live") {
      ctx.font = font(b.px, 700);
      const tw = ctx.measureText("LIVE").width;
      const dot = b.h * 0.18, padX = b.h * 0.42;
      const bw = padX + dot * 2 + b.h * 0.26 + tw + padX;
      ctx.fillStyle = "#cc1f16";
      roundRect(ctx, b.x, b.y, bw, b.h, b.h * 0.22);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x + padX + dot, b.y + b.h / 2, dot, 0, Math.PI * 2);
      ctx.fill();
      ctx.textBaseline = "middle";
      ctx.fillText("LIVE", b.x + padX + dot * 2 + b.h * 0.26, b.y + b.h / 2 + b.h * 0.03);
    } else {
      const s = b.h;
      ctx.fillStyle = "rgba(10,11,13,0.55)";
      roundRect(ctx, b.x, b.y, s, s, s * 0.24);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      const cx = b.x + s / 2, cy = b.y + s / 2, k = s * 0.22;
      if (b.kind === "playing") {
        ctx.beginPath();
        ctx.moveTo(cx - k * 0.75, cy - k);
        ctx.lineTo(cx + k * 1.05, cy);
        ctx.lineTo(cx - k * 0.75, cy + k);
        ctx.closePath();
        ctx.fill();
      } else {
        const bw = k * 0.62;
        ctx.fillRect(cx - k * 0.85, cy - k, bw, k * 2);
        ctx.fillRect(cx + k * 0.85 - bw, cy - k, bw, k * 2);
      }
    }
  }
}

const PANEL_THEMES = {
  dark: { bg0: "#1b1f22", bg1: "#121517", ink: "#eef1ec", muted: "rgba(226,232,224,0.74)", track: "rgba(226,232,224,0.12)", pill: "rgba(226,232,224,0.09)", rule: "rgba(226,232,224,0.08)" },
  light: { bg0: "#f6f4ee", bg1: "#ebe8df", ink: "#2e2c27", muted: "rgba(46,44,39,0.6)", track: "rgba(46,44,39,0.1)", pill: "rgba(46,44,39,0.07)", rule: "rgba(46,44,39,0.08)" },
} as const;
const PANEL_ACCENT = "#a9d38a";

/** Draw the `panel` content: background, title, status pill, rows (label, bar, value), sparkline. */
export function drawPanel(canvas: HTMLCanvasElement, c: Extract<ScreenContent, { kind: "panel" }>) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  const t = PANEL_THEMES[c.theme ?? "dark"];
  const accent = c.accent ?? PANEL_ACCENT;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, t.bg0);
  g.addColorStop(1, t.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const font = (px: number, weight = 600) => `${weight} ${px}px ${FONT_STACK}`;
  const measure = (text: string, px: number) => { ctx.font = font(px); return ctx.measureText(text).width; };
  const L = panelLayout(w, h, c, measure);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if (L.title) {
    ctx.fillStyle = t.ink;
    ctx.font = font(L.title.px, 650);
    ctx.fillText(L.title.text, L.title.x, L.title.y);
  }
  if (L.subtitle) {
    ctx.fillStyle = t.muted;
    ctx.font = font(L.subtitle.px, 500);
    ctx.fillText(L.subtitle.text, L.subtitle.x, L.subtitle.y);
  }
  if (L.status) {
    const s = L.status;
    ctx.fillStyle = t.pill;
    roundRect(ctx, s.x, s.y, s.w, s.h, s.h / 2);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(s.x + s.px * 0.95, s.y + s.h / 2, s.px * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = t.ink;
    ctx.font = font(s.px, 600);
    ctx.textBaseline = "middle";
    ctx.fillText(s.text, s.x + s.px * 1.6, s.y + s.h / 2 + s.px * 0.04);
    ctx.textBaseline = "alphabetic";
  }
  for (const r of L.rows) {
    ctx.fillStyle = t.muted;
    ctx.font = font(r.px, 500);
    ctx.textAlign = "left";
    ctx.fillText(r.label, r.labelX, r.y);
    if (r.value !== null) {
      const b = r.bar;
      ctx.fillStyle = t.track;
      roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
      ctx.fill();
      const fw = Math.max(b.h, b.w * Math.min(1, Math.max(0, r.value)));
      ctx.fillStyle = accent;
      roundRect(ctx, b.x, b.y, fw, b.h, b.h / 2);
      ctx.fill();
    }
    if (r.text) {
      ctx.fillStyle = t.ink;
      ctx.font = font(r.px, 600);
      ctx.textAlign = "right";
      ctx.fillText(r.text, r.textX, r.y);
      ctx.textAlign = "left";
    }
  }
  const S = L.series;
  if (S && c.series && c.series.length > 1) {
    ctx.fillStyle = t.rule;
    ctx.fillRect(S.x, S.y + S.h, S.w, Math.max(1, Math.round(h * 0.003)));
    const n = c.series.length;
    const px = (i: number) => S.x + (S.w * i) / (n - 1);
    const py = (v: number) => S.y + S.h - S.h * Math.min(1, Math.max(0, v));
    ctx.beginPath();
    ctx.moveTo(px(0), S.y + S.h);
    c.series.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(px(n - 1), S.y + S.h);
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    c.series.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(2, h * 0.006);
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

/** Live and render-mode handling of every screen in the scene. */
export class Screens {
  private states = new Map<THREE.Object3D, ScreenState>();
  private hidden = false;
  private gestureArmed = false;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  constructor(private host: ScreenHost) {}

  /** Build the mesh of a screen primitive (box: bezel + face; plane: face). */
  build(e: PrimitiveEntity, geometry: THREE.BufferGeometry): THREE.Mesh {
    const m = e.material ?? {};
    const s = resolveScreen(m.screen ?? true);
    const aspect = faceAspect(e.shape, e.size);
    const st: ScreenState = { id: e.id, mesh: null as unknown as THREE.Mesh, face: null as unknown as THREE.MeshStandardMaterial, video: null, texture: null, ready: null, disposed: false };
    const tex = this.content(st, s, aspect);
    st.texture = tex;
    st.face = faceMaterial(s, tex);
    let mesh: THREE.Mesh;
    if (e.shape === "box") {
      const bezel = bezelMaterial(m);
      // BoxGeometry material groups: +X, −X, +Y, −Y, +Z, −Z
      mesh = new THREE.Mesh(geometry, [bezel, bezel, bezel, bezel, st.face, bezel]);
    } else mesh = new THREE.Mesh(geometry, st.face);
    mesh.castShadow = e.shape === "box";
    mesh.receiveShadow = false;
    mesh.userData.teraScreenState = true;
    st.mesh = mesh;
    this.states.set(mesh, st);
    return mesh;
  }

  /** The texture for the content (or null = off); video/image/thumbnail loads are tracked. */
  private content(st: ScreenState, s: ResolvedScreen, aspect: number): THREE.Texture | null {
    const c = s.content;
    const label = `screen "${st.id}"`;
    switch (c.kind) {
      case "off":
        return null;
      case "image": {
        const tex = new THREE.Texture();
        tex.colorSpace = THREE.SRGBColorSpace;
        st.ready = this.host.track(
          loadImage(this.host.resolve(c.src)).then(
            (img) => {
              if (st.disposed) return;
              tex.image = img;
              fit(tex, img.naturalWidth / img.naturalHeight, aspect);
            },
            (err) => this.host.warn(`${label}: ${(err as Error).message}`),
          ),
        );
        return tex;
      }
      case "panel": {
        const canvas = document.createElement("canvas");
        canvas.height = 720;
        canvas.width = Math.max(64, Math.min(2560, Math.round(720 * Math.max(0.25, aspect))));
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        drawPanel(canvas, c);
        return tex;
      }
      case "youtube": {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = Math.max(64, Math.min(2048, Math.round(1280 / Math.max(0.25, aspect))));
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        drawCard(canvas, c, null);
        const url = youtubeThumbUrl(c, s.youtubeThumb);
        if (url) {
          st.ready = this.host.track(
            loadImage(this.host.resolve(url)).then(
              (img) => {
                if (st.disposed) return;
                drawCard(canvas, c, img);
                tex.needsUpdate = true;
              },
              (err) => this.host.warn(`${label}: thumbnail: ${(err as Error).message}`),
            ),
          );
        }
        return tex;
      }
      case "video": {
        const v = document.createElement("video");
        v.crossOrigin = "anonymous";
        v.muted = true;
        v.defaultMuted = true;
        v.loop = true;
        v.playsInline = true;
        v.preload = "auto";
        v.setAttribute("muted", "");
        v.setAttribute("playsinline", "");
        v.src = this.host.resolve(c.src);
        st.video = v;
        const tex = new THREE.VideoTexture(v);
        tex.colorSpace = THREE.SRGBColorSpace;
        const loaded = once(v, "loadeddata", "error", 30000).then(
          () => {
            if (st.disposed) return;
            fit(tex, v.videoWidth / Math.max(1, v.videoHeight), aspect);
            if (!this.host.renderMode) this.play(st); // the frame loop pauses it again when off screen
          },
          (err) => this.host.warn(`${label}: video ${c.src}: ${(err as Error).message}`),
        );
        st.ready = this.host.track(loaded);
        v.load();
        return tex;
      }
    }
  }

  private play(st: ScreenState) {
    const v = st.video;
    if (!v || st.disposed || this.hidden || !v.paused) return;
    v.play().catch(() => this.armGesture());
  }

  /** Autoplay was refused: try again on the first user gesture. */
  private armGesture() {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    const go = () => {
      window.removeEventListener("pointerdown", go, true);
      window.removeEventListener("keydown", go, true);
      this.gestureArmed = false;
      for (const st of this.states.values()) if (st.video && st.video.paused && st.mesh.userData.teraOnScreen) this.play(st);
    };
    window.addEventListener("pointerdown", go, true);
    window.addEventListener("keydown", go, true);
  }

  get size(): number {
    return this.states.size;
  }

  /** Live mode, every frame: play videos that are on screen, pause the rest. */
  update(camera: THREE.Camera) {
    if (!this.states.size) return;
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cam = camera.getWorldPosition(new THREE.Vector3());
    for (const st of this.states.values()) {
      const v = st.video;
      if (!v) continue;
      let shown = !this.hidden;
      for (let o: THREE.Object3D | null = st.mesh; o && shown; o = o.parent) if (!o.visible) shown = false;
      if (shown) {
        const g = st.mesh.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        this.sphere.copy(g.boundingSphere!).applyMatrix4(st.mesh.matrixWorld);
        shown = this.frustum.intersectsSphere(this.sphere) && this.sphere.distanceToPoint(cam) < PLAY_DISTANCE;
      }
      st.mesh.userData.teraOnScreen = shown;
      if (shown && v.paused && v.readyState >= 2) this.play(st);
      else if (!shown && !v.paused) v.pause();
    }
  }

  /** Live mode: the page stopped drawing (hidden tab) or started again. */
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) for (const st of this.states.values()) st.video?.pause();
  }

  /** Render mode: every video at script time t (mod its duration), its frame uploaded. */
  async seek(t: number) {
    const jobs: Promise<void>[] = [];
    for (const st of this.states.values()) {
      const v = st.video;
      if (!v || st.disposed) continue;
      jobs.push(
        (async () => {
          await st.ready;
          if (st.disposed || v.readyState < 1 || !(v.duration > 0)) return;
          v.pause();
          const target = ((t % v.duration) + v.duration) % v.duration;
          if (Math.abs(v.currentTime - target) > 1e-3 || v.readyState < 2) {
            const seeked = once(v, "seeked", null, 20000);
            v.currentTime = target;
            await seeked.catch((err) => this.host.warn(`screen "${st.id}": ${(err as Error).message}`));
          }
          if (st.texture) st.texture.needsUpdate = true;
        })(),
      );
    }
    if (jobs.length) await this.host.track(Promise.all(jobs));
  }

  /** Forget a screen mesh (its node is being disposed): stop and release the video. */
  dispose(root: THREE.Object3D) {
    root.traverse((o) => {
      const st = this.states.get(o);
      if (!st) return;
      st.disposed = true;
      this.states.delete(o);
      st.texture?.dispose();
      const v = st.video;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    });
  }
}
