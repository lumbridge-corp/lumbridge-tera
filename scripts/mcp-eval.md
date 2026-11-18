# tera-mcp smoke eval

`npm run eval:mcp` (= `node scripts/mcp-eval.ts [--keep] [--out dir]`)

It starts the real server (`src/mcp/server.ts`) over stdio with the official MCP client
SDK, plus the mock gen worker. Worlds go in a temporary `TERA_WORLDS`, which is deleted
afterwards unless you pass `--keep`. No LLM is involved, and every step is asserted:

1. `tools/list` returns exactly the 14 contract tools.
2. `world_new` with the `studio` template.
3. `scene_apply` adds 3 objects (plinth, orb, ring). The diff line names all three.
4. A bad batch is rejected whole: `ops[1].entity.position: unknown field — put it in transform.position` and `ops[2].id: no entity "nope"`.
5. A rotation-only `update` keeps the position (`~ring(transform → pos [0.3, 0.63, 0])`).
6. `scene_find` returns exact bounds for the plinth.
7. `snapshot` returns a PNG (default camera, 1024x576) and a focus close-up (640x360).
8. `script_validate` accepts a valid 2 s orbit script and gives a path-exact error for a bad one.
9. `script_preview` returns a 5-frame contact sheet.
10. `world_get` shows that script events (the orb turns green at t=1) did not leak into the saved world.
11. `render` writes a 2 s 640x360 MP4. `ffprobe` checks 60 frames, yuv420p.
12. `asset_import` imports a PNG and refuses `/etc/passwd` (extension allowlist).
13. `gen_model` against the mock worker imports `assets/gen-thing.glb` and adds it as an entity.
14. `world_open "../outside"` is refused (path guard).

Images and the MP4 are written to `out/mcp-eval/` (git-ignored). Look at them: the eval
checks that the images exist and are not blank, not that they look right.

Exit code 0 = all pass. Typical time on a desktop AMD GPU (Vulkan) is about 10 s, plus a
one-off `vite build` when `dist/` is stale.
