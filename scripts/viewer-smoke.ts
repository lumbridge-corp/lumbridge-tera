// Live viewer smoke test (headless Chrome, the repo's living world, no feed needed):
// loading screen → ready, presets + keys, eased flight, click → card, double-click → fly-to,
// idle orbit, hidden tab pauses, screenshot download, ?ui=0, reduced motion, 360 px layout,
// error state + retry.
//   node scripts/viewer-smoke.ts [--no-build]
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

if (!process.argv.includes("--no-build")) ensureBuilt(true);
const { server, origin } = await startStaticServer(join(REPO_ROOT, "worlds", "living"));
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

type Opts = Parameters<typeof browser.newContext>[0];
async function open(query = "", opts: Opts = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${origin}/?world=/world/world.json&quality=medium${query}`);
  return page;
}
const ready = (p: Page) => p.waitForFunction(() => (window as any).teraViewer?.state().firstLoaded, undefined, { timeout: 60_000 });
const state = (p: Page) => p.evaluate(() => (window as any).teraViewer.state());
const camPos = (p: Page) => p.evaluate(() => (window as any).teraEngine.camera.position.toArray() as number[]);

await step("loading screen shows the world title, then fades out", async () => {
  const p = await open();
  await p.waitForSelector(".tv-loader");
  await ready(p);
  assert.match((await p.textContent(".tv-loader-title")) ?? "", /Living town/);
  await p.waitForSelector(".tv-loader", { state: "detached", timeout: 5000 });
  assert.match(await p.title(), /^Living town.* · Lumbridge Tera$/);
  assert.equal(await p.getAttribute(".tv-agents", "aria-label"), "12 agents");
  await p.context().close();
});

await step("presets: picker lists world cameras, key 2 flies there (eased, not a jump)", async () => {
  const p = await open();
  await ready(p);
  const s = await state(p);
  assert.deepEqual(s.presets.slice(0, 3), ["default", "street", "tunnel"]);
  await p.click("[aria-controls=tv-presets]");
  assert.equal(await p.getAttribute("[aria-controls=tv-presets]", "aria-expanded"), "true");
  assert.equal(await p.locator("#tv-presets [role=menuitem]").count(), s.presets.length);
  await p.keyboard.press("Escape");
  assert.equal(await p.isHidden("#tv-presets"), true);
  const before = await camPos(p);
  await p.keyboard.press("2");
  await p.waitForTimeout(150);
  const mid = await camPos(p);
  assert.equal((await state(p)).flying, true);
  await p.waitForFunction(() => !(window as any).teraViewer.state().flying, undefined, { timeout: 5000 });
  const end = await camPos(p);
  const world = await p.evaluate(() => (window as any).teraEngine.get());
  const street = world.cameras.street.position as number[];
  assert.ok(end.every((v, i) => Math.abs(v - street[i]!) < 0.05), `ended at ${end}`);
  assert.ok(mid.some((v, i) => Math.abs(v - before[i]!) > 1e-3) && mid.some((v, i) => Math.abs(v - end[i]!) > 0.05), "mid-flight pose between the two");
  // remembered across reloads
  await p.reload();
  await ready(p);
  const again = await camPos(p);
  assert.ok(again.every((v, i) => Math.abs(v - street[i]!) < 0.05), `restored ${again}`);
  await p.context().close();
});

await step("click a robot → card with its label and state; double-click → fly-to; Esc closes", async () => {
  const p = await open();
  await ready(p);
  await p.waitForTimeout(500);
  const where = () => p.evaluate(() => {
    const e = (window as any).teraEngine;
    const b = e.focusBox("bot-agent-1");
    const c = b.getCenter(b.min.clone()).project(e.camera);
    return { x: ((c.x + 1) / 2) * innerWidth, y: ((1 - c.y) / 2) * innerHeight };
  });
  let pt = await where();
  await p.mouse.click(pt.x, pt.y);
  await p.waitForSelector(".tv-card:not([hidden])", { timeout: 3000 });
  assert.equal(await p.textContent(".tv-card h2"), "agent-1");
  assert.match((await p.textContent(".tv-card-kind")) ?? "", /Agent/);
  pt = await where(); // it walks
  await p.mouse.dblclick(pt.x, pt.y);
  await p.waitForTimeout(100);
  assert.equal((await state(p)).flying, true);
  await p.keyboard.press("Escape");
  assert.equal(await p.isHidden(".tv-card"), true);
  await p.context().close();
});

await step("idle orbit after ?idle=1 s, stops on input", async () => {
  const p = await open("&idle=1");
  await ready(p);
  await p.waitForFunction(() => (window as any).teraViewer.state().orbiting, undefined, { timeout: 5000 });
  await p.mouse.move(100, 100);
  await p.mouse.down();
  await p.mouse.up();
  assert.equal((await state(p)).orbiting, false);
  await p.click("[aria-label='Idle orbit']");
  assert.equal(await p.getAttribute("[aria-label='Idle orbit']", "aria-pressed"), "false");
  await p.context().close();
});

await step("hidden tab pauses drawing; screenshot button downloads a PNG", async () => {
  const p = await open();
  await ready(p);
  const frames = () => p.evaluate(() => new Promise<number>((ok) => { let n = 0; const off = (window as any).teraEngine.onFrame(() => n++); setTimeout(() => { off(); ok(n); }, 600); }));
  assert.ok((await frames()) > 0);
  await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await frames(), 0);
  await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.ok((await frames()) > 0);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[aria-label='Save screenshot']")]);
  assert.match(dl.suggestedFilename(), /^living-.*\.png$/);
  await p.context().close();
});

await step("?ui=0 draws the world with no UI at all", async () => {
  const p = await open("&ui=0");
  await ready(p);
  assert.equal(await p.locator("#tera-ui").count(), 0);
  assert.equal(await p.locator("canvas").count(), 1);
  await p.context().close();
});

await step("reduced motion: idle orbit off and disabled, flights short", async () => {
  const p = await open("", { reducedMotion: "reduce" });
  await ready(p);
  assert.equal(await p.isDisabled("[aria-label='Idle orbit']"), true);
  await p.keyboard.press("3");
  await p.waitForTimeout(500);
  assert.equal((await state(p)).flying, false);
  await p.context().close();
});

await step("360 px: no horizontal overflow, panels inside the screen", async () => {
  const p = await open("", { viewport: { width: 360, height: 720 }, isMobile: true, hasTouch: true });
  await ready(p);
  const r = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    out: [...document.querySelectorAll<HTMLElement>(".tv-panel")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((b) => b.left < 0 || b.right > innerWidth).length,
  }));
  assert.equal(r.sw, 360);
  assert.equal(r.out, 0);
  await p.context().close();
});

await step("?replay= plays a recording in a loop: replay dot, ops applied, bad lines skipped", async () => {
  const p = await open("&replay=/world/replay.jsonl&replaySpeed=4");
  await ready(p);
  await p.waitForFunction(() => (window as any).teraViewer.state().live === "replay", undefined, { timeout: 10_000 });
  assert.equal(await p.getAttribute(".tv-live", "data-status"), "replay");
  assert.equal(await p.isVisible(".tv-replay-word"), true);
  // the robot from the recording is in the world; a failing op does not drop the rest
  await p.waitForFunction(() => (window as any).teraEngine.get().entities.some((e: any) => e.id === "live-r1"), undefined, { timeout: 5000 });
  // t = 2 has a failing op first: the meter update after it still lands
  await p.waitForFunction(() => {
    const find = (es: any[]): any => es.map((e) => (e.id === "depot-load" ? e : find(e.children ?? []))).find(Boolean);
    return find((window as any).teraEngine.get().entities)?.value === 0.8;
  }, undefined, { timeout: 8000, polling: 50 });
  // 4 s at x4 = a loop per second (+ the 1.2 s dip): wait for two loops
  await p.waitForFunction(() => (window as any).teraViewer.state().replay?.loops >= 2, undefined, { timeout: 15_000 });
  const s = await state(p);
  assert.equal(s.replay.duration, 4);
  assert.equal(s.replay.speed, 4);
  await p.context().close();
});

await step("a missing world shows an error with Try again", async () => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const p = await ctx.newPage();
  await p.goto(`${origin}/?world=/world/missing.json`);
  await p.waitForSelector(".tv-loader-error:not([hidden])", { timeout: 10_000 });
  assert.match((await p.textContent(".tv-err-title")) ?? "", /Couldn’t open/);
  await p.click(".tv-loader-error button");
  await p.waitForSelector(".tv-loader-error:not([hidden])");
  await ctx.close();
});

await browser.close();
server.close();
if (failed) {
  console.log(`\n${failed} viewer check(s) failed`);
  process.exit(1);
}
console.log("\nviewer ok");
