// World pack schema — tera "world/v1". Source of truth for CONTRACT.md section 1.
import { z } from "zod";
import { ActorFields, FlowFields, Graph, MeterFields, PathDef } from "./living.ts";

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb");
const Id = z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/, "ids are lowercase [a-z0-9-_.]");

export const Transform = z.object({
  position: Vec3.optional(),
  rotation: Vec3.optional(), // Euler XYZ, degrees
  scale: z.union([z.number(), Vec3]).optional(),
});
export type Transform = z.infer<typeof Transform>;

export const Material = z.object({
  color: Color.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  emissive: Color.optional(),
  opacity: z.number().min(0).max(1).optional(),
  wireframe: z.boolean().optional(),
  glow: z.number().min(0).max(50).optional(), // emissive intensity; with no emissive colour, glows in its own colour
  /** The glowing surface lands on exactly its colour on screen (emissive, else color), saturated under tone mapping; `glow` then only feeds bloom. */
  glowExact: z.boolean().optional(),
  /** Clear glass: see-through (interiors keep their contrast), slight tint from `color`, sky reflections + fresnel rim; `roughness` frosts it; `opacity` is ignored. */
  glass: z.boolean().optional(),
  /**
   * Night look (with a real or sun sky): as the sun goes down (environment.nightLights.ramp,
   * default +2° → −6°) the emissive fades from its day value to `emissive` (default the
   * material's emissive, else its colour) at `intensity` (default 1.5): windows that glow at night.
   */
  night: z.object({ emissive: Color.optional(), intensity: z.number().min(0).max(50).optional() }).optional(),
});

/** Partial sweep in degrees around the shape's axis. Cylinder/cone/capsule: around Y, 0 = +Z, 90 = +X. Torus: in its XY plane, 0 = +X, 90 = +Y. */
export const Arc = z.object({
  start: z.number().optional(), // degrees, default 0
  length: z.number().gt(0).max(360), // degrees
});

const base = {
  id: Id,
  transform: Transform.optional(),
  visible: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
};

export const PrimitiveEntity = z.object({
  ...base,
  kind: z.literal("primitive"),
  shape: z.enum(["box", "sphere", "plane", "cylinder", "torus", "cone", "capsule", "segment", "prism"]),
  size: z.array(z.number().positive()).optional(),
  material: Material.optional(),
  /** cylinder / cone / torus: only part of the sweep (arches, vaults, half-pipes). */
  arc: Arc.optional(),
  /** cylinder / cone: no end caps (a tube or shell, drawn double-sided). */
  open: z.boolean().optional(),
  /** cylinder: hollow with this inner radius (m), solid walls and end faces (thick arches, rings, pipes). */
  inner: z.number().positive().optional(),
  /** box: rounded edges with this radius (m). segment: the tube radius (m, default 0.05). */
  radius: z.number().positive().optional(),
  /** segment: the two end points (m, in the entity's own space): a cylinder from `from` to `to`. */
  from: Vec3.optional(),
  to: Vec3.optional(),
});
export const ModelEntity = z.object({ ...base, kind: z.literal("model"), src: z.string(), animation: z.string().optional() });
export const SplatEntity = z.object({ ...base, kind: z.literal("splat"), src: z.string() });
export const TextEntity = z.object({
  ...base,
  kind: z.literal("text"),
  text: z.string(),
  size: z.number().positive().optional(),
  color: Color.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  billboard: z.boolean().optional(),
});
export const LightEntity = z.object({
  ...base,
  kind: z.literal("light"),
  light: z.enum(["directional", "point", "spot", "ambient", "hemisphere"]),
  color: Color.optional(),
  intensity: z.number().min(0).optional(),
  target: Vec3.optional(),
  castShadow: z.boolean().optional(),
  /** point / spot: range in metres where the light reaches zero (0 = no limit, the default). */
  distance: z.number().min(0).optional(),
  /** point / spot: falloff exponent (2 = physical inverse square, the default; 0 = no falloff). */
  decay: z.number().min(0).optional(),
  /** Only at night: the intensity fades in as the sun goes down (environment.nightLights.ramp). Streetlights, lamps. */
  night: z.boolean().optional(),
  /** Only by day: the intensity fades out as the sun goes down (fill lights authored for daylight). */
  day: z.boolean().optional(),
});

