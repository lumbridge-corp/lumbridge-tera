// World pack schema — tera "world/v1". Source of truth for CONTRACT.md section 1.
import { z } from "zod";
import { ActorFields, FlowFields, Graph, MeterFields, PathDef } from "./living.ts";
import { ResidentsField, SandboxesField } from "./residents.ts";

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

/**
 * What a screen shows (material.screen.content, the `screen` op). `video`: a same-origin mp4,
 * muted and looping; `image`: a picture; `youtube`: a card drawn from a thumbnail image with
 * title, channel and a live / playing badge (no third-party player); `panel`: a small calm
 * dashboard drawn by the engine (title, status, rows of bars + values, a sparkline), all text
 * and numbers from the world; `off`: dark glass.
 */
export const ScreenContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), src: z.string().min(1), title: z.string().max(200).optional() }),
  z.object({ kind: z.literal("image"), src: z.string().min(1), title: z.string().max(200).optional() }),
  z.object({
    kind: z.literal("youtube"),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "videoId is [A-Za-z0-9_-]"),
    title: z.string().max(200).optional(),
    channel: z.string().max(120).optional(),
    live: z.boolean().optional(),
    playing: z.boolean().optional(),
    /** Thumbnail URL (else the screen's `youtubeThumb`). */
    thumb: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("panel"),
    /** Heading, top left. */
    title: z.string().max(60).optional(),
    /** A short line under the heading. */
    subtitle: z.string().max(80).optional(),
    /** A small status pill, top right (a dot in `accent` + text). */
    status: z.string().max(24).optional(),
    /** Up to 8 rows: a label, an optional 0..1 bar and an optional value text. */
    rows: z.array(z.object({ label: z.string().max(40), value: z.number().min(0).max(1).optional(), text: z.string().max(24).optional() })).max(8).optional(),
    /** A sparkline along the bottom (oldest first), 0..1 each. */
    series: z.array(z.number().min(0).max(1)).max(120).optional(),
    /** Bars, dot and sparkline colour (default a calm green). */
    accent: Color.optional(),
    /** Dark (default) or light background. */
    theme: z.enum(["dark", "light"]).optional(),
  }),
  z.object({ kind: z.literal("off") }),
]);
export type ScreenContent = z.infer<typeof ScreenContent>;

/**
 * A screen surface (CONTRACT section 1 "Screens"): on a box the +Z face shows the content (the
 * other faces are a dark bezel), on a plane its +Y face. `true` = a screen that is off.
 */
export const ScreenSpec = z.object({
  content: ScreenContent.optional(),
  /** Reflections on the glass, 0..1 (default 0.3). */
  glare: z.number().min(0).max(1).optional(),
  /** Emissive gain of the picture (default 1.2). */
  brightness: z.number().min(0).max(4).optional(),
  /** Thumbnail URL for youtube content without its own `thumb`; `{id}` is replaced by the videoId. */
  youtubeThumb: z.string().min(1).optional(),
  /** Reserved: an embedded player overlay in live mode. Not drawn by this engine version (the card is used). */
  iframe: z.boolean().optional(),
});
export type ScreenSpec = z.infer<typeof ScreenSpec>;

export const Material = z.object({
  color: Color.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  emissive: Color.optional(),
  opacity: z.number().min(0).max(1).optional(),
  wireframe: z.boolean().optional(),
  glow: z.number().min(0).max(50).optional(), // emissive intensity; with no emissive colour, glows in its own colour
  /**
   * false: this surface never feeds bloom (the glow pass sees it as an unlit occluder). For a faint
   * emissive on big surfaces, e.g. a room's walls holding a little lamp light at night: seen from
   * inside, bloom would turn it into a haze over the whole picture.
   */
  bloom: z.boolean().optional(),
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
  /** A screen whose picture changes at runtime (the `screen` op): video, image, youtube card or off. Box or plane; not with glass / glowExact. */
  screen: z.union([z.literal(true), ScreenSpec]).optional(),
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
    if (e.kind === "primitive" && e.material?.screen) {
      if (e.shape !== "box" && e.shape !== "plane") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["material", "screen"], message: `a screen is a box (content on its +Z face) or a plane (+Y face), not a ${e.shape}` });
      if (e.material.glass || e.material.glowExact) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["material", "screen"], message: "a screen cannot also be glass or glowExact" });
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

