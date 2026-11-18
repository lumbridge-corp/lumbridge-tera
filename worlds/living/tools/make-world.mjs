#!/usr/bin/env node
// Generates worlds/living/world.json: a small plaza with three buildings, a street graph,
// twelve worker robots, and the Underworks tunnel below with three glowing flows in glass
// pipes. Edit here and re-run: node worlds/living/tools/make-world.mjs
import { writeFileSync } from "node:fs";

const E = [];
const box = (id, pos, size, material, extra = {}) => E.push({ id, kind: "primitive", shape: "box", size, transform: { position: pos }, material, ...extra });

// ---------------------------------------------------------------- ground with a shaft
// Slab top at y = 0, 0.5 m thick. Hole x 12..16, z -2..2 drops into the tunnel.
const paving = { color: "#b9b1a4", roughness: 0.92 };
box("ground-w", [-8, -0.25, 0], [40, 0.5, 52], paving);
box("ground-e", [21, -0.25, 0], [10, 0.5, 52], paving);
box("ground-n", [14, -0.25, -14], [4, 0.5, 24], paving);
box("ground-s", [14, -0.25, 14], [4, 0.5, 24], paving);
E.push({ id: "plaza-disc", kind: "primitive", shape: "cylinder", size: [6.4, 0.04], transform: { position: [-1, 0.02, 1] }, material: { color: "#d9d0c0", roughness: 0.8 } });
E.push({ id: "plaza-ring", kind: "primitive", shape: "torus", size: [5.5, 0.05], transform: { position: [-1, 0.045, 1], rotation: [90, 0, 0] }, material: { color: "#9dff3a", glow: 1.6 } });
// Shaft railing with a lime edge light.
const rail = { color: "#2c3038", roughness: 0.5, metalness: 0.6 };
box("rail-n", [14, 0.5, -2.1], [4.4, 1.0, 0.12], rail);
box("rail-s", [14, 0.5, 2.1], [4.4, 1.0, 0.12], rail);
box("rail-e", [16.1, 0.5, 0], [0.12, 1.0, 4.2], rail);
box("rail-glow", [14, 1.02, -2.1], [4.4, 0.04, 0.16], { color: "#9dff3a", glow: 2.5 });
box("rail-glow-s", [14, 1.02, 2.1], [4.4, 0.04, 0.16], { color: "#9dff3a", glow: 2.5 });

// ---------------------------------------------------------------- streets (graph)
const nodes = {
  lab: [-12, 0, -6.6],
  depot: [-12, 0, 6.6],
  tower: [5, 0, -10.6],
  jw: [-12, 0, 0],
  plaza: [-1, 0, 1],
  jn: [5, 0, -3],
  park: [3, 0, 9],
  shaft: [10.6, 0, 0],
};
const edges = [["lab", "jw"], ["depot", "jw"], ["jw", "plaza"], ["plaza", "jn"], ["jn", "tower"], ["jn", "shaft"], ["plaza", "park"], ["park", "shaft"]];
edges.forEach(([a, b], i) => {
  const p = nodes[a], q = nodes[b];
  const dx = q[0] - p[0], dz = q[2] - p[2];
  const len = Math.hypot(dx, dz) + 2.2;
  E.push({
    id: `street-${i}`, kind: "primitive", shape: "box", size: [2.2, 0.02, len],
    transform: { position: [(p[0] + q[0]) / 2, 0.011 + i * 0.0005, (p[2] + q[2]) / 2], rotation: [0, (Math.atan2(dx, dz) * 180) / Math.PI, 0] },
    material: { color: "#5d5f63", roughness: 0.85 },
  });
});

// ---------------------------------------------------------------- buildings
function building(id, [x, z], [w, h, d], color, doorFace) {
  box(id, [x, h / 2, z], [w, h, d], { color, roughness: 0.75 });
  box(`${id}-roof`, [x, h + 0.15, z], [w + 0.4, 0.3, d + 0.4], { color: "#3b3f46", roughness: 0.6, metalness: 0.2 });
  // Window bands (warm glow) on the door face and both sides.
  const rows = Math.floor((h - 1.6) / 1.6);
  for (let r = 0; r < rows; r++) {
    const y = 2.4 + r * 1.6;
    box(`${id}-win-${r}`, [x, y, z + doorFace * (d / 2 + 0.01)], [w * 0.78, 0.55, 0.04], { color: "#ffd9a0", glow: 1.4 });
    box(`${id}-winx-${r}`, [x + w / 2 + 0.01, y, z], [0.04, 0.55, d * 0.7], { color: "#ffd9a0", glow: 1.2 });
  }
  // Door + lime lintel.
  box(`${id}-door`, [x, 1.1, z + doorFace * (d / 2 + 0.02)], [1.6, 2.2, 0.06], { color: "#1c1f24", roughness: 0.3, metalness: 0.4 });
  box(`${id}-lintel`, [x, 2.32, z + doorFace * (d / 2 + 0.05)], [1.9, 0.08, 0.1], { color: "#9dff3a", glow: 2.4 });
  // Load meter beside the door (a live feed can set these, CONTRACT section 9).
  E.push({ id: `${id}-load`, kind: "meter", style: "bar", vertical: true, value: { lab: 0.42, depot: 0.71, tower: 0.9 }[id], size: [1.6, 0.1], transform: { position: [x + 1.35, 1.25, z + doorFace * (d / 2 + 0.1)] } });
}
building("lab", [-12, -10.5], [8, 7, 7], "#ece4d6", 1);
building("depot", [-12, 10.5], [7, 5.2, 7], "#d98f63", -1);
building("tower", [5, -14.5], [6, 10.6, 7], "#93b7cc", 1);