export const ActorEntity = z.object({ ...base, ...ActorFields });
export const FlowEntity = z.object({ ...base, ...FlowFields });
export const MeterEntity = z.object({ ...base, ...MeterFields });

/** Deterministic per-copy variation for `repeat` (same seed, same layout). */
export const RepeatJitter = z.object({
  seed: z.number().int().optional(),
  position: z.union([z.number().min(0), Vec3]).optional(), // ± metres (number = x and z)
  rotation: z.union([z.number().min(0), Vec3]).optional(), // ± degrees (number = around Y)
  scale: z.number().min(0).max(0.9).optional(), // ± fraction, uniform
  color: z.number().min(0).max(1).optional(), // 0..1 hue/lightness variation
});
export type RepeatJitter = z.infer<typeof RepeatJitter>;

/**
 * Radial layout for `repeat` (instead of count/step): `count` copies on a circle of `radius` around
 * `axis` (default "y"), each turned with its angle so its local +Z points away from the axis and its
 * local +Y runs along it. Angles: around y 0 = +Z, 90 = +X (as cylinder arcs); around z 0 = +X,
 * 90 = +Y (as torus arcs); around x 0 = +Y, 90 = +Z. A full circle (lengthDeg 360, the default)
 * spaces copies evenly; a partial one puts the first copy at startDeg and the last at
 * startDeg + lengthDeg.
 */
export const RepeatRadial = z.object({
  count: z.number().int().min(1),
  radius: z.number().min(0),
  axis: z.enum(["x", "y", "z"]).optional(),
  startDeg: z.number().optional(),
  lengthDeg: z.number().gt(0).max(360).optional(),
});
export type RepeatRadial = z.infer<typeof RepeatRadial>;
/** Cells left empty: [i, j, k] (grid) or a copy index (radial, or i of a single row). */
export const RepeatSkip = z.array(z.union([z.number().int().min(0), z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)])]));
export type RepeatSkip = z.infer<typeof RepeatSkip>;

/** Kinds a repeat may copy (static geometry). */
export const REPEATABLE = ["primitive", "model", "text", "group", "repeat"] as const;
export const REPEAT_MAX = 20000;

export type Entity =
  | z.infer<typeof PrimitiveEntity>
  | z.infer<typeof ModelEntity>
  | z.infer<typeof SplatEntity>
  | z.infer<typeof TextEntity>
  | z.infer<typeof LightEntity>
  | z.infer<typeof ActorEntity>
  | z.infer<typeof FlowEntity>
  | z.infer<typeof MeterEntity>
  | (z.infer<z.ZodObject<typeof base>> & { kind: "group"; children: Entity[] })
  | (z.infer<z.ZodObject<typeof base>> & {
      kind: "repeat";
      of: Entity;
      count?: [number, number, number] | number;
      step?: [number, number, number];
      radial?: RepeatRadial;
      skip?: RepeatSkip;
      jitter?: RepeatJitter;
    });

/** Copies in a grid repeat (product of count; no count = 1). */
export function repeatCount(count: [number, number, number] | number | undefined): number {
  return count === undefined ? 1 : typeof count === "number" ? count : count[0] * count[1] * count[2];
}
type RepeatLike = { of: Entity; count?: [number, number, number] | number; radial?: RepeatRadial };
/** Cells in a repeat, grid or radial (skipped cells included: the limit counts the layout). */
export function repeatCopies(e: Omit<RepeatLike, "of">): number {
  return e.radial ? e.radial.count : repeatCount(e.count);
}

function repeatProblems(e: RepeatLike, path: (string | number)[], ctx: z.RefinementCtx, mult = 1) {
  const n = repeatCopies(e) * mult;
  if (n > REPEAT_MAX) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "count"], message: `${n} copies is over the limit of ${REPEAT_MAX}` });
  const visit = (x: Entity, p: (string | number)[], m: number) => {
    if (!(REPEATABLE as readonly string[]).includes(x.kind)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: p, message: `repeat cannot copy a ${x.kind} (allowed: ${REPEATABLE.join(", ")})` });
    if (x.kind === "group") x.children.forEach((c, i) => visit(c, [...p, "children", i], m));
    if (x.kind === "repeat") {
      const k = repeatCopies(x) * m;
      if (k > REPEAT_MAX) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...p, "count"], message: `${k} copies (nested) is over the limit of ${REPEAT_MAX}` });
      visit(x.of, [...p, "of"], k);
    }
  };
  visit(e.of, [...path, "of"], n);
}

