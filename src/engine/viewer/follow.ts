// The follow camera's manners (viewer.ts "Fly to" a robot, then follow it): it stays out of
// geometry. With `world.layers`, a followed robot that leaves every layer (a lift shaft through
// the rock, a tunnel) is waited for: the camera holds where it is (on a floor it follows across the
// floor only, never down into the lift). When the robot comes out on another floor the viewer fades
// and cuts there; when something solid gets between them it swings: to a clear pose, under the
// layer's ceiling, inside its room, nothing solid on the line of sight (both ways: a ray from
// inside a closed mesh does not hit its faces). Pure functions here; viewer.ts does the rays.
import { framePose, type Pose, type V3 } from "./flight.ts";
import type { Layer } from "../../schema/index.ts";
import { discDist } from "./players.ts";

/**
 * The layer a followed robot stands on (`feet`: the bottom of its box), or null while it is
 * between layers (a shaft, a tunnel). In a room (a layer with a height) its feet must be well
 * inside it: a robot still in the shaft above the ceiling, or just under it, is not there yet.
 */
export function followLayer(layers: readonly Layer[], feet: V3): Layer | null {
  let best: Layer | null = null;
  for (const l of layers) {
    if (feet[1] < l.floorY - 0.6) continue;
    if (l.height !== undefined && feet[1] > l.floorY + Math.max(0.5, l.height - 1.5)) continue;
    if (discDist(l, feet[0], feet[2]) > l.walk.radius + 1) continue;
    if (!best || l.floorY > best.floorY) best = l;
  }
  return best;
}

/** Can the camera stand at `pos` for a robot on `layer`? Above its floor, under its ceiling, inside its room. */
export function poseFits(layer: Layer | null, pos: V3): boolean {
  if (!layer) return true;
  if (pos[1] < layer.floorY + 0.35) return false;
  if (layer.height === undefined) return true;
  if (pos[1] > layer.floorY + layer.height - 0.25) return false;
  return Math.hypot(pos[0] - layer.walk.center[0], pos[2] - layer.walk.center[1]) <= layer.walk.radius + 0.6;
}

/**
 * Candidate follow poses for a robot's box, best first: the current bearing turned step by step,
 * from about 50° above down to 17°, then closer. Only poses that fit the layer.
 */
export function followCandidates(box: { min: V3; max: V3 }, bearing: V3, fov: number, aspect: number, layer: Layer | null): Pose[] {
  const hz = Math.hypot(bearing[0], bearing[2]) || 1;
  const bx = bearing[0] / hz, bz = bearing[2] / hz;
  const out: Pose[] = [];
  for (const dist of [6.5, 4.5, 3]) {
    for (const elev of [0.87, 0.55, 0.3]) {
      for (const turn of [0, 40, -40, 80, -80, 125, -125, 180]) {
        const a = (turn * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const dir: V3 = [(bx * c - bz * s) * Math.cos(elev), Math.sin(elev), (bx * s + bz * c) * Math.cos(elev)];
        const p = framePose(box, dir, fov, aspect, dist);
        if (poseFits(layer, p.position)) out.push(p);
      }
    }
  }
  return out;
}
