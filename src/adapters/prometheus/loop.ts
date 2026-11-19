// The evaluation loop: bindings → Prometheus instant queries on their own cadence → entity
// updates, only when the look changes. Call `tick()` often (every second or few); it queries
// only what is due.
//
// Bindings with the same `every` share one request: each query is wrapped as
//   label_replace((<query>), "tera_binding", "<id>", "", "")
// and the wrapped queries are joined with `or`, so one answer carries every binding's series,
// told apart by that label. A batch Prometheus rejects (one bad query, or a query that answers
// a scalar) is retried one query at a time, and the bindings that broke it run alone from then on.
import type { AdapterItemStatus, UpdateOp, WorldAdapter } from "../types.ts";
import { PromError } from "./client.ts";
import type { PromQuerier, PromSample } from "./client.ts";
import { entitiesOf } from "./spec.ts";
import type { Binding } from "./spec.ts";
import { fires, lookFor, valuesFor } from "./evaluate.ts";

export const BATCH_LABEL = "tera_binding";
const MAX_BATCH_CHARS = 8000;

interface BState {
  lastOk: number | null;
  error: string | null;
  /** entity → value ("" for a binding without entity) */
  values: Map<string, number | null>;
  /** entity → JSON of the look last sent */
  sent: Map<string, string>;
  solo: boolean;
  staleApplied: boolean;
}

export interface BindingLoopOptions {
  client: PromQuerier;
  bindings: Binding[];
  now?: () => number;
}

export class BindingLoop implements WorldAdapter {
  readonly name = "prometheus";
  private readonly client: PromQuerier;
  private readonly bindings: Binding[];
  private readonly now: () => number;
  private readonly st = new Map<string, BState>();
  private readonly due = new Map<number, number>();
  private restores: { at: number; op: UpdateOp }[] = [];
  private entities: Set<string> | null = null;
  private running = false;
  private readonly started: number;

  constructor(o: BindingLoopOptions) {
    this.client = o.client;
    this.bindings = o.bindings;
    this.now = o.now ?? Date.now;
    this.started = this.now();
    for (const b of this.bindings) this.st.set(b.id, { lastOk: null, error: null, values: new Map(), sent: new Map(), solo: !b.batch, staleApplied: false });
  }

  setEntities(ids: Iterable<string> | null): void {
    this.entities = ids ? new Set(ids) : null;
    for (const s of this.st.values()) s.sent.clear(); // a new world: send every look again
  }

  private present(b: Binding): string[] {
    const all = entitiesOf(b);
    return this.entities ? all.filter((e) => this.entities!.has(e)) : all;
  }

  /** A binding is worth querying when it drives something here (or is a plain value). */
  private active(b: Binding): boolean {
    return b.kind === "value" || this.present(b).length > 0;
  }

