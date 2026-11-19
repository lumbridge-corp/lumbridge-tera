import { test } from "node:test";
import assert from "node:assert/strict";
import { BindingLoop } from "./loop.ts";
import { PromClient } from "./client.ts";
import { validateBindings } from "./spec.ts";
import { fakeProm } from "./fake.test-helper.ts";
import { Op } from "../../schema/ops.ts";

const bind = (raw: unknown[]) => {
  const r = validateBindings(raw);
  assert.deepEqual(r.errors, []);
  return r.bindings;
};

const flat = (lists: { id: string; set: Record<string, unknown> }[][]) => lists.flat().map((o) => [o.id, o.set]);

test("loop: same-cadence bindings share ONE request; ops only on change; the batch label never leaks", async () => {
  const p = await fakeProm({
    'probe_success{job="site"}': [{ metric: { instance: "https://private.example/" }, value: 1 }],
    "rate(x[1m])": [{ metric: {}, value: 50 }],
    "cpu": [{ metric: {}, value: 0.5 }],
  });
  try {
    let t = 0;
    const loop = new BindingLoop({
      client: new PromClient({ url: p.url }),
      now: () => t,
      bindings: bind([
        { id: "site", query: 'probe_success{job="site"}', kind: "glow", entity: "light", every: 15, when: { op: "==", value: 1 }, on: { glow: 1 }, off: { glow: 0 } },
        { id: "traffic", query: "rate(x[1m])", kind: "flow", entity: "pipe", every: 15, range: [0, 100], rate: [1, 3] },
        { id: "cpu", query: "cpu", kind: "meter", entity: "gauge", every: 60 },
        { id: "raw", query: "cpu", kind: "value", every: 15 },
      ]),
    });
    const first = await loop.tick(t);
    assert.equal(p.requests.length, 2, "one request per cadence (15 s: three bindings, 60 s: one)");
    assert.match(p.requests[0]!.query, /label_replace\(\(probe_success\{job="site"\}\), "tera_binding", "site", "", ""\)\nor\n/);
    assert.deepEqual(flat(first), [["light", { material: { glow: 1 } }], ["pipe", { visible: true, rate: 2 }], ["gauge", { value: 0.5 }]]);
    for (const l of first) for (const o of l) assert.ok(!JSON.stringify(o).includes("private.example") && !JSON.stringify(o).includes("tera_binding"));
    for (const l of first) for (const o of l) assert.ok(Op.safeParse(o).success, `engine accepts ${JSON.stringify(o)}`);
    assert.equal(loop.value("raw"), 0.5);
    assert.deepEqual(await loop.tick(t + 1000), [], "nothing due");
    t = 15_000;
    assert.deepEqual(await loop.tick(t), [], "due again, nothing changed: no ops");
    assert.equal(p.requests.length, 3);
    p.table.set("rate(x[1m])", [{ metric: {}, value: 0 }]);
    p.table.set('probe_success{job="site"}', [{ metric: {}, value: 0 }]);
    t = 30_000;
    assert.deepEqual(flat(await loop.tick(t)), [["light", { material: { glow: 0 } }], ["pipe", { visible: false }]]);
    assert.deepEqual(loop.status().map((s) => [s.id, s.state]), [["site", "live"], ["traffic", "live"], ["cpu", "live"], ["raw", "live"]]);
  } finally {
    await p.close();
  }
});

test("loop: a bad query or a scalar breaks the batch once; then it runs alone and the rest keep batching", async () => {
  const p = await fakeProm({ good: [{ metric: {}, value: 1 }], "scalar(time())": { scalar: 42 } });
  try {
    let t = 0;
    const loop = new BindingLoop({
      client: new PromClient({ url: p.url }),
      now: () => t,
      bindings: bind([
        { id: "good", query: "good", kind: "value", every: 10 },
        { id: "good2", query: "good", kind: "value", every: 10 },
        { id: "clock", query: "scalar(time())", kind: "value", every: 10 },
        { id: "broken", query: "sum(nope", kind: "value", every: 10 },
      ]),
    });
    await loop.tick(t);
    assert.equal(loop.value("good"), 1);
    assert.equal(loop.value("clock"), 42);
    const st = Object.fromEntries(loop.status().map((s) => [s.id, s]));
    assert.equal(st.broken!.state, "error");
    assert.equal(st.broken!.error, "prometheus: rejected (400 bad_data)");
    const n = p.requests.length; // 1 failed batch + 4 singles
    assert.equal(n, 5);
    t = 10_000;
    await loop.tick(t);
    assert.equal(p.requests.length - n, 3, "next round: one batch (good, good2) + clock alone + broken alone");
    assert.match(p.requests[n]!.query, /"good".*\nor\n.*"good2"/s);
  } finally {
    await p.close();
  }
});

