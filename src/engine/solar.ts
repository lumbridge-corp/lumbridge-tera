// Sun position from a time and a place. Pure: no three.js, runs in Node.
//
// Low-precision almanac formulas (good to ~0.1 deg 1950–2050), which is far finer than
// anything a viewer can see in a sky. World axes: +Y up, -Z north, +X east.

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Degrees above the horizon (negative = below). */
  elevation: number;
  /** Degrees clockwise from north (90 = east). */
  azimuth: number;
}

/**
 * Parse the sky time. ISO strings with a zone (`Z` or `+hh:mm`) are exact. A time
 * without a zone is read as local clock time at the longitude (UTC offset rounded to
 * lon/15 hours), so `"2026-11-17T16:30:00"` is late afternoon wherever the world is,
 * whatever timezone the browser runs in. This keeps renders deterministic.
 */
export function parseSkyTime(time: string, lon: number): Date {
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(time.trim());
  if (hasZone) {
    const d = new Date(time);
    if (Number.isNaN(d.getTime())) throw new Error(`bad sky time "${time}"`);
    return d;
  }
  const d = new Date(time.trim() + "Z");
  if (Number.isNaN(d.getTime())) throw new Error(`bad sky time "${time}"`);
  return new Date(d.getTime() - Math.round(lon / 15) * 3600_000);
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const ha = (gmstHours * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
  const az = Math.atan2(
    -Math.sin(ha) * Math.cos(dec),
    Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(ha),
  );
  return { elevation, azimuth: ((az / RAD) % 360 + 360) % 360 };
}

/** Unit vector pointing at the sun in world axes (+Y up, -Z north, +X east). */
export function sunDirection(p: SunPosition): [number, number, number] {
  const el = p.elevation * RAD, az = p.azimuth * RAD;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}
