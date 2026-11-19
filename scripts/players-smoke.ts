// Players smoke test (headless Chrome, the repo's living world with two layers): Orbit / Walk /
// Fly, walls, floors, layer travel, and two people in the same world through a small presence
// hub (protocol players/v1) served by Playwright's WebSocket routing, so no server is needed.
//   node scripts/players-smoke.ts [--no-build] [--shots <dir>]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { chromeArgs, ensureBuilt, REPO_ROOT, startStaticServer } from "../src/render/host.ts";

if (!process.argv.includes("--no-build")) ensureBuilt(true);
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1]! : null;
if (shots) mkdirSync(shots, { recursive: true });
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

// ---- a tiny presence hub (the protocol, not a production server: no auth, no limits)
const COLORS = ["#e8735a", "#4f9de0", "#8fbf4a", "#b88ae0"];
const hub = new Map<WebSocketRoute, { id: string; name: string; color: string; st: Record<string, unknown> | null }>();
let joined = 0;
function hubRoute(ws: WebSocketRoute) {
  const me = { id: `p${++joined}`, name: `Guest ${joined}`, color: COLORS[joined % COLORS.length]!, st: null as Record<string, unknown> | null };
  hub.set(ws, me);
  const others = () => [...hub.entries()].filter(([w]) => w !== ws);
  ws.send(JSON.stringify({ type: "welcome", v: 1, you: { id: me.id, name: me.name, color: me.color }, players: others().filter(([, o]) => o.st).map(([, o]) => ({ id: o.id, name: o.name, color: o.color, ...o.st })), resume: null, max: 20 }));
  ws.onMessage((m) => {
    const msg = JSON.parse(String(m));
    if (msg.type !== "state") return;
    const first = !me.st;
    me.st = { layer: msg.layer, position: msg.position, heading: msg.heading, mode: msg.mode };
    for (const [w] of others()) w.send(JSON.stringify(first ? { type: "join", player: { id: me.id, name: me.name, color: me.color, ...me.st } } : { type: "states", players: [{ id: me.id, ...me.st }] }));
  });
  ws.onClose(() => drop(ws));
}
function drop(ws: WebSocketRoute) {
  const me = hub.get(ws);
  if (!me) return;
  hub.delete(ws);
  for (const [w] of hub) w.send(JSON.stringify({ type: "leave", id: me.id }));
}

