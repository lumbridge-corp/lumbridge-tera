# Lumbridge Tera — contract v1

> engine/polish (2026-11-18) changes this file: `dof` is scale-free with a `tiltshift` mode, `bloom`
> blooms only glow by default, material `glass` / `glowExact`, `repeat` entity, primitive `capsule`
> and `arc` / `open` / `inner` / `radius`, light `distance` / `decay`, actor lanes (`move.lane`).
>
> engine/viewer (2026-11-18) changes this file: world-level `legend` (viewer UI only), live-mode
> page flags `?ui=0` `?quality=` `?idle=`, render-mode `?labels=fit`, `tera:select` also for actors
> plus `tera:deselect`, live name tags fitted to the screen. Render mode is pixel-identical
> (`npm run parity:render`). The viewer itself: `docs/viewer.md`.

This file is the agreement between the parts of Tera. Several people and agents build
those parts at the same time; if your work needs a change here, change this file in
the same PR and say so at the top of the PR. Everything else is yours to decide.

Tera is a three.js world engine that an agent drives. One world serves two outputs:

1. **A live world on the web** (orbit, fly, click).
2. **Frame-exact video**: a camera script plays the world back one frame at a time in
   headless Chrome and ffmpeg writes the MP4.

```
 agent ──MCP──► tera-mcp (Node) ──Playwright──► engine page (browser)
                    │                               window.tera  (the bridge)
                    ├─ snapshot → PNG back to the agent
                    └─ render  → tera render → frames → ffmpeg → MP4
 gen workers (GPU boxes, HTTP) ◄── tera-mcp gen_* tools  (image → splat, image → model)
```

Units: metres, Y up, right-handed (three.js default). Angles in **degrees** in every
JSON file (the engine converts). Colours are CSS hex strings. Times are seconds.

---

## 1. World pack — `tera: "world/v1"`

A world is a folder: `world.json` plus an `assets/` folder. Paths inside `world.json`
are relative to the folder. Types live in `src/schema/world.ts` (zod) and are the source
of truth; this is the summary.

```jsonc
{
  "tera": "world/v1",
  "id": "demo",                    // [a-z0-9-]+
  "title": "Demo",
  "sky": { "mode": "sun", "time": "2026-11-17T16:30:00-08:00", "lat": 37.77, "lon": -122.42 },
     // or { "mode": "color", "color": "#0b0d12" }  or { "mode": "hdri", "src": "assets/sky.hdr" }
  "environment": { "exposure": 1.0, "fog": { "color": "#c9d4e0", "near": 40, "far": 400 },
                   "post": { "ao": true, "bloom": { "strength": 0.6 }, "dof": { "mode": "tiltshift", "center": 0.5, "band": 0.2 } } },
  "entities": [ Entity, ... ],
  "cameras": { "default": { "position": [8, 5, 10], "target": [0, 1, 0], "fov": 45 } },
  "legend": [ { "label": "requests", "color": "#c4ec3e" }, { "label": "data", "color": "#9fe6e6" } ]
}
```

`cameras` are also the live viewer's camera presets (keys 1–9, in file order; groups tagged `plot`
are added after them). `legend` (optional, ≤ 8 items, label ≤ 40 chars) is a small key in the live
viewer's HUD, typically one entry per flow colour; it is never drawn into frames.

`Entity` — every entity has `id` (unique), `kind`, optional `transform`
(`position`, `rotation` (Euler XYZ degrees), `scale` (number or [x,y,z])), optional
`visible` (default true) and optional `tags: string[]`.

