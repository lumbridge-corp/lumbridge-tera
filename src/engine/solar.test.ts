import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkyTime, sunDirection, sunPosition } from "./solar.ts";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (±${tol})`);

test("San Francisco, June solstice, solar noon: sun high in the south", () => {
  // Solar noon in SF on 2026-06-21 is ~13:11 PDT (20:11 UTC).
  const p = sunPosition(new Date("2026-06-21T20:11:00Z"), 37.77, -122.42);
  near(p.elevation, 90 - 37.77 + 23.44, 0.5, "elevation");
  near(p.azimuth, 180, 2, "azimuth");
});

test("equator at the March equinox: overhead at noon, rises in the east", () => {
  const noon = sunPosition(new Date("2026-03-20T12:07:00Z"), 0, 0);
  assert.ok(noon.elevation > 88, `noon elevation ${noon.elevation}`);
  const morning = sunPosition(new Date("2026-03-20T07:00:00Z"), 0, 0);
  near(morning.azimuth, 90, 2, "morning azimuth");
  near(morning.elevation, 15 - 1.8, 1.5, "morning elevation");
});

test("night is below the horizon", () => {
  const p = sunPosition(new Date("2026-11-17T08:00:00Z"), 37.77, -122.42); // midnight PST
  assert.ok(p.elevation < -30, `elevation ${p.elevation}`);
});

test("sky times with a zone are exact; without one they use the longitude's clock", () => {
  assert.equal(parseSkyTime("2026-11-17T16:30:00-08:00", -122.42).toISOString(), "2026-11-18T00:30:00.000Z");
  assert.equal(parseSkyTime("2026-11-17T16:30:00", -122.42).toISOString(), "2026-11-18T00:30:00.000Z");
  assert.equal(parseSkyTime("2026-11-17T12:00:00Z", 100).toISOString(), "2026-11-17T12:00:00.000Z");
  assert.throws(() => parseSkyTime("not a time", 0));
});

test("sunDirection: +Y up, -Z north, +X east", () => {
  const e = sunDirection({ elevation: 0, azimuth: 90 });
  near(e[0], 1, 1e-9); near(e[1], 0, 1e-9); near(e[2], 0, 1e-9);
  const n = sunDirection({ elevation: 0, azimuth: 0 });
  near(n[2], -1, 1e-9);
  near(sunDirection({ elevation: 90, azimuth: 0 })[1], 1, 1e-9);
});
