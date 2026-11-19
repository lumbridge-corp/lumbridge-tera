// Static batching for the live viewer: still primitives that wear the same material become ONE
// mesh per material and space cell, so a town of two thousand boxes is a few hundred draw calls
// (in the main pass, the shadow pass and the glow pass alike).
//
// The original meshes stay where they are, on BATCH_LAYER only: cameras (and so shadow maps and
// post passes) skip them, raycasters that enable the layer still hit them. Picking, bounds,
// selection, focus and walking keep working on the entity's own object, nothing is remapped.
//
// A batch is a snapshot. When a batched entity changes after it was batched (rebuilt by an
// update op, moved, hidden, animated) it leaves its batch for good ("hot": live ops keep reaching
// it as its own mesh) and the batch is rebuilt without it. An object handed out to page code
// (engine.entityObject: a lift car, a ferry cabin, an island being cross-faded) is HELD out: it
// comes back once it has been left alone for a few seconds, and is watched every frame from then
// on, so the first move (or material swap) takes it out again before that frame is drawn.
// Render mode never batches (frames stay byte-identical to an unbatched engine).
import * as THREE from "three";

/** The layer batched originals live on (not drawn, still raycast by the engine's rays). */
export const BATCH_LAYER = 1;
const BATCH_MASK = 1 << BATCH_LAYER;
/**
 * Space cell (m, x y z) for splitting batches, so frustum culling still drops what is off
 * screen. Flat cells: floors of a building (or layers of an island) land in different batches.
 */
export const BATCH_CELL: readonly [number, number, number] = [64, 24, 64];

/**
 * A mesh that may be batched (the engine decides eligibility): a primitive's mesh, or one
 * InstancedMesh of a repeat (every copy is baked).
 */
export interface BatchCandidate {
  /** The entity it belongs to (what goes hot). */
  id: string;
  /** Unique per mesh: the id, or id#n for the parts of a repeat. */
  part: string;
  mesh: THREE.Mesh;
  /** Everything that decides how it draws: material JSON, side, shadow flags. */
  key: string;
  /**
   * Base colour (linear) carried per vertex instead of by the material, so meshes that differ
   * only in colour share a batch (the key then leaves the colour out, the material is white
   * with vertexColors). null: the colour is in the key.
   */
  tint: THREE.Color | null;
  /** A fresh material that draws like the mesh's own (called when its batch is built). */
  material(): THREE.Material;
}

interface Member {
  id: string;
  part: string;
  mesh: THREE.Mesh;
  batch: Batch;
  matrix: number[];
  mask: number;
  autoUpdate: boolean;
  tint: THREE.Color | null;
  /** The mesh's material when it joined (a watched member that swaps it leaves). */
  mat: THREE.Material | THREE.Material[];
  material(): THREE.Material;
}

interface Batch {
  key: string;
  members: Set<Member>;
  mesh: THREE.Mesh | null;
  /** Union of the members' own world boxes (Box3.setFromObject of each), for shadow fitting. */
  casterBox: THREE.Box3;
}

export interface BatcherHooks {
  added?(mesh: THREE.Mesh): void;
  removed?(mesh: THREE.Mesh): void;
}

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();

