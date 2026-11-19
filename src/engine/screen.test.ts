// Screens: schema, the `screen` op, and the pure layout math (screen-math.ts). Node only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Entity, Op, WorldPack } from "../schema/index.ts";
import { applyOp, worldAt } from "./timeline.ts";
import { checkOps } from "../mcp/validate.ts";
import { balanceLines, cardLayout, coverFit, coverRect, faceAspect, panelLayout, resolveScreen, wrapLines, youtubeThumbUrl, SCREEN_DEFAULTS } from "./screen-math.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const tv = (screen: unknown, shape = "box") => ({ id: "tv", kind: "primitive", shape, size: [1.6, 0.9, 0.04], material: { screen } });
const world = (): WorldPack => WorldPack.parse({ tera: "world/v1", id: "w", title: "w", entities: [{ id: "room", kind: "group", children: [tv(true)] }, { id: "cube", kind: "primitive", shape: "box" }] });

test("schema: screen material accepts true, a spec and every content kind", () => {
  assert.ok(Entity.safeParse(tv(true)).success);
  assert.ok(Entity.safeParse(tv({ glare: 0.5, brightness: 1, youtubeThumb: "/thumb?v={id}", iframe: false })).success);
  for (const content of [
    { kind: "video", src: "loops/a-720.mp4", title: "A" },
    { kind: "image", src: "a.png" },
    { kind: "youtube", videoId: "dQw4w9WgXcQ", title: "t", channel: "c", live: true, playing: true, thumb: "/t.jpg" },
    { kind: "off" },
  ]) assert.ok(Entity.safeParse(tv({ content })).success, JSON.stringify(content));
  assert.ok(Entity.safeParse({ ...tv(true, "plane"), size: [2, 1] }).success, "a plane can be a screen");
});

test("schema: screen material rejects bad content, shapes and mixes", () => {
  const bad = (x: unknown, why: string) => assert.equal(Entity.safeParse(x).success, false, why);
  bad(tv({ content: { kind: "video" } }), "video needs src");
  bad(tv({ content: { kind: "youtube", videoId: "a b/c" } }), "videoId charset");
  bad(tv({ content: { kind: "hologram" } }), "unknown kind");
  bad(tv({ glare: 2 }), "glare is 0..1");
  bad(tv(false), "false is not a screen");
  bad(tv(true, "sphere"), "only box / plane");
  bad({ ...tv(true), material: { screen: true, glass: true } }, "not glass");
  bad({ ...tv(true), material: { screen: true, glowExact: true } }, "not glowExact");
});

test("op screen: stores the content in the entity (true becomes a spec), keeps the rest", () => {
  const w = world();
  const op = Op.parse({ op: "screen", id: "tv", content: { kind: "youtube", videoId: "abc", title: "Hi", live: true } });
  applyOp(w, op);
  const e = (w.entities[0] as Extract<Entity, { kind: "group" }>).children[0] as Extract<Entity, { kind: "primitive" }>;
  assert.deepEqual(e.material?.screen, { content: { kind: "youtube", videoId: "abc", title: "Hi", live: true } });
  assert.deepEqual(e.size, [1.6, 0.9, 0.04]);
  applyOp(w, { op: "screen", id: "tv", content: { kind: "off" } });
  assert.deepEqual((e.material?.screen as { content: unknown }) && ((w.entities[0] as { children: { material: { screen: { content: unknown } } }[] }).children[0]!.material.screen.content), { kind: "off" });
});

test("op screen: errors on unknown ids, non-screens and bad content; the world is untouched", () => {
  const w = world();
  const before = JSON.stringify(w);
  assert.throws(() => applyOp(w, { op: "screen", id: "nope", content: { kind: "off" } }), /no entity "nope"/);
  assert.throws(() => applyOp(w, { op: "screen", id: "cube", content: { kind: "off" } }), /not a screen/);
  assert.throws(() => applyOp(w, { op: "screen", id: "tv", content: { kind: "video" } } as unknown as Op), /invalid op/);
  assert.equal(JSON.stringify(w), before);
});

test("op screen in a script timeline: seek is exact both ways", () => {
  const base = world();
  const events = [{ t: 2, ops: [{ op: "screen" as const, id: "tv", content: { kind: "video" as const, src: "a.mp4" } }] }];
  const at = (t: number) => JSON.stringify(worldAt(base, events, t).world);
  assert.equal(at(1), JSON.stringify(base));
  assert.match(at(3), /"src":"a.mp4"/);
  assert.equal(at(1.5), at(0));
});

