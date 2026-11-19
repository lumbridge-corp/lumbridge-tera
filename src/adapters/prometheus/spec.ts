// Bindings: "this PromQL drives that entity like so" (docs/adapters-prometheus.md).
// Hand-written validation (no schema library), so the adapter has no dependencies at all and
// a binding file can be checked anywhere Node runs. Unknown keys are errors (typos never pass
// silently); keys starting with "//" or "$comment" are comments.

export const BINDING_KINDS = ["glow", "meter", "flow", "pulse", "label", "value"] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];
export const REDUCERS = ["max", "min", "sum", "avg", "count"] as const;
export type Reducer = (typeof REDUCERS)[number];
export const SCALES = ["linear", "log", "sqrt"] as const;
export type Scale = (typeof SCALES)[number];
export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export type Comparator = (typeof COMPARATORS)[number];

/** Material keys a binding may set (nothing that loads a file or changes a screen). */
export const MATERIAL_KEYS = ["color", "emissive", "glow", "opacity", "roughness", "metalness", "night"] as const;

export interface Condition {
  op: Comparator;
  value: number;
}

export interface Binding {
  id: string;
  /** PromQL, evaluated as an instant query */
  query: string;
  /** seconds between evaluations */
  every: number;
  kind: BindingKind;
  /** the entity driven (every kind but `value`, unless `labelMap` names them) */
  entity?: string;
  /** one entity per series: the value of `label` picks the entity; unmapped series are dropped */
  labelMap?: { label: string; map: Record<string, string> };
  /** several series without labelMap: how they become one number */
  reduce: Reducer;
  /** the input domain; values are clamped to it and normalised to 0..1 */
  range: [number, number];
  scale: Scale;
  /** a switch: glow uses on/off, flow hides, pulse fires on the false → true edge */
  when?: Condition;
  /** material partials for a glow with `when` (defaults: glow at the top / bottom of `glow`) */
  on?: Record<string, unknown>;
  off?: Record<string, unknown>;
  /** glow kind: material.glow at normalised 0 and 1 */
  glow: [number, number];
  /** flow kind: pulses/s at normalised just above 0 and at 1 (0 hides the flow) */
  rate: [number, number];
  /** pulse kind: a glow bump when the value goes up (`increase`) or `when` turns true (`rise`) */
  pulse: { trigger: "increase" | "rise"; peak: number; base: number; seconds: number };
  /** label kind: text with `{value}` replaced */
  label: { format: string; decimals: number; multiply: number; missing: string };
  /** seconds without a good answer before the binding counts as stale */
  stale: number;
  /** stale: keep the last look (`hold`) or fall back to the missing look (`off`) */
  onStale: "hold" | "off";
  /** smallest output change worth sending (glow, meter value, flow rate) */
  step: number;
  /** may share one HTTP request with other bindings of the same `every` */
  batch: boolean;
  /** most series the query may return */
  maxSeries: number;
  description?: string;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const KEYS = new Set(["id", "query", "every", "kind", "entity", "labelMap", "reduce", "range", "scale", "when", "on", "off", "glow", "rate", "pulse", "label", "stale", "onStale", "step", "batch", "maxSeries", "description"]);
const STEP: Record<BindingKind, number> = { glow: 0.05, meter: 0.02, flow: 0.25, pulse: 0, label: 0, value: 0 };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const comment = (k: string) => k.startsWith("//") || k === "$comment";

function pair(x: unknown, what: string, errs: string[], d: [number, number], ordered = true): [number, number] {
  if (x === undefined) return d;
  if (!Array.isArray(x) || x.length !== 2 || !fin(x[0]) || !fin(x[1])) {
    errs.push(`${what} must be [number, number]`);
    return d;
  }
  if (ordered && !(x[0] < x[1])) errs.push(`${what}: the first number must be below the second`);
  return [x[0], x[1]];
}

function material(x: unknown, what: string, errs: string[]): Record<string, unknown> | undefined {
  if (x === undefined) return undefined;
  if (!isObj(x)) {
    errs.push(`${what} must be a material object`);
    return undefined;
  }
  for (const [k, v] of Object.entries(x)) {
    if (!(MATERIAL_KEYS as readonly string[]).includes(k)) errs.push(`${what}.${k}: not a material key a binding may set (${MATERIAL_KEYS.join(", ")})`);
    else if ((k === "color" || k === "emissive") && !(typeof v === "string" && HEX.test(v))) errs.push(`${what}.${k} must be #rrggbb`);
    else if ((k === "glow" || k === "opacity" || k === "roughness" || k === "metalness") && !(fin(v) && v >= 0 && v <= (k === "glow" ? 10 : 1))) errs.push(`${what}.${k} out of range`);
    else if (k === "night") {
      if (!isObj(v)) errs.push(`${what}.night must be an object`);
      else
        for (const [nk, nv] of Object.entries(v)) {
          if (nk === "emissive" && typeof nv === "string" && HEX.test(nv)) continue;
          if (nk === "intensity" && fin(nv) && nv >= 0 && nv <= 10) continue;
          errs.push(`${what}.night.${nk}: only emissive (#rrggbb) and intensity (0..10)`);
        }
    }
  }
  return x;
}

/** Validate one binding. Returns the binding with defaults filled in, or null + errors. */
export function validateBinding(raw: unknown, where = "binding"): { binding: Binding | null; errors: string[] } {
  const errs: string[] = [];
  if (!isObj(raw)) return { binding: null, errors: [`${where}: not an object`] };
  const id = raw.id;
  const at = typeof id === "string" ? `${where} "${id}"` : where;
  const e = (m: string) => errs.push(`${at}: ${m}`);
  const sub: string[] = [];
  for (const k of Object.keys(raw)) if (!KEYS.has(k) && !comment(k)) e(`unknown key "${k}"`);
  if (typeof id !== "string" || !ID.test(id)) e("id must be lowercase letters, digits, . _ - (≤ 64)");
  const query = raw.query;
  if (typeof query !== "string" || !query.trim()) e("query must be a non-empty PromQL string");
  else if (query.length > 4000) e("query longer than 4000 chars");
  const kind = raw.kind as BindingKind;
  if (!(BINDING_KINDS as readonly string[]).includes(kind as string)) e(`kind must be one of ${BINDING_KINDS.join(", ")}`);
  const every = raw.every ?? 30;
  if (!fin(every) || every < 5 || every > 3600) e("every must be 5..3600 seconds");
  const entity = raw.entity;
  if (entity !== undefined && !(typeof entity === "string" && ENTITY.test(entity))) e("entity must be an entity id");
  let labelMap: Binding["labelMap"];
  if (raw.labelMap !== undefined) {
    const lm = raw.labelMap;
    if (!isObj(lm) || typeof lm.label !== "string" || !LABEL.test(lm.label) || !isObj(lm.map)) e("labelMap must be { label, map: { value: entity } }");
    else {
      const map: Record<string, string> = {};
      const entries = Object.entries(lm.map);
      if (!entries.length || entries.length > 64) e("labelMap.map needs 1..64 entries");
      for (const [k, v] of entries) {
        if (typeof v !== "string" || !ENTITY.test(v)) e(`labelMap.map["${k.slice(0, 40)}"] must be an entity id`);
        else map[k] = v;
      }
      for (const k of Object.keys(lm)) if (k !== "label" && k !== "map" && !comment(k)) e(`labelMap: unknown key "${k}"`);
      labelMap = { label: lm.label, map };
    }
    if (entity !== undefined) e("give entity or labelMap, not both");
  }
  if (kind !== "value" && (BINDING_KINDS as readonly string[]).includes(kind) && entity === undefined && !labelMap) e(`kind ${kind} needs entity or labelMap`);
  if (kind === "value" && (entity !== undefined || labelMap)) e("kind value drives no entity (drop entity / labelMap)");
  const reduce = (raw.reduce ?? "max") as Reducer;
  if (!(REDUCERS as readonly string[]).includes(reduce)) e(`reduce must be one of ${REDUCERS.join(", ")}`);
  const range = pair(raw.range, "range", sub, [0, 1]);
  const scale = (raw.scale ?? "linear") as Scale;
  if (!(SCALES as readonly string[]).includes(scale)) e(`scale must be one of ${SCALES.join(", ")}`);
  if (scale === "log" && range[0] < 0) e("scale log needs range ≥ 0");
  let when: Condition | undefined;
  if (raw.when !== undefined) {
    const w = raw.when;
    if (!isObj(w) || !(COMPARATORS as readonly string[]).includes(w.op as string) || !fin(w.value) || Object.keys(w).some((k) => k !== "op" && k !== "value")) e(`when must be { op: ${COMPARATORS.join(" ")}, value: number }`);
    else when = { op: w.op as Comparator, value: w.value };
  }
  const on = material(raw.on, "on", sub);
  const off = material(raw.off, "off", sub);
  if ((on || off) && !(kind === "glow" && when)) e("on / off are for a glow with when");
  const glow = pair(raw.glow, "glow", sub, [0.2, 2], false);
  if (glow[0] < 0 || glow[1] > 10) e("glow must stay within 0..10");
  const rate = pair(raw.rate, "rate", sub, [0.5, 4], false);
  if (rate[0] < 0 || rate[1] > 20) e("rate must stay within 0..20 pulses/s");
  let pulse: Binding["pulse"] = { trigger: when ? "rise" : "increase", peak: 2.5, base: 0.6, seconds: 1.2 };
  if (raw.pulse !== undefined) {
    const p = raw.pulse;
    if (!isObj(p)) e("pulse must be an object");
    else {
      for (const k of Object.keys(p)) if (!["trigger", "peak", "base", "seconds"].includes(k)) e(`pulse: unknown key "${k}"`);
      pulse = { trigger: (p.trigger ?? pulse.trigger) as "increase" | "rise", peak: (p.peak ?? pulse.peak) as number, base: (p.base ?? pulse.base) as number, seconds: (p.seconds ?? pulse.seconds) as number };
      if (pulse.trigger !== "increase" && pulse.trigger !== "rise") e("pulse.trigger must be increase or rise");
      if (!fin(pulse.peak) || pulse.peak < 0 || pulse.peak > 10 || !fin(pulse.base) || pulse.base < 0 || pulse.base > 10) e("pulse.peak / base must be 0..10");
      if (!fin(pulse.seconds) || pulse.seconds < 0.1 || pulse.seconds > 30) e("pulse.seconds must be 0.1..30");
    }
  }
  if (kind === "pulse" && pulse.trigger === "rise" && !when) e("pulse trigger rise needs when");
  let label: Binding["label"] = { format: "{value}", decimals: 0, multiply: 1, missing: "–" };
  if (raw.label !== undefined) {
    const l = raw.label;
    if (!isObj(l)) e("label must be an object");
    else {
      for (const k of Object.keys(l)) if (!["format", "decimals", "multiply", "missing"].includes(k)) e(`label: unknown key "${k}"`);
      label = { format: (l.format ?? label.format) as string, decimals: (l.decimals ?? 0) as number, multiply: (l.multiply ?? 1) as number, missing: (l.missing ?? label.missing) as string };
      if (typeof label.format !== "string" || label.format.length > 60 || !label.format.includes("{value}")) e("label.format must contain {value} (≤ 60 chars)");
      if (typeof label.missing !== "string" || label.missing.length > 40) e("label.missing must be a string (≤ 40 chars)");
      if (!Number.isInteger(label.decimals) || label.decimals < 0 || label.decimals > 3) e("label.decimals must be 0..3");
      if (!fin(label.multiply)) e("label.multiply must be a number");
    }
  }
  const stale = raw.stale ?? 3 * (fin(every) ? every : 30);
  if (!fin(stale) || stale < (fin(every) ? every : 5) || stale > 86_400) e("stale must be ≥ every and ≤ 86400 s");
  const onStale = raw.onStale ?? "hold";
  if (onStale !== "hold" && onStale !== "off") e("onStale must be hold or off");
  const step = raw.step ?? (STEP[kind] ?? 0);
  if (!fin(step) || step < 0 || step > 1) e("step must be 0..1");
  const batch = raw.batch ?? true;
  if (typeof batch !== "boolean") e("batch must be true or false");
  const maxSeries = raw.maxSeries ?? 50;
  if (!Number.isInteger(maxSeries) || (maxSeries as number) < 1 || (maxSeries as number) > 500) e("maxSeries must be 1..500");
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 300)) e("description must be a string (≤ 300 chars)");
  for (const s of sub) e(s);
  if (errs.length) return { binding: null, errors: errs };
  return {
    binding: {
      id: id as string, query: (query as string).trim(), every: every as number, kind, ...(entity !== undefined ? { entity: entity as string } : {}), ...(labelMap ? { labelMap } : {}),
      reduce, range, scale, ...(when ? { when } : {}), ...(on ? { on } : {}), ...(off ? { off } : {}), glow, rate, pulse, label,
      stale: stale as number, onStale: onStale as "hold" | "off", step: step as number, batch: batch as boolean, maxSeries: maxSeries as number,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    },
    errors: [],
  };
}

