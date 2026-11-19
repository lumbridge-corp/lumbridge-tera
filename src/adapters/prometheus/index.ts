// Prometheus → world bindings (docs/adapters-prometheus.md, CONTRACT.md section 10).
// Node only, no dependencies: import this from a feed server, a recorder or a test.
//
//   import { PromClient, BindingLoop, validateBindings } from "@lumbridge/tera/src/adapters/prometheus/index.ts";
//   const { bindings, errors } = validateBindings(JSON.parse(readFileSync("bindings.json", "utf8")));
//   const loop = new BindingLoop({ client: new PromClient({ url: "http://prometheus:9090" }), bindings });
//   loop.setEntities(worldEntityIds);
//   setInterval(async () => { for (const ops of await loop.tick()) send({ type: "ops", ops }); }, 1000);
export { PromClient, PromError } from "./client.ts";
export type { InstantResult, PromClientOptions, PromQuerier, PromSample, PromSeries, PromErrorKind } from "./client.ts";
export { BINDING_KINDS, COMPARATORS, MATERIAL_KEYS, REDUCERS, SCALES, entitiesOf, validateBinding, validateBindings } from "./spec.ts";
export type { Binding, BindingKind, Comparator, Condition, Reducer, Scale } from "./spec.ts";
export { fires, formatLabel, holds, lookFor, normalise, reduce, valuesFor } from "./evaluate.ts";
export { BATCH_LABEL, BindingLoop } from "./loop.ts";
export type { BindingLoopOptions } from "./loop.ts";
export type { AdapterItemStatus, AdapterState, UpdateOp, WorldAdapter } from "../types.ts";
