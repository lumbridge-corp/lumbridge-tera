import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { propagate, twoline2satrec } from "satellite.js";
import { LiveSatellites, fixesAt, makeObserver, parseSatellites, satMagnitude } from "./satellites.ts";

const fixture = readFileSync(new URL("../../tests/fixtures/starlink-sample.omm.json", import.meta.url), "utf8");
const sep = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  (Math.acos(Math.min(1, a[i * 3]! * b[j * 3]! + a[i * 3 + 1]! * b[j * 3 + 1]! + a[i * 3 + 2]! * b[j * 3 + 2]!)) * 180) / Math.PI;

test("SGP4: Vallado's test case 00005 at epoch", () => {
  const l1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
  const l2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";
  const rec = twoline2satrec(l1, l2);
  const p = propagate(rec, new Date(Date.UTC(2000, 0, 1) + (179.78495062 - 1) * 86_400_000))!.position as { x: number; y: number; z: number };
  // tcppver.out, t = 0: 7022.46529266 -1400.08296755 0.03995155 km
  assert.ok(Math.abs(p.x - 7022.46529266) < 0.01 && Math.abs(p.y + 1400.08296755) < 0.01 && Math.abs(p.z - 0.03995155) < 0.01, JSON.stringify(p));
});

test("element sets: OMM JSON, TLE text, groups, max", () => {
  const all = parseSatellites(fixture);
  assert.ok(all.sats.length >= 230, `${all.sats.length}`);
  assert.equal(all.skipped, 0);
  const sl = parseSatellites(fixture, ["starlink"]);
  assert.equal(sl.sats.length, all.sats.length - 1); // the ISS is in the sample too
  assert.ok(sl.sats.some((s) => s.low), "a fresh low train is in the sample");
  assert.equal(parseSatellites(fixture, ["iss"]).sats.length, 1);
  assert.equal(parseSatellites(fixture, ["starlink"], 10).sats.length, 10);
  const tle = "ISS (ZARYA)\n1 25544U 98067A   26322.50000000  .00010000  00000-0  18000-3 0  9990\n2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000400000\nnot a tle\n";
  const t = parseSatellites(tle);
  assert.equal(t.sats.length, 1);
  assert.equal(t.sats[0]!.name, "ISS (ZARYA)");
  assert.equal(t.sats[0]!.id, 25544);
  assert.equal(parseSatellites("1 garbage\n2 garbage").sats.length, 0);
});

test("fixes: above the horizon, deterministic, lit vs eclipsed, and the live tracker agrees", () => {
  const { sats } = parseSatellites(fixture);
  const obs = makeObserver(37.77, -122.42);
  const t = Date.parse("2026-11-19T02:30:00Z"); // 18:30 PST, sun ~−20°: dark sky
  const f1 = fixesAt(sats, obs, t, 0, 2.5);
  const f2 = fixesAt(sats, obs, t, 0, 2.5);
  assert.ok(f1.count > 0, "something is up");
  assert.deepEqual([...f1.dir.slice(0, f1.count * 3)], [...f2.dir.slice(0, f2.count * 3)]);
  for (let i = 0; i < f1.count; i++) {
    assert.ok(f1.dir[i * 3 + 1]! >= 0);
    assert.ok(Math.abs(Math.hypot(f1.dir[i * 3]!, f1.dir[i * 3 + 1]!, f1.dir[i * 3 + 2]!) - 1) < 1e-5);
    assert.ok(f1.rangeKm[i]! > 250 && f1.rangeKm[i]! < 4000, `range ${f1.rangeKm[i]}`);
    assert.ok(f1.shadow[i]! >= 0 && f1.shadow[i]! <= 1);
    // the trail is a short arc behind the head (LEO moves < 1.5°/s seen from the ground)
    assert.ok(sep(f1.dir, i, f1.tail, i) < 4);
  }
  // at local midnight most of LEO overhead is in the earth's shadow
  const mid = fixesAt(sats, obs, Date.parse("2026-11-19T08:00:00Z"), 30, 0);
  const lit = [...mid.shadow.slice(0, mid.count)].filter((s) => s < 0.5).length;
  assert.ok(mid.count === 0 || lit / mid.count < 0.5, `midnight lit ${lit}/${mid.count}`);
  // live tracker (interpolated) vs exact
  const live = new LiveSatellites(sats, obs, 0, 2.5);
  const lf = live.frame(t + 7_300);
  const ex = fixesAt(sats, obs, t + 7_300, 0, 2.5);
  const byIdx = new Map<number, number>();
  for (let i = 0; i < ex.count; i++) byIdx.set(ex.index[i]!, i);
  let compared = 0;
  for (let i = 0; i < lf.count; i++) {
    const j = byIdx.get(lf.index[i]!);
    if (j === undefined) continue;
    assert.ok(sep(lf.dir, i, ex.dir, j) < 0.05, `interpolated vs exact ${sep(lf.dir, i, ex.dir, j)}°`);
    compared++;
  }
  assert.ok(compared > 0);
});

test("satellite magnitude: fainter far away, invisible in shadow, trains brighter", () => {
  const { sats } = parseSatellites(fixture);
  const iss = sats.find((s) => s.name.startsWith("ISS"))!, sl = sats.find((s) => s.name.startsWith("STARLINK") && !s.low)!, low = sats.find((s) => s.low)!;
  assert.ok(Math.abs(satMagnitude(550, 0, sl.stdMag) - 5) < 0.1, "a Starlink overhead ≈ mag 5");
  assert.ok(satMagnitude(420, 0, iss.stdMag) < -3, "the ISS overhead is brighter than Sirius");
  assert.ok(satMagnitude(1500, 0, sl.stdMag) > satMagnitude(550, 0, sl.stdMag));
  assert.equal(satMagnitude(550, 1, sl.stdMag), Infinity);
  assert.ok(satMagnitude(550, 0, low.stdMag) < satMagnitude(550, 0, sl.stdMag));
});
