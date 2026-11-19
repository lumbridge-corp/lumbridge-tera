import test from "node:test";
import assert from "node:assert/strict";
import {
  altAz, applyM3, brightLimb, catalogToWorld, gmstDeg, limitingMagnitude, moonPosition, nightness, parseRealTime,
  planetPosition, precessionMatrix, radecToVec, solarPosition, sunRaDec, dirFromAltAz, equatorialToWorld,
} from "./astro.ts";
import { loadStars, starColor, galactic } from "./stars.ts";

const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);
const sep = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * 180) / Math.PI;
const ms = (iso: string) => new Date(iso).getTime();

test("sidereal time: Meeus example 12.a (1987-04-10 0h UT = 13h10m46.3668s)", () => {
  near(gmstDeg(ms("1987-04-10T00:00:00Z")), (13 + 10 / 60 + 46.3668 / 3600) * 15, 0.0005);
  // J2000.0 noon: 280.46061837°
  near(gmstDeg(ms("2000-01-01T12:00:00Z")), 280.46061837, 1e-6);
});

test("sun: San Francisco solstice noons and the equinox (NOAA)", () => {
  const sf = { lat: 37.7749, lon: -122.4194 };
  // solar noon in SF ≈ 20:00 UTC in June
  let best = -90;
  for (let m = 0; m < 120; m++) best = Math.max(best, solarPosition(ms("2026-06-21T19:00:00Z") + m * 60_000, sf.lat, sf.lon).elevation);
  near(best, 75.68, 0.05, "June solstice noon");
  best = -90;
  for (let m = 0; m < 120; m++) best = Math.max(best, solarPosition(ms("2026-12-21T19:00:00Z") + m * 60_000, sf.lat, sf.lon).elevation);
  near(best, 28.82, 0.05, "December solstice noon");
  // the sun's declination at the March 2026 equinox (2026-03-20 14:46 UTC) is ~0
  near(solarPosition(ms("2026-03-20T14:46:00Z"), 0, 0).declination, 0, 0.02);
  // sunset 2026-11-18 SF ≈ 16:56 PST = 00:56 UTC: apparent elevation crosses −0.833° (centre) within a few minutes
  const el = solarPosition(ms("2026-11-19T00:56:00Z"), sf.lat, sf.lon).elevation;
  near(el, -0.83, 0.6, "sunset");
});

test("moon: Meeus example 47.a and eclipse geometry", () => {
  // 1992-04-12 0h TD: λ 133.162655°, β −3.229126°, Δ 368409.7 km; RA 134.688470°, Dec 13.768368°
  const m = moonPosition(ms("1992-04-12T00:00:00Z") - 59_000, 0, 0); // TD − UT ≈ 59 s in 1992
  near(m.ra, 134.68847, 0.03, "RA");
  near(m.dec, 13.768368, 0.03, "Dec");
  near(m.distanceKm, 368409.7, 150, "distance");
  // total solar eclipse 2017-08-21, greatest eclipse 36.97°N 87.67°W 18:25:32 UTC (TT ≈ UT+69 s):
  // topocentric moon and sun centres within a few arcminutes
  const t = ms("2017-08-21T18:25:32Z");
  const mm = moonPosition(t, 36.97, -87.67), ss = solarPosition(t, 36.97, -87.67);
  assert.ok(sep(dirFromAltAz(mm.azimuth, mm.elevation), dirFromAltAz(ss.azimuth, ss.elevation)) < 0.08, "2017 eclipse: sun and moon coincide");
  assert.ok(mm.illuminated < 0.001);
  // and 2024-04-08 greatest eclipse 25.29°N 104.14°W 18:17:16 UTC
  const t2 = ms("2024-04-08T18:17:16Z");
  const m2 = moonPosition(t2, 25.29, -104.14), s2 = solarPosition(t2, 25.29, -104.14);
  assert.ok(sep(dirFromAltAz(m2.azimuth, m2.elevation), dirFromAltAz(s2.azimuth, s2.elevation)) < 0.08, "2024 eclipse");
  // total lunar eclipse 2025-03-14 06:58 UTC: full, opposite the sun
  const full = moonPosition(ms("2025-03-14T06:58:00Z"), 0, 0);
  assert.ok(full.illuminated > 0.999, `full ${full.illuminated}`);
  near(full.phase, 0.5, 0.01);
  // first quarter 2026-11-17 11:48 UTC: half lit, waxing
  const fq = moonPosition(ms("2026-11-17T11:48:00Z"), 37.77, -122.42);
  near(fq.illuminated, 0.5, 0.02);
  near(fq.phase, 0.25, 0.01);
  near(fq.diameter, 0.52, 0.04);
});

test("moon: bright limb points at the sun", () => {
  const moon = dirFromAltAz(180, 30), sun = dirFromAltAz(250, -5);
  const l = brightLimb(moon, sun);
  near(l[0] * moon[0] + l[1] * moon[1] + l[2] * moon[2], 0, 1e-9, "perpendicular");
  assert.ok(l[0] * sun[0] + l[1] * sun[1] + l[2] * sun[2] > 0, "toward the sun");
});

