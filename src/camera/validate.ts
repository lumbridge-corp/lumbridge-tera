// Camera script validation — errors stop a render, warnings are worth a look.
// Pure (no node:fs): pass `fileExists` to check audio.src; the CLI and MCP server do.
import { CameraScript, type Entity, type Op, type WorldPack } from "../schema/index.ts";
import { frameCount } from "./evaluate.ts";

export interface ValidateOptions {
  /** Return whether a script-relative path (audio.src) exists. Skipped when absent. */
  fileExists?: (src: string) => boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Parsed script when the schema check passed. */
  script?: CameraScript;
  frames?: number;
}

const MAX_FRAMES = 120 * 60 * 30; // 30 minutes at 120 fps

function collectIds(list: Entity[], into: Map<string, Entity>) {
  for (const e of list) {
    into.set(e.id, e);
    if (e.kind === "group") collectIds(e.children, into);
  }
}

function removeTree(e: Entity, ids: Map<string, Entity>) {
  ids.delete(e.id);
  if (e.kind === "group") for (const c of e.children) removeTree(c, ids);
}

export function validate(input: unknown, world?: WorldPack, opts: ValidateOptions = {}): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = CameraScript.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message);
    return { ok: false, errors, warnings };
  }
  const s = parsed.data;

  // frames
  const exact = s.duration * s.fps;
  const frames = frameCount(s);
  if (Math.abs(exact - Math.round(exact)) > 1e-6) warnings.push(`duration × fps = ${+exact.toFixed(3)} is not a whole number; renders ${frames} frames`);
  if (frames > MAX_FRAMES) errors.push(`${frames} frames is more than the ${MAX_FRAMES} frame limit`);
  if (s.width % 2 || s.height % 2) errors.push(`size ${s.width}x${s.height}: H.264 yuv420p needs even width and height`);

  // shots
  const shots = [...s.shots].sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  for (const sh of shots) {
    if (seen.has(sh.id)) warnings.push(`shot id "${sh.id}" is used twice`);
    seen.add(sh.id);
    if (sh.start >= s.duration) warnings.push(`shot ${sh.id} starts at ${sh.start}s, at or after the end (${s.duration}s); it never plays`);
    else if (sh.end > s.duration + 1e-9) warnings.push(`shot ${sh.id} ends at ${sh.end}s, after the end (${s.duration}s); it is cut`);
    if (sh.kind === "keys") {
      for (const k of sh.keys) if (k.t < sh.start || k.t > sh.end) errors.push(`shot ${sh.id}: key t=${k.t} is outside the shot [${sh.start}, ${sh.end}]`);
      for (let i = 1; i < sh.keys.length; i++) {
        if (sh.keys[i]!.t < sh.keys[i - 1]!.t) { warnings.push(`shot ${sh.id}: keys are not in time order (sorted for playback)`); break; }
      }
      const times = sh.keys.map((k) => k.t).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) if (times[i] === times[i - 1]) warnings.push(`shot ${sh.id}: two keys at t=${times[i]} — the camera jumps there`);
      for (const k of sh.keys) {
        if (dist(k.position, k.target) < 1e-6) errors.push(`shot ${sh.id}: key t=${k.t} has position == target (no view direction)`);
      }
      if (sh.keys[0]!.t > sh.start || sh.keys[sh.keys.length - 1]!.t < sh.end) {
        const first = Math.min(...times), last = Math.max(...times);
        if (first > sh.start) warnings.push(`shot ${sh.id}: first key at ${first}s, holds still from ${sh.start}s`);
        if (last < sh.end) warnings.push(`shot ${sh.id}: last key at ${last}s, holds still until ${sh.end}s`);
      }
    } else if (Math.abs(sh.height) < 1e-9 && sh.radius < 1e-9) {
      errors.push(`shot ${sh.id}: orbit radius and height are both 0`);
    }
  }
  if (shots[0]!.start > 0) warnings.push(`first shot starts at ${shots[0]!.start}s; frames before it hold its first pose`);
  for (let i = 1; i < shots.length; i++)
    if (shots[i]!.start > shots[i - 1]!.end) warnings.push(`gap ${shots[i - 1]!.end}s–${shots[i]!.start}s between ${shots[i - 1]!.id} and ${shots[i]!.id} holds the last pose`);
  const lastEnd = Math.max(...shots.map((sh) => sh.end));
  if (lastEnd < s.duration) warnings.push(`shots end at ${lastEnd}s but the video runs to ${s.duration}s; the end holds the last pose`);

  // world
  if (world) {
    if (s.world && s.world !== world.id) warnings.push(`script was written for world "${s.world}" but the world is "${world.id}"`);
    const ids = new Map<string, Entity>();
    collectIds(world.entities, ids);
    const events = [...(s.events ?? [])].map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t || a.i - b.i);
    for (const ev of events) {
      ev.ops.forEach((op: Op, j) => {
        const where = `events[${ev.i}] (t=${ev.t}) op ${j}`;
        switch (op.op) {
          case "add": {
            const before = new Map<string, Entity>();
            collectIds([op.entity], before);
            for (const id of before.keys()) if (ids.has(id)) errors.push(`${where}: add "${id}" but that id already exists`);
            if (op.parent && ids.get(op.parent)?.kind !== "group") errors.push(`${where}: parent "${op.parent}" is not a group in the world`);
            collectIds([op.entity], ids);
            break;
          }
          case "update":
          case "animate":
          case "screen":
            if (!ids.has(op.id)) errors.push(`${where}: ${op.op} unknown entity "${op.id}"`);
            break;
          case "remove":
            if (!ids.has(op.id)) errors.push(`${where}: remove unknown entity "${op.id}"`);
            else removeTree(ids.get(op.id)!, ids);
            break;
        }
      });
    }
  } else if (s.events?.length) {
    warnings.push("no world given: entity ids in events were not checked");
  }

  for (const [i, ev] of (s.events ?? []).entries()) if (ev.t > s.duration) warnings.push(`events[${i}] at ${ev.t}s is after the end (${s.duration}s); it never fires`);
  for (const [i, m] of (s.marks ?? []).entries()) if (m.t > s.duration) warnings.push(`marks[${i}] "${m.label}" at ${m.t}s is after the end`);

  // audio
  if (s.audio) {
    if (opts.fileExists && !opts.fileExists(s.audio.src)) errors.push(`audio.src "${s.audio.src}" not found`);
    if ((s.audio.offset ?? 0) >= s.duration) warnings.push(`audio.offset ${s.audio.offset}s is at or after the end; the audio is silent`);
  }

  return { ok: errors.length === 0, errors, warnings, script: s, frames };
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

