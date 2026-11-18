// Post effects for video quality: environment.post = { ao, bloom, dof } (CONTRACT section 1).
//
// WebGL2: three's EffectComposer (RenderPass → GTAOPass → bloom → DofPass → OutputPass).
// WebGPU: TSL nodes in a RenderPipeline (pass + MRT normals → ao(), bloom(), our dof).
// Both backends run the SAME formulas for bloom input and depth of field (dof.ts), so one
// world gives the same picture on either renderer.
//
// - Bloom, source "glow" (default): a second scene pass draws only what glows (emissive and
//   glow materials, flows, robot lights; everything else black, glass and veils hidden) and
//   only that blooms. A bright cream scene never washes out. Source "scene" thresholds the
//   scene-linear colour like three's stock bloom.
// - DOF: two separable, CoC-weighted gaussian passes (our own, not BokehPass / dof()):
//   circle of confusion in fractions of the image width from exact depth (a float depth
//   texture, not the RGBA-packed half-float one BokehPass uses) or from screen height for
//   tilt-shift. A tap only contributes if its own blur reaches the centre pixel, so sharp
//   things never smear over a blurred background.
//
// Nothing here is temporal or random: a frame depends only on the scene and the camera, so
// seek/capture stay deterministic. An effect a backend cannot build is skipped with a
// warning and the rest still apply.
import * as THREE from "three";
import type { Post } from "../schema/index.ts";
import type { RendererHandle } from "./renderer.ts";
import { DOF_MAX_BLUR, DOF_TAPS, dofTapWeight, resolveDof, type DofParams } from "./dof.ts";

export { DOF_MAX_BLUR } from "./dof.ts";

export interface PostPipeline {
  /** Draw the scene through the effects to the canvas. */
  render(): void;
  setSize(w: number, h: number): void;
  dispose(): void;
  /** Effects actually active. */
  active: string[];
}

/** True when the block asks for at least one effect. */
export function wantsPost(p: Post | undefined): p is Post {
  return !!p && (p.ao === true || !!p.bloom || !!p.dof);
}

/** Depth-mode distance from the focus plane (m) at which blur is full: blur = aperture·|1 − focus/d|, so this is where that reaches maxBlur on the far side. */
export function dofFullBlurDistance(aperture: number, focus = 1, maxBlur = DOF_MAX_BLUR): number {
  if (aperture <= maxBlur) return 1e6;
  return focus / (1 - maxBlur / aperture) - focus;
}

/** Resolved bloom settings: source and threshold defaults. */
export function resolveBloom(b: NonNullable<Post["bloom"]>): { strength: number; radius: number; threshold: number; source: "glow" | "scene" } {
  const source = b.source ?? "glow";
  return { strength: b.strength, radius: b.radius ?? 0.4, threshold: b.threshold ?? (source === "glow" ? 0 : 1), source };
}

const isGlass = (m: THREE.Material) => m.userData.teraGlass === true || ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0;

/**
 * Hide what a depth/normal pre-pass cannot draw with its override material: sky helpers
 * (backdrop dome, sun disc, Spark's renderer), sprites, transparent surfaces (text, veils)
 * and glass. Otherwise they stamp opaque depth: AO turns them into black boxes and DOF
 * focuses on the pane instead of the room behind it.
 */
function withoutOverlays(scene: THREE.Scene, fn: () => void) {
  const hidden: THREE.Object3D[] = [];
  scene.traverseVisible((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    const skip = mats.some((m) => m.transparent || isGlass(m));
    if ((o.userData.tera === "sky" && !(o as THREE.Light).isLight) || (o as THREE.Sprite).isSprite || skip) hidden.push(o);
  });
  for (const o of hidden) o.visible = false;
  try { fn(); } finally { for (const o of hidden) o.visible = true; }
}

// ---------------------------------------------------------------- glow-only scene pass

const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/**
 * The material a mesh wears in the glow pass: its own (pure glow materials), its emissive
 * colour unlit, black (opaque occluders) or null (hidden: glass, transparent veils, text).
 */
