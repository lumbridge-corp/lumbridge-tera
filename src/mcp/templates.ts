// World templates for world_new.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldPack } from "../schema/index.ts";

export const TEMPLATES = ["empty", "studio", "demo"] as const;
export type Template = (typeof TEMPLATES)[number];

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Ground, sun + sky fill, a default camera. */
function empty(id: string, title: string): WorldPack {
  return {
    tera: "world/v1",
    id,
    title,
    sky: { mode: "color", color: "#a9bccf" },
    environment: { exposure: 1 },
    entities: [
      { id: "ground", kind: "primitive", shape: "plane", size: [40, 40], material: { color: "#6d7378", roughness: 1 }, tags: ["ground"] },
      { id: "sun", kind: "light", light: "directional", color: "#fff1dc", intensity: 2.5, castShadow: true, transform: { position: [6, 10, 5] } },
      { id: "sky-fill", kind: "light", light: "hemisphere", color: "#cfe0ff", intensity: 0.7 },
    ],
    cameras: { default: { position: [6, 4, 8], target: [0, 0.5, 0], fov: 45 } },
  };
}

/**
 * Infinite-white cyclorama for product and explainer shots: floor, sky and fog share
 * one colour so the horizon disappears; soft key, fill and rim lights; a 3 m stage.
 */
function studio(id: string, title: string): WorldPack {
  const white = "#ececef";
  return {
    tera: "world/v1",
    id,
    title,
    sky: { mode: "color", color: "#dcdbdd" }, // ≈ the lit floor's tone, so floor and background meet without a line
    environment: { exposure: 1, fog: { color: "#dcdbdd", near: 14, far: 45 } },
    entities: [
      { id: "cyc-floor", kind: "primitive", shape: "plane", size: [120, 120], material: { color: white, roughness: 1 }, tags: ["ground", "studio"] },
      { id: "key", kind: "light", light: "directional", color: "#fff6ea", intensity: 2.2, castShadow: true, transform: { position: [4, 7, 5] }, tags: ["studio"] },
      { id: "fill", kind: "light", light: "hemisphere", color: "#ffffff", intensity: 0.9, tags: ["studio"] },
      { id: "rim", kind: "light", light: "directional", color: "#dfe8ff", intensity: 1.0, transform: { position: [-5, 4, -6] }, tags: ["studio"] },
    ],
    cameras: {
      default: { position: [0, 1.4, 4.2], target: [0, 0.6, 0], fov: 35 },
      hero: { position: [2.6, 1.5, 3.2], target: [0, 0.6, 0], fov: 32 },
      top: { position: [0, 5, 0.01], target: [0, 0, 0], fov: 40 },
    },
  };
}

/** Write a new world folder. Returns the world. Throws if the folder exists. */
export function createWorld(dir: string, id: string, title: string, template: Template): WorldPack {
  if (existsSync(dir)) throw new Error(`world folder already exists: ${dir} — use world_open, or pick another id`);
  let world: WorldPack;
  if (template === "demo") {
    const src = join(REPO, "worlds", "demo");
    cpSync(src, dir, { recursive: true });
    world = { ...(JSON.parse(readFileSync(join(dir, "world.json"), "utf8")) as WorldPack), id, title };
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".camera.json"))) {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (s.world) writeFileSync(join(dir, f), JSON.stringify({ ...s, world: id }, null, 2) + "\n");
    }
  } else {
    mkdirSync(dir, { recursive: true });
    world = template === "studio" ? studio(id, title) : empty(id, title);
  }
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "world.json"), JSON.stringify(world, null, 2) + "\n");
  return world;
}