test("MCP checkOps: screen ops are checked against the world", () => {
  const w = world();
  assert.equal(checkOps([{ op: "screen", id: "tv", content: { kind: "image", src: "a.png" } }], w).ok, true);
  const r = checkOps([{ op: "screen", id: "cube", content: { kind: "off" } }], w);
  assert.equal(r.ok, false);
  assert.match(r.errors[0]!.messages.join(" "), /not a screen/);
  assert.equal(checkOps([{ op: "screen", id: "ghost", content: { kind: "off" } }], w).ok, false);
});

test("resolveScreen + faceAspect: defaults and the face that shows the picture", () => {
  assert.deepEqual(resolveScreen(true), { content: { kind: "off" }, glare: SCREEN_DEFAULTS.glare, brightness: SCREEN_DEFAULTS.brightness });
  assert.equal(resolveScreen({ glare: 0, content: { kind: "image", src: "x" } }).glare, 0);
  near(faceAspect("box", [1.6, 0.9, 0.04]), 16 / 9);
  near(faceAspect("plane", [2.1, 0.9]), 2.1 / 0.9);
  near(faceAspect("box", [2]), 1);
});

test("coverFit: crops evenly, never stretches", () => {
  const same = coverFit(16 / 9, 16 / 9);
  assert.deepEqual(same, { repeat: [1, 1], offset: [0, 0] });
  // a 4:3 picture on a 16:9 face: full width, a centred band of its height
  const tall = coverFit(4 / 3, 16 / 9);
  near(tall.repeat[0], 1);
  near(tall.repeat[1], (4 / 3) / (16 / 9));
  near(tall.offset[1], (1 - tall.repeat[1]) / 2);
  // shown aspect = src aspect * repeat.x / repeat.y = face aspect
  for (const [s, f] of [[16 / 9, 21 / 9], [21 / 9, 16 / 9], [1, 16 / 9], [16 / 9, 1]] as const) {
    const c = coverFit(s, f);
    near((s * c.repeat[0]) / c.repeat[1], f, 1e-9);
    assert.ok(c.repeat[0] <= 1 && c.repeat[1] <= 1);
  }
  assert.deepEqual(coverFit(0, 1), { repeat: [1, 1], offset: [0, 0] });
  const r = coverRect(1280, 720, 1000, 1000);
  near(r.h, 1000);
  near(r.x, (1000 - r.w) / 2);
});

test("youtubeThumbUrl: own thumb first, then the template with {id}", () => {
  const c = { kind: "youtube" as const, videoId: "a_b-1" };
  assert.equal(youtubeThumbUrl(c), null);
  assert.equal(youtubeThumbUrl(c, "/thumb?v={id}"), "/thumb?v=a_b-1");
  assert.equal(youtubeThumbUrl(c, "/thumb"), "/thumb");
  assert.equal(youtubeThumbUrl({ ...c, thumb: "/own.jpg" }, "/thumb?v={id}"), "/own.jpg");
});

// a monospace measure: every character is 0.5 em wide
const mono = (text: string, px: number) => text.length * px * 0.5;

test("wrapLines + balanceLines: fit, ellipsis, even breaks", () => {
  assert.deepEqual(wrapLines("one two three", 1000, 2, 10, mono), ["one two three"]);
  assert.deepEqual(wrapLines("aaaa bbbb cccc dddd", 50, 2, 10, mono), ["aaaa bbbb", "cccc dddd"]);
  const cut = wrapLines("aaaa bbbb cccc dddd eeee ffff", 50, 2, 10, mono);
  assert.equal(cut.length, 2);
  assert.ok(cut[1]!.endsWith("…") && mono(cut[1]!, 10) <= 50, cut[1]);
  const long = wrapLines("supercalifragilistic", 50, 1, 10, mono);
  assert.ok(long[0]!.endsWith("…") && mono(long[0]!, 10) <= 50);
  assert.deepEqual(wrapLines("", 50, 2, 10, mono), []);
  // greedy leaves one word on line 2; balanced moves the break
  assert.deepEqual(balanceLines(["aa bb cc dd", "ee"], 60, 10, mono), ["aa bb cc", "dd ee"]);
  assert.deepEqual(balanceLines(["aa bb", "cc…"], 60, 10, mono), ["aa bb", "cc…"], "an ellipsis line is kept");
});