/**
 * A walkable layer of a world (live viewer only: walk / fly / layer travel, presence). Floors are
 * flat at `floorY`; people walk inside the disc `walk` (world x, z); `height` is the room's clear
 * height above the floor (a ceiling), omitted for open sky. CONTRACT.md section 1c.
 */
export const Layer = z.object({
  id: Id,
  name: z.string().min(1).max(40),
  floorY: z.number(),
  walk: z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number().positive().max(1000) }),
  spawn: Vec3,
  /** A world.cameras key to frame this layer from in orbit mode. */
  camera: z.string().max(64).optional(),
  height: z.number().positive().max(1000).optional(),
});
export type Layer = z.infer<typeof Layer>;

export const Layers = z
  .array(Layer)
  .max(8)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((l, i) => {
      if (seen.has(l.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: `duplicate layer id "${l.id}"` });
      seen.add(l.id);
      const d = Math.hypot(l.spawn[0] - l.walk.center[0], l.spawn[2] - l.walk.center[1]);
      if (d > l.walk.radius + 1e-6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "spawn"], message: `spawn is ${d.toFixed(1)} m from the walk centre, outside its radius ${l.walk.radius}` });
      if (l.spawn[1] < l.floorY - 1e-6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "spawn"], message: "spawn is below the floor" });
    });
  });

/**
 * Islands in one sky (CONTRACT.md section 1e, docs/islands.md): other worlds drawn next to this one,
 * each at its own offset, loaded lazily by distance in the live viewer (an impostor until then) and
 * all at load in render mode; an optional ferry (a cabin on a route) links this world to the island.
 */
export const IslandId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "island ids are lowercase [a-z0-9-], at most 32 characters (no dots)");
export const Ferry = z
  .object({
    name: z.string().min(1).max(40).optional(),
    /** The link's geometry in THIS world's frame (towers, cable, stations, the cabin); composed as "<island>.ferry.<id>". */
    entities: z.array(Entity).max(64),
    /** Id (top level of `entities`) of the cabin the viewer moves along `route`. */
    cabin: z.string().min(1),
    /** The cabin origin's path in this world's frame, home end first. */
    route: z.array(Vec3).min(2).max(256),
    /** Where a rider steps in (home side) and out (island side), this world's frame. */
    board: Vec3,
    alight: Vec3,
    /** Rider's feet above the cabin origin (m, default 0). */
    floor: z.number().min(-10).max(10).optional(),
    /** Seconds per crossing, shuttling on its own (default 40; 6 s at each end) and ridden (default: by length). */
    period: z.number().min(4).max(3600).optional(),
  })
  .superRefine((f, ctx) => {
    if (!f.entities.some((e) => e.id === f.cabin)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cabin"], message: `no entity "${f.cabin}" at the top level of ferry.entities` });
  });
export type Ferry = z.infer<typeof Ferry>;
export const IslandRef = z.object({
  id: IslandId,
  name: z.string().min(1).max(40),
  /** The island's own world/v1 JSON, relative to this world's URL. */
  src: z.string().min(1),
  /** The island's origin in this world's frame (translation only). */
  offset: Vec3,
  /** Footprint radius (m) around the offset, in x/z. */
  radius: z.number().positive().max(2000),
  /** Camera distance (m) to the island centre under which the live viewer loads it (default 260; unloads at 1.25x). */
  load: z.number().positive().max(10000).optional(),
  /** Its live feed (ws url or same-origin path), live viewer only. */
  live: z.string().min(1).optional(),
  /** Its presence room (ws url or path), live viewer only. */
  presence: z.string().min(1).optional(),
  /** Island-local stand-in drawn while the full island is not loaded (a few primitives). */
  impostor: z.array(Entity).max(64).optional(),
  ferry: Ferry.optional(),
});
export type IslandRef = z.infer<typeof IslandRef>;
export const Islands = z
  .array(IslandRef)
  .max(8)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: `duplicate island id "${r.id}"` });
      seen.add(r.id);
    });
  });

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
  // live viewer only (walk / fly / layer travel, presence), never drawn into frames
  layers: Layers.optional(),
  // named residents (actors with style "resident" refer to them) and sandbox rooms: CONTRACT.md 1d
  residents: ResidentsField.optional(),
  sandboxes: SandboxesField.optional(),
  // other worlds in the same sky (live viewer: lazy; render mode: all at load): CONTRACT.md 1e
  islands: Islands.optional(),
});
export type WorldPack = z.infer<typeof WorldPack>;
