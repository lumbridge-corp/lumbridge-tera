// Ops — the one way to change a world. CONTRACT.md section 2.
import { z } from "zod";
import { Entity, Vec3 } from "./world.ts";
import { GraphOp, PathOp } from "./living.ts";

export const Ease = z.enum(["linear", "inQuad", "outQuad", "inOutQuad", "inCubic", "outCubic", "inOutCubic", "inOutSine"]);
export type Ease = z.infer<typeof Ease>;

export const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), entity: Entity, parent: z.string().optional() }),
  z.object({ op: z.literal("update"), id: z.string(), set: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  // with `duration` (s) a real/sun sky's `time` change is animated (sky time eased from the old time to the new)
  z.object({ op: z.literal("sky"), set: z.record(z.string(), z.unknown()), duration: z.number().positive().optional(), ease: Ease.optional() }),
  z.object({ op: z.literal("env"), set: z.record(z.string(), z.unknown()) }),
  z.object({
    op: z.literal("animate"),
    id: z.string(),
    to: z.object({ position: Vec3.optional(), rotation: Vec3.optional(), scale: z.union([z.number(), Vec3]).optional() }),
    duration: z.number().positive(),
    ease: Ease.optional(),
  }),
  PathOp,
  GraphOp,
]);
export type Op = z.infer<typeof Op>;