test("precession: Polaris J2000 → 2026 moves toward the pole by ~0.11°", () => {
  const p = precessionMatrix(ms("2026-01-01T00:00:00Z"));
  const v = applyM3(p, radecToVec(37.95456, 89.26411));
  const dec = (Math.asin(v[2]) * 180) / Math.PI;
  near(dec - 89.26411, 0.108, 0.008); // 20.04″/yr · cos α over 26 years
  // a rotation: lengths kept
  near(Math.hypot(...applyM3(p, [0.3, -0.4, 0.866])), Math.hypot(0.3, -0.4, 0.866), 1e-12);
});

test("stars: Polaris stands at the latitude due north; a star on the meridian culminates", async () => {
  const stars = await loadStars();
  assert.ok(stars.count > 9000 && stars.count < 9200);
  // brightest first: Sirius (V −1.46, B−V 0.00)
  near(stars.mag[0]!, -1.46, 0.03);
  near(stars.bv[0]!, 0, 0.02);
  for (const iso of ["2026-11-18T08:00:00Z", "2026-05-02T20:30:00Z"]) {
    const M = catalogToWorld(ms(iso), 37.77, -122.42);
    const polaris = altAz(applyM3(M, radecToVec(37.95456, 89.26411)));
    near(polaris.elevation, 37.77, 0.8, "Polaris altitude");
    assert.ok(polaris.azimuth < 1.5 || polaris.azimuth > 358.5, `Polaris azimuth ${polaris.azimuth}`);
  }
  // a star whose RA equals the local sidereal time is due south at 90 − lat + dec
  const E = equatorialToWorld(100, 37.77);
  const s = altAz(applyM3(E, radecToVec(100, 10)));
  near(s.azimuth, 180, 1e-6);
  near(s.elevation, 90 - 37.77 + 10, 1e-6);
  // colours: hot blue, cool red
  const hot = starColor(-0.3), cool = starColor(1.6);
  assert.ok(hot[2] >= hot[0] && cool[0] > cool[2]);
  // galactic centre at l = 0, b = 0
  const gc = galactic(radecToVec(266.40499, -28.93617));
  assert.ok(Math.min(gc.l, 360 - gc.l) < 0.01 && Math.abs(gc.b) < 0.01);
});

test("planets: Jupiter at opposition, Venus at superior conjunction", () => {
  // Jupiter at opposition 2026-01-10 (opposite the sun, Dec ≈ +22°, mag ≈ −2.7)
  const tj = ms("2026-01-10T08:00:00Z");
  const j = planetPosition("jupiter", tj);
  const sj = sunRaDec(tj);
  assert.ok(sep(radecToVec(j.ra, j.dec), radecToVec(sj.ra, sj.dec)) > 177, "Jupiter at opposition");
  near(j.dec, 22.3, 1, "Jupiter Dec");
  assert.ok(j.mag < -2.4 && j.mag > -3, `Jupiter mag ${j.mag}`);
  const v = planetPosition("venus", ms("2026-01-06T00:00:00Z"));
  const s = sunRaDec(ms("2026-01-06T00:00:00Z"));
  assert.ok(sep(radecToVec(v.ra, v.dec), radecToVec(s.ra, s.dec)) < 2, "Venus at superior conjunction");
});

test("night ramp: day above +2°, night below −6°, smooth between", () => {
  assert.equal(nightness(10), 0);
  assert.equal(nightness(2), 0);
  assert.equal(nightness(-6), 1);
  assert.equal(nightness(-30), 1);
  near(nightness(-2), 0.5, 1e-9);
  assert.ok(nightness(-4) > 0.8 && nightness(-4) < 0.9);
  let prev = 0;
  for (let e = 3; e >= -7; e -= 0.25) {
    const n = nightness(e);
    assert.ok(n >= prev - 1e-12);
    prev = n;
  }
  assert.equal(nightness(0, [0, -10]), 0);
  near(nightness(-5, [0, -10]), 0.5, 1e-9);
});

test("limiting magnitude and time parsing", () => {
  assert.ok(limitingMagnitude(10) < -3);
  near(limitingMagnitude(-30), 6.4, 1e-9);
  assert.ok(limitingMagnitude(-30, 1) < 5.1);
  assert.ok(limitingMagnitude(-9) > 2 && limitingMagnitude(-9) < 3.5);
  assert.equal(parseRealTime("2026-11-18T16:30:00Z", 0, 0), ms("2026-11-18T16:30:00Z"));
  assert.equal(parseRealTime("2026-11-18T16:30:00", -122.42, 0), ms("2026-11-19T00:30:00Z"));
  assert.equal(parseRealTime("now", 0, 1234), 1234);
  assert.throws(() => parseRealTime("yesterday", 0, 0));
});
