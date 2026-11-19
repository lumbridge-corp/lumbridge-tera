// Builds the islands demo (docs/islands.md): a home island, a second island ("harbor") in the same
// sky, and a cable-car ferry between them. Plain primitives only.
//   node worlds/islands-demo/tools/build.ts   -> worlds/islands-demo/world.json + harbor.json
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type V3 = [number, number, number];
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r2 = (v: number) => Math.round(v * 1000) / 1000;
const v = (a: number[]): V3 => [r2(a[0]!), r2(a[1]!), r2(a[2]!)];
const mat = (color: string, extra: Record<string, unknown> = {}) => ({ color, roughness: 0.85, ...extra });
const box = (id: string, size: number[], p: number[], color: string, extra: Record<string, unknown> = {}) => ({ id, kind: "primitive", shape: "box", size, radius: 0.08, transform: { position: v(p), ...(extra.rot ? { rotation: extra.rot } : {}) }, material: mat(color, (extra.mat as object) ?? {}) });

/** A floating island: grass disc + rock keel, top at y = 0. */
function island(prefix: string, r: number, grass: string) {
  return [
    { id: `${prefix}-top`, kind: "primitive", shape: "cylinder", size: [r, 0.6], transform: { position: [0, -0.3, 0] }, material: mat(grass, { roughness: 0.95 }), tags: ["ground"] },
    { id: `${prefix}-rim`, kind: "primitive", shape: "cylinder", size: [r + 0.05, 1.2, r - 0.4], transform: { position: [0, -1.2, 0] }, material: mat("#e4dccd", { roughness: 0.9 }) },
    { id: `${prefix}-keel`, kind: "primitive", shape: "cone", size: [r - 0.4, r * 0.9, 0.6], transform: { position: [0, -1.8 - r * 0.45, 0], rotation: [180, 0, 0] }, material: mat("#c8b392", { roughness: 0.92 }) },
  ];
}
const tree = (id: string, p: number[]) => ({ id, kind: "group", transform: { position: v(p) }, children: [
  { id: `${id}-trunk`, kind: "primitive", shape: "cylinder", size: [0.12, 1.2], transform: { position: [0, 0.6, 0] }, material: mat("#b39874") },
  { id: `${id}-crown`, kind: "primitive", shape: "sphere", size: [0.9], transform: { position: [0, 1.7, 0] }, material: mat("#a9bd96", { roughness: 0.95 }) },
] });

