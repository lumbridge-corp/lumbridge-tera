// Tera → HyperFrames. A Tera clip enters a HyperFrames production as a pre-rendered,
// cached MP4 that the composition places as a <video class="clip"> layer. HyperFrames
// extracts video frames deterministically, so the clip stays frame-exact inside the
// production. See docs/hyperframes.md for why this beats driving the engine page from
// inside HyperFrames.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { CameraScript } from "../schema/index.ts";
import { ensureBuilt, REPO_ROOT } from "./host.ts";
import { prepareScript, render, type RenderOptions } from "./render.ts";

export interface ClipOptions {
  worldDir: string;
  script: CameraScript | string;
  /** Where clips are cached (default <repo>/out/clips). File name = content hash. */
  cacheDir?: string;
  width?: number;
  height?: number;
  fps?: number;
  renderer?: RenderOptions["renderer"];
  /** Keep the script's audio in the MP4. Default false: the production owns the mix. */
  audio?: boolean;
  crf?: number;
  workers?: number;
  /** Ignore the cache. */
  force?: boolean;
  onProgress?: RenderOptions["onProgress"];
  onWarning?: RenderOptions["onWarning"];
}

export interface TeraClip {
  tera: "clip/v1";
  key: string;
  file: string;
  poster: string;
  duration: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  world: string;
  audio: boolean;
  cached: boolean;
  rendered_at: string;
}

const sha = (...parts: (string | Buffer)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex");
};

/** Stable JSON (sorted keys) so key order in a script does not change the cache key. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Cache key: world.json + script + overrides + engine build (dist/index.html names the hashed bundles). */
export function clipKey(opts: ClipOptions, script: CameraScript): string {
  ensureBuilt();
  const world = readFileSync(join(opts.worldDir, "world.json"));
  const engine = readFileSync(join(REPO_ROOT, "dist", "index.html"));
  const over = canonical({ w: opts.width, h: opts.height, fps: opts.fps, r: opts.renderer ?? "auto", a: !!opts.audio, crf: opts.crf ?? 18 });
  const audio = opts.audio && script.audio ? script.audio.src : "";
  return sha("clip/v1", world, canonical(script), over, engine, audio).slice(0, 20);
}

/** Render (or reuse) a Tera clip for a HyperFrames production. */
export async function renderClip(opts: ClipOptions): Promise<TeraClip> {
  const prep = prepareScript(opts.script, opts.worldDir);
  const cacheDir = resolve(opts.cacheDir ?? join(REPO_ROOT, "out", "clips"));
  mkdirSync(cacheDir, { recursive: true });
  const key = clipKey(opts, prep.script);
  const file = join(cacheDir, `${key}.mp4`), poster = join(cacheDir, `${key}.jpg`), manifest = join(cacheDir, `${key}.json`);
  if (!opts.force && existsSync(file) && existsSync(manifest)) {
    return { ...(JSON.parse(readFileSync(manifest, "utf8")) as TeraClip), cached: true };
  }
  const tmp = join(cacheDir, `.${key}.${process.pid}.mp4`);
  try {
    const r = await render({
      worldDir: opts.worldDir, script: opts.script, out: tmp, width: opts.width, height: opts.height, fps: opts.fps,
      renderer: opts.renderer, crf: opts.crf, workers: opts.workers, noAudio: !opts.audio, onProgress: opts.onProgress, onWarning: opts.onWarning,
    });
    renameSync(tmp, file);
    const duration = r.frames / r.fps;
    const pf = spawnSync(process.env.TERA_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", (duration / 2).toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "3", poster]);
    if (pf.status !== 0) throw new Error(`tera: poster frame failed: ${pf.stderr}`);
    const clip: TeraClip = {
      tera: "clip/v1", key, file, poster, duration, frames: r.frames, fps: r.fps, width: r.width, height: r.height,
      world: prep.world.id, audio: !!r.audio, cached: false, rendered_at: new Date().toISOString(),
    };
    writeFileSync(manifest + ".tmp", JSON.stringify(clip, null, 2) + "\n");
    renameSync(manifest + ".tmp", manifest);
    return clip;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface LayerOptions {
  /** src as the composition will reference it (default: the clip file name). */
  src?: string;
  id?: string;
  /** Composition seconds the clip starts at. */
  start?: number;
  /** Seconds to show (default: the whole clip from mediaStart). */
  duration?: number;
  /** Trim: seconds into the clip to start from. */
  mediaStart?: number;
  track?: number;
  className?: string;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const num = (n: number) => String(+n.toFixed(6));

/** The <video> element that places a Tera clip on a HyperFrames timeline. */
export function videoLayer(clip: Pick<TeraClip, "file" | "duration" | "audio" | "key">, o: LayerOptions = {}): string {
  const mediaStart = o.mediaStart ?? 0;
  const duration = o.duration ?? clip.duration - mediaStart;
  if (duration <= 0 || mediaStart + duration > clip.duration + 1e-6) throw new Error(`tera: layer [${mediaStart}, ${mediaStart + duration}] is outside the ${clip.duration}s clip`);
  const a = [
    `id="${attr(o.id ?? `tera-${clip.key.slice(0, 8)}`)}"`,
    `class="${attr(o.className ?? "clip tera")}"`,
    `src="${attr(o.src ?? basename(clip.file))}"`,
    `data-start="${num(o.start ?? 0)}"`,
    `data-duration="${num(duration)}"`,
  ];
  if (mediaStart) a.push(`data-media-start="${num(mediaStart)}"`);
  if (o.track !== undefined) a.push(`data-track-index="${o.track}"`);
  if (clip.audio) a.push(`data-has-audio="true"`);
  else a.push("muted");
  a.push("playsinline");
  return `<video ${a.join(" ")}></video>`;
}

export interface CompositionOptions {
  /** Optional title over the clip (plain CSS, no GSAP). */
  title?: string;
  /** Composition id (default "main"). */
  id?: string;
}

/**
 * A standalone HyperFrames project (index.html + assets/<clip>.mp4) that plays one Tera clip
 * full frame. `npx hyperframes@0.8.20 render <dir> -o out.mp4` renders it. The root carries
 * `data-no-timeline` (no GSAP timeline), else HyperFrames waits 45 s for one to register.
 */
export function writeComposition(clip: TeraClip, dir: string, o: CompositionOptions = {}): string {
  const d = resolve(dir);
  mkdirSync(join(d, "assets"), { recursive: true });
  const name = `tera-${clip.key}.mp4`;
  copyFileSync(clip.file, join(d, "assets", name));
  const id = o.id ?? "main";
  const W = clip.width, H = clip.height, D = num(clip.duration);
  const layer = videoLayer(clip, { src: `./assets/${name}`, id: "tera", track: 0 });
  const title = o.title
    ? `\n      <div id="title" class="clip" data-start="0" data-duration="${D}" data-track-index="1">${o.title.replace(/</g, "&lt;")}</div>`
    : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>Tera clip ${clip.key.slice(0, 8)}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
      #tera { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; }
      #title { position: absolute; left: 6%; right: 6%; bottom: 8%; color: #fff; font: 600 ${Math.round(H / 18)}px/1.1 Inter, Arial, sans-serif;
               letter-spacing: -0.02em; text-shadow: 0 2px 24px rgba(0,0,0,.6); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${attr(id)}" data-no-timeline data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
      ${layer}${title}
    </div>
  </body>
</html>
`;
  writeFileSync(join(d, "index.html"), html);
  writeFileSync(join(d, "tera-clip.json"), JSON.stringify({ ...clip, file: relative(d, join(d, "assets", name)) }, null, 2) + "\n");
  return join(d, "index.html");
}
