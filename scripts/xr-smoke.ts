// XR smoke test (headless, no headset): the live page with ?xr=vr / ?xr=ar in Chrome,
//   1. without WebXR            → the button says WebXR is not available
//   2. with Chrome's own WebXR  → "VR NOT SUPPORTED" (no headset), page still renders
//   3. with Meta's IWER emulator as a Quest 3 (devDependency `iwer`, MIT; runs locally):
//      enter VR, tabletop scale, A toggles walk 1:1, trigger on an entity fires
//      `tera:select`; enter AR: no sky, model placed at table height.
//   node scripts/xr-smoke.ts [--no-build]
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

if (!process.argv.includes("--no-build")) ensureBuilt(true);
const { server, origin } = await startStaticServer(join(REPO_ROOT, "worlds", "demo"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: chromeArgs() });
const IWER = join(REPO_ROOT, "node_modules", "iwer", "build", "iwer.min.js");
let failed = 0;

async function open(xr: string, setup?: (p: Page) => Promise<void>): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await setup?.(page);
  await page.goto(`${origin}/?world=/world/world.json&xr=${xr}`);
  await page.waitForFunction(() => document.querySelector("[data-tera=xr-button]") && (window as any).teraEngine?.info().ready, undefined, { timeout: 30_000 });
  await page.waitForTimeout(300); // isSessionSupported resolves async
  return page;
}
const buttonText = (p: Page) => p.evaluate(() => document.querySelector("[data-tera=xr-button]")!.textContent!.trim());

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const quest = (p: Page) =>
  p.addInitScript({ path: IWER }).then(() =>
    p.addInitScript(() => {
      const I = (window as any).IWER;
      const d = new I.XRDevice(I.metaQuest3);
      d.installRuntime({ forceInstall: true });
      (window as any).__quest = d;
    }),
  );
const frames = (p: Page, n = 6) => p.evaluate((n) => new Promise<void>((ok) => { let i = 0; const s = (window as any).__quest?.activeSession; const tick = () => (++i >= n ? ok() : s ? s.requestAnimationFrame(tick) : requestAnimationFrame(tick)); s ? s.requestAnimationFrame(tick) : requestAnimationFrame(tick); }), n);

await step("no WebXR: button explains, renderer is WebGL2", async () => {
  const p = await open("vr", (pg) => pg.addInitScript(() => { delete (Navigator.prototype as any).xr; }));
  assert.match(await buttonText(p), /WEBXR NOT AVAILABLE/);
  assert.equal(await p.evaluate(() => (window as any).teraEngine.backend), "webgl2");
  await p.close();
});

await step("Chrome WebXR without a headset: VR NOT SUPPORTED", async () => {
  const p = await open("vr");
  assert.match(await buttonText(p), /VR NOT SUPPORTED|WEBXR NOT AVAILABLE/);
  await p.close();
});

await step("Quest 3 (IWER): enter VR, tabletop → walk, select an entity", async () => {
  const p = await open("vr", quest);
  assert.equal(await buttonText(p), "ENTER VR");
  await p.click("[data-tera=xr-button]");
  await p.waitForFunction(() => (window as any).teraEngine.handle.webgl.xr.isPresenting, undefined, { timeout: 10_000 });
  await frames(p);
  const table = await p.evaluate(() => { const x = (window as any).teraEngine.xr; return { scale: x.scale, k: x.rig.matrixWorld.getMaxScaleOnAxis() }; });
  assert.equal(table.scale, "table");
  assert.ok(table.k > 3, `tabletop scale k=${table.k}`);
  // A button → walk at 1:1
  await p.evaluate(() => (window as any).__quest.controllers.right.updateButtonValue("a-button", 1));
  await frames(p);
  await p.evaluate(() => (window as any).__quest.controllers.right.updateButtonValue("a-button", 0));
  await frames(p);
  const walk = await p.evaluate(() => { const x = (window as any).teraEngine.xr; return { scale: x.scale, k: x.rig.matrixWorld.getMaxScaleOnAxis() }; });
  assert.equal(walk.scale, "walk");
  assert.ok(Math.abs(walk.k - 1) < 1e-6, `walk k=${walk.k}`);
  // Point the right controller at the ball and pull the trigger.
  await p.evaluate(() => {
    const e = (window as any).teraEngine, q = (window as any).__quest;
    (window as any).__selected = [];
    addEventListener("tera:select", (ev) => (window as any).__selected.push((ev as CustomEvent).detail));
    const ball = e.scene.getObjectByName("ball");
    const inv = e.xr.rig.matrixWorld.clone().invert();
    const target = ball.getWorldPosition(e.camera.position.clone()).applyMatrix4(inv); // real space
    const from = target.clone().set(target.x + 0.0, 1.2, target.z + 2.0);
    const dir = target.clone().sub(from).normalize();
    const quat = e.camera.quaternion.clone().setFromUnitVectors(from.clone().set(0, 0, -1), dir);
    q.controllers.right.position.set(from.x, from.y, from.z);
    q.controllers.right.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  });
  await frames(p);
  await p.evaluate(() => (window as any).__quest.controllers.right.updateButtonValue("trigger", 1));
  await frames(p);
  await p.evaluate(() => (window as any).__quest.controllers.right.updateButtonValue("trigger", 0));
  await frames(p);
  const sel = await p.evaluate(() => (window as any).__selected);
  assert.equal(sel[0]?.id, "ball", `selected ${JSON.stringify(sel)}`);
  assert.equal(sel[0]?.source, "controller");
  const post = await p.evaluate(() => (window as any).teraEngine.info());
  assert.equal(post.renderer, "webgl2");
  await p.close();
});

