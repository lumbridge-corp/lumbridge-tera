# Tera clips in HyperFrames productions

A Tera clip enters a HyperFrames composition as a **pre-rendered, cached MP4 placed as a
`<video class="clip">` layer**. `src/render/hyperframes.ts` does it: it renders the clip
with `tera render`, caches it by content hash, and writes the `<video>` element (or a
whole standalone composition).

```sh
# render (or reuse) the clip, print the manifest + the <video> layer
node bin/tera.ts clip worlds/demo worlds/demo/intro.camera.json --size 1080x1920

# also write a standalone HyperFrames project that plays it full frame, then render it
node bin/tera.ts clip worlds/demo worlds/demo/intro.camera.json --composition out/hf-intro --title "Tera"
npx hyperframes@0.8.20 render out/hf-intro -o out/hf-intro.mp4
```

```ts
import { renderClip, videoLayer, writeComposition } from "./src/render/hyperframes.ts";
const clip = await renderClip({ worldDir, script, width: 1080, height: 1920, cacheDir });
const html = videoLayer(clip, { src: "./assets/tera.mp4", start: 3.2, mediaStart: 0.5, duration: 4, track: 0 });
```

The standalone composition has no GSAP timeline, so its root carries `data-no-timeline`;
without it HyperFrames 0.8.20 waits 45 s for `window.__timelines["main"]` and warns
`sub_timeline_readiness_timeout`. When you drop the layer into a template that has a
timeline, nothing extra is needed.

## Clip cache

`<cacheDir>/<key>.mp4` + `<key>.jpg` (poster, middle frame) + `<key>.json` (manifest,
`tera: "clip/v1"`). `key` = sha256 of `world.json`, the canonical script JSON, the size /
fps / renderer / crf / audio overrides and the engine build (`dist/index.html`, which
names the hashed bundles). Same inputs → same file, so re-running a production build
does not re-render. Writes are atomic (temp file + rename).

The clip has **no audio** by default: a production usually owns its own mix, so
camera-script audio would double up. `--audio` keeps it, and the
layer then carries `data-has-audio="true"` instead of `muted`.

## Why a video layer and not the engine page inside HyperFrames

Two ways were possible:

**(a) MP4 layer (chosen).** Tera renders the clip; the composition embeds it.

**(b) HyperFrames drives the engine.** HyperFrames 0.8.20 does seek pages
deterministically: its runtime dispatches a `hf-seek` `CustomEvent` on `window` with
`detail = { time, waitUntil(promise) }` for every frame and waits for those promises
(`window.__hfWaitForSeekCompletion`) before capturing; it also has built-in adapters for
three.js (`window.__hfThreeTime`) and GSAP/Lottie/anime. A Tera layer could listen to
`hf-seek` and call `window.tera.seek(time - start)` inside `waitUntil`.

(a) wins on robustness:

- `hf-seek` is **not documented** in 0.8.20 (`dist/docs/*` never mentions it); it is
  runtime internals that can change in any minor version. `<video>` with `data-start`,
  `data-duration`, `data-media-start` is the documented, stable surface.
- HyperFrames renders with its own bundled Chromium and **parallel workers** (default
  auto, "4 is the sweet spot"), each a separate page. With (b) every worker loads the
  three.js bundle, the world and its assets (splats, GLBs) and needs a working GPU in
  HyperFrames' browser; its `--browser-gpu auto` silently falls back to SwiftShader,
  and Docker mode is always SwiftShader. Tera's own host pins the flags that give real
  WebGL2 + WebGPU on Linux with an AMD GPU via Vulkan (see `src/render/host.ts`).
- Pre-rendering three.js beats to MP4 and playing them as video is a common pattern in
  HyperFrames productions, so a Tera clip needs no new concepts on the production side.
- Caching: a clip renders once and is reused across production re-renders, snaps and
  variations; (b) would re-render 3D on every HyperFrames pass.
- Frame exactness is kept: HyperFrames extracts source-video frames by timestamp (use
  `--video-frame-format png` for colour-critical clips; `auto` may extract JPEG).

Cost of (a): one extra encode generation (x264 crf 18, visually lossless) and the clip
must be rendered at the composition's size and fps (pass `--size 1080x1920 --fps 30` for
the 9:16 default). If a clip ever needs to react to composition state per frame, (b) is
a small adapter on top of the same bridge — revisit when `hf-seek` is documented.

## Using it from a production build

A natural hook is a beat type next to plain video.
