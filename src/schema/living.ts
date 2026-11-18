// Living world schema: paths + street graph (world level), and the actor / flow / meter
// entity kinds. CONTRACT.md sections 1 ("Living world") and 8 ("Live feed").
//
// This file only imports zod (world.ts spreads these field shapes into its entity union),
// so there is no import cycle with world.ts.
import { z } from "zod";

const V3 = z.tuple([z.number(), z.number(), z.number()]);
const Col = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb");
const RefId = z.string().min(1);

/** A named polyline in WORLD coordinates. `smooth` = centripetal Catmull-Rom through the points. */
export const PathDef = z.object({
  id: RefId,
  points: z.array(V3).min(2, "a path needs at least 2 points"),
  closed: z.boolean().optional(),
  smooth: z.boolean().optional(),
});
export type PathDef = z.infer<typeof PathDef>;

/** Street graph: named nodes and undirected edges. Actors route between nodes (shortest path). */
export const GraphNode = z.object({ id: RefId, position: V3 });
export const GraphEdge = z.union([
  z.tuple([RefId, RefId]),
  z.object({ from: RefId, to: RefId, path: RefId.optional() }), // path: walk along this named path instead of a straight line
]);
export const Graph = z.object({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) });
export type Graph = z.infer<typeof Graph>;
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ActorMove = z
  .object({
    path: RefId.optional().describe("walk along this world path"),
    to: RefId.optional().describe("graph node to walk to (shortest route)"),
    from: RefId.optional().describe("graph node to start from (default: nearest node to the actor's position)"),
    speed: z.number().positive().max(50).optional(), // m/s, default 1.2
    startT: z.number().optional(), // script seconds when the walk starts (default 0)
    offset: z.number().optional(), // metres along the route at startT
    loop: z.boolean().optional(), // closed path: loop (default true). open path / route: walk back and forth
    dwell: z.number().min(0).optional(), // seconds spent at each end when looping back and forth (shows `state`)
    lane: z.number().min(-3).max(3).optional(), // metres right of the route centre line (default: a per-actor lane 0.25-0.45 m); 0 = on the line
  })
  .refine((m) => !(m.path && m.to), { message: "move takes path OR to, not both" })
  .refine((m) => !!(m.path || m.to), { message: "move needs path or to" });
export type ActorMove = z.infer<typeof ActorMove>;

export const ActorFields = {
  kind: z.literal("actor"),
  style: z.enum(["worker", "model"]).optional(), // default worker
  src: z.string().optional(), // .glb for style "model"
  color: Col.optional(),
  label: z.string().max(80).optional(),
  state: z.enum(["idle", "walking", "working"]).optional(), // what it does when not moving (default idle)
  move: ActorMove.optional(),
};

export const PipeDef = z.object({
  radius: z.number().positive().optional(),
  color: Col.optional(),
  opacity: z.number().min(0).max(1).optional(),
});

export const FlowFields = {
  kind: z.literal("flow"),
  path: RefId,
  rate: z.number().positive().max(200).optional(), // pulses per second, default 2
  speed: z.number().positive().max(200).optional(), // m/s, default 3
  color: Col.optional(),
  size: z.number().positive().optional(), // pulse radius in metres, default 0.08
  glow: z.boolean().optional(), // soft halo around each pulse, default true
  style: z.enum(["dots", "dashes", "comet"]).optional(), // default dots
  pipe: z.union([z.boolean(), PipeDef]).optional(), // a glass tube along the path the flow runs inside
};

export const MeterFields = {
  kind: z.literal("meter"),
  value: z.number().min(0).max(1),
  style: z.enum(["bar", "ring"]).optional(), // default bar
  size: z.array(z.number().positive()).optional(), // bar [length, thickness]; ring [radius, thickness]
  color: Col.optional(), // default: green → amber → red by value
  track: Col.optional(),
  vertical: z.boolean().optional(), // bar grows up instead of along +X
};

/** Ops that edit the world-level paths and graph. */
export const PathOp = z.object({
  op: z.literal("path"),
  set: PathDef.optional(), // add or replace by id
  remove: RefId.optional(),
});
export const GraphOp = z.object({
  op: z.literal("graph"),
  nodes: z.array(GraphNode).optional(), // add or move by id
  edges: z.array(GraphEdge).optional(), // added (duplicates ignored)
  removeNodes: z.array(RefId).optional(), // also drops their edges
});

// ---------------------------------------------------------------- live feed messages

