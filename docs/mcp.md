# tera-mcp — drive Tera from an agent

`tera-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server. An agent connected to
it can create worlds, change them with ops, **see** them with `snapshot`, write camera
scripts, preview them as contact sheets and render MP4s. One server process is one
session: one open world in one headless Chrome page (started when first needed, closed
when the client disconnects).

## Requirements

- Node 22.18+ (runs the TypeScript directly), Google Chrome (or set `TERA_CHROME`), `ffmpeg` for `render`.
- `npm install` in the repo. The engine is built into `dist/` on first use (or run `npm run build` once so the first call is fast).

## Environment

| variable | default | meaning |
|---|---|---|
| `TERA_WORLDS` | `~/tera-worlds` | worlds root. Every path the agent gives is resolved inside it; anything outside is refused. |
| `TERA_GEN_URL` | unset | base URL of a gen worker (CONTRACT section 7) for `gen_splat` / `gen_model`. Unset → the tools answer "no gen worker configured". |
| `TERA_CHROME` | Chrome channel | browser binary. `TERA_CHROME_FLAGS` overrides the GPU flags. |
| `TERA_AUTOSAVE` | `1` | `0` stops saving `world.json` after every `scene_apply` (then use `world_save`). |
| `TERA_ASSET_MAX_BYTES` | 500 MB | `asset_import` size cap. |
| `TERA_SNAPSHOT_DIR` | unset | keep a copy of every image the agent is shown (handy when watching an agent work). |
| `TERA_DEBUG` | unset | print stack traces of unexpected errors to stderr. |

## Add it to a client

### Claude Code

```bash
claude mcp add tera -e TERA_WORLDS=$HOME/tera-worlds -- node /path/to/lumbridge-tera/src/mcp/server.ts
# with a gen worker:
claude mcp add tera -e TERA_WORLDS=$HOME/tera-worlds -e TERA_GEN_URL=http://gpu-box:8874 -- node /path/to/lumbridge-tera/src/mcp/server.ts
```

Or, for a one-off headless run without touching your config, put this in a file and pass it with `--mcp-config`:

```json
{ "mcpServers": { "tera": { "command": "node", "args": ["/path/to/lumbridge-tera/src/mcp/server.ts"], "env": { "TERA_WORLDS": "/home/me/tera-worlds" } } } }
```

```bash
claude -p "build a small desk scene and show me a snapshot" --mcp-config tera.json --strict-mcp-config --allowedTools "mcp__tera__*"
```

The server can run on another machine (for example a box with a GPU) over ssh:
`"command": "ssh", "args": ["-T", "gpu-box", "TERA_WORLDS=~/tera-worlds exec node ~/lumbridge-tera/src/mcp/server.ts"]`.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.tera]
command = "node"
args = ["/path/to/lumbridge-tera/src/mcp/server.ts"]
env = { TERA_WORLDS = "/home/me/tera-worlds" }
startup_timeout_sec = 30
tool_timeout_sec = 600   # render and gen_* take minutes
```

### Others (Cursor, Claude Desktop, VS Code, any MCP client)

Use the same stdio command: `node /path/to/lumbridge-tera/src/mcp/server.ts` with the
environment above. Clients that cap tool time should allow several minutes for `render`
and `gen_*`. The server sends MCP progress notifications for both when the client asks for them.

## Tools

| tool | what it does |
|---|---|
| `world_new { id, title, template? }` | new folder under the root from `empty`, `studio` (light cyclorama, key/fill/rim, cameras default/hero/top) or `demo`; opens it |
| `world_open { path }` | open a world folder (relative to the root) |
| `world_save { path? }` | save; with `path` = save-as into a new folder (assets copied) |
| `world_get` | full world JSON |
| `scene_apply { ops }` | apply ops (CONTRACT section 2). The whole batch is validated first: one bad op → nothing applied, every problem listed by index, with hints for common mistakes. Success → `Applied 3/3 ops. +mug(primitive cylinder) ~lamp(transform → pos [..])` |
| `scene_find { query?, tag?, kind? }` | compact rows: id, kind, detail, world position, axis-aligned bounds and size (real engine bounds: models, splats and text included) |
| `camera_set { position, target, fov?, save_as? }` | live camera for snapshots; `save_as` stores a named camera |
| `snapshot { width?, height?, camera? }` | **returns a PNG** plus a line with the pose, entity count and renderer. `camera`: a name, `"auto"`, a pose, or `{ focus: "id" \| ["a","b"], view: front\|back\|left\|right\|top\|iso }` |
| `script_validate { script }` | errors + warnings (gaps, hard cuts between shots, events on unknown ids, odd sizes). `script` is an object or a file in the world |
| `script_preview { script, times?, thumb_width? }` | contact sheet PNG, each frame labelled with its time |
| `render { script, out?, size?, fps?, from?, to? }` | MP4 under the world folder (default `renders/<name>.mp4`), the script saved beside it |
| `asset_import { src, as? }` | local file or http(s) URL → `assets/`; allowlist `glb gltf spz ply splat ksplat hdr png jpg jpeg webp wav mp3`, 500 MB cap |
| `gen_splat { image, add?, position?, id? }` / `gen_model { image or prompt, ... }` | run a gen-worker job, poll, import the result, optionally add it as an entity |

