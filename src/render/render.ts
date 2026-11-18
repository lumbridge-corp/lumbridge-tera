// Frame-exact video: seek every frame in headless Chrome, pipe PNGs to ffmpeg.
// CONTRACT.md section 5. Frame n is script time n / fps; the same world + script + build
// give the same frames.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { WorldPack, type CameraPose, type CameraScript } from "../schema/index.ts";
import { validate } from "../camera/validate.ts";
import { frameCount } from "../camera/evaluate.ts";
import { openTera, type OpenOptions, type TeraPage } from "./host.ts";

export interface RenderOptions {
  worldDir: string;
  /** Script object or path to a camera/v1 JSON file. */
  script: CameraScript | string;
  out: string;
  fps?: number;
  width?: number;
  height?: number;
  /** Seconds; renders frames round(from*fps) .. round(to*fps) - 1. */
  from?: number;
  to?: number;
  renderer?: OpenOptions["renderer"];
  /** Per-frame timeout, ms (default 30000). */
  timeoutMs?: number;
  /** x264 crf (default 18) and preset (default "medium"). */
  crf?: number;
  preset?: string;
  /** Parallel pages, each seeking its own frames (default 1). */
  workers?: number;
  /** Skip the audio track even if the script has one. */
  noAudio?: boolean;
  onProgress?: (p: { frame: number; done: number; total: number; fps: number; etaS: number }) => void;
  onWarning?: (msg: string) => void;
}

export interface RenderResult {
  out: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  seconds: number;
  renderFps: number;
  audio?: string;
  warnings: string[];
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadWorld(worldDir: string): WorldPack {
  const p = join(worldDir, "world.json");
  if (!existsSync(p)) throw new Error(`tera: no world.json in ${worldDir}`);
  return WorldPack.parse(readJson(p));
}

/** audio.src is resolved against the script's folder first, then the world folder. */
export function resolveAudio(src: string, scriptDir: string | undefined, worldDir: string): string | undefined {
  if (isAbsolute(src)) return existsSync(src) ? src : undefined;
  for (const d of [scriptDir, worldDir]) if (d && existsSync(join(d, src))) return resolve(d, src);
}

/** Parse + validate a script against a world; throws with every error, returns warnings. */
export function prepareScript(script: CameraScript | string, worldDir: string, world = loadWorld(worldDir)) {
  const scriptDir = typeof script === "string" ? dirname(resolve(script)) : undefined;
  const raw = typeof script === "string" ? readJson(script) : script;
  const v = validate(raw, world, { fileExists: (src) => !!resolveAudio(src, scriptDir, worldDir) });
  if (!v.ok || !v.script) throw new Error(`tera: script is not valid:\n  ${v.errors.join("\n  ")}`);
  return { script: v.script, warnings: v.warnings, scriptDir, world };
}

/** ffmpeg arguments: PNG frames on stdin (+ optional audio) → H.264 yuv420p MP4. */
export function ffmpegArgs(o: { fps: number; out: string; crf?: number; preset?: string; frames: number; audio?: { path: string; shift: number } }): string[] {
  const dur = (o.frames / o.fps).toFixed(6);
  const a = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "-"];
  if (o.audio) {
    // shift > 0: audio starts later in the video (pad with silence); shift < 0: skip into the audio.
    if (o.audio.shift < 0) a.push("-ss", (-o.audio.shift).toFixed(6));
    a.push("-i", o.audio.path);
  }
  a.push("-map", "0:v:0");
  if (o.audio) {
    a.push("-map", "1:a:0");
    if (o.audio.shift > 0) a.push("-af", `adelay=${Math.round(o.audio.shift * 1000)}:all=1,apad`);
    else a.push("-af", "apad");
    a.push("-c:a", "aac", "-b:a", "192k");
  }
  a.push("-c:v", "libx264", "-preset", o.preset ?? "medium", "-crf", String(o.crf ?? 18), "-pix_fmt", "yuv420p", "-r", String(o.fps));
  a.push("-t", dur, "-movflags", "+faststart", o.out);
  return a;
}

function startFfmpeg(args: string[]) {
  const ff: ChildProcess = spawn(process.env.TERA_FFMPEG ?? "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  ff.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const done = new Promise<void>((ok, fail) => {
    ff.on("error", (e) => fail(new Error(`tera: could not run ffmpeg: ${e.message}`)));
    ff.on("close", (code) => (code === 0 ? ok() : fail(new Error(`tera: ffmpeg exited ${code}:\n${stderr.trim()}`))));
  });
  done.catch(() => {});
  const write = (buf: Buffer) =>
    new Promise<void>((ok, fail) => {
      if (ff.exitCode !== null) return fail(new Error(`tera: ffmpeg exited early:\n${stderr.trim()}`));
      ff.stdin!.write(buf, (err) => (err ? fail(new Error(`tera: ffmpeg pipe: ${err.message}\n${stderr.trim()}`)) : ok()));
    });
  return { ff, done, write, end: () => ff.stdin!.end() };
}

