// Resident looks per role: colours, badge, idle gesture, prop. Pure data (no three.js), shared by
// the figure renderer (residents.ts) and the viewer's cards (viewer/model.ts).
import type { ResidentDef } from "../schema/residents.ts";

export type Gesture = "watch" | "sweep" | "juggle" | "read" | "hammer" | "carry" | "tinker" | "hum" | "pace" | "wave";
export type Prop = "lantern" | "broom" | "die" | "board" | "hammer" | "satchel" | "book" | "wrench" | "none";

export interface RoleLook {
  body: string;
  accent: string;
  badge: string;
  gesture: Gesture;
  prop: Prop;
}

/** Built-in looks per role (schema/residents.ts ROLES). Soft bodies, one clear accent each. */
export const ROLE_LOOKS: Record<string, RoleLook> = {
  steward: { body: "#f6d27a", accent: "#f0a33c", badge: "key", gesture: "watch", prop: "lantern" },
  maintenance: { body: "#bccb9a", accent: "#4f9f84", badge: "broom", gesture: "sweep", prop: "broom" },
  simulator: { body: "#cfc0ea", accent: "#9b7fe3", badge: "dice", gesture: "juggle", prop: "die" },
  analyst: { body: "#a9cbe8", accent: "#3f8fd0", badge: "chart", gesture: "read", prop: "board" },
  builder: { body: "#f0b98c", accent: "#e0863a", badge: "hammer", gesture: "hammer", prop: "hammer" },
  messenger: { body: "#a9dccb", accent: "#2fa58a", badge: "letter", gesture: "carry", prop: "satchel" },
  librarian: { body: "#e4d3b2", accent: "#c98d3e", badge: "book", gesture: "read", prop: "book" },
  operator: { body: "#d6bd85", accent: "#c79a2e", badge: "dial", gesture: "tinker", prop: "wrench" },
  voice: { body: "#f1c7d1", accent: "#e07a9c", badge: "wave", gesture: "hum", prop: "none" },
  brain: { body: "#e2edbd", accent: "#a8d12e", badge: "bolt", gesture: "hum", prop: "none" },
  sandboxed: { body: "#cdd1d3", accent: "#7fb7c9", badge: "lock", gesture: "pace", prop: "none" },
};
const NEUTRAL: RoleLook = { body: "#e7e1d6", accent: "#8c979d", badge: "star", gesture: "wave", prop: "none" };

/** The look a resident gets: its role's, with its own overrides. */
export function lookOf(def: Pick<ResidentDef, "role" | "look"> | null, fallbackColor?: string): RoleLook & { scale: number } {
  const role = (def && ROLE_LOOKS[def.role]) || NEUTRAL;
  return {
    ...role,
    body: def?.look?.body ?? (def ? role.body : fallbackColor ?? role.body),
    accent: def?.look?.accent ?? role.accent,
    badge: def?.look?.badge ?? role.badge,
    scale: def?.look?.scale ?? 1.3,
  };
}

