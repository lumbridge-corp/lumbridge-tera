#!/usr/bin/env node
// tera — render, snapshot, serve and validate Tera worlds. CONTRACT.md section 5.
// Runs on Node >= 22.18 with built-in type stripping: `node bin/tera.ts render ...`.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureBuilt, openTera, startStaticServer } from "../src/render/host.ts";
import { loadWorld, parseCamera, poseScript, prepareScript, readJson, render, resolveAudio } from "../src/render/render.ts";
import { validate } from "../src/camera/validate.ts";
import { renderClip, videoLayer, writeComposition } from "../src/render/hyperframes.ts";

const USAGE = `tera — Lumbridge Tera CLI

  tera render <world-dir> <script.json> -o out.mp4 [--fps N] [--size WxH] [--from s] [--to s]
              [--renderer auto|webgpu|webgl2] [--workers N] [--crf 18] [--preset medium]
              [--timeout 30] [--no-audio] [--labels fit]
  tera snapshot <world-dir> [--camera name|x,y,z:tx,ty,tz[:fov]] [--t s --script script.json]
              [--size WxH] [--renderer ...] [--labels fit] -o shot.png
  tera serve <world-dir> [--port 8790] [--host 127.0.0.1]
  tera validate <script.json> [--world <world-dir>]
  tera clip <world-dir> <script.json> [--cache dir] [--size WxH] [--fps N] [--audio] [--force]
              [--composition dir [--title text]]   # cached MP4 + <video> layer for HyperFrames
`;

function die(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

function size(s: string | undefined): { width?: number; height?: number } {
  if (!s) return {};
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) die(`tera: --size must look like 1920x1080, got "${s}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const num = (s: string | undefined, name: string) => {
  if (s === undefined) return undefined;
  const v = Number(s);
  if (!Number.isFinite(v)) die(`tera: --${name} must be a number, got "${s}"`);
  return v;
};

const renderer = (s: string | undefined) => {
  if (s && !["auto", "webgpu", "webgl2"].includes(s)) die(`tera: --renderer must be auto, webgpu or webgl2`);
  return s as "auto" | "webgpu" | "webgl2" | undefined;
};

const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(0)}s`);

async function cmdRender(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" }, fps: { type: "string" }, size: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      renderer: { type: "string" }, workers: { type: "string" }, crf: { type: "string" }, preset: { type: "string" }, timeout: { type: "string" },
      "no-audio": { type: "boolean" }, labels: { type: "string" },
    },
  });
  if (p.length !== 2 || !v.out) die(USAGE);
  if (v.labels !== undefined && v.labels !== "fit") die(`tera: --labels must be "fit"`);
  const tty = process.stderr.isTTY;
  let lastPct = -1;
  const r = await render({
    worldDir: p[0]!, script: p[1]!, out: v.out!, fps: num(v.fps, "fps"), ...size(v.size),
    from: num(v.from, "from"), to: num(v.to, "to"), renderer: renderer(v.renderer), workers: num(v.workers, "workers"),
    crf: num(v.crf, "crf"), preset: v.preset, timeoutMs: (num(v.timeout, "timeout") ?? 30) * 1000, noAudio: v["no-audio"], labels: v.labels === "fit" ? "fit" : undefined,
    onWarning: (w) => process.stderr.write(`warning: ${w}\n`),
    onProgress: ({ done, total, fps, etaS }) => {
      const pct = Math.floor((done / total) * 100);
      const line = `frame ${done}/${total}  ${pct}%  ${fps.toFixed(1)} fps  eta ${fmtTime(etaS)}`;
      if (tty) process.stderr.write(`\r${line}   `);
      else if (pct >= lastPct + 10 || done === total) { lastPct = pct; process.stderr.write(line + "\n"); }
    },
  });
  if (tty) process.stderr.write("\n");
  process.stderr.write(`wrote ${r.out}  ${r.frames} frames ${r.width}x${r.height} @ ${r.fps} fps${r.audio ? " + audio" : ""}  in ${r.seconds.toFixed(1)}s (${r.renderFps.toFixed(1)} frames/s)\n`);
  process.stdout.write(JSON.stringify({ out: r.out, frames: r.frames, fps: r.fps, width: r.width, height: r.height, seconds: +r.seconds.toFixed(2), renderFps: +r.renderFps.toFixed(2) }) + "\n");
}

