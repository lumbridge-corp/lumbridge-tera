import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldPack as WorldPackSchema } from "../schema/index.ts";
import type { Entity, WorldPack } from "../schema/index.ts";
import {
  cabinId, cabinSway, composeIslands, ferryAt, ferryRideAt, islandAt, islandDistance, islandSections, layerIsland, nearestOnRoute, planFerry,
  rideCamera, routeLengths, routePoint, showSections, toLocal, toWorld, wantLoaded, type V3,
} from "./islands.ts";

const box = (id: string, p: V3 = [0, 0, 0]): Entity => ({ id, kind: "primitive", shape: "box", size: [1, 1, 1], transform: { position: p } } as Entity);

function home(extra: Partial<WorldPack> = {}): WorldPack {
  return {
    tera: "world/v1", id: "home", title: "Home Town — a test", entities: [box("plaza")],
    cameras: { default: { position: [10, 10, 10], target: [0, 0, 0] } },
    layers: [{ id: "surface", name: "Town", floorY: 0, walk: { center: [0, 0], radius: 20 }, spawn: [1, 0, 1] }],
    islands: [{
      id: "harbor", name: "Harbor", src: "harbor.json", offset: [100, 5, -50], radius: 15,
      impostor: [box("rock")],
      ferry: { name: "Sky tram", entities: [box("tower"), { id: "cabin", kind: "group", children: [box("shell")] } as Entity], cabin: "cabin", route: [[20, 8, -10], [80, 12, -40]], board: [18, 0, -9], alight: [86, 5, -44] },
    }],
    ...extra,
  };
}

const harbor: WorldPack = {
  tera: "world/v1", id: "harbor", title: "Harbor", entities: [
    { id: "sun", kind: "light", light: "directional", intensity: 2 } as Entity,
    { id: "fill", kind: "group", children: [{ id: "sky-fill", kind: "light", light: "hemisphere" } as Entity, { id: "lamp", kind: "light", light: "point" } as Entity] } as Entity,
    { id: "shop", kind: "group", transform: { position: [2, 0, 0] }, children: [box("door", [0, 0, 1])] } as Entity,
    { id: "bot", kind: "actor", transform: { position: [1, 0, 1] }, resident: "cook", style: "resident", move: { to: "shop.door", from: "plaza", stops: [{ to: "plaza", dwell: 2 }] } } as Entity,
    { id: "pipe", kind: "flow", path: "ring" } as Entity,
  ],
  paths: [{ id: "ring", points: [[0, 0, 0], [5, 0, 0]] }],
  graph: { nodes: [{ id: "plaza", position: [0, 0, 0] }, { id: "shop.door", position: [2, 0, 1] }], edges: [["plaza", "shop.door"], { from: "plaza", to: "shop.door", path: "ring" }] },
  cameras: { default: { position: [1, 1, 1], target: [0, 0, 0] }, overview: { position: [30, 20, 30], target: [0, 0, 0] } },
  layers: [{ id: "surface", name: "Harbor", floorY: 0, walk: { center: [0, 0], radius: 14 }, spawn: [2, 0, 2], camera: "overview" }],
  residents: [{ id: "cook", name: "Cook", role: "builder", homeNode: "plaza", sandbox: "kitchen" }],
  sandboxes: [{ id: "kitchen", name: "Kitchen", kind: "container", policy: { network: "none", files: "scratch", tools: [] }, entity: "shop" }],
};

test("schema: islands validate; dotted ids, duplicates and a missing cabin are refused", () => {
  assert.ok(WorldPackSchema.safeParse(home()).success);
  const bad = (f: (w: WorldPack) => void) => { const w = structuredClone(home()); f(w); return WorldPackSchema.safeParse(w).success; };
  assert.equal(bad((w) => { w.islands![0]!.id = "a.b"; }), false);
  assert.equal(bad((w) => { w.islands!.push(structuredClone(w.islands![0]!)); }), false);
  assert.equal(bad((w) => { w.islands![0]!.ferry!.cabin = "nope"; }), false);
  assert.equal(bad((w) => { w.islands![0]!.ferry!.route = [[0, 0, 0]]; }), false);
  assert.ok(WorldPackSchema.safeParse(harbor).success);
});

