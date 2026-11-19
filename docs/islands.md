# Islands in one sky

A world can name other worlds that float in the same sky: **islands**. Each is a normal
`world/v1` file with its own buildings, agents, layers and live feed; the world that names them
(the *home* world) places each at an offset, draws a light stand-in (an impostor) until you come
near, and can link it with a **ferry** — a cabin on a route (a cable car, an airship, a tram on a
bridge) that people ride across. One sky, one time of day, one fog: the home world's.

Typical use: a server that knows who may see what builds the home world per session and lists
only the islands that session may visit (the engine never decides access).

```jsonc
"islands": [{
  "id": "harbor",                          // [a-z0-9-], no dots; composed ids are "harbor.<id>"
  "name": "Harbor",
  "src": "harbor.json",                    // its own world, relative to this world's URL
  "offset": [60, 3, -30],                  // its origin in this world's frame (translation only)
  "radius": 9.5,                           // its footprint (m, x/z)
  "load": 260,                             // live viewer: load within this distance (default 260), unload at 1.25x
  "live": "wss://…/live?world=harbor",     // its live feed while loaded (optional)
  "presence": "/presence?world=harbor",    // its presence room (optional)
  "impostor": [ …entities, island-local… ],
  "ferry": {
    "name": "Cable car",
    "entities": [ …towers, cable, stations, the cabin… ],   // THIS world's frame
    "cabin": "cabin",                      // a top-level entity of `entities`, moved along `route`
    "route": [[12.4, 0, -6.2], …, [52.7, 3, -26.3]],        // the cabin origin's path, home end first
    "board": [10.6, 0, -5.3],              // where riders step in (home side)
    "alight": [54.1, 3, -27.0],            // where they step out (island side)
    "floor": 0.12,                         // riders' feet above the cabin origin
    "period": 40                           // seconds per crossing (shuttling on its own, and ridden)
  }
}]
```

Up to 8 islands. The demo: `worlds/islands-demo` (`node worlds/islands-demo/tools/build.ts`).

## Composition

The engine draws one composed world (`src/engine/islands.ts`, pure and tested):