function glowMaterial(cache: WeakMap<THREE.Material, THREE.MeshBasicMaterial>, m: THREE.Material): THREE.Material | null {
  const ud = m.userData;
  if (isGlass(m)) return null;
  const exact = ud.glowColor as THREE.Color | undefined; // glowExact primitives: colour × glow
  if (ud.glow === true && !exact) return m; // flows, robot lights, meters: already pure light
  const std = m as THREE.MeshStandardMaterial;
  const lit = !!exact || (!!std.emissive && std.emissiveIntensity > 0 && std.emissive.r + std.emissive.g + std.emissive.b > 0);
  if (!lit && m.transparent) return null;
  let b = cache.get(m);
  if (!b) {
    b = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false });
    cache.set(m, b);
  }
  if (exact) b.color.copy(exact);
  else if (lit) b.color.copy(std.emissive).multiplyScalar(std.emissiveIntensity);
  else b.color.setRGB(0, 0, 0);
  b.map = lit && !exact ? std.emissiveMap ?? null : null;
  b.side = m.side;
  b.transparent = m.transparent;
  b.opacity = m.opacity;
  b.depthWrite = m.depthWrite;
  b.depthTest = m.depthTest;
  b.blending = m.blending;
  b.wireframe = (m as THREE.MeshBasicMaterial).wireframe ?? false;
  return b;
}

/** Run fn with the scene dressed for the glow pass (black background, glow materials), then restore. */
function withGlowOnly(scene: THREE.Scene, cache: WeakMap<THREE.Material, THREE.MeshBasicMaterial>, fn: () => void) {
  const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  const hidden: THREE.Object3D[] = [];
  scene.traverseVisible((o) => {
    if ((o.userData.tera === "sky" && !(o as THREE.Light).isLight) || (o as THREE.Sprite).isSprite) return void hidden.push(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.material || !(mesh.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints)) return;
    const orig = mesh.material;
    if (Array.isArray(orig)) {
      const subs = orig.map((m) => glowMaterial(cache, m) ?? INVISIBLE);
      swapped.push([mesh, orig]);
      mesh.material = subs;
      return;
    }
    const sub = glowMaterial(cache, orig);
    if (!sub) return void hidden.push(o);
    if (sub !== orig) {
      swapped.push([mesh, orig]);
      mesh.material = sub;
    }
  });
  const bg = scene.background, fog = scene.fog;
  scene.background = null;
  scene.fog = null;
  for (const o of hidden) o.visible = false;
  try {
    fn();
  } finally {
    for (const o of hidden) o.visible = true;
    for (const [m, mat] of swapped) m.material = mat;
    scene.background = bg;
    scene.fog = fog;
  }
}

// ---------------------------------------------------------------- shared

export async function createPost(
  h: RendererHandle,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  post: Post,
  size: { w: number; h: number },
  warn: (msg: string) => void,
): Promise<PostPipeline | null> {
  if (!wantsPost(post)) return null;
  try {
    return h.webgl ? await webglPost(h.webgl, scene, camera, post, size) : await webgpuPost(h, scene, camera, post, size, warn);
  } catch (err) {
    warn(`post effects disabled on ${h.backend}: ${(err as Error).message}`);
    return null;
  }
}

/** GLSL for one separable DOF pass (pass 1: CoC from depth / screen y, written to alpha; pass 2: CoC read from alpha). */
function dofFragment(p: DofParams, pass: 1 | 2): string {
  const weights = Array.from({ length: DOF_TAPS }, (_, i) => dofTapWeight(i + 1).toFixed(6)).join(", ");
  return /* glsl */ `
#include <packing>
#define TAPS ${DOF_TAPS}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float cameraNear, cameraFar, focus, aperture, maxBlur, center, band, falloff, blur, aspect;
uniform vec2 dir;
varying vec2 vUv;
const float W[TAPS] = float[TAPS](${weights});
float cocAt(vec2 uv) {
${p.mode === "depth"
    ? `  float d = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
  return min(maxBlur, aperture * abs(1.0 - focus / max(d, 1e-4)));`
    : `  float y = 1.0 - uv.y; // 0 = top of the frame
  return blur * smoothstep(0.0, falloff, abs(y - center) - band * 0.5);`}
}
float tapCoc(vec2 uv) { ${pass === 1 ? "return cocAt(uv);" : "return texture2D(tColor, uv).a;"} }
void main() {
  float c0 = tapCoc(vUv);
  vec3 acc = texture2D(tColor, vUv).rgb;
  float wsum = 1.0;
  if (c0 > 1e-5) {
    float unit = c0 / float(TAPS);
    vec2 stepUv = dir * vec2(1.0, aspect) * unit;
    for (int k = 1; k <= TAPS; k++) {
      float dk = unit * float(k);
      for (int s = -1; s <= 1; s += 2) {
        vec2 u = clamp(vUv + stepUv * float(k * s), vec2(0.0), vec2(1.0));
        float w = W[k - 1] * clamp((tapCoc(u) - dk) / unit + 1.0, 0.0, 1.0);
        acc += texture2D(tColor, u).rgb * w;
        wsum += w;
      }
    }
  }
  gl_FragColor = vec4(acc / wsum, ${pass === 1 ? "c0" : "1.0"});
}`;
}