test("a world without islands composes to itself", () => {
  const w = home({ islands: undefined });
  assert.equal(composeIslands(w).world, w);
  const e = home({ islands: [] });
  assert.equal(composeIslands(e).world, e);
});

test("not mounted: the impostor in island space + the ferry in home space", () => {
  const { world } = composeIslands(home());
  const g = world.entities.find((e) => e.id === "harbor") as Entity & { children: Entity[] };
  assert.deepEqual(g.transform?.position, [100, 5, -50]);
  assert.ok(g.tags?.includes("island-impostor"));
  assert.deepEqual(g.children.map((c) => c.id), ["harbor.impostor.rock"]);
  const f = world.entities.find((e) => e.id === "harbor.ferry") as Entity & { children: Entity[] };
  assert.deepEqual(f.children.map((c) => c.id), ["harbor.ferry.tower", "harbor.ferry.cabin"]);
  assert.equal(cabinId(home().islands![0]!), "harbor.ferry.cabin");
  assert.equal((f.children[1] as Entity & { children: Entity[] }).children[0]!.id, "harbor.ferry.shell");
  assert.equal(world.layers!.length, 1);
});

test("mounted: ids, paths, graph, cameras, layers, residents prefixed and moved; global lights dropped", () => {
  const h = home();
  const { world, warnings } = composeIslands(h, new Map([["harbor", harbor]]));
  assert.deepEqual(warnings, []);
  const g = world.entities.find((e) => e.id === "harbor") as Entity & { children: Entity[] };
  assert.ok(g.tags?.includes("island-full"));
  const ids: string[] = [];
  const walk = (l: Entity[]) => { for (const e of l) { ids.push(e.id); if (e.kind === "group") walk((e as { children: Entity[] }).children); } };
  walk(g.children);
  assert.deepEqual(ids, ["harbor.fill", "harbor.lamp", "harbor.shop", "harbor.door", "harbor.bot"]);
  // flows are lifted to the top (they draw along world paths)
  const flow = world.entities.find((e) => e.id === "harbor.pipe") as Entity & { path: string };
  assert.equal(flow.path, "harbor.ring");
  // actors pose in world space
  const bot = g.children.find((e) => e.id === "harbor.bot") as Entity & { move: { to: string; from: string; stops: { to: string }[] }; resident: string };
  assert.deepEqual(bot.transform?.position, [101, 5, -49]);
  assert.equal(bot.move.to, "harbor.shop.door");
  assert.equal(bot.move.from, "harbor.plaza");
  assert.equal(bot.move.stops[0]!.to, "harbor.plaza");
  assert.equal(bot.resident, "harbor-cook");
  // static children keep island-local transforms under the island group
  assert.deepEqual((g.children.find((e) => e.id === "harbor.shop")!).transform?.position, [2, 0, 0]);
  assert.deepEqual(world.paths!.find((p) => p.id === "harbor.ring")!.points, [[100, 5, -50], [105, 5, -50]]);
  assert.deepEqual(world.graph!.nodes.find((n) => n.id === "harbor.shop.door")!.position, [102, 5, -49]);
  assert.deepEqual(world.graph!.edges, [["harbor.plaza", "harbor.shop.door"], { from: "harbor.plaza", to: "harbor.shop.door", path: "harbor.ring" }]);
  // the island's default camera never replaces the home one
  assert.deepEqual(world.cameras!.default, h.cameras!.default);
  assert.deepEqual(world.cameras!["harbor.overview"]!.position, [130, 25, -20]);
  const l = world.layers!.find((x) => x.id === "harbor.surface")!;
  assert.deepEqual([l.floorY, l.walk.center, l.spawn, l.camera], [5, [100, -50], [102, 5, -48], "harbor.overview"]);
  assert.deepEqual(world.residents!.map((r) => [r.id, r.homeNode, r.sandbox]), [["harbor-cook", "harbor.plaza", "harbor-kitchen"]]);
  assert.deepEqual(world.sandboxes!.map((s) => [s.id, s.entity]), [["harbor-kitchen", "harbor.shop"]]);
  // the inputs are untouched
  assert.equal(harbor.entities[3]!.id, "bot");
  assert.equal(h.entities.length, 1);
  // the result is a valid world (layers, residents)
  const v = WorldPackSchema.safeParse(world);
  assert.ok(v.success, v.success ? "" : JSON.stringify(v.error.issues.slice(0, 3)));
});

