# The real sky

`sky.mode: "real"` puts a world under the sky of a real place at a real time: the sun where it
is, the moon with its phase, the stars, the planets, the Milky Way, Starlink and the ISS going
over, and a night that is actually dark. Live pages follow the wall clock, so a town is night
when it is night; renders are deterministic, so a video can be the night version of a day one.
Contract: CONTRACT.md section 1b. Example: `worlds/night` (`tera serve worlds/night`).

```jsonc
"sky": {
  "mode": "real",
  "time": "now",                  // or "2026-11-18T17:20:00-08:00" (no zone = local clock time at lon)
  "lat": 37.77, "lon": -122.42,
  "timezone": "America/Los_Angeles",
  "satellites": { "src": "assets/starlink.omm.json" }
}
```

| field | default | |
|---|---|---|
| `time` | `"now"` | ISO or `"now"`. Render mode reads the clock once at load. |
| `lat`, `lon` | — | degrees, east positive |
| `timezone` | — | IANA zone for the viewer's clock (display only) |
| `timeScale` | 1 | sky seconds per second of script time (render) or page time (live) |
| `moon` | true | `{ "scale": 1..8 }` enlarges the disc (true size is 0.52°, a few pixels in a wide shot) |
| `stars` | true | `{ "magnitudeLimit": 6.5, "milkyWay": true }` |
| `planets` | true | Mercury, Venus, Mars, Jupiter, Saturn |
| `satellites` | none | `{ src, groups?, max? (12000), minElevation? (0), visibleOnly? (true) }` |
| `cityGlow` | 0.15 | warm night horizon; hides faint stars and the Milky Way like a real city |
| `exposureAuto` | true | exposure × (1 + 0.25 · nightness) |

## What is in it

- **Sun** — NOAA Solar Calculator (Meeus), ~0.01°, with refraction; a limb-darkened disc and
  glow; light colour and strength from the atmosphere (white at noon, amber low, off below the
  horizon, all smooth).
- **Sky** — Preetham by day (as mode `sun`); twilight built on top: the sky of a sun on the
  horizon dimming with its depression (the glow toward the set sun lingers and reddens, the
  zenith turns ozone blue), the earth's shadow and the pink belt of Venus opposite the sun;
  night is a deep blue floor (airglow), a moonlit sky (the same blue scattering, from the moon,
  by phase and height) and an optional warm city glow. The image is the background and the
  image-based light; at night the IBL is lifted with the darkness so shadows read blue, not
  black. Fog sinks into the low night sky's colour.
- **Moon** — Meeus ch. 47 (the largest terms, ~0.02°) with topocentric parallax (up to 1°);
  phase from the sun–moon elongation; the lit limb points at the sun; a procedural face with
  the real maria and rayed craters (oriented to celestial north), Lommel–Seeliger shading,
  earthshine on a crescent. At night it is the key light: cool, scaled by phase^1.5 and height,
  casting the shadows (the sky's one shadow-casting light is the sun by day, the moon by night).
- **Stars** — the Yale Bright Star Catalogue (BSC5, public domain): 9 096 stars, 77 KB packed
  (`src/engine/data/stars.ts`, built by `scripts/make-star-catalog.ts`). Placed by sidereal time
  and precession (J2000 → date), coloured by B−V, sized and brightened by magnitude, constant in
  pixels. They fill in with the sky's limiting magnitude (−4 at sunset, ~1 at −6°, 4.5 at −12°,
  6.4 dark; minus moonlight and city glow). Bright stars twinkle in live mode (more near the
  horizon); never in render mode.
- **Planets** — Schlyter's elements, a few arcminutes; magnitudes with phase.
- **Milky Way** — procedural: disc, bulge in Sagittarius, star clouds (Cygnus, Scutum, Carina),
  the Great Rift and dust lanes, in galactic coordinates; only under a dark, moonless sky.
- **Satellites** — SGP4 via satellite.js (MIT) from `src`: a JSON array of OMM objects (e.g.
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json`, saved next to the
  world or served same-origin) or TLE text. The engine never fetches element sets on its own.
  Each satellite sits at its true azimuth/elevation from lat/lon on a dome, with a 1.5 s trail.
  Brightness: standard magnitude (Starlink ≈ 6.3 at 1000 km, still-climbing "train" objects
  ≈ 4, ISS −1.8) + range + `shadowFraction` (lit only in sunlight; the penumbra fades the end
  of a train) + horizon extinction, against the limiting magnitude. `visibleOnly: false` shows
  every object above the horizon (eclipsed ones faint blue), day or night. Element sets age:
  for a live site, refresh the file every few hours.

## Time

- **Render mode**: sky time = `time` + script t × `timeScale`. Same world + script → same pixels.
  A timelapse is `timeScale` (e.g. 1200 = 20 minutes a second) or a sky op with a duration:
  `{ "t": 2, "ops": [{ "op": "sky", "set": { "time": "2026-11-18T20:00:00-08:00" }, "duration": 10 }] }`
  eases the sky time from the old value to the new one, exactly at every frame.
- **Live mode**: `"now"` follows the wall clock; an ISO time starts there and runs at
  `timeScale`. Page flags `?time=` and `?timeScale=` override. The HUD time control shows local
  time at the place, a 24 h scrubber and **Now**. Satellites hide while time runs faster than
  40× or is being scrubbed (keyframed SGP4 cannot keep up), and come back when it settles.

## Night lights

Nightness n is a smooth ramp on the sun's elevation: 0 above `environment.nightLights.ramp[0]`
(default +2°), 1 below `ramp[1]` (default −6°).

```jsonc
{ "id": "win", "kind": "primitive", "shape": "box", "size": [1.3, 1.7, 0.12],
  "material": { "color": "#1c2330", "night": { "emissive": "#ffcf8a", "intensity": 1.2 } } }
{ "id": "lamp", "kind": "light", "light": "point", "intensity": 10, "distance": 16, "night": true }
{ "id": "fill", "kind": "light", "light": "hemisphere", "intensity": 0.6, "day": true }
```

Pages: `window.addEventListener("tera:sky", e => document.body.classList.toggle("dark", e.detail.isNight))`,
or CSS `--tera-nightness` (0..1) and `html[data-tera-night="1"]`. `bridge.info().sky` has the
same state plus sun/moon positions, the sky time and the satellite count.

Intensities that read well at night (exposure 1): windows `night.intensity` 0.8–1.5, lamp heads
3–5, point lights 8–14 with `distance` 12–18, bloom strength ≤ 0.4.

## Performance

Live mode at 1280×720 on a desktop AMD GPU (headless Chrome, WebGPU): 59 fps with all 9 096 stars,
the Milky Way and 6 000 satellites (`npm run smoke:sky`). Stars are ten instanced draws (one per
magnitude band), satellites two (heads, trails); SGP4 runs on keyframes 20 s of sky time apart,
built in 2.5 ms slices per frame, positions interpolated in between and only objects near the
horizon evaluated per frame. The sky image (1024×512) is rebuilt in 3 ms row slices when the sun
or moon has moved. XR: stars to magnitude 5, ≤ 1 500 satellites; AR draws no sky.

## Tests

`npm run check` (sun/moon/sidereal/precession against Meeus and eclipses, star placement,
SGP4 against Vallado's case 00005, OMM/TLE parsing, night ramp, sky ops, radiance), and
`npm run smoke:sky` (both renderers: determinism, night lights, tera:sky, satellites; live HUD;
fps). `npm run parity:render` keeps worlds without a real sky pixel-identical.