Conventions the tools teach the agent: metres, Y up, ground at y = 0, rotations in
degrees, primitives centred on their position (a box of height h on the floor sits at
y = h/2), primitive `size` = box `[w,h,d]`, sphere `[r]`, plane `[w,d]`, cylinder `[r,h]`,
torus `[R,tube]`, cone `[rBottom,h,rTop?]`, capsule `[r,h]` (options `arc`, `open`, `inner`, box `radius`; `repeat` for rows of copies; `material.glass` for windows). `snapshot` draws the world as it is right now
(bridge `render()`), so it never replays script events.

## A worked session

What a short agent session looks like (results abridged):

```text
> world_new { "id": "desk", "title": "Desk", "template": "studio" }
Created and opened world "desk" (studio) at ~/tera-worlds/desk
entities: cyc-floor, key, fill, rim
cameras: default, hero, top

> scene_apply { "ops": [
    { "op": "add", "entity": { "id": "desk-top", "kind": "primitive", "shape": "box", "size": [1.4, 0.04, 0.7],
      "transform": { "position": [0, 0.73, 0] }, "material": { "color": "#8b5a3c" } } },
    { "op": "add", "entity": { "id": "mug", "kind": "primitive", "shape": "cylinder", "size": [0.04, 0.1],
      "position": [0.3, 0.8, 0] } } ] }
Nothing applied — 1 problem(s):
ops[1].entity.position: unknown field — put it in transform.position

> scene_apply { ... fixed ... }
Applied 2/2 ops. +desk-top(primitive box) +mug(primitive cylinder)

> snapshot {}
[image]
camera default: position [0, 1.4, 4.2] target [0, 0.6, 0] fov 35 · 6 entities · webgl2 · 1024x576

> scene_find { "query": "desk" }
1 of 6 entities:
desk-top primitive box [1.4,0.04,0.7] #8b5a3c pos [0, 0.73, 0] bounds [-0.7, 0.71, -0.35]..[0.7, 0.75, 0.35] size [1.4, 0.04, 0.7]

> scene_apply { "ops": [{ "op": "update", "id": "mug", "set": { "transform": { "position": [0.3, 0.8, 0.1] } } }] }
Applied 1/1 ops. ~mug(transform → pos [0.3, 0.8, 0.1])

> snapshot { "camera": { "focus": "mug", "view": "front" } }
[close-up image]

> script_preview { "script": { "tera": "camera/v1", "fps": 30, "width": 1280, "height": 720, "duration": 4,
    "shots": [{ "id": "orbit", "start": 0, "end": 4, "kind": "orbit", "center": [0, 0.8, 0],
                "radius": 1.6, "height": 0.6, "fromDeg": 60, "toDeg": 120 }] } }
[contact sheet: 6 frames labelled t=0s … t=4s]

> render { "script": { ... }, "size": "640x360", "out": "renders/draft.mp4" }
Rendered ~/tera-worlds/desk/renders/draft.mp4
120 frames at 640x360 in 3.4 s
```

## Testing

- `npm run check`: unit and protocol tests with a mock engine page and a mock gen worker (no browser).
- `npm run eval:mcp`: the smoke eval. It drives the real server and headless Chrome through the official MCP client. See [scripts/mcp-eval.md](../scripts/mcp-eval.md).
- Mock gen worker for manual runs: `node src/mcp/testing/mock-gen-worker.ts 8794`, then `TERA_GEN_URL=http://127.0.0.1:8794`.