test("cardLayout: badge, title and channel stay inside the card, bottom-up", () => {
  const c = { kind: "youtube" as const, videoId: "x", title: "A fairly long title that has to wrap onto a second line here", channel: "Channel", live: true };
  const W = 1280, H = 720;
  const L = cardLayout(W, H, c, mono);
  assert.equal(L.badge?.kind, "live");
  assert.ok(L.title && L.title.lines.length === 2);
  for (const line of L.title!.lines) assert.ok(mono(line, L.title!.px) <= W - L.pad * 2);
  assert.ok(L.channel && L.channel.y <= H - L.pad + 1e-9);
  assert.ok(L.title!.y + L.title!.lineH < L.channel!.y, "title above the channel");
  assert.ok(L.shadeTop < L.title!.y - L.title!.px, "the gradient starts above the text");
  assert.ok(L.badge!.y + L.badge!.h < L.title!.y - L.title!.px, "badge clear of the title");
  assert.equal(cardLayout(W, H, { ...c, live: false, playing: true }, mono).badge?.kind, "playing");
  assert.equal(cardLayout(W, H, { ...c, live: undefined, playing: false }, mono).badge?.kind, "paused");
  assert.equal(cardLayout(W, H, { kind: "youtube", videoId: "x" }, mono).badge, null);
  assert.equal(cardLayout(W, H, { kind: "youtube", videoId: "x" }, mono).shadeTop, H, "no text, no shade");
  // sizes scale with the height: a 21:9 card keeps the same proportions
  const wide = cardLayout(2100, 900, c, mono);
  near(wide.title!.px / 900, L.title!.px / 720, 0.002);
});

// ---- panel content (a small dashboard drawn by the engine)
const panel = { kind: "panel", title: "Fleet", subtitle: "six machines", status: "all up", rows: [{ label: "cpu", value: 0.4, text: "40%" }, { label: "memory", value: 0.7 }, { label: "agents", text: "12" }], series: [0.1, 0.4, 0.3, 0.8], accent: "#a9d38a", theme: "dark" };

test("schema: panel content (rows, series, accent, theme) and its limits", () => {
  assert.ok(Entity.safeParse(tv({ content: panel })).success);
  assert.ok(Entity.safeParse(tv({ content: { kind: "panel" } })).success, "everything is optional");
  const bad = (content: unknown, why: string) => assert.equal(Entity.safeParse(tv({ content })).success, false, why);
  bad({ ...panel, rows: Array.from({ length: 9 }, () => ({ label: "x" })) }, "at most 8 rows");
  bad({ ...panel, rows: [{ label: "x", value: 1.5 }] }, "bar values are 0..1");
  bad({ ...panel, series: [2] }, "series values are 0..1");
  bad({ ...panel, accent: "lime" }, "accent is #rrggbb");
  bad({ ...panel, theme: "neon" }, "theme dark | light");
  bad({ ...panel, title: "x".repeat(61) }, "title length");
  const w = world();
  applyOp(w, Op.parse({ op: "screen", id: "tv", content: panel }));
  const e = (w.entities[0] as { children: { material: { screen: { content: unknown } } }[] }).children[0]!;
  assert.deepEqual(e.material.screen.content, panel);
});

test("panelLayout: header, rows between header and sparkline, text fitted, boxes inside the canvas", () => {
  const measure = (t: string, px: number) => t.length * px * 0.55;
  const w = 1280, h = 720;
  const L = panelLayout(w, h, panel as never, measure);
  assert.ok(L.title && L.subtitle && L.status && L.series);
  assert.equal(L.rows.length, 3);
  assert.ok(L.status!.x + L.status!.w <= w - L.pad + 1e-9, "pill inside the right margin");
  assert.ok(L.rows[0]!.bar.y > L.subtitle!.y, "rows start under the header");
  assert.ok(L.rows[2]!.bar.y + L.rows[2]!.bar.h < L.series!.y, "rows end above the sparkline");
  for (const r of L.rows) {
    assert.ok(r.bar.x > r.labelX && r.bar.x + r.bar.w < r.textX, "label | bar | value");
    assert.ok(measure(r.label, r.px) <= w * 0.36 + 1e-9);
  }
  assert.equal(L.rows[2]!.value, null, "a row without value draws no bar");
  const long = panelLayout(w, h, { kind: "panel", title: "a very long title that will never fit into the space left of the pill", status: "ok" }, measure);
  assert.ok(long.title!.text.endsWith("…"));
  assert.ok(measure(long.title!.text, long.title!.px) <= w - long.pad * 2 - long.status!.w);
  const empty = panelLayout(w, h, { kind: "panel" }, measure);
  assert.equal(empty.title, null);
  assert.equal(empty.series, null);
  assert.equal(empty.rows.length, 0);
  const many = panelLayout(w, 200, { kind: "panel", rows: Array.from({ length: 8 }, (_, i) => ({ label: `r${i}`, value: 0.5 })) }, measure);
  for (const r of many.rows) assert.ok(r.bar.y + r.bar.h <= 200, "short canvases squeeze the rows, never overflow");
});
