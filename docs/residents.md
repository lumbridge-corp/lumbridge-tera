# Residents and sandbox rooms

Most agents in a Tera world are **worker robots**: anonymous, many, coming and going. Some
agents are characters: they have a name, a job and a home, they are there every day, and you
want to know which one is which. Those are **residents**. Agents you do not fully trust work in
**sandbox rooms**: glass rooms you can see into, with what they may do written on the door.

Code: `src/schema/residents.ts` (shapes, registry checks), `src/engine/residents.ts` +
`resident-looks.ts` (figures), `src/residents/sandbox-room.ts` (rooms),
`src/engine/viewer/model.ts` (cards). Example world: `node scripts/residents-world.ts`
(`--night`) → `worlds/residents/`.

## A resident in a world

```jsonc
"residents": [{ "id": "keeper", "name": "Keeper", "role": "steward", "home": "The hall", "homeNode": "home-keeper",
                "blurb": "Runs the house: alerts, watchdogs, the front desk." }],
"entities": [{ "id": "res-keeper", "kind": "actor", "style": "resident", "resident": "keeper", "state": "idle", "move": { "to": "home-keeper" } }]
```

| role | colour · accent | badge | at home (idle) | prop |
|---|---|---|---|---|
| steward | butter · amber | key | looks out over the town in slow sweeps, lantern raised now and then | lantern |
| maintenance | sage · teal | broom | sweeps | broom |
| simulator | lilac · violet | dice | turns a die over its hand | die |
| analyst | sky · blue | chart | reads its board | board |
| builder | apricot · orange | hammer | taps with its hammer | hammer |
| messenger | mint · green | letter | waves now and then | satchel |
| librarian | paper · ochre | book | reads | book |
| operator | champagne · gold | dial | tinkers | wrench |
| voice | rose · pink | wave | hums (sways) | — |
| sandboxed | aluminium · steel | lock | paces | — |

Any other role word gets the neutral look; `look` overrides colours, badge and size. Residents
are about 1.3 × a worker robot. They never look like the workers (no dark visor, no antenna, no
lime eyes) or like player avatars (no human head or cap): a cream face with ink eyes and a smile,
a chest badge and a halo ring are theirs alone.

Working: the role's work gesture, a small holo panel in the accent colour, the halo spins
faster. Walking: arms swing, the halo trails. Everything is a function of time: render mode stays
frame-exact and `npm run parity:render` is untouched (worker robots are drawn exactly as before).

Name plates: light pills (accent dot, name, role) over the halo — the opposite of the workers'
dark tags. In the live viewer they are fitted to the screen (`PLATE_FIT`, a touch larger than
worker tags); `?labels=fit` in renders. `label` on the actor replaces the name, `""` hides it.

Cards: clicking a resident shows its name, role, state (`working` / `out` / `at home`), blurb,
home and sandbox.

## Sandbox rooms

```ts
import { sandboxRoom } from "./src/residents/sandbox-room.ts";
const { entity, spots } = sandboxRoom({ id: "lab", name: "Glass lab", size: [4.2, 3.4], furnish: "bench",
  policy: { network: "allowlist", files: "workdir", tools: ["shell", "git"], enforcer: "container" } });
```

The room is ordinary world JSON (≈ 70–90 entities, no lights): glass walls in a pale-wood frame
(corner posts, mullions on long runs, a transom rail at the door head, a kick rail), a
warm-white roof with an overhang and a frosted skylight, a fascia over the front with the
room's **name** (the sign), a closed glass door left of centre under a slim **canopy** (a
downlight under it at night) with the **status lamp** over it, the **policy plaque** on the
glass beside the door at eye height (name, policy, the live line; 5–8 cm letters, readable
from a few steps, softly lit at night), warm light bars under the skylight (the room glows
from inside at night) and `furnish`: `rack` (server racks + a console), `desk` (a desk with
screens and a stool), `bench` (a workbench, pegboard, lamp) or `none` along the back wall.
`spots` are local points for the walking graph: `outside` the door, `inside` it, a `work`
spot and `slots` (in front of the furniture). Add a `world.sandboxes` entry with `entity` =
the room's id so its card can show the policy and who lives in it.

Live ids: `<id>-contain` (the lit ledge round the glass's foot: `CONTAIN_ON` orange when an
agent inside tried to reach out — a denied connection, a blocked syscall — `CONTAIN_OFF` a
soft sea-green when calm), `<id>-lamp`
(`LAMP_IDLE` / `LAMP_BUSY` / `LAMP_OFF`), `<id>-count` (an `update` with `text`: "3 inside").

Be honest on the plaque: `enforcer: "none"` when nothing enforces the policy yet.

## Registries and audiences

A registry (`"tera": "residents/v1"`) is the private file a world's residents come from. On top
of the display data each resident has:

- `match`: how a live feed recognises it. Globs (`*` = anything, case-insensitive, whole
  string; `globMatch()`): `units` ("host:unit"), `procs` ("host:comm" or a feed label),
  `agents` (the feed's "source:key" ids), `langfuse` ({project, trace}), `prometheus`
  (selectors). The engine checks the shape; the feed does the matching.
- `visibility`: `owner` < `member` < `guest` < `public`. An audience sees residents at or above
  its level; below it a resident shows its `publicName` (+ `publicBlurb`) or is dropped.

```ts
const { errors, warnings } = checkRegistry(registry, world);       // refs, names, home nodes, rooms
const forGuests = worldResidents(registry, "guest");                // display data for an audience
const forAll = worldResidents(registry, "public", { renameIds: (r) => slug(r.publicName!) });
```

Registries never ship inside a world: build the world's `residents` / `sandboxes` from one,
per audience, and let the server pick the variant.
