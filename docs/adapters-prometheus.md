# Prometheus adapter: metrics drive the world

`src/adapters/prometheus/` turns PromQL into entity updates, configured as data rather than
written as code. Anything you already track in Prometheus can light a lamp, fill a meter,
speed up a pipe, pulse a ring or change a sign in a Tera world.

It runs in Node (a live feed server, a recorder, a test). It never imports three.js, has no
dependencies, and only reads from Prometheus.

```ts
import { readFileSync } from "node:fs";
import { BindingLoop, PromClient, validateBindings } from "./src/adapters/prometheus/index.ts";

const { bindings, errors } = validateBindings(JSON.parse(readFileSync("bindings.json", "utf8")));
if (errors.length) throw new Error(errors.join("\n"));
const loop = new BindingLoop({ client: new PromClient({ url: "http://prometheus:9090" }), bindings });
loop.setEntities(allEntityIds(world)); // bindings whose entities are missing go quiet
setInterval(async () => {
  for (const ops of await loop.tick()) broadcast({ type: "ops", ops }); // CONTRACT.md section 9
}, 1000);
// a page that just connected: for (const ops of loop.welcome()) send({ type: "ops", ops })
```

## Bindings

A binding file is a JSON array, or `{ "bindings": [...] }`. Keys that start with `//` are
comments. A file is all or nothing: one invalid binding rejects the whole file, and every
error names the binding and the field.

```jsonc
{
  "bindings": [
    // a status light: lime while the site answers, dark grey when it does not
    { "id": "site.up", "query": "min(probe_success{job=\"site\"})", "every": 30,
      "kind": "glow", "entity": "site-light", "when": { "op": "==", "value": 1 },
      "on":  { "color": "#c4ec3e", "emissive": "#9fc42a", "glow": 0.9 },
      "off": { "color": "#5c6064", "emissive": "#2b2d30", "glow": 0 } },
    // a meter: CPU 0..1
    { "id": "box.cpu", "query": "1 - avg(rate(node_cpu_seconds_total{mode=\"idle\"}[2m]))",
      "every": 15, "kind": "meter", "entity": "meter.box.cpu" },
    // a pipe: requests/s, log scale, 0 hides the flow
    { "id": "api.rps", "query": "sum(rate(http_requests_total[2m]))", "every": 15,
      "kind": "flow", "entity": "flow.api", "range": [0, 200], "scale": "log", "rate": [0.5, 4] },
    // a heartbeat: the ring flashes whenever the backup timestamp moves forward
    { "id": "backup.done", "query": "max(backup_last_success_timestamp_seconds)", "every": 60,
      "kind": "pulse", "entity": "backup-ring", "pulse": { "peak": 3, "base": 0.4, "seconds": 1.5 } },
    // a sign
    { "id": "api.latency", "query": "max(probe_duration_seconds{job=\"api\"})", "every": 30,
      "kind": "label", "entity": "api-sign", "label": { "format": "API {value} ms", "multiply": 1000 } },
    // one light per service, picked by a label value; series for other values are dropped
    { "id": "svc", "query": "min by (service) (up{job=\"svc\"})", "every": 30, "kind": "glow",
      "labelMap": { "label": "service", "map": { "api": "light-api", "db": "light-db" } },
      "when": { "op": "==", "value": 1 } },
    // a number for your own code (loop.value("alerts")), drives nothing
    { "id": "alerts", "query": "count(ALERTS{alertstate=\"firing\"}) or vector(0)", "kind": "value" }
  ]
}
```

