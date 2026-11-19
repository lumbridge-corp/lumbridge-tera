// Residents and sandboxes: named agents that live in a world, and glass rooms where contained
// agents work. CONTRACT.md section 1d, docs/residents.md.
//
// Two shapes:
//   - the world's DISPLAY data (world.residents, world.sandboxes): what the viewer draws and
//     shows on a card. No matching rules, nothing about where the signals come from.
//   - a REGISTRY file ("tera": "residents/v1"): the display data plus how a live feed recognises
//     each resident (`match`) and who may see it (`visibility`, `publicName`). Registries are
//     private to whoever runs the world; `worldResidents()` turns one into display data for a
//     given audience, renaming or dropping residents the audience may not see.
//
// This file only imports zod (world.ts spreads these shapes in), like living.ts.
import { z } from "zod";

const Col = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb");
const RId = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,39}$/, "resident / sandbox ids are lowercase [a-z0-9-_], at most 40 characters");
const Short = (n: number) => z.string().min(1).max(n);

/** Roles with a built-in look (colour, badge, idle gesture). Any other role id works too: it gets the neutral look. */
export const ROLES = ["steward", "maintenance", "simulator", "analyst", "builder", "messenger", "librarian", "operator", "voice", "brain", "sandboxed"] as const;
export type Role = (typeof ROLES)[number];

/** Badge icons drawn on a resident's chest (the role's default when omitted). */
export const BADGES = ["key", "broom", "dice", "chart", "hammer", "letter", "book", "dial", "wave", "lock", "star", "bolt", "eye", "leaf"] as const;
export type Badge = (typeof BADGES)[number];

/** Who may see a resident: the world's owner only, members, guests too, or everyone (the public world). */
export const VISIBILITY = ["owner", "member", "guest", "public"] as const;
export type Visibility = (typeof VISIBILITY)[number];
/** owner < member < guest < public: an audience sees residents whose visibility is at or above its own level. */
export const visibilityRank = (v: Visibility) => VISIBILITY.indexOf(v);

export const ResidentLook = z.object({
  /** Body colour (default: the role's). Keep it soft: the world's own palette, not neon. */
  body: Col.optional(),
  /** Accent: eyes, halo, badge rim, name-plate dot (default: the role's). */
  accent: Col.optional(),
  badge: z.enum(BADGES).optional(),
  /** Size against a worker robot (default 1.3). */
  scale: z.number().min(0.8).max(2).optional(),
});
export type ResidentLook = z.infer<typeof ResidentLook>;

/** world.residents[]: one named agent (display data only). */
export const ResidentDef = z.object({
  id: RId,
  name: Short(24),
  role: z.string().regex(/^[a-z][a-z-]{1,23}$/, "a role is a lowercase word"),
  /** Where it lives: a free word shown on its card ("Town hall", "compute") ... */
  home: Short(40).optional(),
  /** ... and the graph node it rests at (live feeds send it there when it has nothing to do). */
  homeNode: z.string().min(1).optional(),
  look: ResidentLook.optional(),
  /** The sandbox room it works in, if contained. */
  sandbox: RId.nullable().optional(),
  /** One line for its card: what it does. */
  blurb: z.string().max(140).optional(),
  /**
   * Access, for servers that serve one world to several audiences (residentsFor): who may see
   * it, and the name / blurb shown to the others. The viewer ignores these; a world for one
   * audience leaves them out (worldResidents does).
   */
  visibility: z.enum(VISIBILITY).optional(),
  publicName: Short(24).optional(),
  publicBlurb: z.string().max(140).optional(),
});
export type ResidentDef = z.infer<typeof ResidentDef>;

export const NETWORK = ["none", "loopback", "allowlist", "tailnet", "open", "unknown"] as const;
export const FILES = ["none", "read-only", "workdir", "scratch", "home", "full", "unknown"] as const;
export const SandboxPolicy = z.object({
  network: z.enum(NETWORK),
  files: z.enum(FILES),
  /** Tool names or classes it may use ("shell", "git", "browser"); ["*"] = all; [] = none. */
  tools: z.array(Short(24)).max(8),
  /** Enforced by what ("docker", "bwrap", "openshell", "none"): an honest plaque says "none" when nothing enforces it. */
  enforcer: Short(24).optional(),
});
export type SandboxPolicy = z.infer<typeof SandboxPolicy>;

