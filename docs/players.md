# Players: walk, fly, layers and other people

The live viewer (never render mode) lets the person at the screen be **in** the world: a
small figure of their own that walks and flies, rides between a world's layers, and — with a
presence server — meets everyone else who has the same world open. Code:
`src/engine/viewer/{play,players,avatars}.ts` and `src/engine/presence.ts`. Render mode is
untouched (`npm run parity:render`).

## Modes

| mode | how | |
|---|---|---|
| **Orbit** | the existing camera (drag, wheel, presets, fly-to, idle orbit) | your figure stands where you left it |
| **Walk** | **WASD** / arrows, **Shift** runs, drag to look, wheel to zoom; a joystick on touch screens | third person: on the floor of the layer you are in, inside its walk disc, stopped by walls (glass counts; the body is a disc: probes along its centre and both sides at knee and chest height, so it cannot slip past the corner of a narrow cabinet), the camera pulled in front of anything between it and your head |
| **Fly** | **WASD** in the look direction, **Space** / **E** up, **Q** / **C** down, **Shift** ×3.2; ▲▼ buttons on touch screens | free flight; never below the floor (nor above the ceiling) of the layer you are in, never into solid geometry (the rock under an island, walls) |

**V** cycles the modes, **F** switches walk ↔ fly, **Esc** goes back to Orbit; the bar at the
bottom does the same. Picking a view (keys 1–9, Views) returns to Orbit. Double-click fly-to
only works in Orbit (in Walk and Fly a drag looks around). With `prefers-reduced-motion` the
figure doesn't bob, the camera doesn't lag and layer travel is short.

## Layers — `world.layers` (CONTRACT.md 1c)

```jsonc
"layers": [
  { "id": "street",     "name": "Street",     "floorY": 0,  "walk": { "center": [0, 0], "radius": 24 }, "spawn": [-4, 0, 2.4], "camera": "street" },
  { "id": "underworks", "name": "Underworks", "floorY": -6, "walk": { "center": [1, 0], "radius": 22 }, "spawn": [-6, -6, 0.6], "camera": "tunnel", "height": 5.5 }
]
```

- `floorY` — the flat floor people walk on. `walk` — the disc (world x, z) they stay inside.
  `spawn` — where they arrive (players are spread out around it). `height` — the room's clear
  height (a ceiling for flying and for the camera); omit it for open sky. `camera` — a
  `world.cameras` key that frames the layer.
- Up to 8 layers, unique ids, the spawn inside its disc and not under its floor (zod checks).
- A world without `layers` walks on one implicit ground layer at y = 0 around its content.
- The HUD lists the layers (top floor first) with how many people are on each (you included,
  with presence on: the same people the title bar counts). Choosing one
  travels there: if the world has an entity **`spine-car`** (a lift car), you walk into it,
  it rides to the other floor (the car really moves, on your screen) and you walk out at the
  spawn; without one, a smooth arcing flight takes you to the spawn.

## Your figure and everyone else's

A friendly human-sized figure (1.6 m: a round head with a face, a soft cap, a bean body in
the player's colour, swinging arms and legs; arms out like a glider when flying) — never
confused with the little worker robots (actors). Other people are interpolated ~120 ms in
the past between the states the server relays, so movement is smooth at 10 Hz. Name tags
are small labels over the head: at most the nearest 8, fading out between 80 m and 180 m (so a
friend is still named from a world's overview camera),
never drawn for yourself. The HUD shows how many people are here (hover: their names).

## Presence — `?presence=<ws url or path>` (protocol "players/v1")

Off unless the page has the flag; the engine has no server address of its own.
`presence.ts` takes any transport (`webSocketTransport(url)`, or your own object with
`send` / `close`), so another carrier can be plugged in.

Client → server, JSON text, at most 10 Hz while moving and a heartbeat every 4 s when still:

```jsonc
{ "type": "state", "layer": "street", "position": [x, y, z], "heading": 90, "mode": "walk" }   // heading: degrees, 0 = +Z
```

Server → client:

```jsonc
{ "type": "welcome", "v": 1, "you": { "id", "name", "color" }, "players": [Player], "resume": State | null, "max": 20 }
{ "type": "join", "player": Player }                    // Player = { id, name, color, layer, position, heading, mode }
{ "type": "states", "players": [{ "id", "layer", "position", "heading", "mode" }] }   // batched
{ "type": "leave", "id": "…" }
{ "type": "reject", "reason": "layer" | "bounds" | "rate" }   // the client goes back to the first layer's spawn
```

- `resume` puts you back where you were (same layer) after a reload or reconnect.
- Everything received is validated (ids, layers, finite numbers, names ≤ 32 printable
  characters, at most 64 players); names are shown as text, never as HTML.
- Reconnects with backoff (0.6 s → 15 s); a policy close (1008, 4401, 4403) stops retrying.
- What a server should enforce (the engine can't): who may join, which layers each person
  may enter or see, message size and rate, a player cap, and never sending anyone's email.

## Tests

- `npm run check` — walking (speed, disc, sliding along walls), flying (floors, ceilings,
  rock), the follow camera, interpolation, name tags, layer travel plans, the schema, the
  presence parser and client (throttle, heartbeat, reconnect).
- `npm run smoke:players` — headless Chrome on the living world: the HUD, walking into the
  lab wall, flying down to the floor, flying and riding a `spine-car` lift to the Underworks, two browsers seeing each
  other through a presence hub served by Playwright's WebSocket routing, reduced motion and a
  360 px touch screen (`--shots <dir>` saves screenshots).

## Islands

With `world.islands` (docs/islands.md) the layers panel becomes **Islands › Layers**, travel to
another island rides its ferry (or flies), and presence is one room per island: the page is in
the room of the island it is on (`?presence=` at home, the island's `presence` elsewhere) and
speaks that island's own layer ids and local positions.
