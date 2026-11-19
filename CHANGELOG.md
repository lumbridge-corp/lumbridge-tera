# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-19

- Islands polish: the HUD follows the island you are on (walking, flying, riding) or looking at
  (orbit): its name and tagline, its agents, its live feed, its legend; the people count shows for
  the room you are in. Ferry rides take `period` seconds (the shuttle's pace) and have their own
  camera (`rideCamera`: three-quarter from behind leaving and arriving, out to the side mid-span
  with both islands in view, rising over anything in the way); cabins swing a little
  (`cabinSway`), riders with them. Other people riding are carried by a cabin of their own (from
  presence). Islands cross-fade between their impostor and the full world (alpha-hashed material
  clones, never the shared materials). The avatar loads islands near it only while you walk, fly or
  ride. Islands › Layers: island names are buttons and say how you get there ("by Cable car",
  "fly", "on the way").
- Performance: the live viewer draws still primitives in static batches (one mesh per material
  and space cell, colours per vertex, the originals kept on a hidden layer for picking, bounds and
  collisions), pools every flow's pulses into a few shared meshes, keeps still objects' matrices
  and updates world matrices once per frame instead of once per pass. A 1,900-mesh town drops from
  ~5,500 to ~1,300 draw calls a frame on WebGPU (~10,500 to ~2,100 on WebGL2). Anything a live op
  touches leaves its batch for good; `?batch=0` turns it all off; render mode is unchanged
  (byte-identical). `npm run smoke:perf` (fps + draw calls per camera, budget) and
  `npm run parity:batch` (batched vs unbatched pixels). See docs/viewer.md, "Draw calls".

- Polish: sandbox rooms get a roof with an overhang and a skylight, the room name on a fascia,
  a door canopy, a status lamp on a plate, a readable policy plaque beside the door, a lit
  containment ledge and back-wall furniture (`furnish`: rack, desk, bench, none). The follow
  camera stays out of geometry (with `world.layers`: it waits while a robot is between layers and
  swings to a clear pose under the ceiling when it comes out). Player name tags read from a
  world's overview (fade 80-180 m); the Layers panel counts you too.

- Islands: `world.islands` puts other worlds in the same sky, each at an offset with its own
  buildings, agents, layers, live feed and presence room. The engine composes one world
  (prefixed ids, moved paths / graph / cameras / layers, remapped living references, the island's
  global lights dropped); the live viewer loads islands lazily by distance (an impostor until
  then), lists them in an **Islands › Layers** panel and an *Islands* section of Views, and
  travels between them by **ferry** (a cabin on a route: walk to the station, ride, step out) or
  by flight; presence switches rooms with the island you are on. Render mode mounts every island
  at load. `engine.mountIsland / unmountIsland / applyIsland`, `scripts/islands-smoke.ts`,
  `worlds/islands-demo`. See [docs/islands.md](docs/islands.md) and CONTRACT.md section 1e.

- Residents: named agents with a role, home and look (`world.residents`, actor
  `style: "resident"`): a figure of their own (role colour, face, badge, halo, a prop), light name
  plates, role cards on click and an "at home" idle gesture per role. Sandbox rooms
  (`world.sandboxes`, `sandboxRoom()`): glass rooms with the policy on the door, a containment
  glow and a live occupancy line. Registries (`residents/v1`) with match rules and visibility,
  `checkRegistry()` and `worldResidents()` for per-audience display data. See
  [docs/residents.md](docs/residents.md).

- Journeys: `move.stops` sends an actor from its start through a list of stops, dwelling at each
  (`dwell` seconds, `state` working by default), to `move.to`; the whole itinerary is one route and
  the pose stays a pure function of time. Actors standing at the same stop at the same time queue
  around it (first on the node, then a ring facing it). Actor `trail` draws a fading ribbon over
  the last seconds walked; actor `card` (kind, title, detail, up to 8 label/value facts) fills the
  viewer's selection card. The viewer gets a **Journeys** toggle (**J**, `?journeys=`) for actors
  tagged `journey`, shows a robot's live activity on its card, and declutters overlapping name
  tags in live mode. CONTRACT.md section 1a.

- Adapters: `src/adapters/prometheus/` turns PromQL into world updates through bindings
  (data, not code): glow lights and switches, meters, flow rates, pulses on counters or
  timestamps, labels, plain values. A small read-only Prometheus client (instant + range,
  timeouts, backoff, size and series caps), a validator, and an evaluation loop that batches
  same-cadence queries and sends ops only on change. See
  [docs/adapters-prometheus.md](docs/adapters-prometheus.md) and CONTRACT.md section 10.
- Players: Walk and Fly modes in the live viewer (third-person figure, WASD / touch joystick,
  walls and floors respected, a follow camera that never sits inside a wall), world-level
  `layers` (floors, walk discs, spawns, ceilings) with layer travel (a `spine-car` lift ride,
  else a smooth flight), and `?presence=<url>`: other people's avatars with name tags,
  interpolated, over a pluggable transport (protocol "players/v1"). See
  [docs/players.md](docs/players.md).
- Screens: `material.screen` turns a box (+Z face) or a plane (+Y face) into a screen that
  shows a looping video, an image, a YouTube-style card (thumbnail, title, channel, LIVE /
  play / pause badge) or nothing (dark glass); the `screen` op changes it at runtime. Videos
  play only while in view in live mode and are seeked to script time in render mode, so
  renders stay deterministic. Both renderers. See [docs/screen.md](docs/screen.md).
- `tera serve` and the render host answer HTTP byte ranges (videos can seek).

## [0.2.0] - 2026-11-19

- Real sky (`sky.mode: "real"`): the sky at a real time and place. A precise sun, the moon
  with its phase, 9 096 catalogue stars, the planets, the Milky Way, Starlink and ISS
  satellites (SGP4) with trails, twilight and a deep-blue night with the moon as key light.
  Live pages follow the wall clock (`?time=`, `?timeScale=`); render mode is deterministic
  and sky ops can animate the time. See [docs/sky.md](docs/sky.md).
- Night lights: `material.night`, light `night` / `day` and `environment.nightLights.ramp`
  switch windows, lamps and signs on as the sun goes down; `info().sky` and the `tera:sky`
  event let a page follow the world into dark mode.
- Viewer: a sky time control in the HUD (local time, a 24 h scrubber, Now).
- Shapes: `segment` and `prism` primitives, radial repeats, skip lists in repeats, exact
  entity bounds in `scene_find`, and optional collars on flow pipes.
- Replay: `?replay=<url>` plays a recorded live stream in a loop, with no server
  (CONTRACT.md section 9a). The living world ships a short example replay.
- `tera render --labels fit` and `tera snapshot --labels fit` fit name tags to the screen,
  as the live viewer does.
- New example world `night`: a small plaza under the real sky of San Francisco, with a
  time-lapse camera script.
- `npm run smoke:sky`: a real-sky smoke and performance check.

## [0.1.0] - 2026-11-18

The first public release.

- Worlds as JSON plus assets: primitives, glTF models, Gaussian splats, text, lights, actors,
  flows, meters and repeats; colour, HDRI and sun skies; fog; AO, bloom, depth of field and
  tilt-shift.
- WebGPU and WebGL 2 renderers with a frame-exact render mode.
- `tera` CLI: `render`, `snapshot`, `serve`, `validate` and `clip` (HyperFrames layers).
- Camera scripts (`camera/v1`) with keyframe and orbit shots, easing and timed events.
- `tera-mcp`: an MCP server to build, inspect, snapshot and render worlds from an agent.
- Live viewer: loading screen, presets, flights, selection cards, live WebSocket feed,
  adaptive quality.
- WebXR: VR and passthrough AR on Meta Quest 3, AR on Snap Spectacles.
- Gen workers (photo → splat, photo → model, text → motion) with a mock backend for CI.
- Example worlds: `demo`, `showcase` and `living`.
