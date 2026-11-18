// One small handle over the two renderers so the rest of the engine does not care
// which backend draws: three's WebGPURenderer (three/webgpu) or WebGLRenderer (WebGL2).
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";

export type Backend = "webgpu" | "webgl2";

/** The members both renderers share that the engine uses. */
export interface AnyRenderer {
  domElement: HTMLCanvasElement;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: string;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
  setPixelRatio(r: number): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): unknown;
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene | null): Promise<unknown>;
  setAnimationLoop(cb: ((time: number) => void) | null): unknown;
  dispose(): void;
}

export interface RendererHandle {
  backend: Backend;
  renderer: AnyRenderer;
  /** Set only on the WebGL2 backend (Spark.js needs it). */
  webgl: THREE.WebGLRenderer | null;
  canvas: HTMLCanvasElement;
  /** Resolves when the GPU has finished all submitted work. */
  finish(): Promise<void>;
  /**
   * Draw one frame with `draw` and read it back as PNG base64. Rendering and reading happen in
   * the same task, which is what makes a WebGPU canvas readable (its texture is
   * dropped once the frame is presented).
   */
  renderPNG(draw: () => void): string;
  dispose(): void;
}

export async function webgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function configure(r: AnyRenderer, pixelRatio: number) {
  r.setPixelRatio(pixelRatio);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
}

export async function createRenderer(backend: Backend, pixelRatio: number): Promise<RendererHandle> {
  const canvas = document.createElement("canvas");
  canvas.dataset.backend = backend;
  if (backend === "webgpu") {
    const { WebGPURenderer: Ctor } = await import("three/webgpu");
    const r: WebGPURenderer = new Ctor({ canvas, antialias: true, alpha: false });
    await r.init();
    const backendObj = r.backend as unknown as { isWebGPUBackend?: boolean; device?: { queue: { onSubmittedWorkDone(): Promise<void> } } };
    if (!backendObj.isWebGPUBackend) {
      r.dispose();
      throw new Error("WebGPU is not available in this browser");
    }
    const any = r as unknown as AnyRenderer;
    configure(any, pixelRatio);
    return {
      backend,
      renderer: any,
      webgl: null,
      canvas,
      finish: async () => { await backendObj.device?.queue.onSubmittedWorkDone(); },
      renderPNG(draw) {
        draw();
        return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
      },
      dispose: () => r.dispose(),
    };
  }
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  const any = r as unknown as AnyRenderer;
  configure(any, pixelRatio);
  return {
    backend,
    renderer: any,
    webgl: r,
    canvas,
    finish: async () => { r.getContext().finish(); },
    renderPNG(draw) {
      draw();
      return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    },
    dispose: () => {
      r.dispose();
      r.forceContextLoss();
    },
  };
}
