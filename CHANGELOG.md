# Changelog

## [Unreleased]

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