// ---------------------------------------------------------------- WebGL2

async function webglPost(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, post: Post, size: { w: number; h: number }): Promise<PostPipeline> {
  const [{ EffectComposer }, { RenderPass }, { OutputPass }, { Pass, FullScreenQuad }] = await Promise.all([
    import("three/addons/postprocessing/EffectComposer.js"),
    import("three/addons/postprocessing/RenderPass.js"),
    import("three/addons/postprocessing/OutputPass.js"),
    import("three/addons/postprocessing/Pass.js"),
  ]);
  const pr = gl.getPixelRatio();
  // HDR (half float) and MSAA so edges match the direct path; tone mapping happens in OutputPass.
  const rt = new THREE.WebGLRenderTarget(size.w * pr, size.h * pr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(gl, rt);
  composer.addPass(new RenderPass(scene, camera));
  const active: string[] = [];
  const extra: { dispose(): void }[] = [];
  if (post.ao) {
    const { GTAOPass } = await import("three/addons/postprocessing/GTAOPass.js");
    const ao = new GTAOPass(scene, camera, size.w, size.h);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = 1;
    ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    const render = ao.render.bind(ao);
    ao.render = (...a: Parameters<typeof render>) => withoutOverlays(scene, () => render(...a));
    composer.addPass(ao);
    active.push("ao");
  }
  if (post.bloom) {
    const b = resolveBloom(post.bloom);
    const { UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js");
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.w, size.h), b.strength, b.radius, b.threshold);
    if (b.source === "scene") composer.addPass(bloom);
    else {
      // Feed the bloom from a glow-only render instead of the scene colour.
      const glowRT = new THREE.WebGLRenderTarget(size.w * pr, size.h * pr, { type: THREE.HalfFloatType });
      const cache = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
      Object.defineProperty((bloom.highPassUniforms as Record<string, { value: unknown }>).tDiffuse, "value", { get: () => glowRT.texture, set: () => {} });
      const clear = new THREE.Color();
      class GlowBloomPass extends Pass {
        constructor() {
          super();
          this.needsSwap = false;
        }
        override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
          renderer.getClearColor(clear);
          const alpha = renderer.getClearAlpha(), autoShadow = renderer.shadowMap.autoUpdate;
          renderer.setClearColor(0x000000, 1);
          renderer.shadowMap.autoUpdate = false; // the main pass already drew this frame's shadows
          renderer.setRenderTarget(glowRT);
          renderer.clear();
          withGlowOnly(scene, cache, () => renderer.render(scene, camera));
          renderer.shadowMap.autoUpdate = autoShadow;
          renderer.setClearColor(clear, alpha);
          bloom.render(renderer, writeBuffer, readBuffer, dt, mask);
        }
        override setSize(w: number, hh: number) {
          glowRT.setSize(w, hh);
          bloom.setSize(w, hh);
        }
        override dispose() {
          glowRT.dispose();
          bloom.dispose();
        }
      }
      composer.addPass(new GlowBloomPass());
    }
    active.push("bloom");
  }
  if (post.dof) {
    const p = resolveDof(post.dof);
    const uniforms = () => ({
      tColor: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null },
      cameraNear: { value: camera.near }, cameraFar: { value: camera.far },
      focus: { value: p.focus }, aperture: { value: p.aperture }, maxBlur: { value: p.maxBlur },
      center: { value: p.center }, band: { value: p.band }, falloff: { value: p.falloff }, blur: { value: p.blur },
      aspect: { value: size.w / size.h }, dir: { value: new THREE.Vector2(1, 0) },
    });
    const vertexShader = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";
    const m1 = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader, fragmentShader: dofFragment(p, 1), depthTest: false, depthWrite: false });
    const m2 = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader, fragmentShader: dofFragment(p, 2), depthTest: false, depthWrite: false });
    m2.uniforms.dir!.value.set(0, 1);
    const mid = new THREE.WebGLRenderTarget(size.w * pr, size.h * pr, { type: THREE.HalfFloatType });
    // Exact depth: a float depth texture from a depth-only pre-pass (depth mode only).
    const depthRT = p.mode === "depth" ? new THREE.WebGLRenderTarget(size.w * pr, size.h * pr, { depthTexture: new THREE.DepthTexture(size.w * pr, size.h * pr, THREE.FloatType) }) : null;
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    const q1 = new FullScreenQuad(m1), q2 = new FullScreenQuad(m2);
    class DofPass extends Pass {
      override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
        if (depthRT) {
          const bg = scene.background, autoShadow = renderer.shadowMap.autoUpdate;
          scene.background = null;
          scene.overrideMaterial = depthMat;
          renderer.shadowMap.autoUpdate = false;
          renderer.setRenderTarget(depthRT);
          renderer.clear();
          withoutOverlays(scene, () => renderer.render(scene, camera));
          scene.overrideMaterial = null;
          scene.background = bg;
          renderer.shadowMap.autoUpdate = autoShadow;
          m1.uniforms.tDepth!.value = depthRT.depthTexture;
        }
        for (const m of [m1, m2]) {
          m.uniforms.cameraNear!.value = camera.near;
          m.uniforms.cameraFar!.value = camera.far;
        }
        m1.uniforms.tColor!.value = readBuffer.texture;
        renderer.setRenderTarget(mid);
        q1.render(renderer);
        m2.uniforms.tColor!.value = mid.texture;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        q2.render(renderer);
      }
      override setSize(w: number, hh: number) {
        mid.setSize(w, hh);
        depthRT?.setSize(w, hh);
        for (const m of [m1, m2]) m.uniforms.aspect!.value = w / hh;
      }
      override dispose() {
        mid.dispose();
        depthRT?.depthTexture?.dispose();
        depthRT?.dispose();
        depthMat.dispose();
        m1.dispose();
        m2.dispose();
        q1.dispose();
        q2.dispose();
      }
    }
    composer.addPass(new DofPass());
    active.push("dof");
  }
  composer.addPass(new OutputPass());
  composer.setSize(size.w, size.h);
  return {
    active,
    render: () => composer.render(0),
    setSize: (w, hh) => composer.setSize(w, hh),
    dispose: () => {
      for (const p of composer.passes) (p as { dispose?: () => void }).dispose?.();
      for (const x of extra) x.dispose();
      composer.dispose();
      rt.dispose();
    },
  };
}

