// Camera script — tera "camera/v1". CONTRACT.md section 3.
import { z } from "zod";
import { Vec3 } from "./world.ts";
import { Ease, Op } from "./ops.ts";

export const Key = z.object({ t: z.number().min(0), position: Vec3, target: Vec3, fov: z.number().min(5).max(120).optional() });

const shotBase = { id: z.string(), start: z.number().min(0), end: z.number().positive(), ease: Ease.optional() };

export const Shot = z.discriminatedUnion("kind", [
  z.object({ ...shotBase, kind: z.literal("keys"), path: z.enum(["linear", "catmull"]).optional(), keys: z.array(Key).min(1) }),
  z.object({
    ...shotBase,
    kind: z.literal("orbit"),
    center: Vec3,
    radius: z.number().positive(),
    height: z.number(),
    fromDeg: z.number(),
    toDeg: z.number(),
    fov: z.number().min(5).max(120).optional(),
  }),
]);
export type Shot = z.infer<typeof Shot>;

export const CameraScript = z
  .object({
    tera: z.literal("camera/v1"),
    world: z.string().optional(),
    fps: z.number().int().min(1).max(120),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(4320),
    duration: z.number().positive(),
    shots: z.array(Shot).min(1),
    events: z.array(z.object({ t: z.number().min(0), ops: z.array(Op) })).optional(),
    audio: z.object({ src: z.string(), offset: z.number().optional() }).optional(),
    marks: z.array(z.object({ t: z.number().min(0), label: z.string() })).optional(),
  })
  .superRefine((s, ctx) => {
    const shots = [...s.shots].sort((a, b) => a.start - b.start);
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i]!;
      if (sh.end <= sh.start) ctx.addIssue({ code: "custom", message: `shot ${sh.id}: end must be after start` });
      if (i > 0 && sh.start < shots[i - 1]!.end) ctx.addIssue({ code: "custom", message: `shot ${sh.id} overlaps ${shots[i - 1]!.id}` });
      if (sh.kind === "keys")
        for (const k of sh.keys)
          if (k.t < sh.start || k.t > sh.end) ctx.addIssue({ code: "custom", message: `shot ${sh.id}: key t=${k.t} outside [${sh.start}, ${sh.end}]` });
    }
  });
export type CameraScript = z.infer<typeof CameraScript>;
