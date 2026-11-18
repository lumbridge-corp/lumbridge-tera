#!/usr/bin/env node
// Writes worlds/showcase/assets/ember-tree.splat: a small autumn tree made of Gaussian
// splats, generated from code (seeded, so the file is reproducible). No source images,
// no third-party data: the output is as licence-clean as this script (Apache-2.0).
//
//   node worlds/showcase/tools/make-splat.mjs
//
// Format: the common ".splat" layout, 32 bytes per splat:
//   float32 x, y, z | float32 sx, sy, sz (metres) | uint8 r, g, b, a | uint8 qw, qx, qy, qz (q * 128 + 128)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let seed = 0x7e4a;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => {
  const u = Math.max(1e-9, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const splats = [];
function randomQuat() {
  const u1 = rand(), u2 = rand(), u3 = rand();
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  return [s2 * Math.cos(2 * Math.PI * u3), s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3)];
}
function add(p, s, c, a, q = randomQuat()) {
  splats.push({ p, s, c, a, q });
}

// Bezier helper for trunk and branches.
const bez = (p0, p1, p2, t) => mix3(mix3(p0, p1, t), mix3(p1, p2, t), t);

const bark = [[0.24, 0.15, 0.1], [0.36, 0.24, 0.16], [0.18, 0.12, 0.09]];
function limb(p0, p1, p2, r0, r1, n) {
  for (let i = 0; i < n; i++) {
    const t = rand();
    const c = bez(p0, p1, p2, t);
    const r = lerp(r0, r1, t);
    const ang = rand() * Math.PI * 2;
    const p = [c[0] + Math.cos(ang) * r * (0.85 + 0.15 * rand()), c[1] + gauss() * 0.01, c[2] + Math.sin(ang) * r * (0.85 + 0.15 * rand())];
    const k = rand();
    const col = k < 0.5 ? mix3(bark[0], bark[1], k * 2) : mix3(bark[0], bark[2], (k - 0.5) * 2);
    const sz = lerp(0.03, 0.014, t);
    add(p, [sz, sz * 1.6, sz], col, 0.95);
  }
}

// Trunk and three main branches.
const top = [0.12, 1.55, 0.05];
limb([0, 0, 0], [0.05, 0.8, 0], top, 0.13, 0.07, 6000);
const crowns = [
  { c: [0.15, 2.45, 0.1], r: 0.85 },
  { c: [-0.65, 2.05, 0.25], r: 0.6 },
  { c: [0.85, 2.1, -0.2], r: 0.62 },
  { c: [0.1, 2.0, -0.7], r: 0.55 },
  { c: [-0.2, 2.15, 0.75], r: 0.55 },
  { c: [0.55, 2.75, 0.45], r: 0.5 },
  { c: [-0.45, 2.8, -0.3], r: 0.5 },
];
for (const cr of crowns) limb(top, mix3(top, cr.c, 0.5).map((v, i) => v + (i === 1 ? 0.15 : 0)), cr.c, 0.06, 0.02, 900);
// Roots flaring into the ground.
for (let k = 0; k < 5; k++) {
  const a = (k / 5) * Math.PI * 2 + 0.3;
  limb([0, 0.3, 0], [Math.cos(a) * 0.18, 0.06, Math.sin(a) * 0.18], [Math.cos(a) * 0.42, 0.0, Math.sin(a) * 0.42], 0.08, 0.025, 500);
}

// Canopy: clustered leaves, ember reds at the edge, gold inside, a little green left.
const leafCols = [
  [0.95, 0.42, 0.12], // ember orange
  [0.85, 0.22, 0.1], // red
  [0.98, 0.68, 0.2], // gold
  [0.62, 0.55, 0.18], // olive
];
for (const cr of crowns) {
  const n = Math.round(4200 * cr.r);
  for (let i = 0; i < n; i++) {
    // Clumpy: pick a sub-centre, then scatter around it.
    const sub = [cr.c[0] + gauss() * cr.r * 0.45, cr.c[1] + gauss() * cr.r * 0.32, cr.c[2] + gauss() * cr.r * 0.45];
    const p = [sub[0] + gauss() * 0.09, sub[1] + gauss() * 0.07, sub[2] + gauss() * 0.09];
    const dx = p[0] - cr.c[0], dy = (p[1] - cr.c[1]) * 1.3, dz = p[2] - cr.c[2];
    const edge = Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / cr.r);
    const height = (p[1] - 1.8) / 1.4;
    let col = mix3(leafCols[2], leafCols[0], edge);
    col = mix3(col, leafCols[1], Math.max(0, edge - 0.7) * 2 * rand());
    if (rand() < 0.08) col = mix3(col, leafCols[3], 0.7);
    const lum = 0.55 + 0.45 * Math.min(1, Math.max(0, height + 0.3)) + gauss() * 0.06;
    col = col.map((v) => Math.min(1, v * lum));
    const s = 0.018 + rand() * 0.03;
    add(p, [s, s * 0.35, s * 0.8], col, 0.55 + rand() * 0.4);
  }
}
// A few fallen leaves on the ground around the trunk.
for (let i = 0; i < 1400; i++) {
  const r = Math.sqrt(rand()) * 1.5, a = rand() * Math.PI * 2;
  const col = leafCols[Math.floor(rand() * 3)].map((v) => v * (0.6 + rand() * 0.3));
  const s = 0.02 + rand() * 0.02;
  add([Math.cos(a) * r, 0.005 + rand() * 0.01, Math.sin(a) * r], [s, 0.003, s * 0.7], col, 0.9, [Math.cos(a / 2), 0, Math.sin(a / 2), 0]);
}

const buf = Buffer.alloc(splats.length * 32);
const q8 = (v) => Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
splats.forEach((sp, i) => {
  const o = i * 32;
  buf.writeFloatLE(sp.p[0], o); buf.writeFloatLE(sp.p[1], o + 4); buf.writeFloatLE(sp.p[2], o + 8);
  buf.writeFloatLE(sp.s[0], o + 12); buf.writeFloatLE(sp.s[1], o + 16); buf.writeFloatLE(sp.s[2], o + 20);
  buf[o + 24] = Math.round(sp.c[0] * 255); buf[o + 25] = Math.round(sp.c[1] * 255); buf[o + 26] = Math.round(sp.c[2] * 255);
  buf[o + 27] = Math.round(sp.a * 255);
  const [w, x, y, z] = sp.q, n = Math.hypot(w, x, y, z) || 1;
  buf[o + 28] = q8(w / n); buf[o + 29] = q8(x / n); buf[o + 30] = q8(y / n); buf[o + 31] = q8(z / n);
});
const out = fileURLToPath(new URL("../assets/ember-tree.splat", import.meta.url));
writeFileSync(out, buf);
console.log(`${splats.length} splats, ${(buf.length / 1024).toFixed(0)} KiB -> ${out}`);