export const Entity: z.ZodType<Entity> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    PrimitiveEntity,
    ModelEntity,
    SplatEntity,
    TextEntity,
    LightEntity,
    ActorEntity,
    FlowEntity,
    MeterEntity,
    z.object({ ...base, kind: z.literal("group"), children: z.array(Entity) }),
    z.object({
        ...base,
        kind: z.literal("repeat"),
        // The copied entity; its id is only a label (copies are not separate entities).
        of: z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) && !("id" in v) ? { ...v, id: "item" } : v), Entity),
        // Grid layout: count + step. Radial layout: radial (instead of count/step).
        count: z.union([z.number().int().min(1), z.tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)])]).optional(),
        step: Vec3.optional(),
        radial: RepeatRadial.optional(),
        skip: RepeatSkip.optional(),
        jitter: RepeatJitter.optional(),
      }),
  ]).superRefine((e, ctx) => {
    if (e.kind === "repeat") {
      const r = e as unknown as RepeatLike & { step?: Vec3 };
      if (r.radial && (r.count !== undefined || r.step)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["radial"], message: "use either radial or count + step, not both" });
      if (!r.radial && (r.count === undefined || !r.step)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: r.count === undefined ? ["count"] : ["step"], message: 'a repeat needs count + step (grid) or radial {"count","radius"}' });
      repeatProblems(r, [], ctx);
    }
    if (e.kind === "primitive" && e.shape === "segment") {
      if (!e.from || !e.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [e.from ? "to" : "from"], message: 'a segment needs "from" and "to" points ([x,y,z]) and an optional "radius"' });
      else if (Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]) < 1e-6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "segment from and to are the same point" });
    }
    if (e.kind === "light" && e.night && e.day) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["day"], message: "a light is either night: true (on at night) or day: true (on by day), not both" });
    if (e.kind === "primitive" && e.shape !== "segment" && (e.from || e.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [e.from ? "from" : "to"], message: `from/to belong to shape "segment", not "${e.shape}"` });
  }),
) as z.ZodType<Entity>;

/** Satellites on the real sky: SGP4 from element sets (OMM JSON array or TLE text) at `src`. */
export const SkySatellites = z.object({
  /** URL or world-relative path of a Celestrak-style GP JSON array (OMM) or TLE text. Never fetched unless given. */
  src: z.string().optional(),
  /** Name filters: "starlink", "oneweb", "iss", "stations", "kuiper", "all" (default all). */
  groups: z.array(z.string().min(1)).max(8).optional(),
  /** Keep at most this many element sets (file order, after the group filter). Default 12000. */
  max: z.number().int().positive().max(20000).optional(),
  /** Degrees above the horizon below which satellites are not drawn. Default 0. */
  minElevation: z.number().min(-2).max(80).optional(),
  /** Default true: only what the eye could see (sunlit, dark sky). false: every object above the horizon, eclipsed ones faint blue. */
  visibleOnly: z.boolean().optional(),
});

/**
 * The real sky at a time and place: precise sun, moon with phase, ~9 000 catalogue stars, the
 * planets, the Milky Way, satellites (SGP4), twilight and night. `time` ISO (no zone = local
 * clock time at `lon`) or "now" (live mode follows the wall clock; render mode reads the clock
 * once at load). In render mode the sky time is `time + script t · timeScale`.
 */
export const RealSky = z.object({
  mode: z.literal("real"),
  time: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** IANA zone (e.g. "America/Los_Angeles") for the viewer's clock display only; the sky itself is computed in UTC. */
  timezone: z.string().optional(),
  /** Sky seconds per second of script (render) or page (live) time. Default 1; 600 = ten minutes a second. */
  timeScale: z.number().min(-100000).max(100000).optional(),
  /** The moon (default true); `scale` enlarges the disc (1 = true size, 0.52°). */
  moon: z.union([z.boolean(), z.object({ scale: z.number().min(0.5).max(8).optional() })]).optional(),
  /** Stars (default true): `magnitudeLimit` (default 6.5) and the Milky Way band (default true). */
  stars: z.union([z.boolean(), z.object({ magnitudeLimit: z.number().min(-1).max(7).optional(), milkyWay: z.boolean().optional() })]).optional(),
  /** Mercury, Venus, Mars, Jupiter, Saturn as points of light (default true). */
  planets: z.boolean().optional(),
  satellites: SkySatellites.optional(),
  /** Warm city glow on the night horizon 0..1 (default 0.15); it also hides faint stars and the Milky Way. */
  cityGlow: z.number().min(0).max(1).optional(),
  /** Lift the exposure gently at night so a dark town still reads (default true). */
  exposureAuto: z.boolean().optional(),
});
export type RealSky = z.infer<typeof RealSky>;

