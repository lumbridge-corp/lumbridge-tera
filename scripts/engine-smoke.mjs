#!/usr/bin/env node
// Engine smoke test: build the page, open it in headless Chrome with GPU flags, load
// each world on each renderer, seek a few times, save PNGs to out/ and fail when a frame
// is blank or a seek throws.
//
//   node scripts/engine-smoke.mjs [--no-build] [--worlds demo,showcase] [--renderers webgpu,webgl2] [--times 0,6] [--headed]
//
// GPU flags (Linux + AMD/Mesa, Chrome 155): Vulkan ANGLE for WebGL and Vulkan Dawn for
// WebGPU. Without them headless Chrome falls back to SwiftShader (slow, no WebGPU HW).
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const worlds = opt("worlds", "demo,showcase").split(",");
const renderers = opt("renderers", "webgpu,webgl2").split(",");
const times = opt("times", "0,6").split(",").map(Number);
const port = Number(opt("port", "0")); // 0 = any free port

export const GPU_FLAGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--ignore-gpu-blocklist",
];

if (!args.includes("--no-build")) execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream", ".spz": "application/octet-stream", ".ply": "application/octet-stream", ".bin": "application/octet-stream",
};

// dist/ at /, the repo's worlds/ at /worlds/.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const candidates = path.startsWith("/worlds/") ? [join(root, normalize(path))] : [join(root, "dist", normalize(path === "/" ? "/index.html" : path))];
  for (const file of candidates) {
    if (!file.startsWith(root)) break;
    try {
      if (!(await stat(file)).isFile()) continue;
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
      return;
    } catch {}
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome", headless: !args.includes("--headed"), args: GPU_FLAGS });
await mkdir(join(root, "out"), { recursive: true });
let failed = 0;

for (const renderer of renderers) {
  for (const world of worlds) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const verbose = args.includes("--verbose");
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
      else if (verbose) console.log(`  console.${m.type()}: ${m.text()}`);
    });
    page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`${r.status()} ${r.url()}`); });
    const tag = `${world}-${renderer}`;
    try {
      await page.goto(`${base}/?mode=render&renderer=${renderer}`);
      await page.waitForFunction(() => !!window.tera);
      const worldUrl = `${base}/worlds/${world}/world.json`;
      // intro.camera.json, else the first *.camera.json in the world folder.
      const scriptName = (await readdir(join(root, "worlds", world))).filter((f) => f.endsWith(".camera.json")).sort((x, y) => (x === "intro.camera.json" ? -1 : y === "intro.camera.json" ? 1 : x.localeCompare(y)))[0];
      const scriptJson = JSON.parse(await readFile(join(root, "worlds", world, scriptName ?? "intro.camera.json"), "utf8"));
      const worldJson = JSON.parse(await readFile(join(root, "worlds", world, "world.json"), "utf8"));
      const t0 = Date.now();
      const loaded = await page.evaluate(([w, u]) => window.tera.load(w, u), [worldJson, worldUrl]);
      const s = await page.evaluate((sc) => window.tera.loadScript(sc), scriptJson);
      const info = await page.evaluate(() => window.tera.info());
      console.log(`${tag}: loaded in ${Date.now() - t0} ms on ${info.renderer}, ${info.entities} entities`);
      for (const w of [...loaded.warnings, ...s.warnings]) console.log(`  warning: ${w}`);
      for (const t of times) {
        const ts = Date.now();
        await page.evaluate((tt) => window.tera.seek(tt), t);
        const seekMs = Date.now() - ts;
        const b64 = await page.evaluate(() => window.tera.capture());
        const file = join(root, "out", `${tag}-t${t}.png`);
        await writeFile(file, Buffer.from(b64, "base64"));
        // Pixel stats in the page (no PNG decoder needed in Node).
        const st = await page.evaluate(async (data) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          const px = g.getImageData(0, 0, c.width, c.height).data;
          let sum = 0, sum2 = 0, n = 0;
          const colours = new Set();
          for (let i = 0; i < px.length; i += 4 * 7) {
            const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            sum += l; sum2 += l * l; n++;
            if (colours.size < 5000) colours.add((px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3));
          }
          const mean = sum / n;
          return { w: c.width, h: c.height, mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), colours: colours.size };
        }, b64);
        const blank = st.std < 4 || st.colours < 24;
        console.log(`  t=${t}: seek ${seekMs} ms, ${st.w}x${st.h}, mean ${st.mean.toFixed(1)} std ${st.std.toFixed(1)} colours ${st.colours}${blank ? "  BLANK" : ""} -> out/${tag}-t${t}.png`);
        if (blank) failed++;
      }
      // Determinism: seeking back must reproduce the first frame exactly.
      await page.evaluate((tt) => window.tera.seek(tt), times[times.length - 1]);
      await page.evaluate((tt) => window.tera.seek(tt), times[0]);
      const again = await page.evaluate(() => window.tera.capture());
      const first = await readFile(join(root, "out", `${tag}-t${times[0]}.png`));
      const same = Buffer.from(again, "base64").equals(first);
      console.log(`  seek back to t=${times[0]}: ${same ? "identical" : "DIFFERENT"}`);
      if (!same) failed++;
      // Other sky modes, through ops: an HDRI when the world ships one, then a flat colour.
      const hdr = (await readdir(join(root, "worlds", world, "assets")).catch(() => [])).find((f) => f.endsWith(".hdr"));
      const skies = [...(hdr ? [["hdri", { mode: "hdri", src: `assets/${hdr}` }]] : []), ["color", { mode: "color", color: "#1d2433" }]];
      for (const [name, sky] of skies) {
        const r = await page.evaluate((sk) => window.tera.apply([{ op: "sky", set: sk }]), sky);
        if (!r.ok) { console.log(`  sky ${name}: ${r.error}`); failed++; continue; }
        await page.evaluate((tt) => window.tera.seek(tt), times[times.length - 1]);
        const b = Buffer.from(await page.evaluate(() => window.tera.capture()), "base64");
        await writeFile(join(root, "out", `${tag}-sky-${name}.png`), b);
        console.log(`  sky ${name}: ${b.length} bytes -> out/${tag}-sky-${name}.png`);
      }
      // render(): the edited world now, no script; bounds() for every entity; post effects.
      await page.evaluate(() => window.tera.apply([{ op: "add", entity: { id: "smoke-cone", kind: "primitive", shape: "cone", size: [0.4, 1], transform: { position: [0, 0.5, 3] } } }]));
      const cam = worldJson.cameras?.default ?? { position: [6, 4, 8], target: [0, 1, 0] };
      await page.evaluate((c) => window.tera.render(c, 640, 360), cam);
      const r1 = Buffer.from(await page.evaluate(() => window.tera.capture()), "base64");
      await writeFile(join(root, "out", `${tag}-render.png`), r1);
      const boxes = await page.evaluate(() => window.tera.bounds());
      const cone = boxes["smoke-cone"];
      const coneOk = cone && Math.abs(cone.max[1] - 1) < 1e-3 && Math.abs(cone.min[0] + 0.4) < 1e-3;
      console.log(`  render(): ${r1.length} bytes; bounds() ${Object.keys(boxes).length} entities, cone ${coneOk ? "ok" : "WRONG " + JSON.stringify(cone)}`);
      if (!coneOk) failed++;
      await page.evaluate(() => window.tera.apply([{ op: "env", set: { post: { ao: true, bloom: { strength: 0.6, threshold: 0.9 }, dof: { focus: 10, aperture: 0.01 } } } }]));
      await page.evaluate(() => window.tera.render());
      const p1 = Buffer.from(await page.evaluate(() => window.tera.capture()), "base64");
      await page.evaluate(() => window.tera.render());
      const p2 = Buffer.from(await page.evaluate(() => window.tera.capture()), "base64");
      await writeFile(join(root, "out", `${tag}-post.png`), p1);
      console.log(`  post ao+bloom+dof: ${p1.equals(p2) ? "deterministic" : "NOT DETERMINISTIC"} -> out/${tag}-post.png`);
      if (!p1.equals(p2) || p1.equals(r1)) failed++;
    } catch (err) {
      console.log(`${tag}: FAILED ${err.message}`);
      failed++;
    }
    for (const e of errors) if (!/status of 404/.test(e) || verbose) console.log(`  page error: ${e}`);
    await page.close();
  }
}

await browser.close();
server.close();
if (failed) {
  console.log(`\n${failed} problem(s)`);
  process.exit(1);
}
console.log("\nall frames rendered");
