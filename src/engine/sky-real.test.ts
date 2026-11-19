import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorldPack, Entity, Op } from "../schema/index.ts";
import { applyOp, skyTimeMs, worldAt } from "./timeline.ts";
import { RealSkyModel } from "./skyModel.ts";
import { dirFromAltAz } from "./astro.ts";
import { magIntensity, magPixels, magVisible } from "./nightSky.ts";

const night = JSON.parse(readFileSync(new URL("../../worlds/night/world.json", import.meta.url), "utf8"));

test("schema: real sky, material.night, light night/day, nightLights ramp, sky op duration", () => {
  assert.ok(WorldPack.safeParse(night).success);
  const w = { tera: "world/v1", id: "t", title: "t", entities: [], sky: { mode: "real", lat: 37.77, lon: -122.42 } };
  assert.ok(WorldPack.safeParse(w).success, "time is optional (now)");
  assert.ok(WorldPack.safeParse({ ...w, sky: { mode: "real", time: "now", lat: 0, lon: 0, moon: { scale: 2 }, stars: { magnitudeLimit: 5, milkyWay: false }, satellites: { src: "x.json", groups: ["starlink"], max: 100, minElevation: 10, visibleOnly: false }, cityGlow: 0.3, exposureAuto: false, timeScale: 600, timezone: "Europe/Paris" } }).success);
  assert.ok(!WorldPack.safeParse({ ...w, sky: { mode: "real", lat: 95, lon: 0 } }).success, "latitude range");
  assert.ok(!WorldPack.safeParse({ ...w, environment: { nightLights: { ramp: [2] } } }).success);
  assert.ok(WorldPack.safeParse({ ...w, environment: { nightLights: { ramp: [0, -8] } } }).success);
  assert.ok(Entity.safeParse({ id: "w", kind: "primitive", shape: "box", material: { color: "#202020", night: { emissive: "#ffcc88", intensity: 2 } } }).success);
  assert.ok(Entity.safeParse({ id: "l", kind: "light", light: "point", night: true }).success);
  const both = Entity.safeParse({ id: "l", kind: "light", light: "point", night: true, day: true });
  assert.ok(!both.success && /either night/.test(both.error.issues[0]!.message));
  assert.ok(Op.safeParse({ op: "sky", set: { time: "2026-11-18T20:00:00Z" }, duration: 4, ease: "linear" }).success);
});

test("timeline: an animated sky time eases from the old time to the new one, exactly by script time", () => {
  const base = { tera: "world/v1", id: "t", title: "t", entities: [], sky: { mode: "real", time: "2026-11-18T16:00:00-08:00", lat: 37.77, lon: -122.42 } } as unknown as WorldPack;
  const ev = [{ t: 2, ops: [{ op: "sky", set: { time: "2026-11-18T20:00:00-08:00" }, duration: 4, ease: "linear" }] as Op[] }];
  const at = (t: number) => skyTimeMs(worldAt(base, ev, t).world.sky)!;
  assert.equal(at(1), Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(at(4), Date.parse("2026-11-19T02:00:00Z"));
  assert.equal(at(6), Date.parse("2026-11-19T04:00:00Z"));
  assert.equal(at(60), Date.parse("2026-11-19T04:00:00Z"));
  // without a clock (bridge.apply) it jumps to the end
  const w = structuredClone(base);
  applyOp(w, ev[0]!.ops[0]!);
  assert.equal(skyTimeMs(w.sky), Date.parse("2026-11-19T04:00:00Z"));
  // switching mode is not animated
  const w2 = structuredClone(base);
  applyOp(w2, { op: "sky", set: { mode: "color", color: "#000000" }, duration: 3 } as Op, { at: 0, now: 1 });
  assert.equal(w2.sky?.mode, "color");
  assert.equal(skyTimeMs({ mode: "real", time: "now", lat: 0, lon: 0 }), null);
});

test("real sky radiance: blue day, warm glow after sunset, deep-blue night, moonlit night brighter", () => {
  const sky = (sunEl: number, moonLight = 0) => new RealSkyModel({ sun: dirFromAltAz(240, sunEl), moon: dirFromAltAz(100, 50), moonLight, cityGlow: 0 });
  const zen = (m: RealSkyModel) => m.radiance([0, 1, 0]);
  const day = zen(sky(40));
  assert.ok(day[2] > day[0] * 1.5, "blue zenith by day");
  const sunset = sky(-2);
  const glow = sunset.radiance(dirFromAltAz(240, 2)), anti = sunset.radiance(dirFromAltAz(60, 2));
  assert.ok(glow[0] > glow[2] && glow[0] > anti[0] * 2, "the glow toward the set sun is warm and bright");
  const n = zen(sky(-30));
  assert.ok(n[2] > n[0] * 2 && n[2] < 0.02, `deep-blue night ${n}`);
  const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  assert.ok(lum(zen(sky(-30, 1))) > lum(n) * 2, "a full moon brightens the night sky");
  // monotone dusk: darker as the sun sinks
  let prev = Infinity;
  for (let e = 10; e >= -20; e -= 2) {
    const l = lum(zen(sky(e)));
    assert.ok(l <= prev + 1e-9, `zenith at ${e}°`);
    prev = l;
  }
});

test("star dots: brighter stars bigger and brighter; visibility fades around the limit", () => {
  assert.ok(magIntensity(-1.46) > magIntensity(1) && magIntensity(1) > magIntensity(6));
  assert.ok(magPixels(-1.46) > magPixels(3) && magPixels(6) >= 2);
  assert.equal(magVisible(2, 6.4), 1);
  assert.equal(magVisible(7, 5), 0);
  assert.ok(magVisible(5.3, 5) > 0 && magVisible(5.3, 5) < 1);
});