| from the island | in the composed world |
|---|---|
| entities | under a group `<id>` (tags `island`, `island:<id>`, `island-full`) at `offset`; ids `<id>.<entity id>` |
| actors | posed in world space: `transform.position` + offset; `move.path/to/from/stops`, `resident` remapped |
| flows | lifted to the top level (they draw along world paths; parents' transforms never move them) |
| global lights (`directional`, `hemisphere`, `ambient`, any depth) | **dropped**: the home world lights the sky. Point and spot lights stay |
| paths, graph nodes | `<id>.<path>`, points + offset; edges remapped |
| cameras | `<id>.<camera>` + offset (the island's `default` never replaces the home one) |
| layers | `<id>.<layer>`: floor + offset y, walk centre + offset x/z, spawn + offset, `camera` remapped |
| residents, sandboxes | `<id>-<resident id>` (resident ids have no dots); `homeNode`, `sandbox`, `entity` remapped |
| sky, environment, legend, title | ignored |

So an island world can also be opened on its own (it carries its own sun and fill lights for
that). An island not mounted is its `impostor` (ids `<id>.impostor.<id>`, island-local). A ferry's
entities are mounted with its ref whether or not the island is loaded, as `<id>.ferry.<id>`
(the cabin: `<id>.ferry.<cabin>`). An island whose id clashes with a top-level entity of the home
world (`<id>` or `<id>.…`) is skipped with a warning. A world without islands composes to itself
(render mode is pixel-identical).

**Ops.** Live ops for an island use the island's own ids and go to its own world
(`engine.applyIsland(id, ops)`), which is then recomposed; actor tweens move with the offset.

## Live viewer

- **Lazy loading** (`viewer/islands.ts`): an island loads when the camera (or your avatar, while
  you walk, fly or ride: not while it waits at its spawn in Orbit) comes within `load` metres of
  its footprint and goes back to its impostor beyond 1.25x that — never the island you are on or
  one a trip is heading to; the island the orbit camera looks at (its view in Views) loads from
  twice that distance. Its `live` feed is connected while it is loaded (a snapshot remounts
  it). The swap is a **cross-fade** (`viewer/fade.ts`, 1.8 s): the old look stays as a ghost and
  dissolves while the new one comes in (alpha-hashed clones of each mesh's material, so shared
  materials are never touched; none with reduced motion or from inside the footprint). An
  impostor cut from the island's own big shapes makes the fade nearly invisible.
- **HUD**: the title, tagline, agent count, live dot and legend follow the island you are on
  (walking, flying, riding) or, in Orbit, the one the camera looks at (`islandAt` of the orbit
  target): its own world's title once loaded, else the ref's name. The people count shows only
  for the presence room you are in.
- **Islands › Layers**: the layers panel lists the home world (named by its title, the part
  before " — ") and each island; an island with several layers shows its name and its layers, one
  with a single layer (or not loaded yet) is one button.
- **Travel**: a layer on another island is reached by its ferry when one links the two — walk to
  `board` (the cabin comes back to meet you), step in, ride along `route` (`period` seconds when
  the ferry has one, else length / 7 m/s, 6–30 s), step out at `alight`, walk to the spawn — else
  by a flight in an arc. Fly mode can fly across freely; switching to Walk over an island lands on
  its layer.
- **Riding** (`rideCamera`): leaving and arriving, a three-quarter view from behind and beside the
  cabin looking ahead into the next station; mid-span the camera swings out to the side (the side
  the home world's default camera looks from) and up, the cabin in the middle, the island behind
  on one edge and the one ahead on the other (a portrait view, a phone, rises behind the cabin and
  looks along the cable instead: the cabin low, the island ahead above it). A slow drift
  keeps it alive; it rises over anything between it and the cabin. The cabin swings gently
  (`cabinSway`: most mid-span, still in the stations) and the rider with it.
- **Ferries** shuttle on their own while nobody rides (`ferryAt`: dwell, cross, dwell, back);
  the motion is local to each page. Other people riding (a player of your presence room on the
  cable, `nearestOnRoute`) ride a cabin too: the shuttle comes to carry the first one, a copy of
  the cabin carries each other one.
- **Presence** is one room at a time: the island you are on (`?presence=` at home, the ref's
  `presence` on an island). The wire stays island-local: layer ids and positions of that
  island's own world, so each room's server checks them against its own world.
- **Views** gets an *Islands* section: the home view and each island (its `overview` camera
  once loaded, else its footprint framed from the home view's bearing). An island's own cameras
  are not listed under Views.
- `teraViewer.state().islands` = `[{ id, name, loaded, live, here }]`;
  `teraViewer.player.travel("<id>.<layer>")` or `travelIsland("<id>")` (`""` = home).

## Render mode

`load()` fetches every island's `src` (relative to the world's URL) and mounts it in full before
the first frame, so stills and films are deterministic. Cabins stay where their entities put them.

## Engine API

```ts
engine.mountIsland(id: string, world: WorldPack): Promise<void>   // full island (or a live snapshot)
engine.unmountIsland(id: string): Promise<void>                   // back to its impostor
engine.applyIsland(id: string, ops: Op[]): Promise<{ ok, applied, error? }>
engine.islands(): { id, name, mounted }[]
engine.islandWorld(id): WorldPack | null                           // its own world (read only)
// pure (src/engine/islands.ts)
composeIslands(home, mounted: Map<id, WorldPack>) -> { world, warnings }
layerIsland(layerId, refs) -> { island, local, offset }; toLocal / toWorld; islandAt(p, refs)
ferryAt(route, t, period?, dwell?) -> { position, s, u, phase }; planFerry(...); ferryRideAt(...)
nearestOnRoute(route, p) -> { s, d }; cabinSway(t, u, moving?) -> { roll, pitch }
rideCamera(u, at, dir, side, aspect?, t?) -> { position, target, fov }
```

## Limits

Translation only (no rotation per island). Flows inside an island are lifted to the top level.
The composed world may hold more than 8 layers (each world's own list is validated). Ferry
cabins are moved locally (no ops); riders in another presence room (the island you are not on)
are not seen.
