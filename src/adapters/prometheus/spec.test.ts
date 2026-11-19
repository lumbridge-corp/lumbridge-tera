import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBinding, validateBindings, entitiesOf } from "./spec.ts";
import { fires, formatLabel, lookFor, normalise, reduce, valuesFor } from "./evaluate.ts";

const ok = (raw: Record<string, unknown>) => {
  const r = validateBinding(raw);
  assert.deepEqual(r.errors, [], JSON.stringify(raw));
  return r.binding!;
};

test("spec: defaults filled in", () => {
  const b = ok({ id: "db", query: "up", kind: "glow", entity: "lamp" });
  assert.equal(b.every, 30);
  assert.equal(b.stale, 90);
  assert.equal(b.onStale, "hold");
  assert.deepEqual(b.range, [0, 1]);
  assert.equal(b.reduce, "max");
  assert.equal(b.batch, true);
  assert.equal(b.step, 0.05);
});

test("spec: errors name the binding and the problem; nothing passes silently", () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ id: "Bad Id", query: "up", kind: "glow", entity: "x" }, /id must be/],
    [{ id: "a", query: "", kind: "glow", entity: "x" }, /query/],
    [{ id: "a", query: "up", kind: "sparkle", entity: "x" }, /kind must be/],
    [{ id: "a", query: "up", kind: "glow" }, /needs entity or labelMap/],
    [{ id: "a", query: "up", kind: "value", entity: "x" }, /drives no entity/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", every: 1 }, /every/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", range: [5, 1] }, /range/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", qeury: "typo" }, /unknown key "qeury"/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", when: { op: "=~", value: 1 } }, /when must be/],
    [{ id: "a", query: "up", kind: "meter", entity: "x", on: { glow: 1 } }, /on \/ off are for a glow with when/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", when: { op: "==", value: 1 }, on: { screen: { kind: "video", src: "x" } } }, /not a material key/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", when: { op: "==", value: 1 }, on: { color: "red" } }, /#rrggbb/],
    [{ id: "a", query: "up", kind: "label", entity: "x", label: { format: "no placeholder" } }, /\{value\}/],
    [{ id: "a", query: "up", kind: "pulse", entity: "x", pulse: { trigger: "rise" } }, /rise needs when/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", labelMap: { label: "job", map: { a: "y" } } }, /not both/],
    [{ id: "a", query: "up", kind: "glow", labelMap: { label: "job", map: { a: "bad id!" } } }, /must be an entity id/],
    [{ id: "a", query: "up", kind: "glow", entity: "x", stale: 2, every: 10 }, /stale/],
  ];
  for (const [raw, re] of bad) {
    const r = validateBinding(raw);
    assert.equal(r.binding, null, JSON.stringify(raw));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(raw)} → ${r.errors.join("; ")}`);
  }
  assert.ok(ok({ id: "c", "//": "a comment", query: "up", kind: "value" }));
});

test("spec: a file is all or nothing; ids unique; one driver per entity", () => {
  const good = { id: "a", query: "up", kind: "glow", entity: "x" };
  assert.equal(validateBindings({ bindings: [good] }).bindings.length, 1);
  const dup = validateBindings([good, { ...good }]);
  assert.equal(dup.bindings.length, 0);
  assert.match(dup.errors.join(), /duplicate id/);
  const two = validateBindings([good, { id: "b", query: "up", kind: "meter", labelMap: { label: "job", map: { j: "x" } } }]);
  assert.match(two.errors.join(), /entity x is already driven by "a"/);
  assert.match(validateBindings({ bindings: [], extra: 1 }).errors.join(), /unknown key/);
  assert.match(validateBindings("nope").errors.join(), /expected an array/);
  assert.deepEqual(entitiesOf(ok({ id: "m", query: "up", kind: "glow", labelMap: { label: "job", map: { a: "x", b: "x", c: "y" } } })), ["x", "y"]);
});

test("evaluate: normalise (linear, sqrt, log), reduce, labels", () => {
  assert.equal(normalise(5, [0, 10]), 0.5);
  assert.equal(normalise(50, [0, 10]), 1);
  assert.equal(normalise(-1, [0, 10]), 0);
  assert.equal(normalise(0.25, [0, 1], "sqrt"), 0.5);
  assert.ok(Math.abs(normalise(99, [0, 999], "log") - 2 / 3) < 0.01);
  assert.equal(reduce([1, 5, 3], "max"), 5);
  assert.equal(reduce([1, 5, 3], "min"), 1);
  assert.equal(reduce([1, 5, 3], "sum"), 9);
  assert.equal(reduce([1, 5, 3], "avg"), 3);
  assert.equal(reduce([], "count"), 0);
  assert.equal(reduce([], "max"), null);
  const l = ok({ id: "l", query: "x", kind: "label", entity: "t", label: { format: "{value} ms", multiply: 1000, decimals: 0 } });
  assert.equal(formatLabel(l, 0.0274), "27 ms");
  assert.equal(formatLabel(l, null), "–");
});

test("evaluate: looks per kind, with and without when; missing data", () => {
  const sw = ok({ id: "s", query: "x", kind: "glow", entity: "e", when: { op: "==", value: 1 }, on: { color: "#c4ec3e", glow: 0.9 }, off: { color: "#5c6064", glow: 0 } });
  assert.deepEqual(lookFor(sw, 1), { material: { color: "#c4ec3e", glow: 0.9 } });
  assert.deepEqual(lookFor(sw, 0), { material: { color: "#5c6064", glow: 0 } });
  assert.deepEqual(lookFor(sw, null), { material: { color: "#5c6064", glow: 0 } }, "no data = off");
  const g = ok({ id: "g", query: "x", kind: "glow", entity: "e", range: [0, 100], glow: [0, 2] });
  assert.deepEqual(lookFor(g, 50), { material: { glow: 1 } });
  assert.deepEqual(lookFor(g, 51), { material: { glow: 1 } }, "quantised to step 0.05");
  const m = ok({ id: "m", query: "x", kind: "meter", entity: "e", range: [0, 4] });
  assert.deepEqual(lookFor(m, 1.03), { value: 0.26 }, "quantised to step 0.02");
  const f = ok({ id: "f", query: "x", kind: "flow", entity: "e", range: [0, 10], rate: [1, 3] });
  assert.deepEqual(lookFor(f, 0), { visible: false });
  assert.deepEqual(lookFor(f, 10), { visible: true, rate: 3 });
  assert.deepEqual(lookFor(f, null), { visible: false });
  assert.equal(lookFor(ok({ id: "v", query: "x", kind: "value" }), 3), null);
});

test("evaluate: labelMap picks entities by exact label value; unmapped series dropped", () => {
  const b = ok({ id: "b", query: "x", kind: "glow", labelMap: { label: "svc", map: { api: "light-api", db: "light-db" } }, reduce: "min" });
  const v = valuesFor(b, [
    { labels: { svc: "api" }, value: 1, ts: 0 },
    { labels: { svc: "api" }, value: 0, ts: 0 },
    { labels: { svc: "someone@example.com" }, value: 1, ts: 0 },
    { labels: { svc: "constructor" }, value: 1, ts: 0 },
  ]);
  assert.deepEqual([...v.entries()], [["light-api", 0], ["light-db", null]]);
});

test("evaluate: pulses fire on increase (not the first answer) or on the rising edge", () => {
  const inc = ok({ id: "p", query: "x", kind: "pulse", entity: "e" });
  assert.equal(fires(inc, undefined, 5), false);
  assert.equal(fires(inc, 5, 5), false);
  assert.equal(fires(inc, 5, 6), true);
  assert.equal(fires(inc, null, 6), false);
  const rise = ok({ id: "r", query: "x", kind: "pulse", entity: "e", when: { op: ">", value: 0 } });
  assert.equal(rise.pulse.trigger, "rise");
  assert.equal(fires(rise, 0, 1), true);
  assert.equal(fires(rise, 1, 2), false);
  assert.equal(fires(rise, null, 1), true);
});
