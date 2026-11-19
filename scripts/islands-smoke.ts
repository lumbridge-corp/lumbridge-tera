// Islands smoke test (headless Chrome, worlds/islands-demo: a home island, a second island and a
// cable car between them): the impostor until near, lazy loading by distance, the Islands › Layers
// panel and the Islands views, a ferry ride there and back, presence one room per island
// (island-local positions on the wire), walking onto the island after a flight, island ops.
//   node scripts/islands-smoke.ts [--no-build] [--shots <dir>]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

if (!process.argv.includes("--no-build")) ensureBuilt(true);
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1]! : null;
if (shots) mkdirSync(shots, { recursive: true });
const { server, origin } = await startStaticServer(join(REPO_ROOT, "worlds", "islands-demo"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: chromeArgs() });
let failed = 0;
const errors: string[] = [];

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

// ---- presence rooms (one per island path), recording what reaches each
const rooms = new Map<string, { opened: number; states: { layer: string; position: number[] }[] }>();
function hub(path: string, ws: WebSocketRoute) {
  const room = rooms.get(path) ?? { opened: 0, states: [] };
  rooms.set(path, room);
  room.opened++;
  ws.send(JSON.stringify({ type: "welcome", v: 1, you: { id: `p${room.opened}`, name: "Tester", color: "#4f9de0" }, players: [], resume: null, max: 20 }));
  ws.onMessage((m) => {
    const msg = JSON.parse(String(m));
    if (msg.type === "state") room.states.push({ layer: msg.layer, position: msg.position });
  });
}

async function open(query = ""): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.routeWebSocket(/\/presence(-harbor)?$/, (ws) => hub(new URL(ws.url()).pathname, ws));
  page.on("pageerror", (e) => { errors.push(e.message); console.log(`  page error: ${e.message}`); });
  await page.goto(`${origin}/?world=/world/world.json&quality=low&idle=9999&presence=/presence${query}`);
  await page.waitForFunction(() => (window as any).teraViewer?.state().firstLoaded, undefined, { timeout: 60_000 });
  return page;
}
const st = (p: Page) => p.evaluate(() => (window as any).teraViewer.state());
const hasEntity = (p: Page, id: string) => p.evaluate((id) => {
  const find = (l: any[]): boolean => l.some((e) => e.id === id || (e.children && find(e.children)));
  return find((window as any).teraEngine.shown().entities);
}, id);

await step("far away: the island is its impostor; the panel lists both islands", async () => {
  const p = await open();
  await p.waitForTimeout(1200);
  const s = await st(p);
  assert.deepEqual(s.islands.map((i: any) => [i.id, i.loaded]), [["harbor", false]]);
  assert.ok(await hasEntity(p, "harbor.impostor.disc"), "impostor drawn");
  assert.ok(await hasEntity(p, "harbor.ferry.cabin"), "ferry drawn");
  assert.ok(!(await hasEntity(p, "harbor.shop")), "full island not loaded");
  assert.equal(await p.locator(".tv-layers .tv-sec").textContent(), "Islands");
  assert.deepEqual(await p.locator(".tv-layers [data-island] .tv-island-label > span:first-child").allTextContents(), ["Hometown", "Harbor"]);
  assert.equal(await p.getAttribute(".tv-layers [data-island='']", "aria-current"), "true");
  if (shots) await p.screenshot({ path: join(shots, "islands-far.png") });
  await p.context().close();
});

