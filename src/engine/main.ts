// Engine page entry: URL flags, window.tera (CONTRACT.md section 4), live mode.
//
//   ?mode=render                 no controls, no UI, no clock; only seek() advances time
//   ?renderer=auto|webgpu|webgl2 auto = WebGPU when available and the world has no splats
//   ?world=<url of world.json>   live mode: world to open (asset paths relative to it)
//   ?xr=vr|ar                    live mode: WebXR button (Quest 3 VR / passthrough AR, Snap Spectacles AR); docs/xr.md
//     &xrsize=<m> &xrwalk=<k> &xrstart=table|walk   tabletop size, walk scale, starting scale
//   ?live=ws://host:port         live feed (live.ts, CONTRACT.md section 9): snapshots + ops as they happen
//   ?ui=0                        live mode: no viewer UI at all (kiosks, embeds)
//   ?quality=auto|high|medium|low|lower|lowest   live mode: adaptive (default) or a pinned level
//   ?idle=<s>                    live mode: seconds without input before the idle orbit (default 60)
//   ?labels=fit                  render mode: fit actor name tags to the screen like live mode does
import type { TeraBridge } from "../bridge/types.ts";
import { Engine, type RendererPref } from "./engine.ts";
import type { XrOptions } from "./xr.ts";

const params = new URLSearchParams(location.search);
const renderMode = params.get("mode") === "render";
const prefParam = params.get("renderer") ?? "auto";
const pref: RendererPref = prefParam === "webgpu" || prefParam === "webgl2" ? prefParam : "auto";

const xrParam = params.get("xr");
const num = (k: string) => (params.get(k) !== null && Number.isFinite(Number(params.get(k))) && Number(params.get(k)) > 0 ? Number(params.get(k)) : undefined);
const xr: XrOptions | undefined =
  xrParam === "vr" || xrParam === "ar"
    ? { mode: xrParam, tableSize: num("xrsize"), walkScale: num("xrwalk"), start: params.get("xrstart") === "walk" ? "walk" : params.get("xrstart") === "table" ? "table" : undefined }
    : undefined;

const engine = new Engine(document.body, renderMode, pref, { xr, labelFit: renderMode ? params.get("labels") === "fit" : true });

/** Bridge calls run one at a time, in order, so a seek never interleaves with an apply. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

const bridge: TeraBridge = {
  version: "bridge/v1",
  load: (w, baseUrl) => serial(() => engine.load(w, baseUrl)),
  apply: (ops) => serial(() => engine.apply(ops)),
  get: () => serial(() => engine.get()),
  setCamera: (pose) => serial(() => engine.setPose(pose)),
  setSize: (w, h) => serial(() => engine.setSize(w, h)),
  loadScript: (s) => serial(() => engine.loadScript(s)),
  seek: (t) => serial(() => engine.seek(t)),
  render: (pose, w, h) => serial(() => engine.render(pose, w, h)),
  bounds: (ids) => serial(() => engine.bounds(ids)),
  capture: () => serial(() => engine.capture()),
  info: () => serial(() => engine.info()),
};
window.tera = bridge;
(window as unknown as { teraEngine: Engine }).teraEngine = engine; // for debugging from devtools

// Live mode: the viewer (loading screen, HUD, camera presets, selection, adaptive quality;
// viewer/viewer.ts, docs/viewer.md). Loaded on demand, so render mode never runs any of it.
if (!renderMode) void import("./viewer/viewer.ts").then(({ startViewer }) => startViewer({ engine, bridge, params, xr }));
