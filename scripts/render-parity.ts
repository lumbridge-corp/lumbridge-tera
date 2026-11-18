// Render-mode parity: the engine page of THIS checkout and of a base ref (default origin/main)
// must draw byte-identical frames in `?mode=render`. Live-mode viewer work (loading screen,
// HUD, presets, labels, adaptive quality) must never leak into render mode.
//
//   node scripts/render-parity.ts [--base origin/main] [--worlds demo,showcase,living] [--renderers webgl2,webgpu] [--times 0,3,6] [--no-build]
//
// The base ref is exported with `git archive` into a temp folder (no checkout, the working tree
// is not touched), built with this checkout's node_modules, and both builds are served side by
// side with this checkout's worlds/. For every world × renderer × time: seek, capture, sha256.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { chromeArgs } from "../src/render/host.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const baseRef = opt("base", "origin/main");
const worlds = opt("worlds", "demo,showcase,living").split(",");
const renderers = opt("renderers", "webgl2,webgpu").split(",");
const times = opt("times", "0,3,6").split(",").map(Number);
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

const tmp = mkdtempSync(join(tmpdir(), "tera-parity-"));
try {
  // 1. Builds: this checkout → dist/, the base ref → <tmp>/base/dist.
  if (!args.includes("--no-build")) execFileSync(process.execPath, [vite, "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });
  const baseDir = join(tmp, "base");
  execFileSync("sh", ["-c", `mkdir -p "${baseDir}" && git -C "${root}" archive "${baseRef}" | tar -x -C "${baseDir}"`], { stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(baseDir, "node_modules"));
  execFileSync(process.execPath, [vite, "build", "--logLevel", "warn"], { cwd: baseDir, stdio: "inherit" });
  const baseSha = execFileSync("git", ["-C", root, "rev-parse", "--short", baseRef]).toString().trim();
  const headSha = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"]).toString().trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]).toString().trim() ? "+dirty" : "";
  console.log(`render parity: ${baseRef} (${baseSha}) vs HEAD (${headSha}${dirty})`);

  // 2. One static server per build; /worlds/ always from this checkout.
  const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary" };
  const serve = (dist: string) =>
    new Promise<{ server: http.Server; origin: string }>((ok) => {
      const server = http.createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
        const file = path.startsWith("/worlds/") ? join(root, normalize(path)) : join(dist, normalize(path === "/" ? "/index.html" : path));
        if ((file.startsWith(root) || file.startsWith(dist)) && existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          res.end(readFileSync(file));
        } else res.writeHead(404).end("not found");
      });
      server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
  const builds = { base: await serve(join(baseDir, "dist")), head: await serve(join(root, "dist")) };

  const browser: Browser = await chromium.launch({ channel: "chrome", headless: true, args: chromeArgs() });
  let failed = 0;
  const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);

  async function frames(origin: string, world: string, renderer: string): Promise<string[]> {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?mode=render&renderer=${renderer}`);
      await page.waitForFunction(() => !!window.tera);
      const dir = join(root, "worlds", world);
      const scriptName = readdirSync(dir).filter((f) => f.endsWith(".camera.json")).sort((x, y) => (x === "intro.camera.json" ? -1 : y === "intro.camera.json" ? 1 : x.localeCompare(y)))[0];
      const w = JSON.parse(readFileSync(join(dir, "world.json"), "utf8"));
      const s = JSON.parse(readFileSync(join(dir, scriptName ?? "intro.camera.json"), "utf8"));
      s.width = 640; s.height = 360; // small frames keep the run fast on a shared GPU
      await page.evaluate(([ww, u]) => window.tera.load(ww, u), [w, `${origin}/worlds/${world}/world.json`] as const);
      await page.evaluate((sc) => window.tera.loadScript(sc), s);
      const out: string[] = [];
      for (const t of times) {
        await page.evaluate((tt) => window.tera.seek(tt), t);
        out.push(sha(await page.evaluate(() => window.tera.capture())));
      }
      // render(): the edited world from the default camera, through bloom + DOF (not AO: its
      // noise kernel is random per page, so AO frames only repeat within one page).
      await page.evaluate(() => window.tera.apply([{ op: "env", set: { post: { bloom: { strength: 0.5 }, dof: { mode: "tiltshift" } } } }]));
      await page.evaluate((c) => window.tera.render(c, 640, 360), w.cameras?.default ?? { position: [6, 4, 8], target: [0, 1, 0] });
      out.push(sha(await page.evaluate(() => window.tera.capture())));
      return out;
    } finally {
      await page.close();
    }
  }

  for (const renderer of renderers) for (const world of worlds) {
    try {
      const a = await frames(builds.base.origin, world, renderer);
      const b = await frames(builds.head.origin, world, renderer);
      const labels = [...times.map((t) => `t=${t}`), "render+post"];
      const bad = labels.filter((_, i) => a[i] !== b[i]);
      console.log(`${world}-${renderer}: ${bad.length ? "DIFFERENT " + bad.join(", ") : "identical"}  ${labels.map((l, i) => `${l} ${b[i]}`).join("  ")}`);
      if (bad.length) failed++;
    } catch (err) {
      console.log(`${world}-${renderer}: FAILED ${(err as Error).message}`);
      failed++;
    }
  }
  await browser.close();
  builds.base.server.close();
  builds.head.server.close();
  if (failed) {
    console.log(`\n${failed} world/renderer pair(s) differ from ${baseRef}`);
    process.exitCode = 1;
  } else console.log(`\nrender mode is pixel-identical to ${baseRef}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