await step("near: flying the camera over loads it (prefixed ids, global lights dropped, its layer and view)", async () => {
  const p = await open();
  await p.evaluate(() => (window as any).teraViewer.selectPreset("island:harbor"));
  await p.waitForFunction(() => (window as any).teraViewer.state().islands[0].loaded, undefined, { timeout: 20_000 });
  assert.ok(await hasEntity(p, "harbor.shop"));
  assert.ok(await hasEntity(p, "harbor.fill") === false && await hasEntity(p, "harbor.sun") === false, "the island's own sun + fill are not mounted");
  assert.ok(!(await hasEntity(p, "harbor.impostor.disc")));
  const s = await st(p);
  assert.ok(s.play.layers.includes("harbor.surface"), `layers ${s.play.layers}`);
  assert.ok(s.presets.includes("island:") && s.presets.includes("island:harbor"));
  assert.ok(!s.presets.includes("harbor.overview"), "an island's cameras stay out of Views");
  await p.waitForTimeout(2500);
  if (shots) await p.screenshot({ path: join(shots, "islands-near.png") });
  // island ops go to the island's own world (its own ids)
  const r = await p.evaluate(() => (window as any).teraEngine.applyIsland("harbor", [{ op: "update", id: "shop-door", set: { material: { color: "#174e45" } } }]));
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = await p.evaluate(() => {
    const find = (l: any[]): any => { for (const e of l) { if (e.id === "harbor.shop-door") return e; const x = e.children && find(e.children); if (x) return x; } return null; };
    return find((window as any).teraEngine.shown().entities).material.color;
  });
  assert.equal(c, "#174e45");
  await p.context().close();
});

await step("ferry: walk to the station, ride the cable car, step out on the island; presence switches rooms", async () => {
  const p = await open();
  rooms.clear();
  await p.waitForTimeout(800);
  await p.click(".tv-layers [data-island=harbor]");
  await p.waitForFunction(() => (window as any).teraViewer.state().play.trip, undefined, { timeout: 20_000 });
  let aboard = false, shot = false, since = 0;
  for (let i = 0; i < 300; i++) {
    const s = await st(p);
    if (s.play.trip?.aboard) {
      aboard = true;
      since ||= Date.now();
      if (shots && !shot && Date.now() - since > 3200) { await p.screenshot({ path: join(shots, "islands-ferry.png") }); shot = true; }
    }
    if (!s.play.trip && s.play.island === "harbor") break;
    await p.waitForTimeout(150);
  }
  const s = await st(p);
  assert.ok(aboard, "rode in the cabin");
  assert.equal(s.play.island, "harbor");
  assert.equal(s.play.layer, "harbor.surface");
  assert.equal(s.play.position[1], 3);
  assert.ok(Math.hypot(s.play.position[0] - 60, s.play.position[2] + 30) < 9, `on the island: ${s.play.position}`);
  assert.equal(s.islands[0].here, true);
  assert.equal(await p.getAttribute(".tv-layers [data-island=harbor]", "aria-current"), "true");
  await p.waitForTimeout(1500);
  const room = rooms.get("/presence-harbor");
  assert.ok(room && room.opened === 1, "joined the island's room");
  const last = room!.states[room!.states.length - 1]!;
  assert.equal(last.layer, "surface");
  assert.ok(Math.hypot(last.position[0], last.position[2]) < 9 && Math.abs(last.position[1]) < 0.01, `island-local position on the wire: ${last.position}`);
  if (shots) await p.screenshot({ path: join(shots, "islands-arrived.png") });
  // and back home
  await p.click(".tv-layers [data-island='']");
  await p.waitForFunction(() => { const s = (window as any).teraViewer.state().play; return !s.trip && s.island === null && s.layer === "surface"; }, undefined, { timeout: 60_000 });
  await p.waitForTimeout(1200);
  assert.ok((rooms.get("/presence")?.opened ?? 0) >= 1, "back in the home room");
  await p.context().close();
});

await step("fly over, then walk: you land on the island's own layer", async () => {
  const p = await open();
  await p.evaluate(() => (window as any).teraViewer.selectPreset("island:harbor"));
  await p.waitForFunction(() => (window as any).teraViewer.state().islands[0].loaded, undefined, { timeout: 20_000 });
  await p.keyboard.press("v"); // walk
  await p.keyboard.press("f"); // fly
  await p.evaluate(() => (window as any).teraViewer.player.teleport("surface", [59, 9, -30]));
  await p.keyboard.press("f"); // walk again: lands on the floor below
  const s = (await st(p)).play;
  assert.equal(s.layer, "harbor.surface");
  assert.equal(s.position[1], 3);
  assert.equal(s.island, "harbor");
  await p.context().close();
});

await step("no page errors", async () => { assert.deepEqual(errors, []); });

await browser.close();
server.close();
console.log(failed ? `islands smoke: ${failed} failed` : "islands smoke: all passed");
process.exit(failed ? 1 : 0);
