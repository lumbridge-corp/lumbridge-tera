// The living-world layer of the engine: actors, flows and meters, kept in step with the
// world JSON and posed every frame from one clock.
//
//   render mode: t = script time (seek)          → same t, same pixels
//   live mode:   t = seconds since the page began → wall clock; feed changes tween
//
// engine.ts calls setWorld() at the start of every sync, build()/upsert()/remove() for
// the entities, and update() once per drawn frame.
import * as THREE from "three";
import type { Entity, WorldPack } from "../schema/index.ts";
import { ActorSystem, type ActorSpec, type LivingHooks } from "./actors.ts";
import { FlowObject, MeterObject, type FlowSpec, type LivingWorld, type MeterSpec } from "./flows.ts";

export const LIVING_KINDS = new Set(["actor", "flow", "meter"]);
export const isLiving = (e: Entity) => LIVING_KINDS.has(e.kind);

export class Living {
  readonly actors: ActorSystem;
  private flows = new Map<string, FlowObject>();
  private meters = new Map<string, MeterObject>();
  private meterMemory = new Map<string, number>();
  private world: LivingWorld = { paths: [], graph: undefined };
  private t0 = performance.now();
  private lastT: number | null = null;

  constructor(scene: THREE.Scene, private renderMode: boolean, private hooks: LivingHooks) {
    this.actors = new ActorSystem(renderMode, hooks);
    scene.add(this.actors.root);
  }

  /** Live clock: seconds since the page started. */
  liveNow(): number {
    return (performance.now() - this.t0) / 1000;
  }

  setWorld(w: WorldPack) {
    const lw = w as WorldPack & { paths?: LivingWorld["paths"]; graph?: LivingWorld["graph"] };
    this.world = { paths: lw.paths ?? [], graph: lw.graph };
    this.actors.setWorld(this.world);
    for (const f of this.flows.values()) f.setWorld(this.world);
  }

  /** Build the scene object for a living entity (the engine parents and transforms it). */
  build(e: Entity): THREE.Object3D {
    const any = e as unknown as { id: string; kind: string };
    if (any.kind === "flow") {
      const f = new FlowObject(e as unknown as FlowSpec, (m) => this.hooks.warn(m));
      f.setWorld(this.world);
      this.flows.set(any.id, f);
      return f.obj;
    }
    if (any.kind === "meter") {
      const m = new MeterObject(e as unknown as MeterSpec, !this.renderMode, this.renderMode ? undefined : this.meterMemory.get(any.id));
      this.meters.set(any.id, m);
      return m.obj;
    }
    // Actors are drawn by the shared ActorSystem; the node keeps an empty anchor.
    this.actors.upsert(e as unknown as ActorSpec);
    return new THREE.Group();
  }

  /** Called on every sync for every living entity (sees transform / visibility changes). */
  upsert(e: Entity) {
    if (e.kind === "actor") this.actors.upsert(e as unknown as ActorSpec);
  }

  remove(e: Entity) {
    const id = e.id;
    if (e.kind === "actor") this.actors.remove(id);
    const f = this.flows.get(id);
    if (f) { f.dispose(); this.flows.delete(id); }
    const m = this.meters.get(id);
    if (m) { this.meterMemory.set(id, m.value); m.dispose(); this.meters.delete(id); }
  }

  /** Pose everything for time t (script seconds) or, without t, the live clock. */
  update(camera: THREE.Camera, t?: number) {
    const now = t ?? this.liveNow();
    const dt = this.lastT === null ? 1 / 60 : Math.min(0.25, Math.max(0, now - this.lastT));
    this.lastT = now;
    this.actors.update(now, camera);
    for (const f of this.flows.values()) f.update(now, camera);
    for (const m of this.meters.values()) m.update(dt);
  }

  stats() {
    return { actors: this.actors.count, flows: this.flows.size, meters: this.meters.size };
  }
}
