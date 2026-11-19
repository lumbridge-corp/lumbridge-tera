// Validation that explains itself to an LLM: exact paths, allowed values, and hints for
// the usual mistakes (position outside transform, colour outside material, unknown ids).
import type { ZodError, ZodIssue, ZodTypeAny } from "zod";
import { fmtV } from "./bounds.ts";
import { CameraScript, Entity, Environment, Op, Sky, applyLivingOp, livingRefErrors, type WorldPack } from "../schema/index.ts";
import { validate as validateScript } from "../camera/validate.ts";
import { shotPose } from "../camera/evaluate.ts";
import { deepMerge as engineMerge } from "../engine/merge.ts";

const HINTS: Record<string, string> = {
  position: "put it in transform.position",
  rotation: "put it in transform.rotation (degrees)",
  scale: "put it in transform.scale",
  color: "for primitives use material.color",
  colour: "use material.color",
  roughness: "use material.roughness",
  metalness: "use material.metalness",
  emissive: "use material.emissive",
  opacity: "use material.opacity",
  radius: "use size: sphere [radius], cylinder [radius, height], cone [bottom radius, height, top radius?]",
  width: "use size: box [width, height, depth]",
  height: "use size: box [width, height, depth], cylinder [radius, height]",
  depth: "use size: box [width, height, depth]",
  type: "use kind (primitive|model|splat|text|light|group|repeat); for lights also light: directional|point|spot|ambient|hemisphere",
  name: "entities only have id",
  geometry: "use shape: box|sphere|plane|cylinder|torus|cone|capsule|prism|segment",
  start: "a rod between two points is {\"shape\":\"segment\",\"from\":[x,y,z],\"to\":[x,y,z],\"radius\":r}",
  end: "a rod between two points is {\"shape\":\"segment\",\"from\":[x,y,z],\"to\":[x,y,z],\"radius\":r}",
  points: "a rod between two points is {\"shape\":\"segment\",\"from\":[x,y,z],\"to\":[x,y,z],\"radius\":r}",
  circle: "copies on a circle: a repeat with \"radial\":{\"count\":n,\"radius\":r} instead of count/step",
  ring: "copies on a circle: a repeat with \"radial\":{\"count\":n,\"radius\":r} instead of count/step",
  around: "copies on a circle: a repeat with \"radial\":{\"count\":n,\"radius\":r} instead of count/step",
  angle: "radial repeats use startDeg / lengthDeg; primitives turn with transform.rotation (degrees)",
  exclude: "leave repeat copies out with skip: [[i,j,k], ...]",
  holes: "leave repeat copies out with skip: [[i,j,k], ...]",
  transparent: "for windows use material.glass: true",
  transmission: "use material.glass: true",
  instances: "use a repeat entity: {\"kind\":\"repeat\",\"of\":{...},\"count\":[nx,ny,nz],\"step\":[dx,dy,dz]} (or \"radial\":{\"count\",\"radius\"} for a ring)",
  thetaLength: "use arc: {\"start\": deg, \"length\": deg}",
  range: "point/spot lights use distance",
  look_at: "cameras use target",
  lookAt: "cameras use target",
};

export function pathStr(path: (string | number)[]): string {
  let s = "";
  for (const p of path) s += typeof p === "number" ? `[${p}]` : s ? `.${p}` : p;
  return s;
}

function issueText(i: ZodIssue, prefix: (string | number)[]): string {
  const at = pathStr([...prefix, ...i.path]) || "(root)";
  switch (i.code) {
    case "invalid_union_discriminator":
      return `${at}: must be one of ${i.options.map((o) => JSON.stringify(o)).join(", ")}`;
    case "invalid_enum_value":
      return `${at}: got ${JSON.stringify(i.received)}, must be one of ${i.options.map((o) => JSON.stringify(o)).join(", ")}`;
    case "invalid_type":
      return i.received === "undefined" ? `${at}: required (${i.expected})` : `${at}: expected ${i.expected}, got ${i.received}`;
    case "too_small":
    case "too_big":
      return `${at}: ${i.message}`;
    case "invalid_union": {
      const inner = i.unionErrors.flatMap((e) => e.issues.map((x) => issueText(x, prefix)));
      return inner.length ? inner[0]! : `${at}: ${i.message}`;
    }
    default:
      return `${at}: ${i.message}`;
  }
}

export function formatZod(err: ZodError, prefix: (string | number)[] = []): string[] {
  return err.issues.map((i) => issueText(i, prefix));
}

