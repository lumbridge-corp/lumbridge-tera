# Screens

A screen is a primitive whose picture changes at runtime: a TV on a wall, a monitor on a
desk, a tablet on a table. Give a `box` (the picture is on its **+Z face**, the other faces are
a dark bezel) or a `plane` (the picture is on its **+Y face**) a `material.screen`:

```jsonc
{ "id": "tv", "kind": "primitive", "shape": "box", "size": [1.6, 0.9, 0.04], "radius": 0.01,
  "transform": { "position": [0, 1.4, -2] },
  "material": { "color": "#16181b",                  // the bezel (optional)
                "screen": { "content": { "kind": "video", "src": "assets/loop-720.mp4" },
                            "glare": 0.3, "brightness": 0.9 } } }
```

`material.screen` is `true` (a screen that is off) or:

| field | meaning |
|---|---|
| `content` | what it shows (below); none = off |
| `glare` | 0..1, reflections of the environment on the glass (default 0.3) |
| `brightness` | emissive gain of the picture (default 0.9; ACES keeps colours rich around 0.8–1.1) |
| `youtubeThumb` | URL for the thumbnail of `youtube` content without its own `thumb`; `{id}` is replaced by the video id. Resolved like asset paths. |
| `iframe` | reserved for an embedded player overlay in live mode; this version always draws the card |

Content (`ScreenContent`):

```jsonc
{ "kind": "video",   "src": "assets/loop-720.mp4", "title"?: "…" }
{ "kind": "image",   "src": "assets/poster.jpg",   "title"?: "…" }
{ "kind": "youtube", "videoId": "…", "title"?: "…", "channel"?: "…", "live"?: true, "playing"?: true, "thumb"?: "/thumb.jpg" }
{ "kind": "panel",   "title"?: "Fleet", "subtitle"?: "…", "status"?: "all up",
  "rows"?: [{ "label": "cpu", "value"?: 0.42, "text"?: "42%" }],   // ≤ 8 rows; value 0..1 draws a bar
  "series"?: [0.1, 0.3, 0.2],                                     // ≤ 120 points, 0..1: a sparkline
  "accent"?: "#a9d38a", "theme"?: "dark" | "light" }
{ "kind": "off" }
```

Change it with the `screen` op (camera-script events, the live feed, `scene_apply`):

```jsonc
{ "op": "screen", "id": "tv", "content": { "kind": "youtube", "videoId": "abc", "title": "Morning news", "channel": "Example", "live": true } }
```

The op writes the content into the entity's `material.screen.content`, so `get()`, seeking and
live snapshots always show the same thing. It fails on an id that is not a screen.

## How it looks

- The face is dark glossy glass: near-black, low roughness, the sky environment reflected at
  `glare`. Off, that is all you see.
- The picture is the face's emissive map (sRGB) at `brightness`, cover-fitted to the face:
  centred and cropped, never stretched. It is not dimmed by `material.night` and only adds a
  faint glow to the bloom pass (a lit screen, not a lamp).
- `youtube` draws a card: the thumbnail (cover), a soft dark gradient, the title (up to two
  balanced lines, ellipsis after), the channel, and a badge top-left: a red **LIVE** pill when
  `live`, else a play or pause mark when `playing` is given. Without a thumbnail (none given or
  it failed to load) the card is a calm dark backdrop with the same text. The engine requests
  only the URL you give it; serve thumbnails from your own origin if third-party requests
  matter to you.

## Panels

`panel` is a small, calm dashboard the engine draws itself, for monitors that should show
*something live* without showing anyone's real screen: a heading and a short line under it
(top left), a status pill with a dot in `accent` (top right), up to eight rows of label | bar |
value, and a sparkline along the bottom. Every word and number comes from the content, so a
live feed changes it with the `screen` op (send it when the values change, not every frame:
each op redraws one canvas). Text is fitted on one line with an ellipsis; sizes follow the
face height, so a 16:9 monitor and a 21:9 one look alike. No images, no requests.

## Video

- `<video>` muted, looping, `playsInline`, loaded with `preload="auto"`; same-origin (or CORS-
  enabled) mp4. The server should answer byte ranges (`tera serve` and the render host do).
- Live mode: a video plays only while its screen is in view (in the camera frustum, within
  160 m, visible) and the page is drawing; otherwise it pauses. If the browser refuses
  autoplay, it starts on the first click or key press.
- Render mode is deterministic: before each frame every screen video is seeked to the script
  time modulo its duration and the frame waits for it. (The clock is script time, not the time
  since the content changed.)

Both renderers (WebGPU and WebGL2) draw screens with the same materials. The test world
`worlds/screens` shows every kind: `node bin/tera.ts snapshot worlds/screens --camera close`.