function worldVisible(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function sameMatrix(a: number[], b: THREE.Matrix4): boolean {
  const e = b.elements;
  for (let i = 0; i < 16; i++) if (a[i] !== e[i]) return false;
  return true;
}

/** Each drawn copy of a mesh: its geometry and world matrix (every instance of an InstancedMesh). */
interface Copy { g: THREE.BufferGeometry; M: THREE.Matrix4; tint: THREE.Color | null }
function copiesOf(m: THREE.Mesh, tint: THREE.Color | null, out: Copy[]) {
  const inst = m as THREE.InstancedMesh;
  if (!inst.isInstancedMesh) return void out.push({ g: m.geometry, M: m.matrixWorld, tint });
  for (let i = 0; i < inst.count; i++) {
    const M = new THREE.Matrix4();
    inst.getMatrixAt(i, M);
    out.push({ g: m.geometry, M: M.premultiply(m.matrixWorld), tint });
  }
}

/**
 * position + normal + uv (+ color when tinted) of every member (every copy), baked into world
 * space, in one indexed geometry.
 */
export function bakeGeometry(meshes: THREE.Mesh[], tints?: (THREE.Color | null)[]): THREE.BufferGeometry {
  const copies: Copy[] = [];
  meshes.forEach((m, i) => copiesOf(m, tints?.[i] ?? null, copies));
  const tinted = copies.some((c) => c.tint);
  let verts = 0, idx = 0;
  for (const { g } of copies) {
    const n = g.attributes.position!.count;
    verts += n;
    idx += g.index ? g.index.count : n;
  }
  const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), uv = new Float32Array(verts * 2);
  const col = tinted ? new Float32Array(verts * 3) : null;
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  let vo = 0, io = 0;
  for (const { g, M, tint } of copies) {
    nm.getNormalMatrix(M);
    const P = g.attributes.position!, N = g.attributes.normal, U = g.attributes.uv;
    const n = P.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(M);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      if (N) {
        v.fromBufferAttribute(N, i).applyNormalMatrix(nm);
        nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z;
      }
      if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
      if (col) { col[(vo + i) * 3] = tint?.r ?? 1; col[(vo + i) * 3 + 1] = tint?.g ?? 1; col[(vo + i) * 3 + 2] = tint?.b ?? 1; }
    }
    // A mirrored transform flips the winding; three flips the front face per object, a baked
    // mesh must flip its triangles instead.
    const flip = M.determinant() < 0;
    const count = g.index ? g.index.count : n;
    for (let t = 0; t < count; t += 3) {
      const a = g.index ? g.index.getX(t) : t, b = g.index ? g.index.getX(t + 1) : t + 1, c = g.index ? g.index.getX(t + 2) : t + 2;
      index[io++] = vo + a;
      index[io++] = vo + (flip ? c : b);
      index[io++] = vo + (flip ? b : c);
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Cell of a mesh (its world bounding-sphere centre, all instances for an InstancedMesh), as a key part. */
function cellOf(m: THREE.Mesh, cell: readonly [number, number, number]): string {
  const inst = m as THREE.InstancedMesh;
  if (inst.isInstancedMesh) {
    if (!inst.boundingSphere) inst.computeBoundingSphere();
    _sphere.copy(inst.boundingSphere!).applyMatrix4(m.matrixWorld);
  } else {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    _sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
  }
  const c = _sphere.center;
  // centred on the origin (an island is centred there: one cell holds it, not four)
  return `${Math.round(c.x / cell[0])},${Math.round(c.y / cell[1])},${Math.round(c.z / cell[2])}`;
}

export class StaticBatcher {
  /** Holds the batch meshes (add it to the scene). */
  readonly root = new THREE.Group();
  private members = new Map<string, Member>();
  private batches = new Map<string, Batch>();
  private hot = new Set<string>();
  /** Held out until (ms, clock()): handed out by entityObject. */
  private held = new Map<string, number>();
  /** Ids ever handed out: their members are checked every frame (tick). */
  private watched = new Set<string>();
  private dirty = new Set<Batch>();
  /** How long a handed-out object stays out after the last hand-out (ms). */
  holdMs = 3000;
  /** Clock (ms); tests replace it. */
  clock = () => performance.now();

  private hooks: BatcherHooks;
  private cell: readonly [number, number, number];

  constructor(hooks: BatcherHooks, cell: readonly [number, number, number] = BATCH_CELL) {
    this.hooks = hooks;
    this.cell = cell;
    this.root.name = "tera-batches";
    this.root.userData.teraBatches = true;
    this.root.matrixAutoUpdate = false;
  }

  /** Numbers for the perf smoke / devtools. */
  stats() {
    let meshes = 0;
    for (const b of this.batches.values()) if (b.mesh) meshes++;
    return { batches: meshes, members: this.members.size, hot: this.hot.size, held: this.held.size };
  }

  /** A new world: every batch goes (its members were the old world's), hot / held / watched are forgotten. */
  reset() {
    for (const m of [...this.members.values()]) this.leave(m);
    this.flush();
    this.hot.clear();
    this.held.clear();
    this.watched.clear();
  }

  /**
   * Reconcile with the current candidates (matrices up to date). New still ones join a batch;
   * batched ones that changed in any way go hot; gone ones leave. Dirty batches are rebuilt.
   */
  sync(cands: Iterable<BatchCandidate>) {
    const seen = new Set<string>();
    const now = this.clock();
    for (const c of cands) {
      if (this.hot.has(c.id)) continue;
      const until = this.held.get(c.id);
      if (until !== undefined) {
        if (now < until) continue;
        this.held.delete(c.id);
      }
      const m = this.members.get(c.part);
      if (m) {
        seen.add(c.part);
        if (m.mesh === c.mesh) {
          // a batched original does not update its own matrix each frame (it is still): do it now
          c.mesh.updateMatrix();
          c.mesh.updateWorldMatrix(true, false);
          if (sameMatrix(m.matrix, c.mesh.matrixWorld) && worldVisible(c.mesh)) continue;
        }
        this.hot.add(c.id);
        this.leave(m);
        continue;
      }
      if (!worldVisible(c.mesh)) continue;
      const key = `${c.key}@${cellOf(c.mesh, this.cell)}`;
      let b = this.batches.get(key);
      if (!b) this.batches.set(key, (b = { key, members: new Set(), mesh: null, casterBox: new THREE.Box3() }));
      const member: Member = { id: c.id, part: c.part, mesh: c.mesh, batch: b, matrix: [...c.mesh.matrixWorld.elements], mask: c.mesh.layers.mask, autoUpdate: c.mesh.matrixAutoUpdate, tint: c.tint, mat: c.mesh.material, material: c.material };
      b.members.add(member);
      this.members.set(c.part, member);
      c.mesh.layers.mask = BATCH_MASK;
      // still: no per-frame matrix work (sync() checks it); a watched one keeps it (tick() reads it)
      if (!this.watched.has(c.id)) c.mesh.matrixAutoUpdate = false;
      c.mesh.userData.teraBatched = true;
      this.dirty.add(b);
      seen.add(c.part);
    }
    // holds that ran out are done (groups and other ids that never batch would else stay "due")
    for (const [id, until] of this.held) if (now >= until) this.held.delete(id);
    // a hot entity's parts leave too (one part of a repeat changed: the whole repeat is live now)
    for (const [part, m] of this.members) if (!seen.has(part) || this.hot.has(m.id)) this.leave(m);
    this.flush();
  }

  /** Take `obj` and everything under it out of the batches for good (it is about to be animated). */
  pin(obj: THREE.Object3D) {
    this.takeOut(obj, (id) => this.hot.add(id));
  }

  /**
   * Hold `obj` and everything under it out of the batches (page code is about to move it or change
   * its materials): back after holdMs without another hold, watched every frame from then on.
   */
  hold(obj: THREE.Object3D) {
    const until = this.clock() + this.holdMs;
    this.takeOut(obj, (id) => {
      this.held.set(id, until);
      this.watched.add(id);
    });
  }

  private takeOut(obj: THREE.Object3D, mark: (id: string) => void) {
    const ids = new Set<string>();
    obj.traverse((o) => {
      const id = o.userData.teraId as string | undefined;
      if (typeof id === "string" && !this.hot.has(id)) {
        mark(id);
        ids.add(id);
      }
    });
    let any = false;
    for (const m of [...this.members.values()]) if (ids.has(m.id)) { this.leave(m); any = true; }
    if (any) this.flush();
  }

  /**
   * Every frame (world matrices up to date): a watched member that moved goes hot, one whose
   * material was swapped is held again; both leave before the frame is drawn. True when a hold
   * ran out (the engine then syncs the batches, which takes them back in).
   */
  tick(): boolean {
    if (!this.watched.size) return false;
    let any = false;
    for (const m of [...this.members.values()]) {
      if (!this.watched.has(m.id)) continue;
      if (!sameMatrix(m.matrix, m.mesh.matrixWorld) || !worldVisible(m.mesh)) this.hot.add(m.id);
      else if (m.mesh.material !== m.mat) this.held.set(m.id, this.clock() + this.holdMs);
      else continue;
      this.leave(m);
      any = true;
    }
    if (any) this.flush();
    const now = this.clock();
    for (const until of this.held.values()) if (now >= until) return true;
    return false;
  }

  /** Is this object a batched original (drawn by its batch)? */
  static batched(o: THREE.Object3D): boolean {
    return o.userData.teraBatched === true;
  }

  /** The members' own box of a batch mesh (null: not a batch mesh). */
  static casterBox(o: THREE.Object3D): THREE.Box3 | null {
    return (o.userData.teraCasterBox as THREE.Box3 | undefined) ?? null;
  }

  private leave(m: Member) {
    this.members.delete(m.part);
    m.batch.members.delete(m);
    m.mesh.layers.mask = m.mask;
    m.mesh.matrixAutoUpdate = m.autoUpdate;
    m.mesh.matrixWorldNeedsUpdate = true;
    delete m.mesh.userData.teraBatched;
    this.dirty.add(m.batch);
  }

  private flush() {
    for (const b of this.dirty) {
      if (b.mesh) {
        this.hooks.removed?.(b.mesh);
        b.mesh.removeFromParent();
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        b.mesh = null;
      }
      if (!b.members.size) {
        this.batches.delete(b.key);
        continue;
      }
      const list = [...b.members].sort((x, y) => (x.part < y.part ? -1 : x.part > y.part ? 1 : 0));
      const sample = list[0]!;
      const mesh = new THREE.Mesh(bakeGeometry(list.map((m) => m.mesh), list.map((m) => m.tint)), sample.material());
      mesh.castShadow = sample.mesh.castShadow;
      mesh.receiveShadow = sample.mesh.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.raycast = () => {};
      mesh.name = `batch:${b.key}`;
      b.casterBox.makeEmpty();
      for (const m of list) b.casterBox.union(_box.setFromObject(m.mesh));
      mesh.userData.teraCasterBox = b.casterBox;
      mesh.userData.teraNoCollide = true;
      b.mesh = mesh;
      this.root.add(mesh);
      this.hooks.added?.(mesh);
    }
    this.dirty.clear();
  }

  dispose() {
    for (const m of [...this.members.values()]) this.leave(m);
    this.flush();
  }
}
