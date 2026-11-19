// Builds worlds/night/world.json: a small plaza under the real sky of San Francisco.
//   node worlds/night/tools/make-world.mjs > worlds/night/world.json
const E = [];
const box = (id, pos, size, material, extra = {}) => E.push({ id, kind: "primitive", shape: "box", size, transform: { position: pos, ...(extra.rot ? { rotation: extra.rot } : {}) }, material, ...(extra.tags ? { tags: extra.tags } : {}) });
E.push({ id: "ground", kind: "primitive", shape: "plane", size: [400, 400], material: { color: "#3b4236", roughness: 1 }, tags: ["ground"] });
E.push({ id: "plaza", kind: "primitive", shape: "box", size: [34, 0.1, 30], transform: { position: [0, 0.05, 0] }, material: { color: "#a39d92", roughness: 0.9 } });
E.push({ id: "street", kind: "primitive", shape: "box", size: [120, 0.06, 9], transform: { position: [0, 0.03, 19.5] }, material: { color: "#2b2d31", roughness: 0.95 } });

// buildings: [id, x, z, w, h, d, colour, facade side (+1 faces +z, -1 faces -z, "x+" faces +x)]
const B = [
  ["bakery", -11, -14, 10, 9, 8, "#d9c7a8"],
  ["tower", 1, -16, 9, 21, 9, "#c9ccd1"],
  ["flats", 12, -14, 10, 13, 8, "#b98e74"],
  ["hall", -18, 2, 8, 11, 14, "#e2dccf", "x+"],
  ["office", 19, 1, 8, 16, 12, "#9fa9b4", "x-"],
];
const windowMat = (lit) => ({ color: "#1c2330", roughness: 0.15, metalness: 0.2, night: lit ? { emissive: lit, intensity: 1.15 } : undefined });
for (const [id, x, z, w, h, d, col, side] of B) {
  box(id, [x, h / 2, z], [w, h, d], { color: col, roughness: 0.85 }, { tags: ["building"] });
  box(`${id}-roof`, [x, h + 0.15, z], [w + 0.4, 0.3, d + 0.4], { color: "#4a4d52", roughness: 0.8 });
  const cols = Math.floor((side ? d : w) / 2.2), rows = Math.floor((h - 1.5) / 3);
  const lits = ["#ffcf8a", "#ffe2b0", "#fff1d6"];
  for (let r = 0; r < rows; r++) {
    // a few windows dark, most warm: three repeats per row with skips
    const y = 2.2 + r * 3;
    const lit = lits[r % 3];
    const skip = [];
    for (let c = 0; c < cols; c++) if ((c * 7 + r * 3 + id.length) % 5 === 0) skip.push(c);
    const span = (cols - 1) * 2.2;
    let pos, step, rot;
    if (!side) { pos = [x - span / 2, y, z + d / 2 + 0.06]; step = [2.2, 0, 0]; rot = [0, 0, 0]; }
    else if (side === "x+") { pos = [x + w / 2 + 0.06, y, z - span / 2]; step = [0, 0, 2.2]; rot = [0, 90, 0]; }
    else { pos = [x - w / 2 - 0.06, y, z - span / 2]; step = [0, 0, 2.2]; rot = [0, 90, 0]; }
    E.push({ id: `${id}-win-${r}`, kind: "repeat", count: [side ? 1 : cols, 1, side ? cols : 1], step, skip: skip.map((c) => (side ? [0, 0, c] : [c, 0, 0])),
      of: { kind: "primitive", shape: "box", size: [1.3, 1.7, 0.12], transform: { rotation: rot }, material: windowMat(lit) },
      transform: { position: pos } });
  }
}
// lamp posts around the plaza (lit at night)
const lamps = [[-14, -9], [-14, 9], [0, 12], [14, -9], [14, 9], [0, -9], [-6, 16], [8, 16]];
lamps.forEach(([x, z], i) => {
  E.push({ id: `lamp-${i}`, kind: "group", transform: { position: [x, 0, z] }, children: [
    { id: `lamp-${i}-pole`, kind: "primitive", shape: "cylinder", size: [0.07, 4.2], transform: { position: [0, 2.1, 0] }, material: { color: "#2d3035", metalness: 0.6, roughness: 0.4 } },
    { id: `lamp-${i}-head`, kind: "primitive", shape: "sphere", size: [0.26], transform: { position: [0, 4.35, 0] }, material: { color: "#f3ead8", roughness: 0.3, night: { emissive: "#ffd59a", intensity: 4 } } },
    { id: `lamp-${i}-light`, kind: "light", light: "point", color: "#ffc98a", intensity: 10, distance: 16, decay: 2, night: true, transform: { position: [0, 4.1, 0] } },
  ] });
});
// trees
const trees = [[-7, 4], [6, 5], [-3, -4], [9, -3], [-10, -2], [3, 9]];
trees.forEach(([x, z], i) => {
  E.push({ id: `tree-${i}`, kind: "group", transform: { position: [x, 0, z], scale: 0.9 + (i % 3) * 0.15 }, children: [
    { id: `tree-${i}-trunk`, kind: "primitive", shape: "cylinder", size: [0.18, 2.2], transform: { position: [0, 1.1, 0] }, material: { color: "#5b4636", roughness: 0.9 } },
    { id: `tree-${i}-crown`, kind: "primitive", shape: "sphere", size: [1.5], transform: { position: [0, 3.0, 0], scale: [1, 1.15, 1] }, material: { color: "#4f6b3f", roughness: 0.95 } },
  ] });
});
// a fountain in the middle with a lit basin
E.push({ id: "fountain", kind: "group", transform: { position: [0, 0, 1] }, children: [
  { id: "fountain-basin", kind: "primitive", shape: "cylinder", size: [2.6, 0.6], inner: 2.3, transform: { position: [0, 0.3, 0] }, material: { color: "#cfc8ba", roughness: 0.7 } },
  { id: "fountain-water", kind: "primitive", shape: "cylinder", size: [2.3, 0.1], transform: { position: [0, 0.45, 0] }, material: { color: "#2f4f66", roughness: 0.05, metalness: 0.4, night: { emissive: "#3fa9d9", intensity: 0.8 } } },
  { id: "fountain-light", kind: "light", light: "point", color: "#7cc9ff", intensity: 4, distance: 7, night: true, transform: { position: [0, 1.2, 0] } },
] });

const world = {
  tera: "world/v1",
  id: "night",
  title: "Night — a plaza under the real sky of San Francisco",
  sky: {
    mode: "real", time: "2026-11-29T18:15:00-08:00", lat: 37.77, lon: -122.42, timezone: "America/Los_Angeles",
    satellites: { src: "assets/starlink.omm.json" }, cityGlow: 0.12, moon: { scale: 2 },
  },
  environment: { exposure: 1, post: { bloom: { strength: 0.35, radius: 0.3 } } },
  entities: E,
  cameras: {
    default: { position: [-15, 1.8, 17], target: [3, 9, -8], fov: 60 },
    south: { position: [3.5, 1.7, -10.5], target: [2, 10, 20], fov: 70 },
    moon: { position: [-12, 1.7, 2], target: [15, 15, -4.3], fov: 50 },
    iss: { position: [-8, 1.7, 10], target: [-1.4, 18.1, 0.6], fov: 75 },
    up: { position: [0, 1.7, 4], target: [0.5, 30, -6], fov: 85 },
    plaza: { position: [-9, 4, 14], target: [2, 2, -4], fov: 50 },
  },
};
process.stdout.write(JSON.stringify(world, null, 1) + "\n");
