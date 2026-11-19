// tera-mcp tools (CONTRACT section 6). Argument schemas and descriptions live here.
// Descriptions are prompts: they teach the agent the units, the conventions and the
// look-fix-look loop.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fmt, fmtV } from "./bounds.ts";
import { importAsset, ASSET_EXTS } from "./assets.ts";
import { imageInput, NO_WORKER, pickOutput, runJob, type GenKind } from "./gen.ts";
import { guardPath } from "./paths.ts";
import { Session, ToolError, type CameraArg } from "./session.ts";
import { TEMPLATES } from "./templates.ts";
import type { Entity } from "../schema/index.ts";

export const INSTRUCTIONS = `Lumbridge Tera builds 3D worlds (three.js) that you can look at and render to video.

Conventions: metres, Y is up, the ground is y = 0, right-handed (+X right, -Z away from the default camera). Rotations are Euler XYZ in DEGREES. Colours are "#rrggbb". Times are seconds.
Primitives are CENTRED on transform.position: a box of height h resting on the ground needs position y = h/2; on a table top at height T it needs y = T + h/2.
Primitive size: box [width(x), height(y), depth(z)] (one number = cube), sphere [radius], plane [width, depth] lying flat, cylinder [radius, height] standing on Y, torus [radius, tube] standing in the XY plane (rotate [90,0,0] to lay it flat), cone [bottom radius, height] apex up (a third number = top radius makes a frustum, e.g. a lampshade or a tree trunk), capsule [radius, total height] along Y, prism [width, height, depth] a triangular prism (triangle in XY, apex up, depth along Z: gables, wedges). A segment is a rod between two points: {"shape":"segment","from":[x,y,z],"to":[x,y,z],"radius":r} (legs, braces, cables, mic arms; no size).
Shape options: "arc":{"start":deg,"length":deg} sweeps only part of a cylinder/cone (around Y, 0 = +Z, 90 = +X) or torus (in its plane from +X toward +Y) — arches, vaults, half-pipes; "open":true drops cylinder/cone end caps; "inner":r makes a hollow cylinder with solid walls (a thick arch = cylinder [R, depth] + inner + arc 180, rotated [90,0,0]); box "radius":r rounds its edges.
Rows of the same thing (shelves of books, fences, chairs, windows): ONE {"kind":"repeat","of":{entity},"count":[nx,ny,nz],"step":[dx,dy,dz],"jitter"?:{"seed","position","rotation","scale","color"}} entity, drawn instanced and counted as one entity. Rings (columns round a hall, a curved screen wall, spokes, braces round a mast): "radial":{"count":n,"radius":r,"axis"?:"y","startDeg"?:0,"lengthDeg"?:360} instead of count/step — each copy is turned so its local +Z faces away from the axis. "skip":[[i,j,k],...] (or copy indices) leaves cells empty (a door gap in a colonnade).

Workflow: world_new or world_open → scene_apply (add/update/remove) → snapshot to SEE the result → scene_find for exact positions and bounds → fix with update ops → snapshot again. Always look at a snapshot after changes; check that objects rest on what they sit on, do not intersect, and are in frame. Use snapshot camera {focus: "<id>"} for close-ups. Changes are saved to the world folder automatically.
For video: write a camera/v1 script, script_validate it, script_preview a contact sheet, then render.`;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Pose = z.object({
  position: Vec3.describe("camera position [x, y, z] in metres"),
  target: Vec3.describe("point the camera looks at [x, y, z]"),
  fov: z.number().min(5).max(120).optional().describe("vertical field of view in degrees, default 45"),
});
const View = z.enum(["front", "back", "left", "right", "top", "iso"]);
const CameraParam = z
  .union([
    z.string().describe('a named camera from the world (e.g. "default") or "auto" to frame every object'),
    Pose,
    z.object({ focus: z.union([z.string(), z.array(z.string())]).describe("entity id(s) to frame"), view: View.optional().describe("side to look from, default iso"), fov: z.number().min(5).max(120).optional() }),
  ])
  .optional();

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

function wrap<A>(fn: (a: A, extra: Extra) => Promise<CallToolResult>) {
  return async (a: A, extra: Extra): Promise<CallToolResult> => {
    try {
      return await fn(a, extra);
    } catch (err) {
      const e = err as Error;
      if (process.env.TERA_DEBUG && !(e instanceof ToolError)) process.stderr.write(`[tera-mcp] ${e.stack ?? e.message}\n`);
      return fail(e.message);
    }
  };
}

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };

function progress(extra: Extra) {
  const token = extra._meta?.progressToken;
  return async (p: number, total: number | undefined, message: string) => {
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: p, total, message } }).catch(() => {});
  };
}

function summarize(entities: Entity[]): string {
  const counts: Record<string, number> = {};
  const walk = (l: Entity[]) => l.forEach((e) => { counts[e.kind] = (counts[e.kind] ?? 0) + 1; if (e.kind === "group") walk(e.children); });
  walk(entities);
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "empty";
}

let kept = 0;
/** TERA_SNAPSHOT_DIR: keep a copy of every image the agent was shown (debugging agents). */
function keepImage(kind: string, png: Buffer) {
  const dir = process.env.TERA_SNAPSHOT_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(++kept).padStart(3, "0")}-${kind}.png`), png);
  } catch { /* best effort */ }
}

export interface ServerOptions { genUrl?: string; genPollMs?: number }

export function createServer(session: Session, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "tera", version: "0.0.1" }, { instructions: INSTRUCTIONS });
  const genUrl = opts.genUrl ?? process.env.TERA_GEN_URL?.trim();

  server.registerTool("world_new", {
    title: "New world",
    description: `Create a new world folder under the worlds root and open it (closes the current world).
Templates: "empty" = grey ground plane 40x40 m + sun + sky light + camera; "studio" = light-grey cyclorama look (floor and background nearly the same colour; fog fades the far floor where the engine supports fog — if a horizon line shows, frame a little lower/tighter) with key/fill/rim lights and cameras default/hero/top aimed at a ~1 m stage at the origin — use it for product shots and explainers; "demo" = a copy of the demo world (three shapes at dusk plus a camera script).
After creating, take a snapshot to see the starting point.`,
    inputSchema: {
      id: z.string().describe('folder name and world id: lowercase letters, digits, dashes, e.g. "desk-scene"'),
      title: z.string().describe("human title"),
      template: z.enum(TEMPLATES).optional().describe("default: empty"),
    },
  }, wrap(async (a) => {
    const w = await session.newWorld(a.id, a.title, a.template ?? "empty");
    return text(`Created and opened world "${w.id}" (${a.template ?? "empty"}) at ${session.requireWorld()}\nentities: ${w.entities.map((e) => e.id).join(", ")}\ncameras: ${Object.keys(w.cameras ?? {}).join(", ")}`);
  }));

  server.registerTool("world_open", {
    title: "Open world",
    description: "Open an existing world folder (one containing world.json). The path is relative to the worlds root (e.g. \"desk-scene\") or absolute inside it. Closes the current world.",
    inputSchema: { path: z.string().describe("world folder, relative to the worlds root") },
  }, wrap(async (a) => {
    const w = await session.openWorld(a.path);
    return text(`Opened "${w.id}" — ${w.title} (${summarize(w.entities)}) at ${session.requireWorld()}\ncameras: ${Object.keys(w.cameras ?? {}).join(", ") || "(none)"}`);
  }));

  server.registerTool("world_save", {
    title: "Save world",
    description: "Write the current world to world.json. Changes from scene_apply are already saved automatically, so you only need this for save-as: give `path` (a new folder under the worlds root) to copy the world and its assets there and continue working on the copy.",
    inputSchema: { path: z.string().optional().describe("new folder for save-as; omit to save in place") },
  }, wrap(async (a) => text(`Saved to ${await session.save(a.path)}/world.json`)));

  server.registerTool("world_get", {
    title: "Get world JSON",
    description: "Return the full current world JSON (world/v1: sky, environment, entities, cameras). For a compact list with positions and sizes use scene_find instead.",
    inputSchema: {},
  }, wrap(async () => text(JSON.stringify(await session.world(), null, 2))));

  server.registerTool("scene_apply", {
    title: "Apply ops",
    description: `Change the world with a list of ops, applied in order. All ops are validated first; if any is invalid NOTHING is applied and every problem is listed with its op index. If the engine rejects an op, the ops before it stay applied and the result names the failing index.