test("loop: entities missing from the world are skipped; a binding with none is not queried", async () => {
  const p = await fakeProm({ up: [{ metric: { job: "a" }, value: 1 }, { metric: { job: "b" }, value: 0 }] });
  try {
    const loop = new BindingLoop({
      client: new PromClient({ url: p.url }),
      now: () => 0,
      bindings: bind([
        { id: "jobs", query: "up", kind: "glow", labelMap: { label: "job", map: { a: "light-a", b: "light-b" } }, when: { op: "==", value: 1 } },
        { id: "gone", query: "up", kind: "meter", entity: "not-here" },
      ]),
    });
    loop.setEntities(["light-a", "other"]);
    const ops = await loop.tick(0);
    assert.deepEqual(flat(ops), [["light-a", { material: { glow: 2 } }]]);
    assert.equal(p.requests.length, 1);
    assert.doesNotMatch(p.requests[0]!.query, /\nor\n/, "the binding without entities is not asked for");
    const st = Object.fromEntries(loop.status().map((s) => [s.id, s]));
    assert.equal(st.gone!.state, "missing");
    assert.equal(st.jobs!.entities, 1);
    assert.deepEqual(flat(loop.welcome()), [["light-a", { material: { glow: 2 } }]]);
  } finally {
    await p.close();
  }
});

test("loop: pulse bumps the glow and restores it after `seconds`", async () => {
  const p = await fakeProm({ "max(last_run)": [{ metric: {}, value: 100 }] });
  try {
    let t = 0;
    const loop = new BindingLoop({ client: new PromClient({ url: p.url }), now: () => t, bindings: bind([{ id: "run", query: "max(last_run)", kind: "pulse", entity: "ring", every: 5, pulse: { peak: 3, base: 0.5, seconds: 2 } }]) });
    assert.deepEqual(flat(await loop.tick(t)), [["ring", { material: { glow: 0.5 } }]], "first answer: base look, no pulse");
    p.table.set("max(last_run)", [{ metric: {}, value: 160 }]);
    t = 5000;
    assert.deepEqual(flat(await loop.tick(t)), [["ring", { material: { glow: 3 } }]]);
    t = 6000;
    assert.deepEqual(await loop.tick(t), []);
    t = 7000;
    assert.deepEqual(flat(await loop.tick(t)), [["ring", { material: { glow: 0.5 } }]], "restored");
  } finally {
    await p.close();
  }
});

test("loop: Prometheus down → error then stale; onStale off falls back once; hold keeps the look", async () => {
  const p = await fakeProm({ up: [{ metric: {}, value: 1 }] });
  let t = 0;
  const loop = new BindingLoop({
    client: new PromClient({ url: p.url, timeoutMs: 500, backoff: { baseMs: 1000, jitter: 0 }, now: () => t }),
    now: () => t,
    bindings: bind([
      { id: "off", query: "up", kind: "glow", entity: "a", every: 10, stale: 30, onStale: "off", when: { op: "==", value: 1 } },
      { id: "hold", query: "up", kind: "glow", entity: "b", every: 10, stale: 30, when: { op: "==", value: 1 } },
    ]),
  });
  await loop.tick(t);
  await p.close();
  let fallback: unknown[] = [];
  for (t = 10_000; t <= 40_000; t += 10_000) fallback.push(...flat(await loop.tick(t)));
  assert.deepEqual(fallback, [["a", { material: { glow: 0.2 } }]], "only the onStale:off binding falls back, once");
  const st = Object.fromEntries(loop.status().map((s) => [s.id, s]));
  assert.equal(st.off!.state, "error");
  assert.match(st.off!.error!, /^(http|timeout|backoff): /);
  assert.ok(!/127\.0\.0\.1/.test(st.off!.error!));
  assert.equal(loop.value("off"), null);
  assert.equal(loop.value("hold"), 1, "hold keeps its last number");
  assert.equal(loop.values().hold, null, "but values() only reports fresh numbers");
  assert.deepEqual(flat(loop.welcome()), [["a", { material: { glow: 0.2 } }], ["b", { material: { glow: 2 } }]]);
});

test("loop: maxSeries per binding; overlapping ticks do not double-query", async () => {
  const p = await fakeProm({ many: Array.from({ length: 5 }, (_, i) => ({ metric: { i: String(i) }, value: i })), slow: { delayMs: 150, then: [{ metric: {}, value: 1 }] } });
  try {
    const loop = new BindingLoop({ client: new PromClient({ url: p.url }), now: () => 0, bindings: bind([{ id: "many", query: "many", kind: "value", maxSeries: 3, batch: false }, { id: "slow", query: "slow", kind: "value", batch: false, every: 60 }]) });
    const [a, b] = await Promise.all([loop.tick(0), loop.tick(0)]);
    assert.deepEqual(b, [], "second tick while the first runs does nothing");
    assert.deepEqual(a, []);
    assert.equal(p.requests.length, 2);
    assert.match(loop.status()[0]!.error!, /limit: 5 series > 3/);
  } finally {
    await p.close();
  }
});
