// Real-sky smoke test (headless Chrome, worlds/night): render-mode determinism on both renderers,
// day/night state (bridge info().sky, tera:sky, night lights), satellites, the live HUD time
// control, and live performance with the full star catalogue plus thousands of satellites.
//   node scripts/sky-smoke.ts [--no-build] [--sats 6000] [--renderers webgpu,webgl2] [--min-fps 55]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1]! : d);
const nSats = Number(opt("sats", "6000"));
const minFps = Number(opt("min-fps", "55"));
const renderers = opt("renderers", "webgpu,webgl2").split(",");
if (!args.includes("--no-build")) ensureBuilt(true);

// A copy of the night world with a synthetic constellation of nSats objects: the sample's
// element sets spread over planes and phases (deterministic), so the test needs no network.
const dir = mkdtempSync(join(tmpdir(), "tera-sky-"));
cpSync(join(REPO_ROOT, "worlds", "night"), dir, { recursive: true });
const sample = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "fixtures", "starlink-sample.omm.json"), "utf8")) as Record<string, unknown>[];
const big: Record<string, unknown>[] = [];
for (let i = 0; i < nSats; i++) {
  const o = sample[1 + (i % (sample.length - 1))]!;
  big.push({ ...o, NORAD_CAT_ID: 90000 + i, OBJECT_NAME: `STARLINK-T${i}`, RA_OF_ASC_NODE: ((o.RA_OF_ASC_NODE as number) + i * 7.31) % 360, MEAN_ANOMALY: ((o.MEAN_ANOMALY as number) + i * 13.7) % 360 });
}
mkdirSync(join(dir, "assets"), { recursive: true });
writeFileSync(join(dir, "assets", "perf.omm.json"), JSON.stringify(big));
const world = JSON.parse(readFileSync(join(dir, "world.json"), "utf8"));
world.sky = { ...world.sky, time: "2026-11-28T18:15:40-08:00", satellites: { src: "assets/perf.omm.json", visibleOnly: false } };
writeFileSync(join(dir, "perf.json"), JSON.stringify(world));

const { server, origin } = await startStaticServer(dir);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: chromeArgs() });
let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}
const sha = (b64: string) => createHash("sha256").update(b64).digest("hex").slice(0, 16);

async function renderPage(renderer: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await p.goto(`${origin}/?mode=render&renderer=${renderer}`);
  await p.waitForFunction(() => !!window.tera);
  return p;
}

for (const renderer of renderers) {
  await step(`${renderer}: day/night state, night lights, satellites, deterministic frames`, async () => {
    const p = await renderPage(renderer);
    const w = JSON.parse(readFileSync(join(dir, "world.json"), "utf8"));
    const events: unknown[] = [];
    await p.exposeFunction("onSky", (d: unknown) => events.push(d));
    await p.evaluate(() => addEventListener("tera:sky", (e) => (window as any).onSky((e as CustomEvent).detail)));
    const load = (time: string) => p.evaluate(([ww, u]) => window.tera!.load(ww, u), [{ ...w, sky: { ...w.sky, time } }, `${origin}/world/world.json`] as const);
    const shot = async () => {
      await p.evaluate(() => window.tera!.render(undefined, 960, 540));
      return p.evaluate(() => window.tera!.capture());
    };
    // noon: day, lamps off
    let r = await load("2026-11-18T12:00:00-08:00");
    assert.deepEqual(r.warnings, []);
    const day = await shot();
    let info = await p.evaluate(() => window.tera!.info());
    assert.equal(info.sky?.mode, "real");
    assert.equal(info.sky?.nightness, 0);
    assert.ok((info.sky?.sunElevation ?? 0) > 25);
    const lampDay = await p.evaluate(() => { let v = -1; (window as any).teraEngine.scene.getObjectByName("lamp-0-light").traverse((o: any) => { if (o.isLight) v = o.intensity; }); return v; });
    assert.equal(lampDay, 0, "night: true light is off at noon");
    // the ISS pass: night, lamps on, satellites drawn
    r = await load("2026-11-28T18:15:40-08:00");
    const night = await shot();
    info = await p.evaluate(() => window.tera!.info());
    assert.equal(info.sky?.nightness, 1);
    assert.equal(info.sky?.isNight, true);
    assert.ok((info.sky?.satellites ?? 0) > 0, `satellites drawn: ${info.sky?.satellites}`);
    const lampNight = await p.evaluate(() => { let v = -1; (window as any).teraEngine.scene.getObjectByName("lamp-0-light").traverse((o: any) => { if (o.isLight) v = o.intensity; }); return v; });
    assert.equal(lampNight, 10, "night: true light is on at night");
    const glow = await p.evaluate(() => { const m = (window as any).teraEngine.scene.getObjectByName("lamp-0-head").material; return m.emissive.r + m.emissive.g + m.emissive.b; });
    assert.ok(glow > 5, `material.night emissive at night (${glow})`);
    assert.ok(events.some((e: any) => e.isNight === true) && events.some((e: any) => e.isNight === false), "tera:sky fired for day and night");
    assert.notEqual(sha(day), sha(night));
    // determinism: same time → same pixels; a script second later moves the satellites only
    const again = await shot();
    assert.equal(sha(again), sha(night), "same frame twice");
    await p.evaluate((s) => window.tera!.loadScript(s), { tera: "camera/v1", fps: 30, width: 960, height: 540, duration: 4, shots: [{ id: "a", start: 0, end: 4, kind: "keys", keys: [{ t: 0, ...w.cameras.iss }, { t: 4, ...w.cameras.iss }] }], events: [{ t: 1, ops: [{ op: "sky", set: { time: "2026-11-28T20:15:40-08:00" }, duration: 2, ease: "linear" }] }] });
    await p.evaluate(() => window.tera!.seek(2));
    const s2 = await p.evaluate(() => window.tera!.capture());
    const mid = await p.evaluate(() => window.tera!.info());
    await p.evaluate(() => window.tera!.seek(0.5));
    await p.evaluate(() => window.tera!.seek(2));
    assert.equal(sha(await p.evaluate(() => window.tera!.capture())), sha(s2), "seek is exact");
    // halfway through the eased op: ~1 h later (+ 2 s of script time)
    const t = Date.parse(mid.sky!.time!);
    assert.ok(Math.abs(t - Date.parse("2026-11-29T03:15:42Z")) < 2000, `sky time halfway ${mid.sky!.time}`);
    writeFileSync(join(REPO_ROOT, "out", `sky-${renderer}-night.png`), Buffer.from(night, "base64"));
    await p.context().close();
  });
}