Ops:
  {"op":"add","entity":{...},"parent"?:"group-id"}
  {"op":"update","id":"mug","set":{...partial entity, deep-merged...}}   e.g. {"set":{"transform":{"position":[0,0.8,0]}}}
  {"op":"remove","id":"mug"}
  {"op":"sky","set":{"mode":"color","color":"#202830"}}   modes: color {color} | sun {time ISO, lat, lon} | hdri {src} | real {time ISO|"now", lat, lon, moon?, stars?, planets?, satellites?:{src (OMM JSON / TLE file, never fetched otherwise), groups?:["starlink"|"iss"|...], visibleOnly?}, cityGlow?, timeScale?}
    real = the real sky at that time and place: sun, moon + phase, ~9000 stars, planets, Milky Way, satellites, twilight and a deep-blue night (the sun by day / the moon by night is the key light). Night in a render: {"op":"sky","set":{"time":"2026-11-18T21:00:00-08:00"}}; a dusk timelapse: {"op":"sky","set":{"time":"…T20:00:00-08:00"},"duration":10} in a script event (eases the sky time).
  {"op":"env","set":{"exposure":1.0,"fog":{"color":"#c9d4e0","near":10,"far":60}}}   fog also fades a colour sky to the fog colour at the horizon (seamless studio floors)
  {"op":"env","set":{"post":{"ao":true,"bloom":{"strength":0.6},"dof":{"focus":6,"aperture":0.03}}}}   video-quality post effects; {"post":null} removes them.
    bloom: only glowing things bloom by default (source "glow"), safe on bright scenes; strength 0.3-1. "source":"scene" + "threshold" blooms bright pixels (scene-linear; sunlit surfaces reach 1.5-3, use 3+).
    dof (depth): focus = camera-to-subject distance in metres; aperture = blur of the far distance as a fraction of the image width, scale-free (miniature look 0.02-0.05 at any distance); "maxBlur" cap (0.012).
    dof (tilt-shift, the diorama look, best for town overviews): {"mode":"tiltshift","center":0.5 (0 top..1 bottom),"band":0.2,"falloff":0.3,"blur":0.008}
