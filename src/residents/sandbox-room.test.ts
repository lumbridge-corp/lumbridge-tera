import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldPack } from "../schema/index.ts";
import { policyLines, sandboxRoom } from "./sandbox-room.ts";

const policy = { network: "none", files: "workdir", tools: ["shell", "git"], enforcer: "docker" } as const;

test("sandbox room: valid world JSON with its live ids, glass walls and a plaque", () => {
  const { entity, spots } = sandboxRoom({ id: "lab", name: "Lab", size: [5, 4], policy: { ...policy, tools: [...policy.tools] } });
  const w = WorldPack.parse({ tera: "world/v1", id: "t", title: "t", entities: [entity] });
  const ids: string[] = [];
  const walk = (e: { id: string; children?: unknown[] }) => { ids.push(e.id); (e.children as typeof e[] | undefined)?.forEach(walk); };
  walk(w.entities[0] as never);
  for (const id of ["lab-contain", "lab-lamp", "lab-count", "lab-plaque", "lab-door"]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  const glass = (entity.children as { material?: { glass?: boolean } }[]).filter((c) => c.material?.glass);
  assert.ok(glass.length >= 6);
  assert.ok(spots.slots.length >= 4);
  for (const s of spots.slots) assert.ok(Math.abs(s[0]) < 2.5 && Math.abs(s[2]) < 2);
  assert.ok(spots.outside[2] > 2 && spots.inside[2] < 2);
});

test("sandbox room: the plaque says the policy plainly", () => {
  assert.deepEqual(policyLines({ ...policy, tools: [...policy.tools] }), ["network  none", "files  workdir", "tools  shell, git", "by  docker"]);
  assert.equal(policyLines({ network: "open", files: "full", tools: ["*"] })[2], "tools  all");
  assert.equal(policyLines({ network: "open", files: "full", tools: [] })[2], "tools  none");
});