| field | default | meaning |
|---|---|---|
| `id` | required | `[a-z0-9._-]`, ≤ 64, unique in the file |
| `query` | required | PromQL, run as an instant query (≤ 4000 chars) |
| `every` | 30 | seconds between runs (5..3600) |
| `kind` | required | `glow` `meter` `flow` `pulse` `label` `value` (below) |
| `entity` | | the entity driven. Give `entity` or `labelMap` (not for `value`) |
| `labelMap` | | `{ label, map: { "<label value>": "<entity id>" } }`: one entity per series, matched exactly. A label value is only used for this lookup; it never reaches the world |
| `reduce` | `max` | several series for one entity: `max` `min` `sum` `avg` `count` |
| `range` | `[0, 1]` | the input domain: values are clamped to it and normalised to 0..1 |
| `scale` | `linear` | `linear`, `sqrt` or `log` (log1p over the range) |
| `when` | | `{ op: > >= < <= == !=, value }`: a switch (glow on/off, flow shown/hidden, pulse on its rising edge) |
| `on` / `off` | glow top / bottom | glow with `when`: material partials for each state. Allowed keys: `color` `emissive` `glow` `opacity` `roughness` `metalness` `night` (`emissive`, `intensity`) |
| `glow` | `[0.2, 2]` | glow: `material.glow` at normalised 0 and 1 |
| `rate` | `[0.5, 4]` | flow: pulses/s just above 0 and at 1; 0 (or `when` false) hides the flow |
| `pulse` | `{ trigger: "increase", peak: 2.5, base: 0.6, seconds: 1.2 }` | pulse: glow `peak` for `seconds`, then `base`. `increase` fires when the number goes up (counters, timestamps), `rise` when `when` turns true. The first answer never fires |
| `label` | `{ format: "{value}", decimals: 0, multiply: 1, missing: "–" }` | label: sets a text entity's `text` (≤ 60 chars) |
| `stale` | `3 × every` | seconds without a good answer before the binding is stale |
| `onStale` | `hold` | `hold` keeps the last look; `off` shows the "no data" look (glow off, meter 0, flow hidden, label `missing`) |
| `step` | glow 0.05, meter 0.02, flow 0.25 | smallest output change worth an op |
| `batch` | true | may share a request with other bindings of the same `every` |
| `maxSeries` | 50 | most series the query may return (more = an error, nothing applied) |
| `description` | | free text for people |

No data (an empty answer) is the "missing" look: a switch is off, a meter 0, a flow hidden.
Write `... or vector(0)` when no series should mean zero instead.

One entity has one driver: two bindings on the same entity are an error. Keep bindings off
entities something else drives (a feed's own collectors), or the two will fight.

## What goes over the wire

Only `update` ops (CONTRACT.md section 2) with values computed from numbers:
`{ material: { glow } }`, `{ material: <on|off> }`, `{ value }`, `{ visible, rate }`, `{ text }`.
Entity ids come from your bindings, never from Prometheus. Label values, instance URLs and
the `tera_binding` batching label are dropped before anything is built.

## The loop

- `tick(now?)` runs every cadence that is due and returns op lists, one per binding (plus one
  for pulse restores). Send each list as its own `ops` message: a page that lacks an entity
  rejects that list only. Calls while a tick is running return `[]`.
- Bindings with the same `every` share one request: each query becomes
  `label_replace((q), "tera_binding", "<id>", "", "")`, joined with `or` (requests are split
  at ~8000 chars). If Prometheus rejects the batch (one bad query, or a query that answers a
  scalar), the loop asks one by one, and the ones that broke it run alone from then on.
- Ops are sent only when the look changes, so a calm system sends nothing.
- `setEntities(ids)` (the world's entity ids, or null) skips entities the world does not have
  and stops querying bindings that have none. Call it again when the world changes: every look
  is sent once more.
- `welcome()` returns the current looks for a page that just connected.
- `status()` lists every binding: `pending` `live` `stale` `error` `missing`, age in seconds,
  entities driven and a scrubbed error (a kind and an HTTP status, never a URL, a query or
  Prometheus's message).
- `value(id)` / `values()` give the current numbers to your own code (`values()` only fresh ones).

## The client

`new PromClient({ url, timeoutMs = 5000, maxSeries = 500, maxBytes = 2 MiB, backoff, headers })`

- `instant(query)` → `{ type: "vector" | "scalar", samples: [{ labels, value, ts }] }`;
  `range(query, { start, end, step })` → `[{ labels, values: [[ms, v]] }]`. Non-finite values
  are dropped.
- POSTs form data to `/api/v1/query` and `/api/v1/query_range` only (long queries fit, and
  queries stay out of access-log URLs). Redirects are refused.
- `url` must be http(s) without credentials; put a token in `headers` (never logged, never
  in an error).
- Server failures (network, timeout, 5xx, a page that is not the API) back off exponentially
  (1 s doubling to 60 s, ±20 % jitter); meanwhile calls fail fast with kind `backoff`. A query
  Prometheus rejects (4xx) is the query's fault and does not back off.

## Beside it: other adapters

`src/adapters/types.ts` holds the shape every adapter shares (`WorldAdapter`: `setEntities`,
`tick`, `welcome`, `status`; `UpdateOp`; `AdapterItemStatus`). A Langfuse or OpenTelemetry
adapter (traces become walks) implements the same interface next to this one, so a feed
server can run several and treat them alike.
