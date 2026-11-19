import { test } from "node:test";
import assert from "node:assert/strict";
import { PresenceClient, cleanName, parsePresenceMessage, type TransportHandlers } from "./presence.ts";

const P = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `N ${id}`, color: "#aabbcc", layer: "surface", position: [1, 0, 2], heading: 90, mode: "walk", ...extra });

test("parse: welcome / join / states / leave / reject; malformed input is ignored", () => {
  const w = parsePresenceMessage(JSON.stringify({ type: "welcome", v: 1, you: { id: "me", name: "Ada", color: "#112233" }, players: [P("a"), P("me"), { id: "bad" }], resume: { layer: "compute", position: [1, -17.1, 2], heading: 400, mode: "fly" }, max: 20 }));
  assert.equal(w.type, "welcome");
  if (w.type !== "welcome") return;
  assert.deepEqual(w.players.map((p) => p.id), ["a"], "self and invalid players dropped");
  assert.equal(w.resume?.heading, 40, "heading normalised");
  assert.equal(parsePresenceMessage(JSON.stringify({ type: "join", player: P("b") })).type, "join");
  const s = parsePresenceMessage(JSON.stringify({ type: "states", players: [P("a"), { id: "x", layer: "surface", position: [1, 2], heading: 0 }, { id: "y", layer: "Bad Layer!", position: [0, 0, 0], heading: 0 }] }));
  assert.ok(s.type === "states" && s.players.length === 1);
  assert.equal(parsePresenceMessage(JSON.stringify({ type: "leave", id: "a" })).type, "leave");
  assert.equal(parsePresenceMessage(JSON.stringify({ type: "reject", reason: "layer" })).type, "reject");
  for (const bad of ["", "nope", "[]", "null", JSON.stringify({ type: "join", player: P("c", { position: [Infinity, 0, 0] }) }), JSON.stringify({ type: "join", player: P("c", { id: "<script>" }) }), JSON.stringify({ type: "evil" })])
    assert.equal(parsePresenceMessage(bad).type, "ignore", bad);
});

test("names: control and bidi characters stripped, capped at 32", () => {
  assert.equal(cleanName("  A‮da\u0000  "), "Ada");
  assert.equal(cleanName("x".repeat(80))!.length, 32);
  assert.equal(cleanName("​"), null);
  assert.equal(cleanName(42), null);
});

function fakeTransport() {
  const sent: string[] = [];
  let h: TransportHandlers | null = null;
  let opens = 0;
  const factory = (handlers: TransportHandlers) => { h = handlers; opens++; return { send: (t: string) => sent.push(t), close: () => {} }; };
  return { sent, factory, h: () => h!, opens: () => opens };
}

test("client: throttles to the rate, heartbeats when still, tracks players", () => {
  let now = 0;
  const t = fakeTransport();
  const ev: string[] = [];
  const c = new PresenceClient(t.factory, {
    join: (p) => ev.push(`join ${p.id}`), leave: (id) => ev.push(`leave ${id}`), move: (id) => ev.push(`move ${id}`), welcome: (y) => ev.push(`welcome ${y.name}`),
  }, { now: () => now, rateHz: 10, heartbeatMs: 4000 }).start();
  c.update({ layer: "surface", position: [0, 0, 0], heading: 0, mode: "orbit" });
  assert.equal(t.sent.length, 0, "nothing before open");
  t.h().open();
  assert.equal(t.sent.length, 1, "state sent on open");
  assert.deepEqual(JSON.parse(t.sent[0]!), { type: "state", layer: "surface", position: [0, 0, 0], heading: 0, mode: "orbit" });
  for (let i = 1; i <= 60; i++) { now = i * (1000 / 60); c.update({ layer: "surface", position: [i * 0.05, 0, 0], heading: 0, mode: "walk" }); }
  assert.ok(t.sent.length >= 9 && t.sent.length <= 11, `~10 per second, got ${t.sent.length}`);
  const n = t.sent.length;
  for (let i = 0; i < 300; i++) { now += 1000 / 60; c.update({ layer: "surface", position: [3, 0, 0], heading: 0, mode: "walk" }); }
  assert.ok(t.sent.length - n <= 3, "standing still: only the last move and heartbeats");
  t.h().message(JSON.stringify({ type: "welcome", v: 1, you: { id: "me", name: "Ada", color: "#112233" }, players: [P("a")], resume: null, max: 20 }));
  t.h().message(JSON.stringify({ type: "join", player: P("b") }));
  t.h().message(JSON.stringify({ type: "states", players: [{ id: "b", layer: "compute", position: [0, -17, 0], heading: 5, mode: "fly" }] }));
  assert.equal(c.players.get("b")?.layer, "compute");
  t.h().message(JSON.stringify({ type: "leave", id: "a" }));
  assert.deepEqual([...c.players.keys()], ["b"]);
  assert.ok(ev.includes("welcome Ada") && ev.includes("join a") && ev.includes("leave a"));
  c.stop();
});

test("client: reconnects after a drop (players cleared), stops on a refusal", async () => {
  const t = fakeTransport();
  const left: string[] = [];
  const c = new PresenceClient(t.factory, { leave: (id) => left.push(id) }, { backoff: () => 1 }).start();
  t.h().open();
  t.h().message(JSON.stringify({ type: "join", player: P("a") }));
  t.h().close(1006);
  assert.deepEqual(left, ["a"]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.opens(), 2, "reconnected");
  t.h().close(1008);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.opens(), 2, "policy close: no retry");
  c.stop();
});
