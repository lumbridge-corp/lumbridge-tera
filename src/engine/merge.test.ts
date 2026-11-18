import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "./merge.ts";

test("nested objects merge, arrays replace", () => {
  const base = { a: 1, t: { position: [1, 2, 3], scale: 2 }, m: { color: "#ffffff" } };
  const out = deepMerge(base, { t: { position: [0, 0, 0] }, m: { roughness: 0.2 } });
  assert.deepEqual(out, { a: 1, t: { position: [0, 0, 0], scale: 2 }, m: { color: "#ffffff", roughness: 0.2 } });
});

test("inputs are not mutated and results share no references", () => {
  const base = { t: { position: [1, 2, 3] } };
  const patch = { t: { rotation: [0, 90, 0] } };
  const out = deepMerge(base, patch);
  (out.t as unknown as { rotation: number[] }).rotation[1] = 5;
  assert.deepEqual(base, { t: { position: [1, 2, 3] } });
  assert.deepEqual(patch, { t: { rotation: [0, 90, 0] } });
});

test("null deletes, undefined is ignored", () => {
  const out = deepMerge({ a: 1, b: { c: 2, d: 3 } }, { a: undefined, b: { c: null } });
  assert.deepEqual(out, { a: 1, b: { d: 3 } });
});

test("an object replaces a scalar and vice versa", () => {
  assert.deepEqual(deepMerge({ s: 1 }, { s: { x: 1 } }), { s: { x: 1 } });
  assert.deepEqual(deepMerge({ s: { x: 1 } }, { s: 2 }), { s: 2 });
});
