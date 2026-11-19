import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldPack, checkRegistry, globMatch, livingRefErrors, worldResidents, type ResidentRegistry } from "./index.ts";

const reg: ResidentRegistry = {
  tera: "residents/v1",
  residents: [
    { id: "keeper", name: "Keeper", role: "steward", home: "Hall", homeNode: "hall.door", match: { units: ["box:keeper.service"] }, visibility: "public" },
    { id: "ada", name: "Ada", role: "analyst", match: { agents: ["jobs:*"] }, visibility: "member", publicName: "Analyst", publicBlurb: "Reads the numbers." , blurb: "Ada reads the numbers first." },
    { id: "secret", name: "Secret", role: "sandboxed", sandbox: "glass", match: { procs: ["box:codex"] }, visibility: "owner" },
  ],
  sandboxes: [{ id: "glass", name: "Glass room", kind: "worktree", policy: { network: "none", files: "workdir", tools: ["shell"] }, entity: "glass", visibility: "member", publicName: "Sandbox" }],
};

test("residents: a good registry passes; refs and names are checked", () => {
  const ok = checkRegistry(reg, { graph: { nodes: [{ id: "hall.door" }] }, entities: [{ id: "glass" }] });
  assert.deepEqual(ok.errors, []);
  const bad = structuredClone(reg);
  bad.residents[1]!.name = "Keeper";
  bad.residents[2]!.sandbox = "nope";
  bad.residents.push({ ...bad.residents[0]!, homeNode: "nowhere" });
  const r = checkRegistry(bad, { graph: { nodes: [{ id: "hall.door" }] } });
  assert.ok(r.errors.some((e) => e.includes("duplicate resident id")));
  assert.ok(r.errors.some((e) => e.includes('name "Keeper"')));
  assert.ok(r.errors.some((e) => e.includes('no sandbox "nope"')));
  assert.ok(r.errors.some((e) => e.includes('home node "nowhere"')));
  assert.equal(checkRegistry({ tera: "residents/v1", residents: [{ id: "x", name: "X", role: "steward", match: { bogus: [] }, visibility: "public" }] }).registry, null);
});

test("residents: an audience sees its level and up; below it publicName or nothing", () => {
  const owner = worldResidents(reg, "owner");
  assert.deepEqual(owner.residents.map((r) => r.name), ["Keeper", "Ada", "Secret"]);
  const pub = worldResidents(reg, "public", { renameIds: (r) => r.publicName!.toLowerCase() });
  assert.deepEqual(pub.residents.map((r) => [r.id, r.name, r.blurb]), [["keeper", "Keeper", undefined], ["analyst", "Analyst", "Reads the numbers."]]);
  assert.equal(pub.ids.get("secret"), null);
  assert.equal(pub.sandboxes[0]!.name, "Sandbox");
  const text = JSON.stringify(pub);
  for (const w of ["Ada", "Secret", "match", "visibility", "Glass room"]) assert.ok(!text.includes(w), w);
});

test("residents: the world pack carries display data; actors must name a known resident", () => {
  const { residents, sandboxes } = worldResidents(reg, "owner");
  const w = WorldPack.parse({ tera: "world/v1", id: "t", title: "t", entities: [{ id: "a", kind: "actor", style: "resident", resident: "keeper" }], residents, sandboxes });
  assert.equal(w.residents?.length, 3);
  assert.deepEqual(livingRefErrors({ id: "a", kind: "actor", style: "resident", resident: "keeper" }, w), []);
  assert.match(livingRefErrors({ id: "b", kind: "actor", style: "resident", resident: "who" }, w)[0]!, /no resident "who"/);
  assert.match(livingRefErrors({ id: "c", kind: "actor", resident: "keeper" }, w)[0]!, /needs style "resident"/);
  assert.equal(WorldPack.safeParse({ tera: "world/v1", id: "t", title: "t", entities: [], residents: [residents[0], residents[0]] }).success, false);
});

test("residents: glob matching for feeds", () => {
  assert.ok(globMatch("web:app-gateway*", "web:app-gateway.service"));
  assert.ok(globMatch("search:*", "search:abc123"));
  assert.ok(!globMatch("search:*", "mail:sync"));
  assert.ok(globMatch("a.b", "A.B"));
  assert.ok(!globMatch("a.b", "axb"));
});

test("residents: a server filters display data that keeps its access fields", async () => {
  const { residentsFor } = await import("./residents.ts");
  const owner = worldResidents(reg, "owner", { keepAccess: true }).residents;
  assert.equal(owner.find((r) => r.id === "ada")?.publicName, "Analyst");
  const guest = residentsFor(owner, "guest");
  assert.deepEqual(guest.residents.map((r) => r.name), ["Keeper", "Analyst"]);
  assert.ok(!JSON.stringify(guest.residents).includes("visibility"));
  assert.equal(residentsFor(owner, "member").residents.length, 2);
  assert.equal(residentsFor(owner, "owner", { keepAccess: true }).residents.find((r) => r.id === "secret")?.visibility, "owner");
});
