// World documents and ops, without three.js. Pure: runs in Node and in the page.
//
// The engine keeps the world as JSON (a WorldPack) and the scene graph is a function
// of that JSON. Ops edit the JSON here; the renderer reconciles the scene to it. That
// makes seek(t) exact and cheap: worldAt(base, events, t) is the JSON at time t, and
// only entities whose JSON changed get rebuilt.
import { Entity as EntitySchema, Environment as EnvSchema, Op as OpSchema, Sky as SkySchema } from "../schema/index.ts";
import type { Entity, Op, Sky, WorldPack } from "../schema/index.ts";
import { parseRealTime } from "./astro.ts";
import { deepMerge, type Plain } from "./merge.ts";
import { applyLivingOp } from "../schema/living.ts";
import { lerpTransform, progress } from "./ease.ts";

export interface Found {
  entity: Entity;
  /** The array that holds it (world.entities or a group's children). */
  list: Entity[];
  index: number;
  parent: Entity | null;
}

export function findEntity(list: Entity[], id: string, parent: Entity | null = null): Found | undefined {
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.id === id) return { entity: e, list, index: i, parent };
    if (e.kind === "group") {
      const f = findEntity(e.children, id, e);
      if (f) return f;
    }
  }
}

export function walkEntities(list: Entity[], fn: (e: Entity, parent: Entity | null) => void, parent: Entity | null = null) {
  for (const e of list) {
    fn(e, parent);
    if (e.kind === "group") walkEntities(e.children, fn, e);
  }
}

export function countEntities(list: Entity[]): number {
  let n = 0;
  walkEntities(list, () => n++);
  return n;
}

export function hasSplats(list: Entity[]): boolean {
  let found = false;
  walkEntities(list, (e) => { if (e.kind === "splat") found = true; });
  return found;
}

function zodMessage(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");
}

function idsIn(e: Entity, out: string[] = []): string[] {
  out.push(e.id);
  if (e.kind === "group") for (const c of e.children) idsIn(c, out);
  return out;
}

/** Time context for `animate`: the op was issued at `at`; evaluate it at `now`. */
export interface OpClock {
  at: number;
  now: number;
}

/**
 * Apply one op to `world` in place. Throws with a readable message on failure; the
 * world is untouched when it throws. Without a clock, `animate` jumps to its end
 * state (that is what the world looks like once the animation is over).
 */
export function applyOp(world: WorldPack, rawOp: Op, clock?: OpClock): void {
  const parsed = OpSchema.safeParse(rawOp);
  if (!parsed.success) throw new Error(`invalid op: ${zodMessage(parsed.error)}`);
  const op = parsed.data;
  switch (op.op) {
    case "add": {
      for (const id of idsIn(op.entity)) if (findEntity(world.entities, id)) throw new Error(`id "${id}" already exists`);
      const ids = idsIn(op.entity);
      if (new Set(ids).size !== ids.length) throw new Error(`duplicate ids inside "${op.entity.id}"`);
      const entity = structuredClone(op.entity);
      if (op.parent) {
        const p = findEntity(world.entities, op.parent);
        if (!p) throw new Error(`no parent "${op.parent}"`);
        if (p.entity.kind !== "group") throw new Error(`parent "${op.parent}" is a ${p.entity.kind}, not a group`);
        p.entity.children.push(entity);
      } else world.entities.push(entity);
      return;
    }
    case "update": {
      const f = findEntity(world.entities, op.id);
      if (!f) throw new Error(`no entity "${op.id}"`);
      if ("id" in op.set && op.set.id !== op.id) throw new Error("update cannot change an id (remove + add instead)");
      const merged = deepMerge(f.entity as unknown as Plain, op.set as Plain);
      const res = EntitySchema.safeParse(merged);
      if (!res.success) throw new Error(`update "${op.id}": ${zodMessage(res.error)}`);
      if (res.data.kind === "group") {
        const ids = idsIn(res.data).slice(1);
        for (const id of ids) {
          const other = findEntity(world.entities, id);
          if (other && !findEntity([f.entity], id)) throw new Error(`id "${id}" already exists`);
        }
      }
      f.list[f.index] = res.data;
      return;
    }
    case "remove": {
      const f = findEntity(world.entities, op.id);
      if (!f) throw new Error(`no entity "${op.id}"`);
      f.list.splice(f.index, 1);
      return;
    }
    case "sky": {
      const cur = (world.sky ?? {}) as Plain;
      const base = op.set.mode !== undefined && op.set.mode !== cur.mode ? {} : cur;
      const res = SkySchema.safeParse(deepMerge(base, op.set as Plain));
      if (!res.success) throw new Error(`sky: ${zodMessage(res.error)}`);
      const next = res.data;
      // an animated time change: the sky time eases from the old time to the new one
      if (op.duration && clock && "time" in op.set && (next.mode === "real" || next.mode === "sun") && (cur.mode === "real" || cur.mode === "sun") && base === cur) {
        const u = progress(clock.now, clock.at, op.duration, op.ease ?? "inOutCubic");
        const from = skyTimeMs(cur as Sky), to = skyTimeMs(next);
        if (from !== null && to !== null && u < 1) next.time = new Date(from + (to - from) * u).toISOString();
      }
      world.sky = next;
      return;
    }
    case "env": {
      const res = EnvSchema.safeParse(deepMerge((world.environment ?? {}) as Plain, op.set as Plain));
      if (!res.success) throw new Error(`env: ${zodMessage(res.error)}`);
      world.environment = res.data;
      return;
    }
    case "animate": {
      const f = findEntity(world.entities, op.id);
      if (!f) throw new Error(`no entity "${op.id}"`);
      const u = clock ? progress(clock.now, clock.at, op.duration, op.ease) : 1;
      f.entity.transform = lerpTransform(f.entity.transform, op.to, u);
      return;
    }
    case "path":
    case "graph":
      applyLivingOp(world, op);
      return;
  }
}

/** A sun/real sky's time in ms (null for "now", a missing time or another mode). */
export function skyTimeMs(sky: Sky | undefined): number | null {
  if (!sky || (sky.mode !== "real" && sky.mode !== "sun") || !sky.time || sky.time === "now") return null;
  try {
    return parseRealTime(sky.time, sky.lon, 0);
  } catch {
    return null;
  }
}

/** Apply ops in order; stop at the first failure (earlier ops stay applied). */
export function applyOps(world: WorldPack, ops: Op[], clock?: OpClock): { ok: boolean; applied: number; error?: string } {
  let applied = 0;
  for (const op of ops) {
    try {
      applyOp(world, op, clock);
    } catch (err) {
      return { ok: false, applied, error: `op ${applied} (${(op as { op?: string }).op ?? "?"}): ${(err as Error).message}` };
    }
    applied++;
  }
  return { ok: true, applied };
}

export interface TimedOps {
  t: number;
  ops: Op[];
}

/**
 * The world at script time `t`: a copy of `base` with every event at or before `t`
 * replayed in time order (ties keep file order). An `animate` issued at time `at`
 * shows its eased in-between state at `t`. Ops that fail are skipped and reported.
 */
export function worldAt(base: WorldPack, events: TimedOps[] | undefined, t: number): { world: WorldPack; errors: string[] } {
  const world = structuredClone(base);
  const errors: string[] = [];
  const evs = (events ?? []).map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  for (const { e } of evs) {
    if (e.t > t) break;
    for (const op of e.ops) {
      try {
        applyOp(world, op, { at: e.t, now: t });
      } catch (err) {
        errors.push(`event t=${e.t}: ${(err as Error).message}`);
      }
    }
  }
  return { world, errors };
}
