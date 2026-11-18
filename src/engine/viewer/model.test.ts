import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldPack } from "../../schema/index.ts";
import { buildPresets, countAgents, describe, legendOf, parseSavedView, pretty, resolveSelection, splitTitle } from "./model.ts";

const world = WorldPack.parse({
  tera: "world/v1",
  id: "town",
  title: "Town — a small one",
  legend: [{ label: "requests", color: "#b8ff3c" }, { label: "data", color: "#3fd8ff" }],
  cameras: {
    default: { position: [10, 10, 10], target: [0, 0, 0] },
    overview: { position: [10, 10, 10], target: [0, 0, 0] },
    "machine-room": { position: [0, 2, 4], target: [0, 1, 0], fov: 50 },
  },
  entities: [
    { id: "ground", kind: "primitive", shape: "plane", size: [40, 40], tags: ["ground"] },
    { id: "post-office", kind: "group", tags: ["building", "plot", "mail"], children: [
      { id: "po-wall", kind: "primitive", shape: "box" },
      { id: "po-roof", kind: "group", children: [{ id: "po-roof-tile", kind: "primitive", shape: "box" }] },
    ] },
    { id: "machine-room", kind: "group", tags: ["machine-room"], children: [
      { id: "mr-rack-1", kind: "group", tags: ["machine", "rack-1"], children: [
        { id: "rack", kind: "primitive", shape: "box" },
        { id: "meter.rack-1.cpu", kind: "meter", value: 0.42, tags: ["meter", "cpu"] },
        { id: "meter.rack-1.gpu", kind: "meter", value: 0.91, tags: ["meter", "gpu"] },
      ] },
      { id: "mr-floor", kind: "primitive", shape: "box" },
    ] },
    { id: "living", kind: "group", tags: ["living"], children: [
      { id: "bot-agent-1", kind: "actor", label: "agent-1", state: "working", move: { to: "lab" } },
      { id: "bot-hidden", kind: "actor", visible: false },
    ] },
    { id: "hidden-plot", kind: "group", tags: ["plot"], visible: false, children: [] },
  ],
});

test("model: presets = cameras (deduped, default = Home) then visible plots", () => {
  const p = buildPresets(world);
  assert.deepEqual(p.map((x) => x.id), ["default", "machine-room", "place:post-office"]);
  assert.equal(p[0]!.name, "Overview"); // default = overview
  assert.equal(buildPresets({ ...world, cameras: { default: world.cameras!.default! } })[0]!.name, "Home");
  assert.equal(p[1]!.name, "Machine room");
  assert.equal(p[2]!.group, "place");
});

test("model: a click selects the meaningful thing", () => {
  assert.equal(resolveSelection(world, "po-roof-tile"), "post-office");
  assert.equal(resolveSelection(world, "rack"), "mr-rack-1");
  assert.equal(resolveSelection(world, "meter.rack-1.cpu"), "meter.rack-1.cpu");
  assert.equal(resolveSelection(world, "mr-floor"), "machine-room");
  assert.equal(resolveSelection(world, "bot-agent-1"), "bot-agent-1");
  assert.equal(resolveSelection(world, "ground"), null);
  assert.equal(resolveSelection(world, "nope"), null);
});

test("model: cards carry world data only", () => {
  const bot = describe(world, "bot-agent-1")!;
  assert.equal(bot.title, "agent-1");
  assert.equal(bot.kind, "Agent");
  assert.equal(bot.state, "working");
  assert.equal(bot.detail, "heading to Lab");
  const m = describe(world, "mr-rack-1")!;
  assert.equal(m.kind, "Machine");
  assert.equal(m.title, "Rack 1");
  assert.deepEqual(m.meters, [{ label: "cpu", value: 0.42 }, { label: "gpu", value: 0.91 }]);
  const po = describe(world, "post-office")!;
  assert.equal(po.kind, "Building");
  assert.deepEqual(po.chips, ["mail"]);
  const meter = describe(world, "meter.rack-1.gpu")!;
  assert.equal(meter.title, "Rack 1 · gpu");
  assert.equal(describe(world, "nope"), null);
});

test("model: agent count skips hidden actors; legend and title", () => {
  assert.equal(countAgents(world), 1);
  assert.equal(legendOf(world)!.length, 2);
  assert.equal(legendOf({ ...world, legend: undefined }), null);
  assert.deepEqual(splitTitle(world.title), { name: "Town", tagline: "a small one" });
  assert.deepEqual(splitTitle("Demo"), { name: "Demo", tagline: "" });
  assert.equal(pretty("post-office"), "Post office");
});

test("model: saved views are validated", () => {
  assert.equal(parseSavedView(null), null);
  assert.equal(parseSavedView("{bad"), null);
  assert.equal(parseSavedView(JSON.stringify({ pose: { position: [1, 2], target: [0, 0, 0] } })), null);
  assert.deepEqual(parseSavedView(JSON.stringify({ preset: "overview", pose: { position: [1, 2, 3], target: [0, 0, 0], fov: 500 } })), { preset: "overview", pose: { position: [1, 2, 3], target: [0, 0, 0], fov: 45 } });
});