// ---------------------------------------------------------------- geometry of the link
const OFFSET: V3 = [60, 3, -30];
const dir = (() => { const d = Math.hypot(OFFSET[0], OFFSET[2]); return [OFFSET[0] / d, 0, OFFSET[2] / d]; })();
const at = (r: number, base: number[] = [0, 0, 0], y = 0) => v([base[0]! + dir[0]! * r, base[1]! + y, base[2]! + dir[2]! * r]);
const HANG = 2.6; // cable above the cabin floor
const homeEnd = at(12.4), islandEnd = at(-8.2, OFFSET);
const route: V3[] = [];
for (let i = 0; i <= 24; i++) {
  const u = i / 24;
  route.push(v([homeEnd[0] + (islandEnd[0] - homeEnd[0]) * u, homeEnd[1] + (islandEnd[1] - homeEnd[1]) * u - 4 * 2.2 * u * (1 - u), homeEnd[2] + (islandEnd[2] - homeEnd[2]) * u]));
}
const yaw = (Math.atan2(dir[0]!, dir[2]!) * 180) / Math.PI;
const portal = (id: string, p: V3) => ({ id, kind: "group", transform: { position: p, rotation: [0, yaw, 0] }, children: [
  { id: `${id}-l`, kind: "primitive", shape: "box", size: [0.18, HANG + 0.4, 0.18], radius: 0.04, transform: { position: [-1.1, (HANG + 0.4) / 2, 0] }, material: mat("#c9ccce", { roughness: 0.35, metalness: 0.8 }) },
  { id: `${id}-r`, kind: "primitive", shape: "box", size: [0.18, HANG + 0.4, 0.18], radius: 0.04, transform: { position: [1.1, (HANG + 0.4) / 2, 0] }, material: mat("#c9ccce", { roughness: 0.35, metalness: 0.8 }) },
  { id: `${id}-beam`, kind: "primitive", shape: "box", size: [2.6, 0.2, 0.3], radius: 0.05, transform: { position: [0, HANG + 0.4, 0] }, material: mat("#fbf8f2") },
  { id: `${id}-deck`, kind: "primitive", shape: "box", size: [2.8, 0.1, 2.4], radius: 0.04, transform: { position: [0, 0.05, 0] }, material: mat("#e3cba4", { roughness: 0.7 }) },
] });
const cable = route.slice(1).map((p, i) => ({ id: `cable-${i}`, kind: "primitive", shape: "segment", from: v([route[i]![0], route[i]![1] + HANG, route[i]![2]]), to: v([p[0], p[1] + HANG, p[2]]), radius: 0.035, material: mat("#3b3e42", { roughness: 0.45, metalness: 0.35 }) }));
const cabin = { id: "cabin", kind: "group", transform: { position: route[0], rotation: [0, yaw, 0] }, children: [
  { id: "cabin-floor", kind: "primitive", shape: "box", size: [1.5, 0.12, 1.3], radius: 0.05, transform: { position: [0, 0.06, 0] }, material: mat("#e3cba4", { roughness: 0.7 }) },
  { id: "cabin-roof", kind: "primitive", shape: "box", size: [1.6, 0.14, 1.4], radius: 0.06, transform: { position: [0, 2.05, 0] }, material: mat("#fbf8f2") },
  { id: "cabin-back", kind: "primitive", shape: "box", size: [1.5, 1.95, 0.08], transform: { position: [0, 1.04, -0.6] }, material: mat("#e3efee", { glass: true, roughness: 0.06, metalness: 0.1 }) },
  { id: "cabin-post-a", kind: "primitive", shape: "box", size: [0.08, 1.95, 0.08], transform: { position: [-0.72, 1.04, 0.62] }, material: mat("#fbf8f2") },
  { id: "cabin-post-b", kind: "primitive", shape: "box", size: [0.08, 1.95, 0.08], transform: { position: [0.72, 1.04, 0.62] }, material: mat("#fbf8f2") },
  { id: "cabin-hanger", kind: "primitive", shape: "segment", from: [0, 2.1, 0], to: [0, HANG, 0], radius: 0.05, material: mat("#c9ccce", { roughness: 0.35, metalness: 0.8 }) },
  { id: "cabin-wheel", kind: "primitive", shape: "torus", size: [0.16, 0.04], transform: { position: [0, HANG, 0], rotation: [0, 90, 0] }, material: mat("#3b3e42") },
] };
const ferry = {
  name: "Cable car",
  entities: [portal("home-station", at(12.4)), portal("harbor-station", at(-8.2, OFFSET)), ...cable, cabin],
  cabin: "cabin",
  route,
  board: at(10.6),
  alight: at(-6.6, OFFSET),
  floor: 0.12,
  period: 24,
};