export async function render(opts: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  const prep = prepareScript(opts.script, opts.worldDir);
  const script: CameraScript = { ...prep.script };
  if (opts.fps) script.fps = opts.fps;
  if (opts.width) script.width = opts.width;
  if (opts.height) script.height = opts.height;
  if (script.width % 2 || script.height % 2) throw new Error(`tera: size ${script.width}x${script.height} must be even for yuv420p`);
  const warnings = [...prep.warnings];
  warnings.forEach((w) => opts.onWarning?.(w));

  const fps = script.fps;
  const total = frameCount(script);
  const first = Math.max(0, Math.round((opts.from ?? 0) * fps));
  const end = Math.min(total, opts.to !== undefined ? Math.round(opts.to * fps) : total);
  if (end <= first) throw new Error(`tera: empty frame range (${first}..${end}) — check --from/--to`);
  const n = end - first;

  let audio: { path: string; shift: number } | undefined;
  if (script.audio && !opts.noAudio) {
    const path = resolveAudio(script.audio.src, prep.scriptDir, opts.worldDir)!;
    audio = { path, shift: (script.audio.offset ?? 0) - first / fps };
  }

  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  const workers = Math.max(1, Math.min(opts.workers ?? 1, n));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pages: TeraPage[] = [];
  const ff = startFfmpeg(ffmpegArgs({ fps, out: opts.out, crf: opts.crf, preset: opts.preset, frames: n, audio }));
  try {
    for (let w = 0; w < workers; w++) {
      const p = await openTera({ worldDir: opts.worldDir, width: script.width, height: script.height, renderer: opts.renderer, timeoutMs });
      await p.bridge.loadScript(script);
      pages.push(p);
    }

    // Each worker takes the next frame; frames go to ffmpeg strictly in order.
    const ready = new Map<number, Buffer>();
    let next = first, written = first, failed: Error | undefined;
    let wake: (() => void) | undefined;
    const tStart = performance.now();
    const shoot = async (p: TeraPage, f: number) => {
      try {
        await p.bridge.seek(f / fps);
        return await p.png();
      } catch (err) {
        throw new Error(`tera: frame ${f} (t=${(f / fps).toFixed(3)}s) failed: ${(err as Error).message}`);
      }
    };
    const worker = async (p: TeraPage) => {
      while (!failed && next < end) {
        // keep at most a few frames per worker buffered ahead of the writer
        while (!failed && next - written > workers * 4) await new Promise<void>((r) => setTimeout(r, 2));
        if (failed || next >= end) break;
        const f = next++;
        ready.set(f, await shoot(p, f));
        wake?.();
      }
    };
    const writer = async () => {
      while (written < end && !failed) {
        const buf = ready.get(written);
        if (!buf) {
          await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
          continue;
        }
        ready.delete(written);
        await ff.write(buf);
        written++;
        const done = written - first, el = (performance.now() - tStart) / 1000, rate = done / el;
        opts.onProgress?.({ frame: written - 1, done, total: n, fps: rate, etaS: (n - done) / rate });
      }
    };
    const ws = pages.map((p) => worker(p).catch((e: Error) => { failed ??= e; }));
    await Promise.all([...ws, writer().catch((e: Error) => { failed ??= e; })]);
    if (failed) throw failed;
    ff.end();
    await ff.done;
    const seconds = (performance.now() - t0) / 1000;
    return { out: resolve(opts.out), frames: n, fps, width: script.width, height: script.height, seconds, renderFps: n / ((performance.now() - tStart) / 1000), audio: audio?.path, warnings };
  } catch (err) {
    ff.ff.kill("SIGKILL");
    throw err;
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }
}

/** A one-pose script: lets snapshot use only seek(), so the frame is rendered the same way video is. */
export function poseScript(pose: CameraPose, width: number, height: number, worldId?: string): CameraScript {
  return { tera: "camera/v1", world: worldId, fps: 30, width, height, duration: 1, shots: [{ id: "still", start: 0, end: 1, kind: "keys", keys: [{ t: 0, ...pose }] }] };
}

/** Parse "x,y,z:tx,ty,tz[:fov]" or a camera name from world.cameras. */
export function parseCamera(spec: string | undefined, world: WorldPack): CameraPose {
  const name = spec ?? "default";
  if (world.cameras?.[name]) return world.cameras[name]!;
  const m = name.split(":");
  const v = (s: string | undefined) => {
    const a = (s ?? "").split(",").map(Number);
    if (a.length !== 3 || a.some((x) => !Number.isFinite(x))) throw new Error(`tera: bad camera "${spec}" — use a camera name or x,y,z:tx,ty,tz[:fov]`);
    return a as [number, number, number];
  };
  if (m.length < 2) {
    if (spec === undefined) return { position: [8, 5, 10], target: [0, 1, 0], fov: 45 };
    throw new Error(`tera: no camera "${name}" in world.cameras (have: ${Object.keys(world.cameras ?? {}).join(", ") || "none"})`);
  }
  return { position: v(m[0]), target: v(m[1]), fov: m[2] ? Number(m[2]) : 45 };
}

/**
 * PNG of the CURRENT world state (including applied ops) from a pose, on an open page.
 * Rebases the page on bridge.get() so ops survive, then renders via seek(0).
 */
/** A still of the current world (incl. applied ops) from `pose`, via bridge.render. */
export async function snapshotPage(p: TeraPage, pose: CameraPose, width: number, height: number): Promise<Buffer> {
  await p.bridge.render(pose, width, height);
  return p.png();
}