/** Live feed server → page. `ops` items are validated by the engine's op schema when applied. */
export const LiveMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ops"), ops: z.array(z.record(z.string(), z.unknown())), seq: z.number().optional() }),
  z.object({ type: z.literal("snapshot"), world: z.record(z.string(), z.unknown()), seq: z.number().optional() }),
  z.object({ type: z.literal("ping"), t: z.number().optional() }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;

// ---------------------------------------------------------------- reference checks

interface LivingWorldLike {
  paths?: PathDef[];
  graph?: Graph;
}
interface EntityLike {
  id: string;
  kind: string;
  [k: string]: unknown;
}

/** Problems with path / node references of a living entity (empty when fine). */
export function livingRefErrors(e: EntityLike, world: LivingWorldLike): string[] {
  const out: string[] = [];
  const paths = new Set((world.paths ?? []).map((p) => p.id));
  const nodes = new Set((world.graph?.nodes ?? []).map((n) => n.id));
  const listP = () => [...paths].slice(0, 20).join(", ") || "(none — add one with {\"op\":\"path\",\"set\":{...}})";
  const listN = () => [...nodes].slice(0, 20).join(", ") || "(none — add them with {\"op\":\"graph\",\"nodes\":[...],\"edges\":[...]})";
  if (e.kind === "flow" && typeof e.path === "string" && !paths.has(e.path)) out.push(`flow "${e.id}": no path "${e.path}". Paths: ${listP()}`);
  if (e.kind === "actor") {
    const m = e.move as ActorMove | undefined;
    if (m?.path && !paths.has(m.path)) out.push(`actor "${e.id}": no path "${m.path}". Paths: ${listP()}`);
    if (m?.to && !nodes.has(m.to)) out.push(`actor "${e.id}": no graph node "${m.to}". Nodes: ${listN()}`);
    if (m?.from && !nodes.has(m.from)) out.push(`actor "${e.id}": no graph node "${m.from}". Nodes: ${listN()}`);
    if (e.style === "model" && !e.src) out.push(`actor "${e.id}": style "model" needs src (a .glb)`);
  }
  return out;
}

/** Apply a path / graph op to a world in place. Throws with a readable message. */
export function applyLivingOp(world: LivingWorldLike, op: z.infer<typeof PathOp> | z.infer<typeof GraphOp>): void {
  if (op.op === "path") {
    if (!op.set && !op.remove) throw new Error("path op needs set or remove");
    const list = [...(world.paths ?? [])];
    if (op.remove) {
      const i = list.findIndex((p) => p.id === op.remove);
      if (i < 0) throw new Error(`no path "${op.remove}"`);
      list.splice(i, 1);
    }
    if (op.set) {
      const i = list.findIndex((p) => p.id === op.set!.id);
      if (i >= 0) list[i] = structuredClone(op.set);
      else list.push(structuredClone(op.set));
    }
    world.paths = list;
    return;
  }
  const g: Graph = structuredClone(world.graph ?? { nodes: [], edges: [] });
  for (const n of op.nodes ?? []) {
    const i = g.nodes.findIndex((x) => x.id === n.id);
    if (i >= 0) g.nodes[i] = structuredClone(n);
    else g.nodes.push(structuredClone(n));
  }
  if (op.removeNodes?.length) {
    const drop = new Set(op.removeNodes);
    for (const id of drop) if (!g.nodes.some((n) => n.id === id)) throw new Error(`no graph node "${id}"`);
    g.nodes = g.nodes.filter((n) => !drop.has(n.id));
    g.edges = g.edges.filter((e) => !drop.has(edgeEnds(e)[0]) && !drop.has(edgeEnds(e)[1]));
  }
  const ids = new Set(g.nodes.map((n) => n.id));
  const key = (e: GraphEdge) => edgeEnds(e).slice().sort().join("\u0000");
  const have = new Set(g.edges.map(key));
  for (const e of op.edges ?? []) {
    const [a, b] = edgeEnds(e);
    if (!ids.has(a)) throw new Error(`edge ${a}-${b}: no graph node "${a}"`);
    if (!ids.has(b)) throw new Error(`edge ${a}-${b}: no graph node "${b}"`);
    if (have.has(key(e))) continue;
    have.add(key(e));
    g.edges.push(structuredClone(e));
  }
  world.graph = g;
}

export function edgeEnds(e: GraphEdge): [string, string] {
  return Array.isArray(e) ? [e[0], e[1]] : [e.from, e.to];
}