| kind | extra fields |
|---|---|
| `primitive` | `shape`: `box` `sphere` `plane` `cylinder` `torus` `cone` `capsule`; `size`: number[] (below); `material`; shape options `arc` `open` `inner` `radius` (below) |
| `model` | `src`: `.glb` / `.gltf`; optional `animation` (clip name to loop) |
| `splat` | `src`: `.spz` `.ply` `.splat` `.ksplat` (Spark.js formats) |
| `text` | `text`, `size` (m), `color`, `align`: `left` `center` `right`, optional `billboard` |
| `light` | `light`: `directional` `point` `spot` `ambient` `hemisphere`; `color`, `intensity`, optional `target` [x,y,z], `castShadow`; point/spot: `distance` (m where it reaches zero, 0 = unlimited, default 0), `decay` (default 2 = physical) |
| `group` | `children`: Entity[] |
| `repeat` | `of`: Entity (copied; its `id` is only a label and may be omitted), `count`: [nx, ny, nz] (or n = [n,1,1]), `step`: [dx, dy, dz], optional `jitter` (below). Counts as ONE entity |
| `actor` | `style`: `worker` (built-in robot) `model` (+ `src` .glb); `color`, `label`, `state`: `idle` `walking` `working`, `move` (section 1a) |
| `flow` | `path` (world path id); `rate` pulses/s, `speed` m/s, `color`, `size` m, `glow`, `style`: `dots` `dashes` `comet`; `pipe`: true \| `{ radius, color, opacity }` |
| `meter` | `value` 0..1; `style`: `bar` `ring`; `size` [length\|radius, thickness]; `color` (default green → amber → red), `track`, `vertical` |

`material` (primitives only): `{ color, roughness?, metalness?, emissive?, opacity?, wireframe?, glow?, glowExact?, glass? }`.
`glow` is the emissive intensity; without `emissive` the primitive glows in its own colour.
Tone mapping (ACES) desaturates bright emissive colours toward white; `glowExact: true` makes the
glowing surface land on exactly its colour (`emissive`, else `color`) on both renderers, with or
without post (colours too saturated for ACES keep their hue at the brightest reachable level);
`glow` then only sets how much it feeds bloom. Flows, meters and robot lights do this already.
`glass: true` is clear glass: see-through with the room behind it keeping its contrast (no milky
veil), tinted by `color` (default a faint green-grey), sky reflections with a fresnel rim, a faint
outline on sharp edges so panes read; `roughness` frosts it, `opacity` is ignored. Drawn in the
transmissive pass (after opaque, before transparent: sorted correctly); transparent things behind
a pane (veils, flow pipes, labels) show through untinted. Do not fake windows with low `opacity`.

`repeat` copies a primitive, model, text, group or nested repeat into a grid: copy (i, j, k) sits at
(i·dx, j·dy, k·dz) in the repeat's space, then gets the copied entity's own transform. Every
primitive inside becomes one instanced draw for all copies. Limit 20 000 copies (nested repeats
multiply); no lights, actors, flows, meters or splats inside. `jitter`
`{ seed?, position?: m | [x,y,z], rotation?: deg (around Y) | [x,y,z], scale?: ±fraction, color?: 0..1 }`
varies each copy deterministically (same seed → same layout); rotation and scale turn about the
copy's own origin, colour shifts hue/saturation/lightness.

### 1a. Living world — paths, graph, actors, flows (`src/schema/living.ts`)

Two optional world-level fields, in **world coordinates**:

```jsonc
"paths": [ { "id": "main-st", "points": [[0,0,0], [12,0,0], [12,0,8]], "closed"?: false, "smooth"?: false } ],
          // smooth = centripetal Catmull-Rom through the points
"graph": { "nodes": [ { "id": "cafe", "position": [0,0,0] }, ... ],
           "edges": [ ["cafe", "dock"], { "from": "dock", "to": "lab", "path"?: "main-st" } ] }   // undirected
```

`actor.move` = `{ path | to, from?, speed? (m/s, 1.2), startT? (script s, 0), offset? (m), loop?, dwell? (s), lane? (m) }`:
`path` follows a named path (a closed path loops); `to` walks the shortest graph route from
`from` (default: the node nearest the actor's position). `loop` on an open route walks back
and forth, stopping `dwell` seconds at each end in `state`. Without `move` the actor stands
at `transform.position` facing `transform.rotation[1]`, doing `state`. Actors ignore parent
group transforms (paths are world space); `transform.scale` sizes them.

Crowds: a walking actor keeps to a lane `lane` metres right of the route's centre line (default
0.25–0.45 m per actor id, × scale; `0` = on the line), easing onto the line over the first/last
1.2 m of an open route, so walkers going opposite ways pass each other. Walkers closer than about
0.55 m (× scale) also step apart each frame; standing actors do not move and walkers step around
them. Both are computed from that frame's poses only, so render mode stays pose = f(t).