/** Validate a list (or a `{ bindings: [...] }` file). Ids must be unique; one entity has one driver. */
export function validateBindings(raw: unknown, where = "bindings"): { bindings: Binding[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.bindings) ? raw.bindings : null;
  if (!list) return { bindings: [], errors: [`${where}: expected an array of bindings or { "bindings": [...] }`] };
  if (isObj(raw)) for (const k of Object.keys(raw)) if (k !== "bindings" && !comment(k)) return { bindings: [], errors: [`${where}: unknown key "${k}"`] };
  const out: Binding[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  const drivers = new Map<string, string>();
  list.forEach((b, i) => {
    const r = validateBinding(b, `${where}[${i}]`);
    errors.push(...r.errors);
    if (!r.binding) return;
    if (ids.has(r.binding.id)) {
      errors.push(`${where}[${i}]: duplicate id "${r.binding.id}"`);
      return;
    }
    ids.add(r.binding.id);
    for (const ent of entitiesOf(r.binding)) {
      const other = drivers.get(ent);
      if (other) errors.push(`${where}[${i}] "${r.binding.id}": entity ${ent} is already driven by "${other}"`);
      else drivers.set(ent, r.binding.id);
    }
    out.push(r.binding);
  });
  return { bindings: errors.length ? [] : out, errors };
}

/** Every entity id a binding can drive. */
export function entitiesOf(b: Binding): string[] {
  if (b.entity) return [b.entity];
  if (b.labelMap) return [...new Set(Object.values(b.labelMap.map))];
  return [];
}