  async tick(nowMs: number = this.now()): Promise<UpdateOp[][]> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: UpdateOp[][] = [];
      const groups = new Map<number, Binding[]>();
      for (const b of this.bindings) {
        if (!this.active(b)) continue;
        if (nowMs < (this.due.get(b.every) ?? 0)) continue;
        groups.set(b.every, [...(groups.get(b.every) ?? []), b]);
      }
      for (const every of groups.keys()) this.due.set(every, nowMs + every * 1000);
      for (const list of groups.values()) {
        const batch = list.filter((b) => !this.st.get(b.id)!.solo);
        const solo = list.filter((b) => this.st.get(b.id)!.solo);
        for (const chunk of chunks(batch)) {
          if (chunk.length === 1) solo.push(chunk[0]!);
          else await this.runBatch(chunk, nowMs, out);
        }
        for (const b of solo) await this.runOne(b, nowMs, out);
      }
      out.push(...this.staleOps(nowMs));
      const restore = this.restores.filter((r) => r.at <= nowMs).map((r) => r.op);
      this.restores = this.restores.filter((r) => r.at > nowMs);
      if (restore.length) out.push(restore);
      return out.filter((l) => l.length);
    } finally {
      this.running = false;
    }
  }

  private async runBatch(list: Binding[], now: number, out: UpdateOp[][]): Promise<void> {
    const q = list.map((b) => `label_replace((${b.query}), "${BATCH_LABEL}", "${b.id}", "", "")`).join("\nor\n");
    try {
      const r = await this.client.instant(q);
      const per = new Map<string, PromSample[]>(list.map((b) => [b.id, []]));
      for (const s of r.samples) {
        const id = s.labels[BATCH_LABEL];
        if (id === undefined || !per.has(id)) continue;
        const { [BATCH_LABEL]: _drop, ...labels } = s.labels;
        per.get(id)!.push({ ...s, labels });
      }
      for (const b of list) this.apply(b, per.get(b.id)!, now, out);
    } catch (e) {
      if (e instanceof PromError && (e.kind === "prometheus" || e.kind === "parse")) {
        // one of them breaks the batch: ask one by one, and the ones that fail or answer a scalar run alone
        for (const b of list) {
          const ok = await this.runOne(b, now, out);
          if (ok !== "vector") this.st.get(b.id)!.solo = true;
        }
        return;
      }
      for (const b of list) this.failed(b, e);
    }
  }

  private async runOne(b: Binding, now: number, out: UpdateOp[][]): Promise<"vector" | "scalar" | null> {
    try {
      const r = await this.client.instant(b.query);
      this.apply(b, r.samples, now, out);
      return r.type;
    } catch (e) {
      this.failed(b, e);
      return null;
    }
  }

  private failed(b: Binding, e: unknown): void {
    this.st.get(b.id)!.error = e instanceof PromError ? `${e.kind}: ${e.message}` : "failed";
  }

  private apply(b: Binding, samples: PromSample[], now: number, out: UpdateOp[][]): void {
    const s = this.st.get(b.id)!;
    if (samples.length > b.maxSeries) {
      s.error = `limit: ${samples.length} series > ${b.maxSeries}`;
      return;
    }
    const values = valuesFor(b, samples);
    const ops: UpdateOp[] = [];
    for (const [ent, v] of values) {
      const prev = s.values.has(ent) ? s.values.get(ent)! : undefined;
      s.values.set(ent, v);
      if (b.kind === "value" || (this.entities && !this.entities.has(ent))) continue;
      if (fires(b, prev, v)) {
        ops.push({ op: "update", id: ent, set: { material: { glow: b.pulse.peak } } });
        this.restores = this.restores.filter((r) => r.op.id !== ent);
        this.restores.push({ at: now + b.pulse.seconds * 1000, op: { op: "update", id: ent, set: { material: { glow: b.pulse.base } } } });
        s.sent.set(ent, JSON.stringify(lookFor(b, v)));
        continue;
      }
      this.send(b, s, ent, lookFor(b, v), ops);
    }
    s.lastOk = now;
    s.error = null;
    s.staleApplied = false;
    if (ops.length) out.push(ops);
  }

  private send(b: Binding, s: BState, ent: string, look: Record<string, unknown> | null, ops: UpdateOp[]): void {
    if (!look) return;
    const key = JSON.stringify(look);
    if (s.sent.get(ent) === key) return;
    s.sent.set(ent, key);
    if (b.kind === "pulse" && this.restores.some((r) => r.op.id === ent)) return; // mid-pulse: the restore sets the base
    ops.push({ op: "update", id: ent, set: look });
  }

  /** Stale bindings with onStale "off" fall back to their missing look (once). */
  private staleOps(now: number): UpdateOp[][] {
    const out: UpdateOp[][] = [];
    for (const b of this.bindings) {
      const s = this.st.get(b.id)!;
      if (b.onStale !== "off" || s.staleApplied || !this.isStale(b, s, now) || !this.active(b)) continue;
      s.staleApplied = true;
      const ops: UpdateOp[] = [];
      for (const ent of this.present(b)) this.send(b, s, ent, lookFor(b, null), ops);
      if (ops.length) out.push(ops);
    }
    return out;
  }

  private isStale(b: Binding, s: BState, now: number): boolean {
    return now - (s.lastOk ?? this.started) > b.stale * 1000;
  }

  /** Ops that put a new page in the current state: one list per binding. */
  welcome(): UpdateOp[][] {
    const now = this.now();
    const out: UpdateOp[][] = [];
    for (const b of this.bindings) {
      if (b.kind === "value") continue;
      const s = this.st.get(b.id)!;
      if (s.lastOk === null && !(b.onStale === "off" && s.staleApplied)) continue;
      const off = b.onStale === "off" && this.isStale(b, s, now);
      const ops: UpdateOp[] = [];
      for (const ent of this.present(b)) {
        const look = lookFor(b, off ? null : (s.values.get(ent) ?? null));
        if (look) ops.push({ op: "update", id: ent, set: look });
      }
      if (ops.length) out.push(ops);
    }
    return out;
  }

  status(): AdapterItemStatus[] {
    const now = this.now();
    return this.bindings.map((b) => {
      const s = this.st.get(b.id)!;
      const entities = b.kind === "value" ? 0 : this.present(b).length;
      const ageS = s.lastOk === null ? null : Math.round((now - s.lastOk) / 1000);
      const state: AdapterItemStatus["state"] = !this.active(b) ? "missing" : s.error && (s.lastOk === null || this.isStale(b, s, now)) ? "error" : s.lastOk === null ? "pending" : this.isStale(b, s, now) ? "stale" : "live";
      return { id: b.id, kind: b.kind, state, ageS, entities, ...(s.error ? { error: s.error } : {}) };
    });
  }

  /** The current number of a binding (one entity, or a value binding); null = no data / unknown id. */
  value(id: string): number | null {
    const s = this.st.get(id);
    const b = this.bindings.find((x) => x.id === id);
    if (!s || !b) return null;
    if (this.isStale(b, s, this.now()) && b.onStale === "off") return null;
    return s.values.get(b.entity ?? "") ?? null;
  }

  /** Every value binding's (and single-entity binding's) current number, fresh ones only. */
  values(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const b of this.bindings) if (!b.labelMap) out[b.id] = this.fresh(b) ? this.value(b.id) : null;
    return out;
  }

  private fresh(b: Binding): boolean {
    const s = this.st.get(b.id)!;
    return s.lastOk !== null && !this.isStale(b, s, this.now());
  }
}

/** Split a batch so no request grows past MAX_BATCH_CHARS. */
function chunks(list: Binding[]): Binding[][] {
  const out: Binding[][] = [];
  let cur: Binding[] = [];
  let n = 0;
  for (const b of list) {
    const len = b.query.length + 60;
    if (cur.length && n + len > MAX_BATCH_CHARS) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(b);
    n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}
