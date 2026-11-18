# Changelog

## [Unreleased]

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