const home = {
  tera: "world/v1", id: "islands-demo", title: "Hometown — a home island and a harbor in one sky",
  sky: { mode: "sun", time: "2026-06-21T16:30:00-07:00", lat: 37.77, lon: -122.42 },
  environment: { exposure: 1.05, fog: { color: "#efe6d6", near: 120, far: 380 } },
  entities: [
    { id: "fill", kind: "light", light: "hemisphere", color: "#fff6e8", intensity: 0.7 },
    ...island("home", 14, "#c3cfaa"),
    box("hall", [6, 4, 5], [-3, 2, -2], "#f3ede2"),
    box("hall-roof", [6.4, 0.4, 5.4], [-3, 4.2, -2], "#cfae80"),
    box("tower", [2, 8, 2], [3, 4, 3], "#fbf8f2"),
    { id: "beacon", kind: "primitive", shape: "sphere", size: [0.6], transform: { position: [3, 8.5, 3] }, material: { color: "#c4ec3e", emissive: "#9fc42a", glowExact: true, roughness: 0.4 } },
    tree("tree-a", [-8, 0, 5]), tree("tree-b", [6, 0, -7]), tree("tree-c", [-6, 0, 8]),
  ],
  cameras: {
    default: { position: [-38, 26, 40], target: [22, 0, -12], fov: 40 },
    overview: { position: [-38, 26, 40], target: [22, 0, -12], fov: 40 },
    town: { position: [18, 12, 20], target: [0, 1, 0], fov: 42 },
  },
  layers: [{ id: "surface", name: "Town", floorY: 0, walk: { center: [0, 0], radius: 13.4 }, spawn: [0, 0, 7], camera: "town" }],
  islands: [{
    id: "harbor", name: "Harbor", src: "harbor.json", offset: OFFSET, radius: 9.5, load: 45,
    presence: "/presence-harbor",
    impostor: [
      { id: "disc", kind: "primitive", shape: "cylinder", size: [9, 0.6], transform: { position: [0, -0.3, 0] }, material: mat("#c3cfaa") },
      { id: "keel", kind: "primitive", shape: "cone", size: [8.6, 8, 0.6], transform: { position: [0, -5, 0], rotation: [180, 0, 0] }, material: mat("#c8b392") },
      { id: "blocks", kind: "primitive", shape: "box", size: [5, 3, 4], transform: { position: [1, 1.5, 1] }, material: mat("#f3ede2") },
    ],
    ferry,
  }],
};

const harbor = {
  tera: "world/v1", id: "harbor", title: "Harbor — the second island",
  // its own lights (it can be opened on its own); dropped when mounted beside a home world
  entities: [
    { id: "sun", kind: "light", light: "directional", intensity: 2.4, transform: { position: [20, 30, 10] }, castShadow: true },
    { id: "fill", kind: "light", light: "hemisphere", color: "#fff6e8", intensity: 0.7 },
    ...island("harbor", 9, "#b2c09a"),
    { id: "shop", kind: "group", tags: ["plot", "building"], transform: { position: [2, 0, 1] }, children: [
      box("shop-body", [4.5, 3, 3.6], [0, 1.5, 0], "#f3ede2"),
      box("shop-awning", [4.8, 0.12, 1.2], [0, 2.4, 2.3], "#d2bd8c", { rot: [12, 0, 0] }),
      box("shop-door", [1, 2, 0.1], [0, 1, 1.82], "#cfae80"),
    ] },
    tree("tree", [-4, 0, -3]),
  ],
  paths: [{ id: "loop", closed: true, smooth: true, points: [[-5, 0, 0], [0, 0, -5], [5, 0, 0], [0, 0, 5]] }],
  graph: { nodes: [{ id: "plaza", position: [-2, 0, 2] }, { id: "shop.door", position: [2, 0, 3.6] }], edges: [["plaza", "shop.door"]] },
  cameras: { default: { position: [16, 10, 16], target: [0, 1, 0], fov: 40 }, overview: { position: [16, 10, 16], target: [0, 1, 0], fov: 40 } },
  layers: [{ id: "surface", name: "Harbor", floorY: 0, walk: { center: [0, 0], radius: 8.6 }, spawn: [-2, 0, 3], camera: "overview" }],
};

writeFileSync(join(OUT, "world.json"), JSON.stringify(home, null, 1) + "\n");
writeFileSync(join(OUT, "harbor.json"), JSON.stringify(harbor, null, 1) + "\n");
console.log("islands-demo: world.json + harbor.json");