/** Keys present in raw but dropped by zod (zod strips unknown keys silently). */
export function unknownKeys(raw: unknown, parsed: unknown, prefix: (string | number)[] = []): string[] {
  const out: string[] = [];
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((r, i) => out.push(...unknownKeys(r, parsed[i], [...prefix, i])));
  } else if (raw && parsed && typeof raw === "object" && typeof parsed === "object") {
    for (const k of Object.keys(raw)) {
      const p = [...prefix, k];
      if (!(k in (parsed as object))) {
        const hint = HINTS[k];
        out.push(`${pathStr(p)}: unknown field${hint ? ` — ${hint}` : ""}`);
      } else out.push(...unknownKeys((raw as Record<string, unknown>)[k], (parsed as Record<string, unknown>)[k], p));
    }
  }
  return out;
}

/** Parse with a schema; error list includes unknown fields. */
export function strictParse<T>(schema: ZodTypeAny, raw: unknown, prefix: (string | number)[] = []): { ok: true; value: T } | { ok: false; errors: string[] } {
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, errors: formatZod(r.error, prefix) };
  const extra = unknownKeys(raw, r.data, prefix);
  if (extra.length) return { ok: false, errors: extra };
  return { ok: true, value: r.data as T };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  return out as T;
}

export function indexEntities(list: Entity[], map = new Map<string, Entity>()): Map<string, Entity> {
  for (const e of list) {
    map.set(e.id, e);
    if (e.kind === "group") indexEntities(e.children, map);
  }
  return map;
}

export interface OpCheck {
  ok: boolean;
  ops: Op[];
  errors: { index: number; messages: string[] }[];
}

/**
 * Validate a batch of ops against the schema and the current world (ids exist, no
 * duplicates, the entity after an update is still valid). Nothing is applied here.
 */
export function checkOps(rawOps: unknown, world: WorldPack | null): OpCheck {
  if (!Array.isArray(rawOps)) return { ok: false, ops: [], errors: [{ index: -1, messages: ["ops must be an array of op objects"] }] };
  const ids = indexEntities(world ? structuredClone(world.entities) : []);
  const errors: OpCheck["errors"] = [];
  const ops: Op[] = [];
  // Living world: paths + graph as they will be after the ops so far (for reference checks).
  const lw: Pick<WorldPack, "paths" | "graph" | "residents"> = structuredClone({ paths: world?.paths, graph: world?.graph, residents: world?.residents });
  const refs = (e: Entity, msgs: string[], index: number) => {
    for (const m of livingRefErrors(e as unknown as { id: string; kind: string }, lw)) msgs.push(`ops[${index}]: ${m}`);
    if (e.kind === "group") e.children.forEach((c) => refs(c, msgs, index));
  };
  rawOps.forEach((raw, index) => {
    const r = strictParse<Op>(Op, raw, ["ops", index]);
    if (!r.ok) { errors.push({ index, messages: r.errors }); return; }
    const op = r.value;
    const msgs: string[] = [];
    const known = () => [...ids.keys()].slice(0, 30).join(", ") || "(none)";
    switch (op.op) {
      case "add": {
        const add = (e: Entity) => {
          if (ids.has(e.id)) msgs.push(`ops[${index}]: id "${e.id}" already exists — use {"op":"update","id":"${e.id}","set":{...}} to change it, or pick a new id`);
          ids.set(e.id, e);
          if (e.kind === "group") e.children.forEach(add);
        };
        add(op.entity);
        refs(op.entity, msgs, index);
        if (op.parent) {
          const p = ids.get(op.parent);
          if (!p) msgs.push(`ops[${index}].parent: no entity "${op.parent}"`);
          else if (p.kind !== "group") msgs.push(`ops[${index}].parent: "${op.parent}" is a ${p.kind}, not a group`);
        }
        break;
      }
      case "update": {
        const cur = ids.get(op.id);
        if (!cur) { msgs.push(`ops[${index}].id: no entity "${op.id}". Known ids: ${known()}`); break; }
        if ("id" in op.set && op.set.id !== op.id) msgs.push(`ops[${index}].set.id: ids cannot be renamed — remove and add instead`);
        const merged = deepMerge(cur, op.set);
        const m = strictParse<Entity>(Entity, merged, ["ops", index, "set"]);
        if (!m.ok) msgs.push(...m.errors);
        else {
          ids.set(op.id, m.value);
          refs(m.value, msgs, index);
          // Send each touched top-level key fully merged, so the result is the same whether
          // the engine deep- or shallow-merges (updating only rotation keeps position).
          const full: Record<string, unknown> = {};
          for (const k of Object.keys(op.set)) full[k] = (m.value as Record<string, unknown>)[k];
          ops.push({ ...op, set: full });
          return void (msgs.length && errors.push({ index, messages: msgs }));
        }
        break;
      }
      case "screen": {
        const cur = ids.get(op.id);
        if (!cur) msgs.push(`ops[${index}].id: no entity "${op.id}". Known ids: ${known()}`);
        else if (cur.kind !== "primitive" || !cur.material?.screen) msgs.push(`ops[${index}].id: "${op.id}" is not a screen (a box or plane with material.screen)`);
        else ids.set(op.id, { ...cur, material: { ...cur.material, screen: { ...(cur.material.screen === true ? {} : cur.material.screen), content: op.content } } });
        break;
      }
      case "remove":
      case "animate":
        if (!ids.has(op.id)) msgs.push(`ops[${index}].id: no entity "${op.id}". Known ids: ${known()}`);
        else if (op.op === "remove") ids.delete(op.id);
        break;
      case "sky": {
        const merged = op.set.mode && op.set.mode !== world?.sky?.mode ? op.set : deepMerge(world?.sky ?? {}, op.set);
        const m = strictParse(Sky, merged, ["ops", index, "set"]);
        if (!m.ok) msgs.push(...m.errors);
        break;
      }
      case "path":
      case "graph":
        try {
          applyLivingOp(lw, op);
        } catch (err) {
          msgs.push(`ops[${index}]: ${(err as Error).message}`);
        }
        break;
      case "env": {
        // Same merge as the engine: null removes a key ({"post": null}, {"fog": null}).
        const m = strictParse(Environment, engineMerge(world?.environment ?? {}, op.set), ["ops", index, "set"]);
        if (!m.ok) msgs.push(...m.errors);
        break;
      }
    }
    if (msgs.length) errors.push({ index, messages: msgs });
    ops.push(op);
  });
  return { ok: errors.length === 0, ops, errors };
}