Time: in render mode every pose is a function of script time (frame-exact, seekable); in
live mode the clock is seconds since the page opened, and a changed `move` (or a moved
actor) continues from where the actor is drawn. A camera-script event that sends an actor
somewhere should set `move.startT` to the event time.

A flow's pulse *i* is emitted at *i*/rate and sits at s = (t − i/rate)·speed along its path;
the flow is already full at t = 0. Flows/actors/meters are additive and untonemapped where
they glow, so they read without a bloom pass.



Primitive `size`, every shape **centred on its position** (a box of height h resting on
y = 0 has position y = h/2):

| shape | size | notes |
|---|---|---|
| `box` | `[w, h, d]` | one number = cube |
| `sphere` | `[r]` | |
| `plane` | `[w, d]` | lying flat in XZ, facing +Y |
| `cylinder` | `[r, h]` | along Y; optional third = bottom radius |
| `torus` | `[R, tube]` | standing in the XY plane (rotate `[90,0,0]` to lay it flat) |
| `cone` | `[rBottom, h]` | along Y, apex up; optional third = top radius → frustum |
| `capsule` | `[r, h]` | along Y, `h` = total height including the round ends |

Shape options (primitive fields):
- `arc: { start?, length }` degrees, only part of the sweep: cylinder/cone around Y with 0 = +Z and
  90 = +X; torus in its XY plane with 0 = +X and 90 = +Y. A cut cylinder/cone without `inner` is a
  thin shell drawn double-sided (vaults, half-pipes).
- `open: true` — cylinder/cone without end caps (a tube, double-sided).
- `inner: r` — cylinder only: hollow with solid walls and end faces. A thick arch:
  `{ shape: "cylinder", size: [R, depth], inner: r, arc: { start: -90, length: 180 }, transform: { rotation: [-90, 0, 0] } }`
  stands on y = 0 with its opening along X.
- `radius: r` — box only: rounded edges.

`environment`:
- `fog` `{ color, near, far }` (metres from the camera). Under a `color` sky the background
  also fades to the fog colour at and below the horizon, so a fogged floor has no seam.
  A `color` sky shows its exact hex on both renderers.
- `post` (optional, for video quality): `ao: true` (screen-space ambient occlusion), `bloom`, `dof`.
  Deterministic (nothing temporal); both renderers run the same DOF and bloom-input formulas.
  A renderer that cannot build an effect skips it with a load warning. Live XR sessions never
  draw post effects.
  - `bloom: { strength, threshold?, radius?, source? }`. `source: "glow"` (default): only what
    glows blooms — emissive/`glow` materials, flows, meters, robot lights — rendered in a separate
    glow-only pass, so a bright sunlit or cream scene never washes out; `threshold` (default 0) on
    that glow. `source: "scene"`: every pixel whose scene-linear luminance (before tone mapping and
    exposure) is above `threshold` (default 1) — sunlit surfaces reach 1.5–3 and a cream backdrop
    ~1, so a "scene" threshold below ~3 blooms the whole frame in a bright world. Recommended for
    bright scenes: default source, `strength` 0.3–0.6, `radius` 0.2–0.4; bloom adds light that ACES
    turns toward white, so keep `strength` ≤ 0.5 where saturated glows (glowExact) must stay saturated.
  - `dof`, two modes; blur sizes are fractions of the image width (the same look at any
    resolution):
    - depth (default, `mode` omitted or `"depth"`): `{ focus, aperture, maxBlur? }`. `focus` = sharp
      distance in metres along the view direction (use the camera-to-subject distance); blur =
      `aperture · |1 − focus / d|`, capped at `maxBlur` (default 0.012). Scale-free: `aperture` is
      the blur of something infinitely far away, so the same numbers work at 2 m or 200 m.
      Subtle 0.004–0.01, miniature look 0.02–0.05. (Changed from v1's `|d − focus| · aperture`,
      which left a 106 m overview with a focus band a few centimetres deep.)
    - tilt-shift (`mode: "tiltshift"`): `{ center?, band?, falloff?, blur? }` — a sharp horizontal
      band on screen with blur growing above and below it, independent of depth: the diorama /
      miniature look. `center` = band centre from the top of the frame (0 top, 1 bottom, default
      0.5), `band` = band height (default 0.2), `falloff` = height over which blur reaches full
      (default 0.3), `blur` (default 0.008). For town overviews: `center` on the subject,
      `band` 0.15–0.3, `blur` 0.006–0.012.