Entity: {"id":"lowercase-id","kind":...,"transform":{"position":[x,y,z],"rotation":[rx,ry,rz] degrees,"scale":n|[x,y,z]},"tags"?:[...],"visible"?:bool}
  primitive: "shape":"box|sphere|plane|cylinder|torus|cone|capsule|prism|segment","size":[...],"material":{"color":"#rrggbb","roughness":0-1,"metalness":0-1,"emissive":"#rrggbb","opacity":0-1,"glass"?:true,"glow"?:n,"glowExact"?:true}, options "arc":{"start","length"} (deg), "open", "inner" (hollow cylinder), "radius" (rounded box)
    size: box [w,h,d]; sphere [r]; plane [w,d] flat on XZ; cylinder [r,h] along Y; torus [R,tube] in XY plane; cone [rBottom,h,rTop?] apex up; capsule [r, total h]; prism [w,h,d] (triangle in XY, apex up); segment: no size, "from":[x,y,z],"to":[x,y,z],"radius"?:0.05 (a rod between two points in the entity's space). Centred on position, so resting on y=Y means position y = Y + half height.
    windows/doors: "material":{"glass":true,"color":"#e6f2f0"} — clear, tinted, reflective edges, the room behind keeps its contrast (do NOT fake glass with low opacity: it vanishes or turns milky).
  screen (a TV / monitor): a box (picture on its +Z face) or plane (+Y face) with "material":{"color":"#16181b" (bezel),"screen":{"content":{"kind":"video","src":"assets/loop.mp4"} | {"kind":"image","src":"assets/a.jpg"} | {"kind":"youtube","videoId":"…","title"?,"channel"?,"live"?,"playing"?,"thumb"?:"url"} | {"kind":"panel","title"?,"subtitle"?,"status"?,"rows"?:[{"label","value"?:0..1,"text"?}],"series"?:[0..1],"accent"?,"theme"?:"dark"|"light"} | {"kind":"off"},"glare"?:0.3,"brightness"?:0.9,"youtubeThumb"?:"url with {id}"}} (or "screen":true = off)
    change what it shows: {"op":"screen","id":"tv","content":{"kind":"image","src":"assets/b.jpg"}}
  light: "light":"directional|point|spot|ambient|hemisphere","color","intensity","target"?:[x,y,z],"castShadow"?, point/spot: "distance"?: m where it reaches zero (0 = unlimited), "decay"?: 2 physical; "night":true = on only at night (streetlights), "day":true = on only by day (fill lights)
  night look (sun/real sky): "material":{"color":"#1c2330","night":{"emissive":"#ffcf8a","intensity":1.2}} — windows that glow after sunset (fades in from +2° to −6° sun elevation; environment.nightLights.ramp changes it)
  repeat: "of":{entity, its id is only a label},"count":[nx,ny,nz] (or n),"step":[dx,dy,dz],"jitter"?:{"seed":1,"position":m or [x,y,z],"rotation":deg (around Y) or [x,y,z],"scale":±fraction,"color":0..1}   copies a primitive/model/text/group in a grid, e.g. 40 books: {"id":"books","kind":"repeat","transform":{"position":[0,1.1,0]},"of":{"kind":"primitive","shape":"box","size":[0.04,0.3,0.22],"material":{"color":"#b85c38"}},"count":[40,1,1],"step":[0.045,0,0],"jitter":{"seed":3,"scale":0.08,"color":0.6}}
    radial instead of count/step: "radial":{"count":n,"radius":r,"axis"?:"x|y|z","startDeg"?,"lengthDeg"?} (around y: 0 = +Z, 90 = +X; full circle = evenly spaced, partial = first at start, last at start+length; local +Z faces out), e.g. 12 columns: {"id":"cols","kind":"repeat","of":{"kind":"primitive","shape":"cylinder","size":[0.12,3],"transform":{"position":[0,1.5,0]}},"radial":{"count":12,"radius":4}}; "skip":[[i,j,k]] or [index,...] leaves copies out.
  model: "src":"assets/x.glb"   splat: "src":"assets/x.spz"   (import files first with asset_import)
  text: "text","size" (m),"color","align","billboard"?
  group: "children":[entities] — children positions are relative to the group (build a lamp from parts, then move the group). To hinge a part (a laptop lid, a door), make it a child group whose origin sits on the hinge, offset the part inside it, then rotate that group.
update deep-merges: {"set":{"transform":{"rotation":[0,30,0]}}} keeps the current position.
Living world (paths, robots, data flows, load meters):
  {"op":"path","set":{"id":"main-st","points":[[x,y,z],...],"closed"?:bool,"smooth"?:bool}}   a named route in WORLD coordinates (add or replace); {"op":"path","remove":"main-st"}
  {"op":"graph","nodes":[{"id":"cafe","position":[x,0,z]},...],"edges":[["cafe","dock"],{"from":"dock","to":"lab","path":"main-st"}]}   street graph (nodes added/moved by id, edges added); "removeNodes":[ids]
  actor: {"kind":"actor","style":"worker"(built-in robot)|"model"(+ "src" .glb),"color"?,"label"?:"agent-1","state"?:"idle|walking|working","transform":{"position":[x,0,z]},
          "move"?:{"to":"lab"} walk the shortest graph route from the nearest node | {"path":"main-st"} follow a path; + "speed" m/s (1.2), "startT" script s, "offset" m, "loop" (closed paths loop; else back and forth), "dwell" s at each end doing "state"}
    e.g. a robot walking from the cafe to the lab, working on arrival: {"op":"add","entity":{"id":"bot-1","kind":"actor","transform":{"position":[0,0,0]},"state":"working","move":{"from":"cafe","to":"lab","speed":1.4}}}
    In camera-script events give "startT" (= the event time) so the walk starts then.
  flow: {"kind":"flow","path":"pipe-a","rate":3 pulses/s,"speed":4 m/s,"color":"#9dff3a","size":0.08 m,"style":"dots|dashes|comet","glow"?:true,"pipe"?:true|{"radius","color","opacity"}}   light pulses streaming along a path (inside a glass pipe with "pipe")
  meter: {"kind":"meter","value":0..1,"style":"bar|ring","size":[length|radius, thickness],"color"? (default green→amber→red),"vertical"?}   e.g. machine load; update "value" to change it
  material.glow: emissive intensity (e.g. 2); without "emissive" the primitive glows in its own colour. Add "glowExact":true to keep a glow strip saturated (exactly its colour on screen; glow then only drives bloom).
  resident: {"kind":"actor","style":"resident","resident":"<world.residents id>",...} a NAMED agent (world.residents: name, role, look, home): role-coloured figure with a halo, badge and prop, a light name plate, a role card on click; idle = its role's "at home" gesture. Without a known id: the neutral look with "label" + "color".
  actor lanes: walkers keep ~0.25-0.45 m right of the route centre line and step around each other; "move":{"lane":0} walks exactly on the line.
Units metres, Y up, ground at y=0. After applying, call snapshot to check the result.`,
    inputSchema: {
      ops: z.array(z.record(z.string(), z.unknown())).describe("list of op objects, see the tool description"),
    },
  }, wrap(async (a) => {
    const r = await session.apply(a.ops);
    if (r.validation) return fail(`Nothing applied — ${r.validation.length} problem(s):\n${r.validation.join("\n")}`);
    if (!r.ok) return fail(`Applied ${r.applied} of ${r.total}; op ${r.applied} failed: ${r.error?.replace(/^op \d+:\s*/, "") ?? "unknown error"}. Ops before it stayed applied.\nchanges: ${r.diff}`);
    return text(`Applied ${r.applied}/${r.total} ops. ${r.diff}`);
  }));

  server.registerTool("scene_find", {
    title: "Find entities",
    description: `List entities with world-space position and axis-aligned world bounds (min..max, metres; a rotated object's box is larger than the object itself — the shape's own size is shown too) so you can place things precisely: e.g. a mug on a table goes at y = table bounds max y + mug half height. Filters are optional and combine (query matches id, tags and detail, case-insensitive; a matching group also lists its children). Bounds come from the engine's real geometry: primitives, models, splats, text and groups all have sizes (a model that failed to load shows bounds "?").`,
    inputSchema: {
      query: z.string().optional().describe("substring of id, tag or detail"),
      tag: z.string().optional(),
      kind: z.enum(["primitive", "model", "splat", "text", "light", "group", "repeat", "actor", "flow", "meter"]).optional(),
    },
  }, wrap(async (a) => {
    const { rows, total } = await session.find(a);
    if (!rows.length) return text(`No match (world has ${total} entities).`);
    const lines = rows.map((r) => {
      const b = r.bounds ? ` bounds ${fmtV(r.bounds.min)}..${fmtV(r.bounds.max)} size ${fmtV(r.bounds.max.map((v, i) => v - r.bounds!.min[i]!))}` : r.kind === "light" ? "" : " bounds ?";
      return `${r.id} ${r.kind} ${r.detail} pos ${fmtV(r.position)}${b}${r.parent ? ` in ${r.parent}` : ""}${r.tags ? ` tags ${r.tags.join(",")}` : ""}${r.visible ? "" : " hidden"}`;
    });
    return text(`${rows.length} of ${total} entities:\n${lines.join("\n")}`);
  }));

  server.registerTool("camera_set", {
    title: "Set camera",
    description: "Move the live camera that snapshot uses when called without `camera`. Give `save_as` to also store the pose as a named camera in the world (usable by snapshot camera and camera scripts). Tip: a camera at eye height looks from about y = 1.6; for tabletop objects use a target near the table top.",
    inputSchema: { ...Pose.shape, save_as: z.string().optional().describe("store as a named camera, e.g. \"closeup\"") },
  }, wrap(async (a) => {
    await session.setCamera({ position: a.position, target: a.target, fov: a.fov }, a.save_as);
    return text(`Camera at ${fmtV(a.position)} looking at ${fmtV(a.target)}, fov ${a.fov ?? 45}${a.save_as ? `; saved as "${a.save_as}"` : ""}. Call snapshot to see it.`);
  }));

  server.registerTool("snapshot", {
    title: "Snapshot",
    description: `Render the world now and return the image so you can SEE it. Use after every batch of changes. camera: omit for the live camera (camera_set, else the world's "default"); a named camera; "auto" to frame all objects; a pose {position, target, fov}; or {focus: "id" or ["a","b"], view: front|back|left|right|top|iso} for a close-up framed on those entities. Default size 1024x576.`,
    inputSchema: {
      width: z.number().int().min(64).max(2048).optional(),
      height: z.number().int().min(64).max(2048).optional(),
      camera: CameraParam,
    },
  }, wrap(async (a) => {
    const r = await session.snapshot({ width: a.width, height: a.height, camera: a.camera as CameraArg | undefined });
    keepImage("snapshot", r.png);
    return { content: [{ type: "image", data: r.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: r.text }] };
  }));

  const ScriptParam = z.union([z.string().describe("path of a camera/v1 JSON file in the world folder"), z.record(z.string(), z.unknown()).describe("a camera/v1 script object")]);
  const scriptHelp = `A script is {"tera":"camera/v1","fps":30,"width":1920,"height":1080,"duration":s,"shots":[...],"events"?:[{"t":s,"ops":[...]}],"audio"?:{"src":"narration.wav"}}.
Shots (must not overlap): {"id","start","end","kind":"keys","path":"catmull|linear","ease","keys":[{"t" (absolute seconds within the shot),"position","target","fov"}]} or {"id","start","end","kind":"orbit","center":[x,y,z],"radius","height" (above center),"fromDeg","toDeg","fov","ease"}; the orbit camera sits at center + [radius·cos θ, height, radius·sin θ], so θ=0 is on +X, θ=90 on +Z (in front, the side the default cameras look from), θ=180 on -X; increasing θ turns from +X toward +Z. To continue smoothly from a keys shot, start the orbit at the angle and distance where that shot ended. Eases: linear inQuad outQuad inOutQuad inCubic outCubic inOutCubic inOutSine.`;

  server.registerTool("script_validate", {
    title: "Validate camera script",
    description: `Check a camera script against the schema and the open world. Returns errors (must fix) and warnings (gaps, events on unknown ids, odd sizes). ${scriptHelp}`,
    inputSchema: { script: ScriptParam },
  }, wrap(async (a) => {
    const c = await session.validateScript(a.script);
    const s = c.script;
    const head = c.ok ? `Valid: ${s!.duration}s, ${s!.shots.length} shot(s), ${s!.width}x${s!.height} @ ${s!.fps} fps, ${s!.events?.length ?? 0} event(s).` : `Invalid — ${c.errors.length} error(s):\n${c.errors.join("\n")}`;
    const r = head + (c.warnings.length ? `\nwarnings:\n${c.warnings.join("\n")}` : "");
    return c.ok ? text(r) : fail(r);
  }));

  server.registerTool("script_preview", {
    title: "Preview camera script",
    description: "Render a contact sheet: frames of the script at the given times tiled into one image, each labelled with its time. Use it to check framing and motion before render. Default: 6 frames spread over the duration. At most 16.",
    inputSchema: {
      script: ScriptParam,
      times: z.array(z.number().min(0)).max(16).optional().describe("seconds, e.g. [0, 2.5, 5]"),
      thumb_width: z.number().int().min(160).max(960).optional().describe("width of each frame, default 480"),
    },
  }, wrap(async (a) => {
    const r = await session.preview(a.script, a.times, a.thumb_width);
    keepImage("preview", r.png);
    return { content: [{ type: "image", data: r.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: r.text }] };
  }));

  server.registerTool("render", {
    title: "Render video",
    description: "Render the script frame by frame and write an MP4 (H.264) in the world folder. This takes real time (roughly 0.05–0.5 s per frame) — preview first, and use a small `size` like 640x360 for drafts. Returns the file path, frame count and seconds taken. The script used is saved next to the MP4.",
    inputSchema: {
      script: ScriptParam,
      out: z.string().optional().describe("output path relative to the world folder, default renders/<name>.mp4"),
      size: z.string().optional().describe('override size, e.g. "1280x720"'),
      fps: z.number().int().min(1).max(120).optional().describe("override fps"),
      from: z.number().min(0).optional().describe("start second (render a range)"),
      to: z.number().min(0).optional().describe("end second"),
    },
  }, wrap(async (a, extra) => {
    const p = progress(extra);
    const r = await session.render({ ...a, onProgress: (done, total) => (done % 10 === 0 || done === total ? void p(done, total, `frame ${done}/${total}`) : undefined) });
    return text(`Rendered ${r.out}\n${r.frames} frames at ${r.width}x${r.height} @ ${r.fps} fps in ${fmt(r.seconds)} s${r.audio ? ` with audio ${r.audio}` : ""}${r.warnings.length ? `\nwarnings:\n${r.warnings.join("\n")}` : ""}`);
  }));

  server.registerTool("asset_import", {
    title: "Import asset",
    description: `Copy a local file or download an http(s) URL into the world's assets/ folder and return its path (e.g. "assets/chair.glb") to use as a model/splat src. Allowed: ${ASSET_EXTS.join(" ")}. Max 500 MB. Re-importing the same file returns the existing path. After importing, add it with scene_apply, e.g. {"op":"add","entity":{"id":"chair","kind":"model","src":"assets/chair.glb"}}.`,
    inputSchema: {
      src: z.string().describe("absolute local path or http(s) URL"),
      as: z.string().optional().describe("file name to store it under, e.g. chair.glb"),
    },
  }, wrap(async (a) => {
    const r = await importAsset(session.requireWorld(), a.src, a.as, { maxBytes: Number(process.env.TERA_ASSET_MAX_BYTES) || undefined });
    return text(`${r.reused ? "Already imported" : "Imported"}: ${r.path} (${(r.bytes / 1e6).toFixed(2)} MB)`);
  }));

  const genTool = (name: "gen_splat" | "gen_model", kind: GenKind, description: string, input: z.ZodRawShape) =>
    server.registerTool(name, { title: name, description, inputSchema: input }, wrap(async (a: Record<string, unknown>, extra) => {
      if (!genUrl) return fail(NO_WORKER);
      const dir = session.requireWorld();
      const image = a.image as string | undefined, prompt = a.prompt as string | undefined;
      if (kind === "image_to_model" && !image && !prompt) throw new ToolError("give image (path or URL) or prompt");
      if (kind === "image_to_splat" && !image) throw new ToolError("give image (path or URL)");
      const p = progress(extra);
      const { job, outputs } = await runJob(genUrl, kind, {
        image: image ? imageInput(image, (x) => {
          const inWorld = guardPath(session.root, x, dir);
          return existsSync(inWorld) ? inWorld : guardPath(session.root, x);
        }) : undefined,
        prompt,
      }, a.params as Record<string, unknown> | undefined, { pollMs: opts.genPollMs, onProgress: (v, st) => p(v, 1, st) });
      const out = pickOutput(kind, outputs);
      const id = (a.id as string | undefined) ?? `${kind === "image_to_splat" ? "splat" : "model"}-${job.id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
      const asset = await importAsset(dir, out.url, `${id}.${out.format}`);
      let line = `Job ${job.id} done → ${asset.path}`;
      if (a.add) {
        const entity = { id, kind: kind === "image_to_splat" ? "splat" : "model", src: asset.path, ...(a.position ? { transform: { position: a.position } } : {}) };
        const r = await session.apply([{ op: "add", entity }]);
        line += r.ok && !r.validation ? `\nAdded entity "${id}". Take a snapshot to see it.` : `\nImported, but adding failed: ${r.validation?.join("; ") ?? r.error}`;
      } else line += `\nAdd it with {"op":"add","entity":{"id":"${id}","kind":"${kind === "image_to_splat" ? "splat" : "model"}","src":"${asset.path}"}}`;
      return text(line);
    }));

  const genCommon = {
    id: z.string().optional().describe("entity id / file name for the result"),
    add: z.boolean().optional().describe("add the result to the world as an entity"),
    position: Vec3.optional().describe("where to add it [x, y, z]"),
    params: z.record(z.string(), z.unknown()).optional().describe("worker-specific parameters"),
  };
  genTool("gen_splat", "image_to_splat",
    "Turn one photo into a Gaussian splat world/scene via the configured gen worker (TERA_GEN_URL), import it into assets/, and optionally add it. Slow (minutes). image: a path relative to the world folder (e.g. assets/photo.jpg), a path inside the worlds root, or an http(s) URL (png/jpg/webp).",
    { image: z.string().describe("image path (relative to the world folder, e.g. assets/photo.jpg) or URL"), ...genCommon });
  genTool("gen_model", "image_to_model",
    "Make a 3D model (.glb) of one object from an image or a text prompt via the configured gen worker (TERA_GEN_URL), import it into assets/, and optionally add it. Slow (minutes). Generated models come in at their own scale: check with snapshot and scale with an update op.",
    { image: z.string().optional().describe("image path (relative to the world folder, e.g. assets/photo.jpg) or URL"), prompt: z.string().optional().describe("text description, if no image"), ...genCommon });

  return server;
}

