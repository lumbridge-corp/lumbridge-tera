// The engine page for the MCP server: the render host's page host (src/render/host.ts, CONTRACT 5a).
import { openTera as hostOpen, type OpenOptions, type TeraPage as HostPage } from "../render/host.ts";
import type { TeraBridge } from "../bridge/types.ts";

export type { OpenOptions };

/** Contract 5a surface plus the optional extras the host provides (origin, Playwright page). */
export interface TeraPage {
  bridge: TeraBridge;
  png(): Promise<Buffer>;
  close(): Promise<void>;
  origin?: string;
  page?: HostPage["page"];
}
export type OpenTera = (opts?: OpenOptions) => Promise<TeraPage>;

export const openTera: OpenTera = (opts) => hostOpen(opts);

/** Base URL the world folder is served at; asset paths in world.json resolve against it. */
export function worldBase(tp: TeraPage): string {
  return tp.origin ? `${tp.origin}/world/` : "/world/";
}