type Opts = Parameters<typeof browser.newContext>[0];
async function open(query = "", opts: Opts = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  const page = await ctx.newPage();
  await page.routeWebSocket(/\/presence$/, (ws) => {
    hubRoute(ws);
    page.once("close", () => drop(ws)); // a closed page's route never reports its close
  });
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${origin}/?world=/world/world.json&quality=low&presence=/presence${query}`);
  await page.waitForFunction(() => (window as any).teraViewer?.state().firstLoaded, undefined, { timeout: 60_000 });
  return page;
}
const play = (p: Page) => p.evaluate(() => (window as any).teraViewer.state().play);
const hold = async (p: Page, key: string, ms: number) => { await p.keyboard.down(key); await p.waitForTimeout(ms); await p.keyboard.up(key); };

await step("HUD: Orbit / Walk / Fly, both layers listed, the avatar stands at the street spawn", async () => {
  const p = await open();
  assert.equal(await p.locator(".tv-mode").count(), 3);
  assert.equal(await p.getAttribute(".tv-mode[data-mode=orbit]", "aria-checked"), "true");
  assert.deepEqual(await p.locator(".tv-layer span:first-child").allTextContents(), ["Street", "Underworks"]);
  const s = await play(p);
  assert.equal(s.layer, "street");
  assert.ok(Math.hypot(s.position[0] + 4, s.position[2] - 2.4) < 2.5 && s.position[1] === 0, `spawn ${s.position}`);
  await p.context().close();
});

await step("walk: V switches, W walks forward on the floor, the camera follows behind", async () => {
  const p = await open();
  await p.keyboard.press("v");
  assert.equal((await play(p)).mode, "walk");
  await p.evaluate(() => (window as any).teraViewer.player.teleport("street", [-4, 0, 2.4], 90)); // face +X, down the street
  const a = await play(p);
  await hold(p, "w", 1200);
  await p.waitForTimeout(300);
  const b = await play(p);
  assert.ok(b.position[0] - a.position[0] > 2, `walked ${b.position[0] - a.position[0]} m`);
  assert.equal(b.position[1], 0);
  assert.ok(b.camera[0] < b.position[0], "camera behind (looking +X)");
  assert.ok(Math.round(b.heading) === 90, `faces +X: ${b.heading}`);
  if (shots) await p.screenshot({ path: join(shots, "players-walk.png") });
  await p.context().close();
});

await step("walls: the lab stops a walker (engine.solidHit) and the walk disc holds", async () => {
  const p = await open();
  const hit = await p.evaluate(() => (window as any).teraEngine.solidHit([-12, 1, -2], [-12, 1, -12]));
  assert.ok(hit !== null && hit < 6, `ray into the lab hits: ${hit}`);
  await p.keyboard.press("v");
  await p.evaluate(() => (window as any).teraViewer.player.teleport("street", [-12, 0, -3], 180)); // facing -Z, the lab's front
  await hold(p, "w", 2500);
  const s = await play(p);
  assert.ok(s.position[2] > -7.2, `stopped at the lab wall: z ${s.position[2]}`);
  await p.context().close();
});

await step("fly: F flies, Q holds at the floor, Space climbs; Esc back to orbit", async () => {
  const p = await open();
  await p.keyboard.press("v");
  await p.keyboard.press("f");
  assert.equal((await play(p)).mode, "fly");
  await hold(p, "Space", 1200);
  const up = await play(p);
  assert.ok(up.position[1] > 3, `climbed to ${up.position[1]}`);
  await hold(p, "q", 3000);
  const down = await play(p);
  assert.ok(down.position[1] >= 0.3 && down.position[1] < 1, `held above the floor: ${down.position[1]}`);
  await p.keyboard.press("Escape");
  assert.equal((await play(p)).mode, "orbit");
  await p.context().close();
});

await step("layer travel: Underworks button flies the avatar down to the tunnel floor", async () => {
  const p = await open();
  await p.click(".tv-layer[data-layer=underworks]");
  await p.waitForTimeout(200);
  assert.equal((await play(p)).riding, true);
  await p.waitForFunction(() => !(window as any).teraViewer.state().play.riding, undefined, { timeout: 10_000 });
  const s = await play(p);
  assert.equal(s.layer, "underworks");
  assert.equal(s.position[1], -6);
  assert.equal(await p.getAttribute(".tv-layer[data-layer=underworks]", "aria-current"), "true");
  if (shots) await p.screenshot({ path: join(shots, "players-underworks.png") });
  await p.context().close();
});

await step("lift: with a spine-car the avatar walks in, rides it down and walks out", async () => {
  const p = await open();
  const r = await p.evaluate(() => (window as any).tera.apply([{ op: "add", entity: { id: "spine-car", kind: "primitive", shape: "box", size: [1.8, 0.2, 1.8], transform: { position: [2, 0.1, 0.6] }, material: { color: "#dddddd" } } }]));
  assert.equal(r.ok, true);
  await p.click(".tv-layer[data-layer=underworks]");
  let sawCar = false;
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(150);
    const s = await p.evaluate(() => ({ play: (window as any).teraViewer.state().play, car: (window as any).teraEngine.entityObject("spine-car").position.y }));
    if (s.car < -1 && Math.hypot(s.play.position[0] - 2, s.play.position[2] - 0.6) < 0.2 && Math.abs(s.play.position[1] - (s.car - 0.1)) < 0.05) sawCar = true;
    if (!s.play.riding) break;
  }
  const end = await p.evaluate(() => ({ play: (window as any).teraViewer.state().play, car: (window as any).teraEngine.entityObject("spine-car").position.y }));
  assert.ok(sawCar, "rode inside the car on the way down");
  assert.equal(end.play.layer, "underworks");
  assert.ok(Math.abs(end.car - (-6 + 0.1)) < 0.05, `car ended at the Underworks floor: ${end.car}`);
  await p.context().close();
});

await step("two people: each sees the other's avatar and name tag, movement arrives", async () => {
  const a = await open();
  const b = await open();
  await a.waitForFunction(() => (window as any).teraViewer.state().play.players.length === 1, undefined, { timeout: 8000 });
  await b.waitForFunction(() => (window as any).teraViewer.state().play.players.length === 1, undefined, { timeout: 8000 });
  const sa = await play(a);
  assert.equal(sa.presence, "open");
  assert.match(sa.players[0].name, /^Guest \d$/);
  assert.equal(await a.locator(".tv-people b").textContent(), "2");
  // B walks; A sees it move
  await b.keyboard.press("v");
  await b.evaluate(() => (window as any).teraViewer.player.teleport("street", [-4, 0, 2.4], 90));
  const before = (await play(a)).players[0].position[0];
  await hold(b, "w", 1500);
  await a.waitForTimeout(500);
  const after = (await play(a)).players[0];
  assert.ok(after.position[0] - before > 1.5, `A saw B walk ${after.position[0] - before} m`);
  assert.equal(after.mode, "walk");
  // A frames both: walk mode looking at B
  await a.keyboard.press("v");
  await a.evaluate(() => (window as any).teraViewer.player.teleport("street", [-9, 0, 2.4], 90));
  await a.waitForTimeout(900);
  const tag = a.locator(".tv-tag-name");
  assert.equal(await tag.count(), 1);
  assert.ok(Number(await tag.evaluate((el) => getComputedStyle(el).opacity)) > 0.5, "B's name tag shows");
  if (shots) {
    await a.screenshot({ path: join(shots, "players-two-a.png") });
    await b.screenshot({ path: join(shots, "players-two-b.png") });
  }
  // B rides down to the Underworks: A's layer panel counts B there (and A itself on the street)
  await b.click(".tv-layer[data-layer=underworks]");
  await b.waitForFunction(() => !(window as any).teraViewer.state().play.riding, undefined, { timeout: 10_000 });
  await a.waitForFunction(() => (window as any).teraViewer.state().play.players[0]?.layer === "underworks", undefined, { timeout: 5000 });
  await a.waitForTimeout(200);
  assert.equal(await a.locator(".tv-layer[data-layer=underworks] .tv-layer-n").textContent(), "1");
  assert.equal(await a.locator(".tv-layer[data-layer=street] .tv-layer-n").textContent(), "1");
  await b.context().close();
  await a.waitForFunction(() => (window as any).teraViewer.state().play.players.length === 0, undefined, { timeout: 5000 });
  await a.context().close();
});

await step("reduced motion: travel is short; 360 px: modes and layers fit", async () => {
  const p = await open("", { reducedMotion: "reduce", viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  const t0 = Date.now();
  await p.click(".tv-layer[data-layer=underworks]");
  await p.waitForFunction(() => !(window as any).teraViewer.state().play.riding, undefined, { timeout: 5000 });
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  for (const sel of [".tv-modes", ".tv-layers"]) {
    const box = (await p.locator(sel).boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 360, `${sel} fits: ${JSON.stringify(box)}`);
  }
  await p.click(".tv-mode[data-mode=walk]");
  assert.equal(await p.isVisible(".tv-stick"), true, "touch joystick in walk mode");
  if (shots) await p.screenshot({ path: join(shots, "players-phone.png") });
  await p.context().close();
});

await browser.close();
server.close();
console.log(failed ? `${failed} step(s) failed` : "players smoke: all passed");
process.exit(failed ? 1 : 0);