// Little planters and benches round the plaza.
[[-5.5, -3.8], [5.5, 6.2], [-17, 2.5]].forEach(([x, z], i) => {
  E.push({ id: `planter-${i}`, kind: "primitive", shape: "cylinder", size: [0.7, 0.5], transform: { position: [x, 0.25, z] }, material: { color: "#6f6a62", roughness: 0.9 } });
  E.push({ id: `bush-${i}`, kind: "primitive", shape: "sphere", size: [0.75], transform: { position: [x, 0.85, z] }, material: { color: "#6f9a52", roughness: 0.95 } });
});

// ---------------------------------------------------------------- the Underworks tunnel
// Runs along X under the street, z -3.2..3.2, floor y = -6, ceiling = slab underside (-0.5).
const concrete = { color: "#565b65", roughness: 0.95 };
box("tunnel-floor", [1, -6.1, 0], [46, 0.2, 7], { color: "#4a4f58", roughness: 0.55, metalness: 0 });
// Ribs: concrete pilasters every 4 m give the walls depth.
for (let i = 0; i < 12; i++) {
  const x = -20 + i * 4;
  if (x > 11 && x < 17) continue;
  box(`rib-n-${i}`, [x, -3.25, -3.1], [0.5, 5.5, 0.3], { color: "#4b505a", roughness: 0.9 });
  box(`rib-s-${i}`, [x, -3.25, 3.1], [0.5, 5.5, 0.3], { color: "#4b505a", roughness: 0.9 });
}
box("tunnel-wall-n", [1, -3.25, -3.4], [46, 5.5, 0.4], concrete);
box("tunnel-wall-s", [1, -3.25, 3.4], [46, 5.5, 0.4], concrete);
box("tunnel-end-w", [-22, -3.25, 0], [0.4, 5.5, 7], concrete);
box("tunnel-end-e", [24, -3.25, 0], [0.4, 5.5, 7], concrete);
box("tunnel-edge-n", [1, -5.98, -2.9], [46, 0.04, 0.08], { color: "#9dff3a", glow: 2 });
box("tunnel-edge-s", [1, -5.98, 2.9], [46, 0.04, 0.08], { color: "#9dff3a", glow: 2 });
for (let i = 0; i < 6; i++) {
  const x = -18 + i * 8;
  E.push({ id: `tunnel-lamp-${i}`, kind: "light", light: "point", color: "#ffc98a", intensity: 6, transform: { position: [x, -1.2, 0] } });
  box(`tunnel-lampbar-${i}`, [x, -0.62, 0], [1.4, 0.06, 0.2], { color: "#ffe2bd", glow: 3 });
}
// Machines along the south wall with ring load meters.
[[-16, 0.35], [-9, 0.62], [-2, 0.88], [5, 0.5]].forEach(([x, v], i) => {
  box(`machine-${i}`, [x, -4.9, 2.55], [2.4, 2.2, 1.1], { color: "#2a2f37", roughness: 0.4, metalness: 0.7 });
  box(`machine-${i}-face`, [x, -4.7, 1.99], [2.0, 1.6, 0.02], { color: "#0e1116", roughness: 0.2, metalness: 0.5 });
  E.push({ id: `machine-${i}-load`, kind: "meter", style: "ring", value: v, size: [0.34, 0.05], transform: { position: [x - 0.45, -4.55, 1.96] } });
  box(`machine-${i}-led`, [x + 0.55, -4.25, 1.97], [0.5, 0.06, 0.02], { color: "#62e6ff", glow: 3 });
});

