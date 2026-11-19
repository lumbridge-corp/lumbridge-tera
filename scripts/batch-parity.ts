// Batch parity: static batching + pooled flows (batch.ts, live mode) must draw the same picture
// as one mesh per entity. Renders every camera of each world in render mode twice, `?batch=0`
// and `?batch=1` (same build, same fixed sky time, AO off: its noise is random per page), and
// compares the pixels.
//
//   node scripts/batch-parity.ts [--worlds demo,showcase,living] [--world <dir>/<file>.json ...]
//       [--renderers webgl2,webgpu] [--size 960x540] [--max-share 0.005] [--cameras a,b] [--out <dir>] [--no-build]
//
// Not byte-identical, by design: a batch holds its vertices already in world space (baked on the
// CPU in float64, stored as float32) where the unbatched mesh has the GPU multiply its model-view
// matrix in float32. Vertices land a fraction of a float32 step apart, so here and there an
// antialiased edge pixel takes the neighbour's coverage (scattered single pixels along edges,
// nothing that reads as a change). --max-share is the budget: the share of a frame's pixels that
// may differ at all (default 0.5 %; bloom spreads an edge pixel into a faint 1-step halo). Render mode never batches, so `npm run parity:render` stays
// byte-identical.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const many = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const extra = many("world").map((f) => resolve(f));
const worlds = [...(extra.length && !args.includes("--worlds") ? [] : opt("worlds", "demo,showcase,living").split(",").filter(Boolean).map((w) => join(REPO_ROOT, "worlds", w, "world.json"))), ...extra];
const renderers = opt("renderers", "webgl2,webgpu").split(",");
const [W, H] = opt("size", "960x540").split("x").map(Number) as [number, number];
const maxShare = Number(opt("max-share", "0.005"));
const cameraFilter = opt("cameras", "");
const outDir = opt("out", ""); // keep the frames of differing cameras (off/on PNGs) here

if (!args.includes("--no-build")) ensureBuilt();
// one server for every world: the common folder of all world files at /world/
const common = worlds.map(dirname).reduce((a, b) => {
  while (!b.startsWith(a)) a = dirname(a);
  return a;
});
const { server, origin } = await startStaticServer(common);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: chromeArgs() });

async function frames(file: string, renderer: string, batch: 0 | 1): Promise<{ names: string[]; png: string[] }> {
  const page = await browser.newPage();
  try {
    page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
    await page.goto(`${origin}/?mode=render&renderer=${renderer}&batch=${batch}`);
    await page.waitForFunction(() => !!window.tera);
    const w = JSON.parse(readFileSync(file, "utf8"));
    if (w.sky?.mode === "real") w.sky.time = "2026-06-21T18:00:00Z"; // the same sky on both pages
    if (w.environment?.post?.ao) delete w.environment.post.ao; // AO noise is random per page
    const url = `${origin}/world/${relative(common, file)}`;
    await page.evaluate(([ww, u]) => window.tera.load(ww, u), [w, url] as const);
    const cams = Object.entries((w.cameras ?? {}) as Record<string, { position: number[]; target: number[]; fov?: number }>)
      .filter(([k]) => !cameraFilter || cameraFilter.split(",").includes(k));
    if (!cams.length) cams.push(["default", { position: [6, 4, 8], target: [0, 1, 0] }]);
    const png: string[] = [];
    for (const [, pose] of cams) {
      await page.evaluate(([p, ww, hh]) => window.tera.render(p as never, ww as number, hh as number), [pose, W, H] as const);
      png.push(await page.evaluate(() => window.tera.capture()));
    }
    return { names: cams.map(([k]) => k), png };
  } finally {
    await page.close();
  }
}

/** Pixel difference of two PNGs (decoded in a page). */
async function diff(page: Page, a: string, b: string): Promise<{ pixels: number; max: number }> {
  return page.evaluate(async ([pa, pb]) => {
    const load = async (b64: string) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const [x, y] = await Promise.all([load(pa), load(pb)]);
    let pixels = 0, max = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!));
      if (d) pixels++;
      if (d > max) max = d;
    }
    return { pixels, max };
  }, [a, b] as const);
}

const differ = await browser.newPage();
let failed = 0;
for (const renderer of renderers) for (const file of worlds) {
  const name = relative(common, file);
  try {
    const off = await frames(file, renderer, 0);
    const on = await frames(file, renderer, 1);
    const parts: string[] = [];
    let bad = false;
    for (let i = 0; i < off.png.length; i++) {
      const d = await diff(differ, off.png[i]!, on.png[i]!);
      if (d.pixels > maxShare * W * H) bad = true;
      if (outDir && d.pixels) {
        mkdirSync(outDir, { recursive: true });
        const stem = join(outDir, `${name.replace(/[^a-z0-9]+/gi, "-")}-${renderer}-${off.names[i]}`);
        writeFileSync(`${stem}-off.png`, Buffer.from(off.png[i]!, "base64"));
        writeFileSync(`${stem}-on.png`, Buffer.from(on.png[i]!, "base64"));
      }
      parts.push(`${off.names[i]} ${d.pixels ? `${d.pixels} px (${((100 * d.pixels) / (W * H)).toFixed(3)} %, ≤${d.max})` : "identical"}`);
    }
    if (bad) failed++;
    console.log(`${name} ${renderer}: ${bad ? "DIFFERENT" : "ok"}  ${parts.join("  ")}`);
  } catch (err) {
    failed++;
    console.log(`${name} ${renderer}: FAILED ${(err as Error).message}`);
  }
}
await browser.close();
server.close();
if (failed) {
  console.log(`\n${failed} world/renderer pair(s) over the batch parity budget (${100 * maxShare} % of the pixels)`);
  process.exitCode = 1;
} else console.log(`\nbatched frames match unbatched ones (≤ ${100 * maxShare} % of the pixels, edge pixels only)`);
