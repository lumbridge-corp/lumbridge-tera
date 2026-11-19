import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldPack } from "../../schema/index.ts";
import { sandboxRoom } from "../../residents/sandbox-room.ts";
import { describe, resolveSelection } from "./model.ts";

const room = sandboxRoom({ id: "lab", name: "Glass lab", size: [4, 3], policy: { network: "none", files: "workdir", tools: ["shell"] }, count: "2 inside" });
const world = WorldPack.parse({
  tera: "world/v1", id: "r", title: "r",
  graph: { nodes: [{ id: "home-k", position: [0, 0, 0] }], edges: [] },
  residents: [
    { id: "keeper", name: "Keeper", role: "steward", home: "The hall", homeNode: "home-k", blurb: "Runs the house." },
    { id: "moth", name: "Moth", role: "sandboxed", sandbox: "lab" },
  ],
  sandboxes: [{ id: "lab", name: "Glass lab", kind: "container", entity: "lab", policy: { network: "none", files: "workdir", tools: ["shell"] } }],
  entities: [
    room.entity,
    { id: "living", kind: "group", tags: ["living"], children: [
      { id: "res-keeper", kind: "actor", style: "resident", resident: "keeper", state: "idle", move: { to: "home-k" } },
      { id: "res-ghost", kind: "actor", style: "resident", resident: "ghost", label: "Ghost", color: "#aabbcc" },
    ] },
  ],
});

test("model: a resident's card has its name, role, home and state", () => {
  const c = describe(world, "res-keeper")!;
  assert.equal(c.title, "Keeper");
  assert.equal(c.kind, "Steward");
  assert.equal(c.state, "at home");
  assert.equal(c.detail, "Runs the house.");
  assert.ok(c.chips.includes("home · The hall"));
  const g = describe(world, "res-ghost")!;
  assert.equal(g.title, "Ghost");
  assert.equal(g.kind, "Resident");
});

test("model: a click on a sandbox room's glass selects the room; its card shows the policy and residents", () => {
  assert.equal(resolveSelection(world, "lab-glass-back"), "lab");
  const c = describe(world, "lab")!;
  assert.equal(c.title, "Glass lab");
  assert.equal(c.kind, "Sandbox · container");
  assert.equal(c.state, "2 inside");
  assert.deepEqual(c.chips, ["network · none", "files · workdir", "tools · shell", "resident · Moth"]);
});