const paths = [
  // Three pipes: lime (north wall, high), cyan (north wall, low), amber (drops down the shaft corner, runs the ceiling).
  { id: "pipe-lime", points: [[-21.6, -2.2, -2.75], [23.6, -2.2, -2.75]] },
  { id: "pipe-cyan", points: [[-21.6, -3.2, -2.75], [23.6, -3.2, -2.75]] },
  { id: "pipe-amber", smooth: true, points: [[15.6, 2.2, -1.6], [15.6, 0.6, -1.6], [15.6, -0.9, -1.6], [14.4, -1.4, -1.3], [8, -1.45, -1.0], [-4, -1.45, -1.0], [-21.6, -1.45, -1.0]] },
  // A walk loop round the plaza ring, and a tunnel inspection walk.
  { id: "plaza-loop", closed: true, smooth: true, points: Array.from({ length: 12 }, (_, i) => [-1 + 5.5 * Math.cos((i / 12) * Math.PI * 2), 0.04, 1 + 5.5 * Math.sin((i / 12) * Math.PI * 2)]) },
  { id: "tunnel-walk", points: [[-17, -6, 0.6], [17, -6, 0.6]] },
  { id: "tunnel-walk-2", points: [[10, -6, -0.9], [-12, -6, -0.9]] },
];
E.push({ id: "flow-lime", kind: "flow", path: "pipe-lime", rate: 3.2, speed: 5, color: "#a6ff3c", size: 0.07, style: "comet", pipe: { radius: 0.2 } });
E.push({ id: "flow-cyan", kind: "flow", path: "pipe-cyan", rate: 6, speed: 3.2, color: "#4fe3ff", size: 0.055, style: "dots", pipe: { radius: 0.17 } });
E.push({ id: "flow-amber", kind: "flow", path: "pipe-amber", rate: 4, speed: 4, color: "#ff9a1f", size: 0.06, style: "dashes", pipe: { radius: 0.17 } });
// The amber pipe starts at a junction box on the street.
box("junction", [15.6, 2.4, -1.6], [0.7, 0.7, 0.7], { color: "#2c3038", roughness: 0.4, metalness: 0.7 });
box("junction-led", [15.6, 2.4, -1.24], [0.4, 0.08, 0.02], { color: "#ffb03a", glow: 3 });
box("junction-post", [15.6, 1.0, -1.6], [0.12, 2.0, 0.12], rail);

// ---------------------------------------------------------------- workers
const A = (id, extra) => E.push({ id, kind: "actor", style: "worker", ...extra });
A("bot-agent-1", { label: "agent-1", color: "#f3efe4", state: "working", transform: { position: nodes.lab }, move: { from: "lab", to: "depot", speed: 1.3, loop: true, dwell: 3.5 } });
A("bot-agent-2", { label: "agent-2", color: "#7cc6ff", state: "working", transform: { position: nodes.tower }, move: { from: "tower", to: "lab", speed: 1.5, loop: true, dwell: 2.5, offset: 6 } });
A("bot-agent-3", { label: "agent-3", color: "#ffb547", state: "working", transform: { position: nodes.depot }, move: { from: "depot", to: "shaft", speed: 1.4, loop: true, dwell: 3, offset: 12 } });
A("bot-courier", { color: "#ff8a65", state: "working", transform: { position: nodes.park }, move: { from: "park", to: "tower", speed: 1.2, loop: true, dwell: 4, offset: 3 } });
A("bot-ring-1", { color: "#c7b6ff", move: { path: "plaza-loop", speed: 0.9, offset: 0 } });
A("bot-ring-2", { color: "#7fe0c3", move: { path: "plaza-loop", speed: 0.9, offset: 11.5 } });
A("bot-ring-3", { label: "scout", color: "#ffd84d", move: { path: "plaza-loop", speed: 0.9, offset: 23 } });
A("bot-lab-desk", { color: "#f2f5f8", state: "working", transform: { position: [-9.4, 0, -6.2], rotation: [0, 120, 0] } });
A("bot-depot-desk", { color: "#7cc6ff", state: "working", transform: { position: [-14.6, 0, 6.2], rotation: [0, -20, 0] } });
A("bot-watch", { color: "#ffb547", state: "idle", transform: { position: [11.4, 0, 2.6], rotation: [0, 120, 0] } });
A("bot-tunnel-1", { label: "indexer", color: "#7fe0c3", state: "working", move: { path: "tunnel-walk", speed: 1.1, loop: true, dwell: 3 } });
A("bot-tunnel-2", { color: "#ff8a65", state: "working", move: { path: "tunnel-walk-2", speed: 1.0, loop: true, dwell: 2.5, offset: 5 } });

const world = {
  tera: "world/v1",
  id: "living",
  title: "Living town: plaza + Underworks",
  sky: { mode: "sun", time: "2026-11-17T15:40:00-08:00", lat: 37.77, lon: -122.42 },
  environment: { exposure: 1.1, fog: { color: "#d9c9b3", near: 60, far: 220 } },
  entities: [
    ...E,
    { id: "fill", kind: "light", light: "hemisphere", color: "#ffe9cc", intensity: 0.35 },
  ],
  paths,
  graph: { nodes: Object.entries(nodes).map(([id, position]) => ({ id, position })), edges },
  cameras: {
    default: { position: [-27, 7.5, 1.5], target: [-1, 0.5, 0], fov: 44 },
    street: { position: [-5, 1.6, 8], target: [-4, 0.9, 0], fov: 45 },
    tunnel: { position: [14, -3.2, 0.5], target: [0, -3.6, 0], fov: 55 },
  },
};
writeFileSync(new URL("../world.json", import.meta.url), JSON.stringify(world, null, 1) + "\n");
console.log(`world.json: ${world.entities.length} entities, ${paths.length} paths, ${world.graph.nodes.length} nodes`);