export const Sky = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("sun"), time: z.string(), lat: z.number(), lon: z.number() }),
  RealSky,
  z.object({ mode: z.literal("color"), color: Color }),
  z.object({ mode: z.literal("hdri"), src: z.string() }),
]);
export type Sky = z.infer<typeof Sky>;

/** Post effects for video quality (CONTRACT section 1). A backend that cannot do one skips it with a warning. */
export const Post = z.object({
  /** Screen-space ambient occlusion (GTAO). */
  ao: z.boolean().optional(),
  /**
   * Glow around bright pixels. source "glow" (default): only glowing things bloom (material glow/emissive,
   * flows, robot lights), so a bright sunlit scene never washes out; threshold (default 0) on that glow.
   * source "scene": every pixel whose scene-linear luminance is above threshold (default 1;
   * sunlit surfaces reach 1.5-3, so use 3+ in bright scenes). strength ~0.2-1.5, radius 0..1.
   */
  bloom: z
    .object({
      strength: z.number().min(0),
      threshold: z.number().min(0).optional(),
      radius: z.number().min(0).max(1).optional(),
      source: z.enum(["glow", "scene"]).optional(),
    })
    .optional(),
  /**
   * Depth of field, two modes (blur sizes are fractions of the image width):
   * - depth (default): focus = sharp distance in metres along the view direction; blur = aperture·|1 − focus/d|
   *   (aperture = blur of something at infinity, scale-free: the same numbers work at 2 m or 200 m),
   *   capped at maxBlur (default 0.012). Miniature look ≈ 0.02-0.05.
   * - tiltshift: a sharp horizontal band on screen, blur growing above and below it — the diorama look,
   *   independent of depth. center = band centre (0 top .. 1 bottom, default 0.5), band = band height
   *   (default 0.2), falloff = height over which blur reaches full (default 0.3), blur (default 0.008).
   */
  dof: z
    .union([
      z.object({
        mode: z.literal("depth").optional(),
        focus: z.number().positive(),
        aperture: z.number().min(0),
        maxBlur: z.number().min(0).max(0.05).optional(),
      }),
      z.object({
        mode: z.literal("tiltshift"),
        center: z.number().min(0).max(1).optional(),
        band: z.number().min(0).max(1).optional(),
        falloff: z.number().positive().max(2).optional(),
        blur: z.number().min(0).max(0.05).optional(),
      }),
    ])
    .optional(),
});
export type Post = z.infer<typeof Post>;

export const Environment = z.object({
  exposure: z.number().positive().optional(),
  fog: z.object({ color: Color, near: z.number(), far: z.number() }).optional(),
  post: Post.optional(),
  /** Night lights (material.night, light night/day): the sun-elevation ramp [day, night] in degrees, default [2, -6]. */
  nightLights: z.object({ ramp: z.tuple([z.number().min(-30).max(30), z.number().min(-30).max(30)]).optional() }).optional(),
});

export const CameraPose = z.object({ position: Vec3, target: Vec3, fov: z.number().min(5).max(120).optional() });
export type CameraPose = z.infer<typeof CameraPose>;

export const WorldPack = z.object({
  tera: z.literal("world/v1"),
  id: Id,
  title: z.string(),
  sky: Sky.optional(),
  environment: Environment.optional(),
  entities: z.array(Entity),
  paths: z.array(PathDef).optional(), // living world: named polylines (streets, tunnels) in world coordinates
  graph: Graph.optional(), // living world: street graph actors route on
  cameras: z.record(z.string(), CameraPose).optional(),
  // live viewer UI only (a small key in the HUD), never drawn into frames
  legend: z.array(z.object({ label: z.string().min(1).max(40), color: Color })).max(8).optional(),
});
export type WorldPack = z.infer<typeof WorldPack>;