test("an island whose id clashes with a home entity is skipped with a warning", () => {
  const h = home();
  h.entities.push(box("harbor.x"));
  const r = composeIslands(h, new Map([["harbor", harbor]]));
  assert.equal(r.warnings.length, 1);
  assert.ok(!r.world.entities.some((e) => e.id === "harbor"));
});

test("frames: layer ids, local <-> world, islandAt, sections", () => {
  const refs = home().islands!;
  assert.deepEqual(layerIsland("harbor.surface", refs), { island: "harbor", local: "surface", offset: [100, 5, -50] });
  assert.deepEqual(layerIsland("surface", refs), { island: null, local: "surface", offset: [0, 0, 0] });
  assert.deepEqual(layerIsland("x.y", refs).island, null);
  assert.deepEqual(toLocal([101, 5, -49], [100, 5, -50]), [1, 0, 1]);
  assert.deepEqual(toWorld([1, 0, 1], [100, 5, -50]), [101, 5, -49]);
  assert.equal(islandAt([104, 5, -50], refs), "harbor");
  assert.equal(islandAt([0, 0, 0], refs), null);
  const { world } = composeIslands(home(), new Map([["harbor", harbor]]));
  const s = islandSections("Home Town", refs, world.layers!, new Set(["harbor"]));
  assert.deepEqual(s.map((x) => [x.id, x.name, x.layers.map((l) => l.id), x.loaded]), [[null, "Home Town", ["surface"], true], ["harbor", "Harbor", ["harbor.surface"], true]]);
  assert.equal(showSections(s), true);
  assert.equal(showSections([s[0]!]), false);
});

test("routes: lengths and points by arc length", () => {
  const r: V3[] = [[0, 0, 0], [3, 4, 0], [3, 4, 10]];
  assert.deepEqual(routeLengths(r), { cum: [0, 5, 15], total: 15 });
  assert.deepEqual(routePoint(r, 2.5).position, [1.5, 2, 0]);
  assert.deepEqual(routePoint(r, 10).position, [3, 4, 5]);
  assert.deepEqual(routePoint(r, 99).position, [3, 4, 10]);
});

test("ferryAt: dwell, cross, dwell, back", () => {
  const r: V3[] = [[0, 0, 0], [10, 0, 0]];
  assert.equal(ferryAt(r, 0, 20, 5).phase, "home");
  assert.deepEqual(ferryAt(r, 4, 20, 5).position, [0, 0, 0]);
  const mid = ferryAt(r, 15, 20, 5);
  assert.equal(mid.phase, "out");
  assert.ok(Math.abs(mid.position[0] - 5) < 1e-9);
  assert.equal(ferryAt(r, 27, 20, 5).phase, "island");
  assert.deepEqual(ferryAt(r, 27, 20, 5).position, [10, 0, 0]);
  assert.equal(ferryAt(r, 40, 20, 5).phase, "back");
  assert.deepEqual(ferryAt(r, 50, 20, 5).position, [0, 0, 0]); // one full cycle
});

test("planFerry: walk to the dock (the cabin comes), ride, walk out; reverse too", () => {
  const f = home().islands![0]!.ferry!;
  const plan = planFerry([0, 0, 0], f, [101, 5, -49], { cabinS: 30 });
  assert.equal(plan.legs.length, 5);
  assert.ok(plan.legs[2]!.path);
  const L = routeLengths(f.route as V3[]).total;
  let at = ferryRideAt(plan, 0);
  assert.equal(at.cabinS, 30);
  at = ferryRideAt(plan, plan.legs[0]!.duration + 0.01);
  assert.ok(Math.abs(at.cabinS!) < 1e-6);
  at = ferryRideAt(plan, plan.legs[0]!.duration + plan.legs[1]!.duration + plan.legs[2]!.duration / 2);
  assert.ok(at.riding);
  assert.ok(Math.abs(at.cabinS! - L / 2) < 1e-6);
  at = ferryRideAt(plan, plan.total + 1);
  assert.ok(at.done);
  assert.deepEqual(at.position, [101, 5, -49]);
  const back = planFerry([101, 5, -49], f, [1, 0, 1], { reverse: true, cabinS: L });
  assert.deepEqual(back.legs[0]!.to, f.alight);
  const mid = ferryRideAt(back, back.legs[0]!.duration + back.legs[1]!.duration + 0.001);
  assert.ok(mid.riding && Math.abs(mid.cabinS! - L) < 0.1);
  assert.deepEqual(ferryRideAt(back, back.total).position, [1, 0, 1]);
});

