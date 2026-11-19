// Pure functions: a binding + a number → the entity update it means. No I/O, no clock.
import type { Binding, Condition, Reducer } from "./spec.ts";
import type { PromSample } from "./client.ts";

/** Clamp to the range, then 0..1 on the binding's scale. */
export function normalise(v: number, range: [number, number], scale: Binding["scale"] = "linear"): number {
  const [lo, hi] = range;
  const c = Math.min(hi, Math.max(lo, v));
  if (scale === "log") return Math.log1p(c - lo) / Math.log1p(hi - lo);
  const n = (c - lo) / (hi - lo);
  return scale === "sqrt" ? Math.sqrt(n) : n;
}

export function holds(c: Condition, v: number): boolean {
  switch (c.op) {
    case ">": return v > c.value;
    case ">=": return v >= c.value;
    case "<": return v < c.value;
    case "<=": return v <= c.value;
    case "==": return v === c.value;
    case "!=": return v !== c.value;
  }
}

export function reduce(values: number[], how: Reducer): number | null {
  if (!values.length) return how === "count" ? 0 : null;
  switch (how) {
    case "max": return Math.max(...values);
    case "min": return Math.min(...values);
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "count": return values.length;
  }
}

/**
 * The samples of one binding → a number per driven entity (`null` = no data for it).
 * With a labelMap only mapped series count (a value is matched exactly; the label value itself
 * never leaves this function). Several series for one entity are reduced with `reduce`.
 */
export function valuesFor(b: Binding, samples: PromSample[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (b.labelMap) {
    const per = new Map<string, number[]>();
    for (const s of samples) {
      const lv = s.labels[b.labelMap.label];
      if (lv === undefined || !Object.hasOwn(b.labelMap.map, lv)) continue;
      const ent = b.labelMap.map[lv]!;
      per.set(ent, [...(per.get(ent) ?? []), s.value]);
    }
    for (const ent of new Set(Object.values(b.labelMap.map))) out.set(ent, reduce(per.get(ent) ?? [], b.reduce));
    return out;
  }
  out.set(b.entity ?? "", reduce(samples.map((s) => s.value), b.reduce));
  return out;
}

const roundTo = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** `{value}` formatted for a label (null = the missing text). */
export function formatLabel(b: Binding, v: number | null): string {
  if (v === null) return b.label.missing;
  const x = v * b.label.multiply;
  const s = Number.isFinite(x) ? x.toFixed(b.label.decimals) : b.label.missing;
  return b.label.format.replace(/\{value\}/g, s).slice(0, 60);
}

/**
 * The steady look of an entity for a value (pulse bindings have no steady look beyond their
 * base glow). `null` value = no data / stale-off: the binding's "missing" look.
 */
export function lookFor(b: Binding, v: number | null): Record<string, unknown> | null {
  const on = v !== null && (b.when ? holds(b.when, v) : true);
  const n = v === null ? 0 : normalise(v, b.range, b.scale);
  switch (b.kind) {
    case "glow":
      if (b.when) return { material: on ? (b.on ?? { glow: b.glow[1] }) : (b.off ?? { glow: b.glow[0] }) };
      return { material: { glow: r3(roundTo(b.glow[0] + (b.glow[1] - b.glow[0]) * n, b.step)) } };
    case "meter":
      return { value: r3(roundTo(on ? n : 0, b.step)) };
    case "flow": {
      if (!on || n <= 0) return { visible: false };
      return { visible: true, rate: r3(Math.max(0.05, roundTo(b.rate[0] + (b.rate[1] - b.rate[0]) * n, b.step))) };
    }
    case "label":
      return { text: formatLabel(b, v) };
    case "pulse":
      return { material: { glow: b.pulse.base } };
    case "value":
      return null;
  }
}

/** Does this new value fire a pulse? (`prev` undefined = first answer: never fires.) */
export function fires(b: Binding, prev: number | null | undefined, v: number | null): boolean {
  if (b.kind !== "pulse" || prev === undefined || v === null) return false;
  if (b.pulse.trigger === "rise") return !!b.when && holds(b.when, v) && (prev === null || !holds(b.when, prev));
  return prev !== null && v > prev;
}
