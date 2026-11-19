import { test } from "node:test";
import assert from "node:assert/strict";
import { PromClient, PromError } from "./client.ts";
import { fakeProm } from "./fake.test-helper.ts";

test("client: config is checked (http/https only, no credentials, no query string)", () => {
  for (const url of ["ftp://x", "http://u:p@host:9090", "not a url", "http://h:9090/?a=1"])
    assert.throws(() => new PromClient({ url }), (e: unknown) => e instanceof PromError && e.kind === "config", url);
  assert.ok(new PromClient({ url: "https://prom.example:9090/" }));
});

test("client: instant vector, scalar and range answers; POST form, headers sent", async () => {
  const p = await fakeProm({
    up: [{ metric: { job: "a" }, value: 1 }, { metric: { job: "b" }, value: "NaN" }, { metric: { job: "c" }, value: 0 }],
    "scalar(1)": { scalar: 7 },
  });
  try {
    const c = new PromClient({ url: p.url, headers: { authorization: "Bearer t0ken" } });
    const v = await c.instant("up");
    assert.equal(v.type, "vector");
    assert.deepEqual(v.samples.map((s) => [s.labels.job, s.value]), [["a", 1], ["c", 0]], "non-finite values dropped");
    const s = await c.instant("scalar(1)");
    assert.equal(s.type, "scalar");
    assert.equal(s.samples[0]!.value, 7);
    const r = await c.range("up", { start: Date.now() - 60_000, end: Date.now(), step: 30 });
    assert.equal(r.length, 3, "a NaN series is kept as a series, its points dropped");
    assert.equal(r[0]!.values.length, 2);
    assert.equal(r[1]!.values.length, 0);
    assert.ok(p.requests.every((q) => q.method === "POST"));
    assert.equal(p.requests[0]!.headers.authorization, "Bearer t0ken");
    assert.equal(p.requests[0]!.headers["content-type"], "application/x-www-form-urlencoded");
    await assert.rejects(c.range("up", { start: 10, end: 5, step: 1 }), (e: unknown) => e instanceof PromError && e.kind === "config");
  } finally {
    await p.close();
  }
});

test("client: a rejected query is 'prometheus' (no backoff) and errors never leak URLs or messages", async () => {
  const p = await fakeProm({ boom: { status: 503 } });
  try {
    let t = 1000;
    const c = new PromClient({ url: p.url, now: () => t, backoff: { baseMs: 1000, jitter: 0 } });
    await assert.rejects(c.instant("nope{"), (e: unknown) => e instanceof PromError && e.kind === "prometheus" && e.status === 400 && e.message === "rejected (400 bad_data)");
    assert.equal(c.health().failures, 0);
    await assert.rejects(c.instant("boom"), (e: unknown) => {
      assert.ok(e instanceof PromError && e.kind === "http" && e.status === 503);
      assert.ok(!/secret|127\.0\.0\.1|https?:/.test((e as Error).message), (e as Error).message);
      return true;
    });
    assert.deepEqual(c.health(), { failures: 1, retryAt: 2000 });
  } finally {
    await p.close();
  }
});

test("client: server failures back off exponentially, fail fast meanwhile, reset on success", async () => {
  const p = await fakeProm({ boom: { status: 500 }, up: [{ metric: {}, value: 1 }] });
  try {
    let t = 0;
    const c = new PromClient({ url: p.url, now: () => t, backoff: { baseMs: 1000, maxMs: 4000, jitter: 0 } });
    await assert.rejects(c.instant("boom"));
    assert.equal(c.health().retryAt, 1000);
    const before = p.requests.length;
    await assert.rejects(c.instant("up"), (e: unknown) => e instanceof PromError && e.kind === "backoff");
    assert.equal(p.requests.length, before, "no request while backing off");
    t = 1000;
    await assert.rejects(c.instant("boom"));
    assert.equal(c.health().retryAt, 3000);
    t = 3000;
    await assert.rejects(c.instant("boom"));
    t = 7000;
    await assert.rejects(c.instant("boom"));
    assert.equal(c.health().retryAt, 11_000, "capped at maxMs");
    t = 11_000;
    assert.equal((await c.instant("up")).samples[0]!.value, 1);
    assert.deepEqual(c.health(), { failures: 0, retryAt: 0 });
  } finally {
    await p.close();
  }
});

test("client: timeout, series cap, size cap and non-API answers", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ metric: { i: String(i) }, value: i }));
  const p = await fakeProm({ slow: { delayMs: 400, then: [] }, many, junk: { raw: "<html>login</html>" } });
  try {
    const c = new PromClient({ url: p.url, timeoutMs: 100, maxSeries: 10, backoff: { baseMs: 0, jitter: 0 } });
    await assert.rejects(c.instant("slow"), (e: unknown) => e instanceof PromError && e.kind === "timeout");
    await assert.rejects(c.instant("many"), (e: unknown) => e instanceof PromError && e.kind === "limit");
    await assert.rejects(c.instant("junk"), (e: unknown) => e instanceof PromError && e.kind === "parse");
    const small = new PromClient({ url: p.url, maxBytes: 200, backoff: { baseMs: 0, jitter: 0 } });
    await assert.rejects(small.instant("many"), (e: unknown) => e instanceof PromError && e.kind === "limit");
    await assert.rejects(c.instant("x".repeat(20_000)), (e: unknown) => e instanceof PromError && e.kind === "config");
    await assert.rejects(c.instant("  "), (e: unknown) => e instanceof PromError && e.kind === "config");
  } finally {
    await p.close();
  }
});

test("client: unreachable server is an http failure", async () => {
  const c = new PromClient({ url: "http://127.0.0.1:9", timeoutMs: 1000, backoff: { jitter: 0 } });
  await assert.rejects(c.instant("up"), (e: unknown) => e instanceof PromError && (e.kind === "http" || e.kind === "timeout"));
  assert.equal(c.health().failures, 1);
});