async function cmdSnapshot(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" }, camera: { type: "string" }, t: { type: "string" }, script: { type: "string" }, size: { type: "string" }, renderer: { type: "string" }, timeout: { type: "string" }, labels: { type: "string" } },
  });
  if (p.length !== 1 || !v.out) die(USAGE);
  if (v.labels !== undefined && v.labels !== "fit") die(`tera: --labels must be "fit"`);
  const worldDir = p[0]!;
  const world = loadWorld(worldDir);
  let script, t = 0;
  if (v.script) {
    const prep = prepareScript(v.script, worldDir, world);
    prep.warnings.forEach((w) => process.stderr.write(`warning: ${w}\n`));
    script = prep.script;
    t = num(v.t, "t") ?? 0;
    if (v.camera) die("tera: use --camera or --script, not both");
  } else {
    if (v.t) die("tera: --t needs --script");
    script = poseScript(parseCamera(v.camera, world), 1280, 720, world.id);
  }
  const sz = size(v.size);
  script = { ...script, width: sz.width ?? (v.script ? script.width : 1280), height: sz.height ?? (v.script ? script.height : 720) };
  const page = await openTera({ worldDir, width: script.width, height: script.height, renderer: renderer(v.renderer), timeoutMs: (num(v.timeout, "timeout") ?? 30) * 1000, labels: v.labels === "fit" ? "fit" : undefined });
  try {
    await page.bridge.loadScript(script);
    await page.bridge.seek(t);
    mkdirSync(dirname(resolve(v.out!)), { recursive: true });
    writeFileSync(v.out!, await page.png());
    process.stderr.write(`wrote ${resolve(v.out!)}  ${script.width}x${script.height}  t=${t}\n`);
  } finally {
    await page.close();
  }
}

async function cmdServe(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: "string" }, host: { type: "string" } } });
  if (p.length !== 1) die(USAGE);
  if (!existsSync(resolve(p[0]!, "world.json"))) die(`tera: no world.json in ${p[0]}`);
  ensureBuilt();
  const { origin } = await startStaticServer(p[0]!, num(v.port, "port") ?? 8790, v.host ?? "127.0.0.1");
  process.stderr.write(`serving ${resolve(p[0]!)}\n  ${origin.replace("127.0.0.1", "localhost")}/?world=/world/world.json\n`);
}

function cmdValidate(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({ args: argv, allowPositionals: true, options: { world: { type: "string" } } });
  if (p.length !== 1) die(USAGE);
  const scriptDir = dirname(resolve(p[0]!));
  const world = v.world ? loadWorld(v.world) : undefined;
  const r = validate(readJson(p[0]!), world, { fileExists: (src) => !!resolveAudio(src, scriptDir, v.world ?? scriptDir) });
  for (const e of r.errors) process.stdout.write(`error: ${e}\n`);
  for (const w of r.warnings) process.stdout.write(`warning: ${w}\n`);
  process.stdout.write(r.ok ? `ok: ${r.frames} frames\n` : `invalid: ${r.errors.length} error(s)\n`);
  process.exit(r.ok ? 0 : 1);
}

async function cmdClip(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cache: { type: "string" }, size: { type: "string" }, fps: { type: "string" }, renderer: { type: "string" }, audio: { type: "boolean" },
      force: { type: "boolean" }, workers: { type: "string" }, composition: { type: "string" }, title: { type: "string" },
    },
  });
  if (p.length !== 2) die(USAGE);
  const clip = await renderClip({
    worldDir: p[0]!, script: p[1]!, cacheDir: v.cache, ...size(v.size), fps: num(v.fps, "fps"), renderer: renderer(v.renderer),
    audio: v.audio, force: v.force, workers: num(v.workers, "workers"),
    onWarning: (w) => process.stderr.write(`warning: ${w}\n`),
    onProgress: ({ done, total, fps }) => { if (done === total || done % 30 === 0) process.stderr.write(`frame ${done}/${total}  ${fps.toFixed(1)} fps\n`); },
  });
  process.stderr.write(`${clip.cached ? "cached" : "rendered"} ${clip.file}\n`);
  const composition = v.composition ? writeComposition(clip, v.composition, { title: v.title }) : undefined;
  if (composition) process.stderr.write(`composition ${composition}\n  npx hyperframes@0.8.20 render ${resolve(v.composition!)} -o out.mp4\n`);
  process.stdout.write(JSON.stringify({ ...clip, layer: videoLayer(clip, { src: clip.file }), composition }, null, 2) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds: Record<string, (a: string[]) => unknown> = { render: cmdRender, snapshot: cmdSnapshot, serve: cmdServe, validate: cmdValidate, clip: cmdClip };
if (!cmd || !cmds[cmd]) die(USAGE, cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
try {
  await cmds[cmd]!(rest);
} catch (err) {
  die((err as Error).message);
}
