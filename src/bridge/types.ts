// window.tera — CONTRACT.md section 4. The engine implements it; the render host and the MCP server use it.
import type { CameraPose, CameraScript, Op, Vec3, WorldPack } from "../schema/index.ts";

/** World-space axis-aligned box, metres. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** Day/night state of the sky (bridge info().sky and the `tera:sky` event). */
export interface SkyState {
  mode: "real" | "sun" | "color" | "hdri";
  /** 0 day … 1 night: environment.nightLights.ramp (default +2° → −6°) on the sun's elevation; always 0 for color/hdri skies. */
  nightness: number;
  /** nightness ≥ 0.5 (the sun below ≈ −2° with the default ramp). */
  isNight: boolean;
  /** Degrees above the horizon (refracted), null for color/hdri skies. */
  sunElevation: number | null;
  sunAzimuth: number | null;
  moonElevation?: number;
  moonAzimuth?: number;
  moonIllumination?: number;
  /** Sky time, ISO UTC. */
  time?: string;
  /** Satellites drawn in the last frame (real sky). */
  satellites?: number;
  /** "day" | "golden" | "civil" | "nautical" | "astronomical" | "night" (real sky). */
  phase?: string;
}

export interface TeraBridge {
  version: "bridge/v1";
  load(world: WorldPack, baseUrl?: string): Promise<{ ok: true; warnings: string[] }>;
  apply(ops: Op[]): Promise<{ ok: boolean; applied: number; error?: string }>;
  get(): Promise<WorldPack>;
  setCamera(pose: CameraPose): Promise<void>;
  setSize(width: number, height: number): Promise<void>;
  loadScript(script: CameraScript): Promise<{ ok: true; warnings: string[] }>;
  /** Pose + events at t, render ONE frame; resolves when pixels are final. */
  seek(t: number): Promise<void>;
  /**
   * Draw the current world (incl. ops applied with apply(), without script events) now,
   * optionally from `pose` at width x height (both or neither); resolves when pixels are
   * final (assets loaded, splats sorted, post effects drawn). Follow with capture().
   */
  render(pose?: CameraPose, width?: number, height?: number): Promise<void>;
  /**
   * World-space boxes of entities (every entity when `ids` is omitted; unknown id → error).
   * Real geometry: models, splats and text included; groups are the union of their
   * children; null = no extent (lights, empty groups, assets that failed to load).
   */
  bounds(ids?: string[]): Promise<Record<string, Box | null>>;
  /** PNG (base64, no data: prefix) of the last rendered frame. */
  capture(): Promise<string>;
  /** `sky`: day/night state (CONTRACT.md section 4): nightness 0..1, isNight, sun/moon positions, sky time. */
  info(): Promise<{ renderer: "webgpu" | "webgl2"; entities: number; ready: boolean; sky?: SkyState }>;
}

declare global {
  interface Window {
    tera?: TeraBridge;
  }
}