## 2. Ops — the one way to change a world

Agents, camera-script events and the UI all change a world with the same ops
(`src/schema/ops.ts`). An op either applies fully or fails with a message; a list of ops
applies in order and stops at the first failure (earlier ops stay applied; the result
says which index failed).

```jsonc
{ "op": "add",     "entity": Entity, "parent"?: "group-id" }
{ "op": "update",  "id": "chair", "set": { /* partial Entity, deep-merged */ } }
{ "op": "remove",  "id": "chair" }
{ "op": "sky",     "set": { /* partial sky */ } }
{ "op": "env",     "set": { /* partial environment */ } }
{ "op": "animate", "id": "chair", "to": { "position"?, "rotation"?, "scale"? },
                   "duration": 1.5, "ease": "inOutCubic" }   // only meaningful inside a script timeline
{ "op": "path",    "set"?: PathDef, "remove"?: "path-id" }          // add/replace a world path by id, or remove one
{ "op": "graph",   "nodes"?: GraphNode[], "edges"?: GraphEdge[], "removeNodes"?: ["id"] }
                   // nodes add/move by id, edges are added (duplicates ignored), removed nodes drop their edges
```

## 3. Camera script — `tera: "camera/v1"`

`src/schema/camera.ts`. The script is the whole video: camera moves, timed world
changes, and the soundtrack. Rendering is deterministic: frame `n` is time `n / fps`,
and the same world + script + build give the same pixels.

```jsonc
{
  "tera": "camera/v1",
  "world": "demo",                       // world id it was written for (checked, warning only)
  "fps": 30, "width": 1920, "height": 1080,
  "duration": 12,
  "shots": [
    { "id": "open", "start": 0, "end": 5, "kind": "keys", "path": "catmull", "ease": "inOutCubic",
      "keys": [ { "t": 0, "position": [20, 12, 20], "target": [0, 1, 0], "fov": 40 },
                { "t": 5, "position": [6, 3, 8],    "target": [0, 1, 0], "fov": 45 } ] },
    { "id": "orbit", "start": 5, "end": 12, "kind": "orbit",
      "center": [0, 1, 0], "radius": 9, "height": 4, "fromDeg": 30, "toDeg": 150, "fov": 45, "ease": "linear" }
  ],
  "events": [ { "t": 6, "ops": [ { "op": "animate", "id": "logo", "to": { "position": [0, 3, 0] }, "duration": 1 } ] } ],
  "audio": { "src": "narration.wav", "offset": 0 },
  "marks": [ { "t": 1.2, "label": "intro" } ]     // optional; narration word timings, chapter marks
}
```

- `keys[].t` are absolute script seconds inside `[start, end]`.
- Orbit angle: position = `center + (radius·cos θ, height, radius·sin θ)`, so **θ = 0 is on
  +X, θ = 90 on +Z** (the side default cameras look from), θ = 180 on −X; growing θ turns
  from +X toward +Z.
- Shots must not overlap; a gap holds the last camera pose.
- Eases: `linear`, `inQuad` `outQuad` `inOutQuad`, `inCubic` `outCubic` `inOutCubic`, `inOutSine`.
- Events at time `t` apply once when playback crosses `t`; `seek(t)` rebuilds state by
  replaying events `<= t` from the loaded world, so seeking backwards is exact.

## 4. The bridge — `window.tera` (engine page ↔ Node)

The engine page (`index.html`, built by Vite) exposes this object. Node talks to it with
Playwright `page.evaluate`. All methods are async and JSON-in / JSON-out.
Types: `src/bridge/types.ts`.