/** world.sandboxes[]: one glass room and the policy on its door. */
export const SandboxDef = z.object({
  id: RId,
  name: Short(28),
  /** What the boundary really is: "container", "ci-runner", "worktree", "vm", "openshell", ... */
  kind: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
  policy: SandboxPolicy,
  /** The room's group entity in the world (sandboxRoom() builds it). */
  entity: z.string().min(1).optional(),
  blurb: z.string().max(140).optional(),
});
export type SandboxDef = z.infer<typeof SandboxDef>;

/** Display data on the world pack. */
export const ResidentsField = z.array(ResidentDef).max(64).superRefine((list, ctx) => uniqueIds(list, ctx, "resident"));
export const SandboxesField = z.array(SandboxDef).max(32).superRefine((list, ctx) => uniqueIds(list, ctx, "sandbox"));

function uniqueIds(list: { id: string }[], ctx: z.RefinementCtx, what: string) {
  const seen = new Set<string>();
  list.forEach((x, i) => {
    if (seen.has(x.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: `duplicate ${what} id "${x.id}"` });
    seen.add(x.id);
  });
}

// ---------------------------------------------------------------- the registry file

/**
 * How a live feed recognises a resident. Every field is a list of globs (`*` = any run of
 * characters) matched by the feed, not by the engine; the engine only checks the shape.
 *   units       "host:unit"            systemd units (".service" may be left out)
 *   procs       "host:comm" / "host:label"   processes or their feed labels
 *   agents      "source:key"           the feed's own agent ids
 *   langfuse    { project, trace }     trace name globs (journeys)
 *   prometheus  "job" / "metric{label=...}"   selectors (bindings)
 */
export const ResidentMatch = z
  .object({
    units: z.array(Short(96)).max(16).optional(),
    procs: z.array(Short(96)).max(16).optional(),
    agents: z.array(Short(96)).max(16).optional(),
    langfuse: z.array(z.object({ project: Short(64), trace: Short(96).optional() })).max(8).optional(),
    prometheus: z.array(Short(160)).max(8).optional(),
  })
  .strict();
export type ResidentMatch = z.infer<typeof ResidentMatch>;

export const ResidentEntry = ResidentDef.extend({
  match: ResidentMatch,
  /** Who may see it (required in a registry). Audiences below it see `publicName` (+ `publicBlurb`), else nothing. */
  visibility: z.enum(VISIBILITY),
}).strict();
export type ResidentEntry = z.infer<typeof ResidentEntry>;

export const SandboxEntry = SandboxDef.extend({
  visibility: z.enum(VISIBILITY),
  publicName: Short(28).optional(),
  /** What feeds the room's live numbers ("gitea-ci", "lanes", "containers", "openshell"): feed-specific. */
  source: Short(40).optional(),
}).strict();
export type SandboxEntry = z.infer<typeof SandboxEntry>;

export const ResidentRegistry = z
  .object({
    tera: z.literal("residents/v1"),
    residents: z.array(ResidentEntry).max(64),
    sandboxes: z.array(SandboxEntry).max(32).optional(),
  })
  .strict();
export type ResidentRegistry = z.infer<typeof ResidentRegistry>;

export interface RegistryReport {
  errors: string[];
  warnings: string[];
}

/**
 * Check a registry beyond its shape: unique ids and names, sandbox references, a match for
 * every resident (a resident nothing can ever wake is a statue), publicName rules, and, given
 * a world, that home nodes and sandbox room entities exist.
 */