await step("Quest 3 (IWER): enter AR passthrough, no sky, tabletop at table height", async () => {
  const p = await open("ar", quest);
  assert.equal(await buttonText(p), "START AR");
  await p.click("[data-tera=xr-button]");
  await p.waitForFunction(() => (window as any).teraEngine.handle.webgl.xr.isPresenting, undefined, { timeout: 10_000 });
  await frames(p);
  const s = await p.evaluate(() => {
    const e = (window as any).teraEngine;
    const ground = e.scene.getObjectByName("ground");
    const box = e.contentBox();
    const inv = e.xr.rig.matrixWorld.clone().invert();
    const bottom = box.min.clone().applyMatrix4(inv); // real height of the model's base
    return { bg: e.scene.background, fog: e.scene.fog, backdrop: e.sky.backdrop.mesh.visible, ground: ground.visible, mode: e.xr.opts.mode, baseY: bottom.y, size: box.getSize(box.min.clone()).x / e.xr.rig.matrixWorld.getMaxScaleOnAxis() };
  });
  assert.equal(s.bg, null);
  assert.equal(s.fog, null);
  assert.equal(s.backdrop, false);
  assert.equal(s.ground, false);
  assert.ok(Math.abs(s.baseY - 0.8) < 0.01, `model base at ${s.baseY} m`);
  assert.ok(s.size <= 0.5 + 1e-6, `model ${s.size} m wide`);
  // Two-hand grab: squeeze both grips, spread the hands to twice the distance → the model doubles.
  const k0 = await p.evaluate(() => (window as any).teraEngine.xr.rig.matrixWorld.getMaxScaleOnAxis());
  await p.evaluate(() => {
    const q = (window as any).__quest;
    q.controllers.left.position.set(-0.1, 1.0, -0.4);
    q.controllers.right.position.set(0.1, 1.0, -0.4);
  });
  await frames(p);
  await p.evaluate(() => { const q = (window as any).__quest; q.controllers.left.updateButtonValue("squeeze", 1); q.controllers.right.updateButtonValue("squeeze", 1); });
  await frames(p);
  await p.evaluate(() => {
    const q = (window as any).__quest;
    q.controllers.left.position.set(-0.2, 1.0, -0.4);
    q.controllers.right.position.set(0.2, 1.0, -0.4);
  });
  await frames(p);
  const k1 = await p.evaluate(() => (window as any).teraEngine.xr.rig.matrixWorld.getMaxScaleOnAxis());
  await p.evaluate(() => { const q = (window as any).__quest; q.controllers.left.updateButtonValue("squeeze", 0); q.controllers.right.updateButtonValue("squeeze", 0); });
  assert.ok(Math.abs(k1 - k0 / 2) < k0 * 0.02, `two-hand grab: k ${k0} → ${k1}, want ${k0 / 2}`);
  await p.close();
});

await browser.close();
server.close();
if (failed) {
  console.log(`\n${failed} XR check(s) failed`);
  process.exit(1);
}
console.log("\nall XR checks passed");