await step("live: HUD time control, scrub, Now, ?time= / ?timeScale=", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await p.goto(`${origin}/?world=/world/world.json&quality=medium&time=2026-11-18T17:22:00-08:00&timeScale=60`);
  await p.waitForFunction(() => (window as any).teraViewer?.state().firstLoaded, undefined, { timeout: 90_000 });
  await p.waitForSelector(".tv-time:not([hidden])");
  const clock = await p.textContent(".tv-time-clock");
  assert.match(clock ?? "", /^17:2\d$/, `local time shown: ${clock}`);
  assert.match((await p.textContent(".tv-time-date")) ?? "", /×60/);
  const t0 = (await p.evaluate(() => (window as any).teraEngine.skyClockState())).ms;
  await p.waitForTimeout(1000);
  const t1 = (await p.evaluate(() => (window as any).teraEngine.skyClockState())).ms;
  assert.ok(t1 - t0 > 30_000 && t1 - t0 < 120_000, `timeScale 60 runs ~60 s per s (${(t1 - t0) / 1000})`);
  // scrub to 03:00 local
  await p.locator(".tv-time-range").fill("180");
  await p.waitForTimeout(300);
  assert.match((await p.textContent(".tv-time-clock")) ?? "", /^03:0\d$/);
  await p.click(".tv-time-now");
  await p.waitForTimeout(600);
  const st = await p.evaluate(() => (window as any).teraEngine.skyClockState());
  assert.ok(Math.abs(st.ms - Date.now()) < 5000 && st.rate === 1 && st.following);
  assert.equal(await p.getAttribute(".tv-time-now", "aria-pressed"), "true");
  await p.screenshot({ path: join(REPO_ROOT, "out", "sky-live-hud.png") });
  await ctx.close();
});

await step(`live performance: 9 096 stars + ${nSats} satellites ≥ ${minFps} fps (1280x720)`, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  await p.goto(`${origin}/?world=/world/perf.json&quality=high&ui=0`);
  await p.waitForFunction(() => (window as any).teraEngine?.info().ready && (window as any).teraEngine.skyInfo().satellites > 0, undefined, { timeout: 120_000 });
  await p.evaluate(() => { const e = (window as any).teraEngine; const c = e.base.cameras.up; e.setPose(c); });
  await p.waitForTimeout(1500); // warm-up: shader compiles, first keyframes, Milky Way slices
  const res = await p.evaluate(() => new Promise<{ fps: number; sats: number; p95: number }>((resolve) => {
    const dts: number[] = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      dts.push(now - last);
      last = now;
      if (now - t0 < 4000) requestAnimationFrame(tick);
      else {
        dts.sort((a, b) => a - b);
        resolve({ fps: (dts.length / (now - t0)) * 1000, sats: (window as any).teraEngine.skyInfo().satellites, p95: dts[Math.floor(dts.length * 0.95)]! });
      }
    };
    requestAnimationFrame(tick);
  }));
  console.log(`  ${res.fps.toFixed(1)} fps, p95 frame ${res.p95.toFixed(1)} ms, ${res.sats} satellites drawn`);
  assert.ok(res.fps >= minFps, `${res.fps.toFixed(1)} fps`);
  await ctx.close();
});

await browser.close();
server.close();
rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} sky check(s) failed`);
  process.exit(1);
}
console.log("\nsky ok");