export function checkRegistry(raw: unknown, world?: { graph?: { nodes: { id: string }[] }; entities?: unknown[] }): RegistryReport & { registry: ResidentRegistry | null } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = ResidentRegistry.safeParse(raw);
  if (!r.success) {
    for (const i of r.error.issues.slice(0, 30)) errors.push(`${i.path.join(".") || "registry"}: ${i.message}`);
    return { errors, warnings, registry: null };
  }
  const reg = r.data;
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const sandboxes = new Set((reg.sandboxes ?? []).map((s) => s.id));
  if (sandboxes.size !== (reg.sandboxes ?? []).length) errors.push("sandboxes: duplicate sandbox id");
  const nodes = world?.graph ? new Set(world.graph.nodes.map((n) => n.id)) : null;
  const entityIds = world?.entities ? collectIds(world.entities) : null;
  for (const x of reg.residents) {
    const at = `residents.${x.id}`;
    if (ids.has(x.id)) errors.push(`${at}: duplicate resident id`);
    ids.add(x.id);
    for (const nm of [x.name, x.publicName].filter(Boolean) as string[]) {
      const k = nm.toLowerCase();
      if (names.has(k) && names.get(k) !== x.id) errors.push(`${at}: name "${nm}" is also ${names.get(k)}'s`);
      names.set(k, x.id);
    }
    const m = x.match;
    const n = (m.units?.length ?? 0) + (m.procs?.length ?? 0) + (m.agents?.length ?? 0) + (m.langfuse?.length ?? 0) + (m.prometheus?.length ?? 0);
    if (!n) warnings.push(`${at}: no match rules (it will never wake up)`);
    if (x.sandbox && !sandboxes.has(x.sandbox)) errors.push(`${at}: no sandbox "${x.sandbox}"`);
    if (x.visibility !== "public" && x.publicName && x.publicName.toLowerCase() === x.name.toLowerCase()) errors.push(`${at}: publicName is its private name`);
    if (x.publicBlurb && !x.publicName) warnings.push(`${at}: publicBlurb without publicName is never shown`);
    if (nodes && x.homeNode && !nodes.has(x.homeNode)) errors.push(`${at}: home node "${x.homeNode}" is not in the world graph`);
  }
  for (const s of reg.sandboxes ?? []) {
    if (entityIds && s.entity && !entityIds.has(s.entity)) errors.push(`sandboxes.${s.id}: no entity "${s.entity}" in the world`);
    if (s.visibility !== "public" && s.publicName && s.publicName.toLowerCase() === s.name.toLowerCase()) errors.push(`sandboxes.${s.id}: publicName is its private name`);
  }
  return { errors, warnings, registry: reg };
}

function collectIds(list: unknown[], out = new Set<string>()): Set<string> {
  for (const e of list) {
    const x = e as { id?: unknown; children?: unknown[] };
    if (typeof x?.id === "string") out.add(x.id);
    if (Array.isArray(x?.children)) collectIds(x.children, out);
  }
  return out;
}

/**
 * The display data an audience may see. Residents at or above the audience's level keep their
 * name; below it they show `publicName` (and `publicBlurb`), or are dropped without one. Ids are
 * kept unless `renameIds` gives a new id per resident (a public world should not carry private
 * words in ids either). A dropped resident's sandbox stays (rooms are places, not people).
 */
export function worldResidents(
  reg: ResidentRegistry,
  audience: Visibility,
  opts: { renameIds?: (r: ResidentDef) => string; keepAccess?: boolean } = {},
): { residents: ResidentDef[]; sandboxes: SandboxDef[]; ids: Map<string, string | null> } {
  const { residents, ids } = residentsFor(reg.residents.map(({ match: _m, ...r }) => r), audience, opts);
  return { residents, sandboxes: sandboxesFor(reg.sandboxes ?? [], audience), ids };
}

/**
 * The same for display data that still carries access fields (a server holding the owner's
 * world): residents below the audience's level renamed to publicName or dropped; with
 * `keepAccess` the access fields stay (for a server to filter again), else they are removed.
 */
export function residentsFor(
  list: ResidentDef[],
  audience: Visibility,
  opts: { renameIds?: (r: ResidentDef) => string; keepAccess?: boolean } = {},
): { residents: ResidentDef[]; ids: Map<string, string | null> } {
  const lvl = visibilityRank(audience);
  const ids = new Map<string, string | null>();
  const residents: ResidentDef[] = [];
  for (const r of list) {
    const seen = visibilityRank(r.visibility ?? "public") >= lvl;
    if (!seen && !r.publicName) {
      ids.set(r.id, null);
      continue;
    }
    const id = !seen && opts.renameIds ? opts.renameIds(r) : r.id;
    ids.set(r.id, id);
    const { visibility, publicName, publicBlurb, blurb, name, ...rest } = r;
    const text = seen ? blurb : publicBlurb;
    const access = opts.keepAccess && seen ? { ...(visibility ? { visibility } : {}), ...(publicName ? { publicName } : {}), ...(publicBlurb ? { publicBlurb } : {}) } : {};
    residents.push({ ...rest, id, name: seen ? name : publicName!, ...(text ? { blurb: text } : {}), ...access });
  }
  return { residents, ids };
}

function sandboxesFor(list: SandboxEntry[], audience: Visibility): SandboxDef[] {
  const lvl = visibilityRank(audience);
  return list.map((s) => {
    const seen = visibilityRank(s.visibility) >= lvl;
    const { visibility: _v, publicName, source: _s, name, ...rest } = s;
    return { ...rest, name: seen ? name : publicName ?? "Sandbox" };
  });
}

/** Glob match used by feeds for `match` rules: `*` = any run, case-insensitive, whole string. */
export function globMatch(glob: string, s: string): boolean {
  const re = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(s);
}
