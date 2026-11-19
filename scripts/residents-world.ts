#!/usr/bin/env node
// worlds/residents/world.json: a small square where every built-in resident role stands at home,
// two worker robots for scale, and a sandbox room with a contained resident inside. The example
// for docs/residents.md and the residents stills.
//
//   node scripts/residents-world.ts [--night]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldPack, checkRegistry, worldResidents, type ResidentRegistry } from "../src/schema/index.ts";
import { sandboxRoom } from "../src/residents/sandbox-room.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const night = process.argv.includes("--night");

const registry: ResidentRegistry = {
  tera: "residents/v1",
  residents: [
    { id: "keeper", name: "Keeper", role: "steward", home: "The hall", homeNode: "home-keeper", blurb: "Runs the house: alerts, watchdogs, the front desk.", match: { units: ["hall:keeper.service"] }, visibility: "public" },
    { id: "brush", name: "Brush", role: "maintenance", home: "The yard", homeNode: "home-brush", blurb: "Prunes, heals the network, restarts what hangs.", match: { units: ["*:prune*.service"] }, visibility: "public" },
    { id: "dice", name: "Dice", role: "simulator", home: "The gym", homeNode: "home-dice", blurb: "Runs the what-ifs before anything real happens.", match: { agents: ["gym:*"] }, visibility: "public" },
    { id: "lens", name: "Lens", role: "analyst", home: "The library", homeNode: "home-lens", blurb: "Reviews every cut before it ships.", match: { agents: ["review:*"] }, visibility: "public" },
    { id: "mason", name: "Mason", role: "builder", home: "The factory", homeNode: "home-mason", blurb: "Leads the coding crew.", match: { procs: ["*:claude"] }, visibility: "public" },
    { id: "wren", name: "Wren", role: "messenger", home: "Post office", homeNode: "home-wren", blurb: "Carries mail and messages between houses.", match: { units: ["*:mail*"] }, visibility: "public" },
    { id: "page", name: "Page", role: "librarian", home: "The library", homeNode: "home-page", blurb: "Shelves the night's reading.", match: { units: ["*:library*"] }, visibility: "public" },
    { id: "gauge", name: "Gauge", role: "operator", home: "Machine room", homeNode: "home-gauge", blurb: "Decides which models are awake.", match: { units: ["*:governor*"] }, visibility: "public" },
    { id: "echo", name: "Echo", role: "voice", home: "Radio tower", homeNode: "home-echo", blurb: "Speaks for the house.", match: { units: ["*:speak*"] }, visibility: "public" },
    { id: "moth", name: "Moth", role: "sandboxed", home: "Glass room", homeNode: "lab.work", sandbox: "lab", blurb: "Experimental: works behind glass.", match: { procs: ["*:codex"] }, visibility: "public" },
  ],
  sandboxes: [
    { id: "lab", name: "Glass lab", kind: "container", entity: "lab", blurb: "Experimental agents work here, in view.", policy: { network: "allowlist", files: "workdir", tools: ["shell", "git"], enforcer: "container" }, visibility: "public" },
  ],
};

const homes: Record<string, [number, number]> = {};
const order = registry.residents.filter((r) => r.role !== "sandboxed");
order.forEach((r, i) => {
  const a = ((i / order.length) * 300 - 150) * (Math.PI / 180);
  homes[r.id] = [Math.round(Math.sin(a) * 5.2 * 100) / 100, Math.round(Math.cos(a) * 5.2 * 100) / 100 - 0.5];
});

const room = sandboxRoom({ id: "lab", name: "Glass lab", size: [4.2, 3.4], policy: registry.sandboxes![0]!.policy, count: "1 inside" });
const roomPos: [number, number, number] = [0, 0, -7.5];
const nodes = [
  ...Object.entries(homes).map(([id, [x, z]]) => ({ id: `home-${id}`, position: [x, 0, z] as [number, number, number] })),
  { id: "square", position: [0, 0, 0] as [number, number, number] },
  { id: "lab.door", position: [roomPos[0] + room.spots.outside[0], 0, roomPos[2] + room.spots.outside[2]] as [number, number, number] },
  { id: "lab.in", position: [roomPos[0] + room.spots.inside[0], room.spots.inside[1], roomPos[2] + room.spots.inside[2]] as [number, number, number] },
  { id: "lab.work", position: [roomPos[0] + room.spots.work[0], room.spots.work[1], roomPos[2] + room.spots.work[2]] as [number, number, number] },
];
const edges: [string, string][] = [...Object.keys(homes).map((id) => [`home-${id}`, "square"] as [string, string]), ["square", "lab.door"], ["lab.door", "lab.in"], ["lab.in", "lab.work"]];