export interface ScriptCheck {
  ok: boolean;
  script?: CameraScript;
  errors: string[];
  warnings: string[];
}

/**
 * Script check: our strict parse first (exact paths, unknown fields), then the camera
 * module's validate() for timing/world semantics, plus a few agent-oriented warnings.
 */
export function checkScript(raw: unknown, world: WorldPack | null, fileExists: (rel: string) => boolean = () => true): ScriptCheck {
  const r = strictParse<CameraScript>(CameraScript, raw, ["script"]);
  if (!r.ok) return { ok: false, errors: r.errors, warnings: [] };
  const v = validateScript(raw, world ?? undefined, { fileExists });
  const s = r.value;
  const warnings = [...v.warnings];
  for (const sh of s.shots) {
    if (sh.kind === "keys" && sh.keys.length === 1) warnings.push(`shot ${sh.id} has one key: a static shot`);
    if (sh.kind === "orbit" && sh.radius < 0.3) warnings.push(`shot ${sh.id}: orbit radius ${sh.radius} m is very small`);
  }
  if (s.fps > 60) warnings.push(`fps ${s.fps} is high; 30 or 60 is usual`);
  // Back-to-back shots whose poses do not meet are hard cuts — say so (often unintended).
  const sorted = [...s.shots].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!, b = sorted[i]!;
    if (Math.abs(b.start - a.end) > 1e-6) continue;
    const pa = shotPose(a, a.end), pb = shotPose(b, b.start);
    const jump = Math.hypot(pa.position[0] - pb.position[0], pa.position[1] - pb.position[1], pa.position[2] - pb.position[2]);
    const scale = Math.max(0.1, Math.hypot(pa.position[0] - pa.target[0], pa.position[1] - pa.target[1], pa.position[2] - pa.target[2]));
    if (jump > 0.05 * scale)
      warnings.push(`hard cut at ${b.start}s: ${a.id} ends at ${fmtV(pa.position)} but ${b.id} starts at ${fmtV(pb.position)} (${jump.toFixed(2)} m jump). Fine if you want a cut; for a continuous move make ${b.id} start at ${a.id}'s end pose${b.kind === "orbit" ? ` (orbit angle θ puts the camera at center + [radius·cos θ, height, radius·sin θ]; θ=90 is +Z)` : ""}.`);
  }
  return { ok: v.ok, script: s, errors: v.errors, warnings };
}
