# The live viewer

What people see when they open a Tera world in a browser (live mode: no `?mode=render`).
Code: `src/engine/viewer/` (loaded on demand, so render mode never runs any of it).
Render mode stays pixel-identical: `npm run parity:render` builds `origin/main` next to this
checkout and compares frame hashes of the demo, showcase and living worlds on both renderers.

## What it does

| | |
|---|---|
| Loading screen | `world.title` (split at " — " into name + tagline), a thin bar fed by real progress (world.json bytes, then asset loads started/finished, then the first frame), a status line. Fades out once two frames have been drawn with every asset loaded. Errors (no WebGPU/WebGL 2, world failed to load, live feed unreachable before the first snapshot) show a message and **Try again**. |
| HUD | Title, live dot (green *live*, amber *reconnecting*, red *offline*; only with `?live=`), visible agents (actors with `visible` ≠ false), flow legend (`world.legend`, hidden when absent), Views, idle orbit, screenshot (PNG of the current frame), fullscreen (where the browser allows it), VR / AR (only when `navigator.xr` supports the session; reopens the page with `?xr=`). Light and dark follow the system. Safe-area insets, no overflow at 360 px. |
| Camera presets | `world.cameras` in file order (`default` is *Home*, or *Overview* when an `overview` camera is the same pose), then every visible group tagged `plot`, framed from its bounds and looked at from outside the island. Keys **1–9**. Flights are eased swings around the target (0.8–2.2 s by distance and turn); a drag or the wheel takes the camera back. The last view is remembered per world in localStorage. Authored cameras are pulled back up to 1.5× on portrait screens. |
| Fly to | Double-click / double-tap anything, or **Fly to** on the card. Robots are framed from about 50° above, turning the bearing until nothing solid is in the way, and the camera then follows the robot until another view is picked. |
| Idle orbit | After 60 s without input (`?idle=<s>`) the camera turns slowly (≈ 200 s per turn) until the next input. Toggle in the HUD (remembered). Off and disabled with `prefers-reduced-motion`. |
| Selection card | Click / tap: the nearest actor, meter or flow, else the nearest group tagged `plot`/`building`/`machine`/`hero`, else the nearest tagged group. Shows the label or a readable id, the kind, an actor's `state` and where it is heading (`move.to`), a meter's value, the meters inside a machine, tags. World JSON only, no network. Refreshes twice a second as the feed changes things. Esc closes. |
| Name tags | Actor labels never draw taller than 22 CSS px however close the camera comes, fade out below ~10 px (too small to read) and right at the camera (< 0.9–2.4 m). They were already depth tested, so buildings hide them. Pure function of the camera, so it is deterministic; render mode keeps world-size tags unless `?labels=fit`. |
| Accessibility | Every control is a real button with an `aria-label`; the views menu works with arrow keys / Home / End / Esc; focus rings; the loader is a live region with a progressbar; reduced motion shortens flights to 0.3 s and turns off auto-orbit and UI transitions. |

## Query flags (live mode)

| flag | |
|---|---|
| `?ui=0` | no viewer UI at all (kiosks, embeds); the world, adaptive quality and idle orbit still run |
| `?quality=auto` (default) `high` `medium` `low` `lower` `lowest` | adaptive, or a pinned level |
| `?idle=<seconds>` | idle-orbit delay (default 60) |
| `?labels=fit` | render mode only: fit name tags like the live viewer does |

Unchanged: `?world=`, `?live=`, `?renderer=`, `?xr=` (CONTRACT.md section 4).

## Performance policy

Levels (`src/engine/viewer/quality.ts`):

| level | pixel ratio cap | post (AO, bloom, DOF) | shadow maps |
|---|---|---|---|
| high | 2 | on | as authored |
| medium | 1.5 | on | ≤ 2048 |
| low | 1.25 | off | ≤ 1024 |
| lower | 1 | off | ≤ 1024 |
| lowest | 0.75 | off | ≤ 512 |

- The pixel ratio is never above 2 (`min(devicePixelRatio, cap)`).
- Start: desktops at *high*; touch screens whose short side is under 820 px (phones, small tablets) at *medium*.
- After the first frame: one warm-up second is ignored (shader compiles, uploads), then the median fps of each 1.5 s window decides: under 42 fps → one level down, under 24 → two. Two good windows in a row and it is settled; after that only a sustained slump (median under 30 fps over 5 s) steps down once more. It never steps back up by itself, so the picture never oscillates. Frames over 0.5 s (tab switches) are ignored; the window restarts after a resize or a hidden tab.
- Hidden tab: the render loop stops (`setAnimationLoop(null)`), and starts again when the tab is visible. XR sessions are never paused.
- XR sessions keep their own budget (no post, shadows ≤ 1024, `docs/xr.md`); the smaller shadow cap wins.
- `document.documentElement.dataset.teraQuality` shows the current level (and `teraViewer.state()` in devtools).

## Tests

- `npm run check` — unit tests for flights, framing, the quality governor, presets / selection / cards, label fitting.
- `npm run smoke:viewer` — headless Chrome on the living world: loader, presets + keys + flight + remembered view, click → card, double-click → fly-to, idle orbit, hidden-tab pause, screenshot download, `?ui=0`, reduced motion, 360 px layout, error + retry.
- `npm run parity:render` — render mode frame hashes identical to `origin/main` (`--base <ref>` for another base).