```ts
interface TeraBridge {
  version: "bridge/v1";
  load(world: WorldPack, baseUrl?: string): Promise<{ ok: true; warnings: string[] }>;
  apply(ops: Op[]): Promise<{ ok: boolean; applied: number; error?: string }>;
  get(): Promise<WorldPack>;                         // current world incl. applied ops
  setCamera(pose: CameraPose): Promise<void>;        // live view
  setSize(width: number, height: number): Promise<void>;
  loadScript(script: CameraScript): Promise<{ ok: true; warnings: string[] }>;
  seek(t: number): Promise<void>;                    // pose + events at t, render ONE frame, resolve when pixels are final (assets loaded, splats sorted)
  render(pose?: CameraPose, width?: number, height?: number): Promise<void>;
                                                     // draw the current world (incl. applied ops, no script events) NOW, resolve when pixels are final
  bounds(ids?: string[]): Promise<Record<string, { min: Vec3; max: Vec3 } | null>>;
                                                     // world-space AABBs of real geometry (models, splats, text, groups); null = no extent (lights)
  capture(): Promise<string>;                        // PNG, base64, of the last rendered frame
  info(): Promise<{ renderer: "webgpu" | "webgl2"; entities: number; ready: boolean }>;
}
```

Page URL flags: `?live=ws://host:port` (live feed, section 9), `?mode=render` (no controls, no UI chrome, no internal clock — only
`seek` advances time), `?renderer=webgpu|webgl2|auto` (default `auto`: WebGPU when
available and the world has no splats, else WebGL2 — Spark.js 2.x is WebGL2-only).
Live mode only: `?ui=0` hides the viewer UI (loading screen, HUD, cards: for kiosks and embeds),
`?quality=auto|high|medium|low|lower|lowest` (adaptive by default), `?idle=<s>` idle-orbit delay
(default 60), see `docs/viewer.md`. Live name tags (actor `label`) are fitted to the screen (never
taller than 22 px, faded when tiny or at the camera); render mode keeps world-size tags unless
`?labels=fit` (still deterministic: a function of the camera pose only).
Live mode only: `?xr=vr|ar` adds an Enter VR / Start AR button (WebXR, WebGL2 renderer;
`&xrsize=<m>` tabletop size, `&xrwalk=<k>` walk scale, `&xrstart=table|walk`), see
`docs/xr.md`.

Events: pointing at an entity and clicking (mouse) or pulling the trigger / pinching (XR)
fires a DOM `CustomEvent("tera:select")` on `window` with
`detail = { id, point: [x,y,z] | null, source: "mouse" | "controller" | "hand" }`. Actors count:
a click on a robot selects the actor (the nearest of robot and mesh wins). A mouse click on
nothing fires `CustomEvent("tera:deselect")`.

## 5. Render CLI

```
tera render <world-dir> <script.json> -o out.mp4 [--fps N] [--size 1920x1080] [--from s --to s] [--renderer auto|webgpu|webgl2]
tera snapshot <world-dir> [--camera default|x,y,z:tx,ty,tz] [--t s --script script.json] -o shot.png
tera serve <world-dir>   # live world on http://localhost:8790
```

Headless Chrome with GPU flags; frames go to ffmpeg over a pipe (H.264, yuv420p,
`-movflags +faststart`); `audio.src` is muxed. Exit non-zero with a clear message when a
frame times out (default 30 s) or WebGPU/WebGL is unavailable.

### 5a. The page host — `src/render/host.ts` (used by the render CLI and the MCP server)

One helper starts headless Chrome around the engine so the render CLI and the MCP server
do not each write their own:

```ts
export interface OpenOptions {
  worldDir?: string;                         // served at /world/ so asset paths resolve
  width?: number; height?: number;           // default 1280x720
  renderer?: "auto" | "webgpu" | "webgl2";   // passed as ?renderer=
  mode?: "render" | "live";                  // default "render"
  headless?: boolean;                        // default true
}
export interface TeraPage {
  bridge: TeraBridge;                        // every method proxied through page.evaluate
  png(): Promise<Buffer>;                    // capture() decoded
  close(): Promise<void>;
}
export function openTera(opts?: OpenOptions): Promise<TeraPage>;
```

It serves the built engine (`dist/`, building it if missing) and the world folder from one
local static server on a free port, and it calls `bridge.load(world.json)` when
`worldDir` is given.

## 6. MCP server — `tera-mcp` (stdio)

