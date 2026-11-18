// Actor name tags: how big and how opaque a tag is drawn, from the camera alone.
//
// A tag is a camera-facing sprite `worldH` metres tall. Without fitting it grows without
// bound as the camera comes close (a close camera pass can sweep a tag past the lens at twice
// the frame height) and turns into unreadable specks from far away. labelFit keeps it between
// those: never taller than `maxPx` CSS pixels on screen, faded out when it would be smaller
// than `minPx` (too small to read, only clutter) and faded out when the camera is almost on
// top of it. Pure function of (depth, fov, viewport): render mode stays pose = f(t).
// No three.js import, so it is testable in Node.

export interface LabelFitOptions {
  /** Largest on-screen height, CSS px. */
  maxPx: number;
  /** Below this on-screen height the tag fades out... */
  minPx: number;
  /** ...over this many px (fully gone at minPx - fadePx). */
  fadePx: number;
  /** Camera closer than `near` m (view depth): hidden; fully shown from `nearFull` m. */
  near: number;
  nearFull: number;
}

/** The live viewer's tags: about the size of 13 px UI text, never bigger. */
export const LIVE_LABELS: LabelFitOptions = { maxPx: 22, minPx: 10, fadePx: 4, near: 0.9, nearFull: 2.4 };

const smooth = (a: number, b: number, x: number) => {
  if (b <= a) return x >= b ? 1 : 0;
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** On-screen height (CSS px) of something `worldH` m tall at view depth `depth` m. */
export function screenPx(worldH: number, depth: number, fovDeg: number, viewportH: number): number {
  if (!(depth > 1e-6)) return Infinity;
  return (worldH * viewportH) / (2 * Math.tan((fovDeg * Math.PI) / 360) * depth);
}

/**
 * Scale (multiplies the tag's world size) and opacity for a tag at view depth `depth`.
 * Behind the camera (depth <= 0): opacity 0.
 */
export function labelFit(worldH: number, depth: number, fovDeg: number, viewportH: number, o: LabelFitOptions = LIVE_LABELS): { scale: number; opacity: number; px: number } {
  if (!(depth > 0)) return { scale: 1, opacity: 0, px: 0 };
  const px = screenPx(worldH, depth, fovDeg, viewportH);
  const scale = px > o.maxPx ? o.maxPx / px : 1;
  const opacity = smooth(o.minPx - o.fadePx, o.minPx, px) * smooth(o.near, o.nearFull, depth);
  return { scale, opacity, px: px * scale };
}