// ---------------------------------------------------------------- WebGPU

async function webgpuPost(h: RendererHandle, scene: THREE.Scene, camera: THREE.PerspectiveCamera, post: Post, _size: { w: number; h: number }, warn: (msg: string) => void): Promise<PostPipeline> {
  const W = await import("three/webgpu");
  const T = await import("three/tsl");
  const renderer = h.renderer as unknown as InstanceType<typeof W.WebGPURenderer>;
  const scenePass = T.pass(scene, camera);
  const active: string[] = [];
  const passes: { dispose(): void }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let color: any = scenePass.getTextureNode("output");
  if (post.ao) {
    try {
      const { ao } = await import("three/addons/tsl/display/GTAONode.js");
      scenePass.setMRT(T.mrt({ output: T.output, normal: T.directionToColor(T.normalView) }));
      const normalTex = scenePass.getTextureNode("normal");
      const normal = T.sample((uv) => T.colorToDirection(normalTex.sample(uv)));
      const depth = scenePass.getTextureNode("depth");
      const aoPass = ao(depth, normal, camera);
      aoPass.radius.value = 0.35;
      aoPass.samples.value = 16;
      aoPass.useTemporalFiltering = false;
      // Spatial denoise (fixed noise texture, no history) instead of TRAA: stays deterministic.
      const { denoise } = await import("three/addons/tsl/display/DenoiseNode.js");
      const clean = denoise(aoPass.getTextureNode().r, depth, normal, camera);
      color = scenePass.getTextureNode("output").mul(T.vec4(T.vec3(T.float(clean as never)), 1));
      active.push("ao");
    } catch (err) {
      warn(`post ao skipped on webgpu: ${(err as Error).message}`);
    }
  }
  if (post.bloom) {
    try {
      const b = resolveBloom(post.bloom);
      const { bloom } = await import("three/addons/tsl/display/BloomNode.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let input: any = color;
      if (b.source === "glow") {
        const glowPass = T.pass(scene, camera);
        const cache = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
        const gp = glowPass as unknown as { updateBefore(frame: unknown): unknown };
        const orig = gp.updateBefore.bind(glowPass);
        const clear = new THREE.Color();
        gp.updateBefore = (frame: unknown) => {
          renderer.getClearColor(clear);
          const alpha = renderer.getClearAlpha();
          renderer.setClearColor(0x000000, 1);
          let out: unknown;
          withGlowOnly(scene, cache, () => { out = orig(frame); });
          renderer.setClearColor(clear, alpha);
          return out;
        };
        passes.push(glowPass);
        input = glowPass.getTextureNode("output");
      }
      color = color.add(bloom(input, b.strength, b.radius, b.threshold));
      active.push("bloom");
    } catch (err) {
      warn(`post bloom skipped on webgpu: ${(err as Error).message}`);
    }
  }
  const uAspect = T.uniform(camera.aspect), uNear = T.uniform(camera.near), uFar = T.uniform(camera.far);
  if (post.dof) {
    try {
      const p = resolveDof(post.dof);
      const depthTex = scenePass.getTextureNode("depth");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type N = any;
      const X: N = T;
      const cocAt = (u: N): N => {
        if (p.mode === "depth") {
          const d = X.perspectiveDepthToViewZ(depthTex.sample(u).r, uNear, uFar).negate();
          return X.min(X.float(p.maxBlur), X.float(p.aperture).mul(X.abs(X.float(1).sub(X.float(p.focus).div(X.max(d, 1e-4))))));
        }
        // WebGPU uv has y = 0 at the top already.
        return X.float(p.blur).mul(X.smoothstep(0, p.falloff, X.abs(u.y.sub(p.center)).sub(p.band / 2)));
      };
      const blurPass = (tex: N, dir: [number, number], first: boolean): N =>
        X.Fn(() => {
          const u0 = X.uv();
          const c0 = (first ? cocAt(u0) : tex.sample(u0).a).toVar();
          const unit = c0.div(DOF_TAPS).toVar();
          const stepUv = X.vec2(dir[0], uAspect.mul(dir[1])).mul(unit).toVar();
          const acc = tex.sample(u0).rgb.toVar();
          const wsum = X.float(1).toVar();
          for (let k = 1; k <= DOF_TAPS; k++) {
            for (const s of [-1, 1]) {
              const u = X.clamp(u0.add(stepUv.mul(k * s)), X.vec2(0, 0), X.vec2(1, 1));
              const ck = first ? cocAt(u) : tex.sample(u).a;
              const w = X.clamp(ck.sub(unit.mul(k)).div(X.max(unit, 1e-6)).add(1), 0, 1).mul(dofTapWeight(k));
              acc.addAssign(tex.sample(u).rgb.mul(w));
              wsum.addAssign(w);
            }
          }
          return X.vec4(acc.div(wsum), first ? c0 : X.float(1));
        })();
      const src = T.convertToTexture(color);
      const h1 = T.convertToTexture(blurPass(src, [1, 0], true));
      color = blurPass(h1, [0, 1], false);
      active.push("dof");
    } catch (err) {
      warn(`post dof skipped on webgpu: ${(err as Error).message}`);
    }
  }
  const pipeline = new W.RenderPipeline(renderer, color);
  return {
    active,
    render: () => {
      uAspect.value = camera.aspect;
      uNear.value = camera.near;
      uFar.value = camera.far;
      pipeline.render();
    },
    setSize: () => { /* the passes follow the renderer's drawing-buffer size */ },
    dispose: () => {
      for (const p of passes) p.dispose();
      pipeline.dispose();
    },
  };
}