Tool names are stable; arguments are zod schemas in `src/mcp/tools.ts`. One session
holds one open world in one headless page.

| tool | does |
|---|---|
| `world_new` `{ id, title, template? }` | new world folder from a template |
| `world_open` `{ path }` / `world_save` `{ path? }` / `world_get` | load, save, read JSON |
| `scene_apply` `{ ops }` | apply ops (section 2) |
| `scene_find` `{ query?, tag?, kind? }` | list entities (id, kind, position, bounds) |
| `camera_set` `{ position, target, fov? }` | move the live camera |
| `snapshot` `{ width?, height?, camera? }` | **returns the image** so the agent sees its work |
| `script_validate` `{ script }` | errors + warnings |
| `script_preview` `{ script, times[] }` | contact sheet image of frames at those times |
| `render` `{ script, out, size?, fps? }` | MP4 path, frames, seconds taken |
| `asset_import` `{ src, as? }` | copy a file/URL into `assets/`, return the path |
| `gen_splat` `{ image }` / `gen_model` `{ image or prompt }` | call a gen worker (section 7), import the result |

## 7. Gen workers (HTTP, any GPU box)

```
POST /v1/jobs   { "kind": "image_to_splat" | "image_to_model" | "text_to_motion", "input": { "image"?: url|base64, "prompt"?: string }, "params"?: {} }
             →  { "id": "j_..." }
GET  /v1/jobs/:id → { "id", "status": "queued"|"running"|"done"|"failed", "progress"?: 0..1, "outputs"?: [ { "url", "format" } ], "error"? }
GET  /v1/health   → { "ok": true, "models": [ { "kind", "name", "license" } ] }
```

Every worker reports the **licence** of the model it runs. Public Tera ships only
commercially usable defaults: Lyra 1 (NVIDIA Open Model License) for `image_to_splat`,
TRELLIS (MIT) for `image_to_model`. Research-only weights (e.g. Lyra 2) never ship as a
default and must be marked `"license": "research-only"` in `/v1/health`.

## 8. Repo layout

| path | module |
|---|---|
| `src/schema/` | contract (this file) — change only with this file |
| `src/engine/`, `index.html`, `worlds/` | engine |
| `src/camera/`, `src/render/`, `bin/` | camera scripts and render host |
| `src/mcp/` | MCP server |
| `workers/` | gen workers |
| `src/bridge/` | implemented by the engine, used by the render host and the MCP server |

Rules: TypeScript strict, ESM, Node ≥ 22. Dependencies need a licence compatible with
Apache-2.0 (no GPL/AGPL/non-commercial). No telemetry and no calls home. No secrets in
the repo. Tests with `node --test`. Every change leaves `npm run check` (typecheck +
tests) green.

## 9. Live feed — `?live=ws://host:port`

Off by default. With the flag the live page (not render mode) opens a WebSocket and applies
what the server sends. One JSON object per message (`src/schema/living.ts` `LiveMessage`,
parsed by `src/engine/live.ts` `parseLiveMessage`):

```jsonc
{ "type": "snapshot", "world": WorldPack, "seq"?: 1 }   // replace the whole world; the viewer's camera is kept
{ "type": "ops", "ops": Op[], "seq"?: 2 }               // section 2 ops, applied in order (same as bridge.apply)
{ "type": "ping" }                                      // keep-alive, ignored
```

- Send a `snapshot` first on every (re)connect, then `ops` as things happen. Messages are
  applied strictly in arrival order; a bad message is logged and skipped (never fatal).
- Actor changes tween: an `update` that changes `move` (e.g. `{"move":{"to":"lab"}}`) or
  `transform.position` makes the actor walk there from where it is drawn. Meter `value`
  changes ease over ~0.3 s.
- Reconnect: exponential backoff 0.5 s → 10 s (±20 % jitter), reset on open. A dot in the
  viewer HUD shows the state: green live, amber (re)connecting, red offline (none with `?ui=0`).
- Example — a worker starts a job in the lab: `{"type":"ops","ops":[{"op":"update","id":"bot-agent-1","set":{"move":{"to":"lab"},"state":"working"}}]}`;
  host load: `{"type":"ops","ops":[{"op":"update","id":"lab-load","set":{"value":0.83}}]}`.
