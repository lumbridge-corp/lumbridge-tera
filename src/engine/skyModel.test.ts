import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToLinear, skyRadiance, skyState, sunLight, sunSkyImage } from "./skyModel.ts";

const luminance = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

test("midday sky is blue overhead and brighter than night", () => {
  const day = skyState([0.3, 0.9, 0.3]);
  const zenith = skyRadiance(day, [0, 1, 0]);
  assert.ok(zenith[2] > zenith[0], `zenith ${zenith}`);
  const night = skyRadiance(skyState([0, -0.5, 0.866]), [0, 1, 0]);
  assert.ok(luminance(zenith) > luminance(night) * 20);
});

test("sunlight is warm at the horizon and fades below it", () => {
  const noon = sunLight(skyState([0, 1, 0]));
  const low = sunLight(skyState([0, 0.05, 0.9987]));
  const under = sunLight(skyState([0, -0.2, 0.98]));
  assert.ok(noon.strength > 0.9);
  assert.ok(low.color[2] < noon.color[2], "low sun should be less blue");
  assert.equal(under.strength, 0);
});

test("sky image: row 0 is the ground, top row is the sky", () => {
  const w = 16, h = 8;
  const img = sunSkyImage([0, 0.7, 0.714], w, h);
  assert.equal(img.length, w * h * 4);
  const px = (j: number) => [img[j * w * 4]!, img[j * w * 4 + 1]!, img[j * w * 4 + 2]!];
  assert.ok(luminance(px(h - 1)) > luminance(px(0)));
  assert.ok(img.every((v) => Number.isFinite(v) && v >= 0));
});

test("hexToLinear decodes sRGB", () => {
  assert.deepEqual(hexToLinear("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToLinear("#ffffff"), [1, 1, 1]);
  assert.ok(Math.abs(hexToLinear("#808080")[0] - 0.2158) < 1e-3);
});

test("with fog the horizon and below take the fog colour", () => {
  const w = 8, h = 64;
  const fog: [number, number, number] = [0.3, 0.2, 0.1];
  const img = sunSkyImage([0, 0.5, 0.866], w, h, undefined, fog);
  // A row just below the horizon is pure fog.
  const j = Math.floor(h / 2) - 2;
  const k = j * w * 4;
  assert.ok(Math.abs(img[k]! - 0.3) < 1e-6 && Math.abs(img[k + 1]! - 0.2) < 1e-6 && Math.abs(img[k + 2]! - 0.1) < 1e-6);
});