const display = worldResidents(registry, "public");
const working = new Set(["mason", "lens"]);
const actors = registry.residents.map((r) => {
  const pos = r.sandbox ? nodes.find((n) => n.id === "lab.work")!.position : [homes[r.id]![0], 0, homes[r.id]![1]];
  const yaw = r.sandbox ? 0 : (Math.atan2(-pos[0]!, 14 - pos[2]!) * 180) / Math.PI; // towards the viewer side
  return { id: `res-${r.id}`, kind: "actor", style: "resident", resident: r.id, state: working.has(r.id) ? "working" : "idle", transform: { position: pos, rotation: [0, Math.round(yaw), 0] }, tags: ["resident", r.role] };
});
const workers = [
  { id: "bot-1", kind: "actor", style: "worker", label: "claude ×3", color: "#fbf8f2", state: "working", transform: { position: [2.2, 0, 2.6], rotation: [0, 200, 0] } },
  { id: "bot-2", kind: "actor", style: "worker", color: "#a6e6e6", state: "idle", transform: { position: [-2.4, 0, 2.4], rotation: [0, 150, 0] } },
];

const world = {
  tera: "world/v1",
  id: "residents",
  title: "Residents — named agents and a sandbox room",
  sky: night ? { mode: "real", time: "2026-11-18T18:30:00-08:00", lat: 37.77, lon: -122.42, moon: { scale: 2 } } : { mode: "sun", time: "2026-11-17T14:00:00-08:00", lat: 37.77, lon: -122.42 },
  environment: { exposure: 1.0, fog: { color: "#f3ead9", near: 60, far: 200 }, post: { bloom: { strength: 0.35, radius: 0.3 } } },
  entities: [
    { id: "ground", kind: "primitive", shape: "cylinder", size: [16, 0.4], transform: { position: [0, -0.2, -2] }, material: { color: "#c3cfaa", roughness: 0.95 }, tags: ["ground"] },
    { id: "square-paving", kind: "primitive", shape: "cylinder", size: [6.6, 0.04], transform: { position: [0, 0.01, -0.3] }, material: { color: "#ebe5d9", roughness: 0.9 } },
    { id: "lamp-fill", kind: "light", light: "hemisphere", color: "#fff1dd", intensity: 0.7, ...(night ? { day: true } : {}) },
    ...(night ? [{ id: "moon-fill", kind: "light", light: "hemisphere", color: "#8fa6d6", intensity: 0.32, night: true }, { id: "square-lamp", kind: "light", light: "point", color: "#ffcf8a", intensity: 9, distance: 12, night: true, transform: { position: [0, 3.2, 0] } }] : []),
    { ...room.entity, transform: { position: roomPos } },
    { id: "living", kind: "group", tags: ["living"], children: [...actors, ...workers] },
  ],
  graph: { nodes, edges },
  residents: display.residents,
  sandboxes: display.sandboxes,
  cameras: {
    default: { position: [9.5, 6.5, 12], target: [0, 0.6, -2], fov: 42 },
    lineup: { position: [0, 2.4, 9.2], target: [0, 0.8, -1.2], fov: 40 },
    close: { position: [-1.2, 1.35, 3.2], target: [-3.4, 0.85, 1.6], fov: 34 },
    room: { position: [3.2, 2.2, -1.2], target: [0, 1.0, -7.4], fov: 40 },
    top: { position: [0, 22, 6], target: [0, 0, -2], fov: 40 },
  },
};

const r = checkRegistry(registry, { graph: world.graph, entities: world.entities });
if (r.errors.length) throw new Error(r.errors.join("\n"));
WorldPack.parse(world);
const out = join(root, "worlds", night ? "residents-night" : "residents", "world.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(world, null, 1) + "\n");
console.log(`wrote ${out}`);