test("loading: hysteresis and footprint distance", () => {
  assert.equal(wantLoaded(false, 250, 260), true);
  assert.equal(wantLoaded(false, 270, 260), false);
  assert.equal(wantLoaded(true, 300, 260), true);
  assert.equal(wantLoaded(true, 330, 260), false);
  assert.equal(wantLoaded(true, 9999, 260, true), true);
  const ref = home().islands![0]!;
  assert.equal(islandDistance([100, 5, -50], ref), 0);
  assert.equal(islandDistance([125, 5, -50], ref), 10);
});

test("planFerry: a ferry with a period rides at its shuttle's pace", () => {
  const f = { ...home().islands![0]!.ferry!, period: 24 };
  const plan = planFerry([0, 0, 0], f, [101, 5, -49]);
  assert.equal(plan.legs[2]!.duration, 24);
  const { period: _, ...noPeriod } = f;
  const L = routeLengths(f.route as V3[]).total;
  assert.ok(Math.abs(planFerry([0, 0, 0], noPeriod, [101, 5, -49]).legs[2]!.duration - Math.min(30, Math.max(6, L / 7))) < 1e-9);
  assert.ok(planFerry([0, 0, 0], f, [101, 5, -49], { reduced: true }).legs[2]!.duration < 10);
});

test("nearestOnRoute: arc length and distance to a polyline", () => {
  const r: V3[] = [[0, 0, 0], [10, 0, 0], [10, 0, 10]];
  assert.deepEqual(nearestOnRoute(r, [5, 1, 0]), { s: 5, d: 1 });
  const n = nearestOnRoute(r, [11, 0, 4]);
  assert.ok(Math.abs(n.s - 14) < 1e-9 && Math.abs(n.d - 1) < 1e-9);
  assert.equal(nearestOnRoute(r, [-3, 0, 0]).s, 0);
});

test("cabinSway: small, still in the stations and when not moving", () => {
  for (let t = 0; t < 60; t += 0.37) {
    const s = cabinSway(t, 0.5);
    assert.ok(Math.abs(s.roll) <= 2.2 && Math.abs(s.pitch) <= 0.8);
  }
  for (const u of [0, 1]) { const s = cabinSway(3, u); assert.equal(Math.abs(s.roll) + Math.abs(s.pitch), 0); }
  const still = cabinSway(3, 0.5, 0);
  assert.equal(Math.abs(still.roll) + Math.abs(still.pitch), 0);
});

test("rideCamera: three-quarter behind at the ends, out to the side mid-span, looking ahead", () => {
  const at: V3 = [0, 10, 0], dir: V3 = [1, 0, 0];
  const start = rideCamera(0, at, dir, 1);
  assert.ok(start.position[0] < -5, "behind the cabin");
  assert.ok(start.target[0] > 5, "looking ahead");
  const mid = rideCamera(0.5, at, dir, 1);
  const off = Math.abs(mid.position[2]);
  assert.ok(off > 20, `out to the side (${off})`);
  assert.ok(Math.abs(mid.target[0]) < 3, "the cabin centred");
  assert.ok(Math.sign(rideCamera(0.5, at, dir, -1).position[2]) === -Math.sign(mid.position[2]), "the other side");
  const tall = rideCamera(0.5, at, dir, 1, 0.5);
  assert.ok(tall.position[0] < -10 && tall.target[0] > 10 && Math.abs(tall.position[2]) < off, "a portrait view looks along the cable from behind and above");
  const end = rideCamera(1, at, dir, 1);
  assert.ok(end.position[0] < at[0] && end.target[0] > at[0]);
});
