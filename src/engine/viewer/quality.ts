// Adaptive quality for the live viewer (docs/viewer.md, "Performance policy").
//
// Levels trade sharpness and effects for frame rate. The governor watches frame times after
// the first frame: a warm-up second is ignored (shader compiles, texture uploads), then the
// median fps of each 1.5 s window decides. Below 42 fps it steps down one level, below 24 two.
// After two good windows in a row it is settled and only a sustained slump (median < 30 over
// 5 s) steps down again. It never steps back up by itself, so quality never oscillates.
// Pure: no DOM, testable in Node.

export interface QualityLevel {
  name: "high" | "medium" | "low" | "lower" | "lowest";
  /** Device-pixel-ratio cap (the canvas is never sharper than this). */
  dprCap: number;
  /** environment.post effects (AO, bloom, DOF). */
  post: boolean;
  /** Shadow map size cap in texels, 0 = as authored. */
  shadow: number;
}

export const LEVELS: readonly QualityLevel[] = [
  { name: "high", dprCap: 2, post: true, shadow: 0 },
  { name: "medium", dprCap: 1.5, post: true, shadow: 2048 },
  { name: "low", dprCap: 1.25, post: false, shadow: 1024 },
  { name: "lower", dprCap: 1, post: false, shadow: 1024 },
  { name: "lowest", dprCap: 0.75, post: false, shadow: 512 },
];

export const levelIndex = (name: string | null | undefined): number => LEVELS.findIndex((l) => l.name === name);

/** The canvas pixel ratio at a level on a display with `dpr`. */
export const pixelRatioAt = (level: number, dpr: number) => Math.min(Math.max(0.5, dpr || 1), LEVELS[level]!.dprCap);

/** Where to start: phones and small touch screens begin one step down. */
export function initialLevel(env: { coarsePointer: boolean; minScreenSide: number; dpr: number }): number {
  return env.coarsePointer && env.minScreenSide < 820 ? 1 : 0;
}

/** Median of a list (copy-sorted). */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class QualityGovernor {
  level: number;
  settled = false;
  private dts: number[] = [];
  private windowT = 0;
  private warm = 0;
  private good = 0;

  readonly opts = { warmup: 1, window: 1.5, settledWindow: 5, down1: 42, down2: 24, slump: 30 };

  constructor(start: number) {
    this.level = Math.min(LEVELS.length - 1, Math.max(0, start));
  }

  /** Forget the current window (after a level change, a hidden tab, a resize). */
  reset() {
    this.dts = [];
    this.windowT = 0;
    this.warm = 0;
  }

  /**
   * Feed one frame's duration in seconds. Returns the new level index when it changed, else
   * null. Frames longer than 0.5 s (tab switches, debugger pauses) are ignored.
   */
  frame(dt: number): number | null {
    if (!(dt > 0) || dt > 0.5) return null;
    if (this.warm < this.opts.warmup) {
      this.warm += dt;
      return null;
    }
    this.dts.push(dt);
    this.windowT += dt;
    const win = this.settled ? this.opts.settledWindow : this.opts.window;
    if (this.windowT < win) return null;
    const fps = 1 / median(this.dts);
    this.dts = [];
    this.windowT = 0;
    const last = LEVELS.length - 1;
    let step = 0;
    if (this.settled) step = fps < this.opts.slump ? 1 : 0;
    else step = fps < this.opts.down2 ? 2 : fps < this.opts.down1 ? 1 : 0;
    if (step === 0 || this.level >= last) {
      if (!this.settled && ++this.good >= 2) this.settled = true;
      return null;
    }
    this.good = 0;
    this.level = Math.min(last, this.level + step);
    this.warm = 0;
    return this.level;
  }
}
