// Player avatars (live viewer only): a friendly, human-sized figure — round head with a face,
// a soft cap and a bean body in the player's colour, arms and legs that swing with the walk —
// clearly not one of the little worker robots (no visor, no antenna, twice their height).
// Name tags are small DOM labels over the head: crisp at any zoom, at most 8 shown (the
// nearest), fading out with distance, hidden behind the camera. docs/players.md.
import * as THREE from "three";
import type { V3 } from "./flight.ts";
import { tagOpacity, visibleTags } from "./players.ts";

export const AVATAR_HEIGHT = 1.62; // m

const SKIN = "#f1dcc4";
const INK = "#2b2a28";
const SHOE = "#3b3a37";

interface Rig {
  root: THREE.Group;
  body: THREE.Group; // everything above the hips (leans when flying)
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  head: THREE.Object3D;
  mats: THREE.Material[];
}

let shared: {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  pom: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  cheek: THREE.BufferGeometry;
  limb: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  skin: THREE.Material;
  ink: THREE.Material;
  shoeMat: THREE.Material;
  cheekMat: THREE.Material;
} | null = null;

function geos() {
  if (shared) return shared;
  const torso = new THREE.CapsuleGeometry(0.24, 0.36, 8, 24);
  torso.scale(1, 1, 0.82);
  const head = new THREE.SphereGeometry(0.2, 28, 20);
  const cap = new THREE.SphereGeometry(0.212, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.42);
  const pom = new THREE.SphereGeometry(0.055, 14, 10);
  const eye = new THREE.CapsuleGeometry(0.022, 0.03, 4, 10);
  const cheek = new THREE.CircleGeometry(0.034, 16);
  const limb = new THREE.CapsuleGeometry(0.075, 0.34, 6, 14);
  limb.translate(0, -0.245, 0); // pivot at the hip
  const arm = new THREE.CapsuleGeometry(0.058, 0.3, 6, 12);
  arm.translate(0, -0.2, 0); // pivot at the shoulder
  const shoe = new THREE.SphereGeometry(0.09, 14, 10);
  shoe.scale(1, 0.55, 1.45);
  const std = (color: string, rough = 0.7) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
  shared = {
    torso, head, cap, pom, eye, cheek, limb, arm, shoe,
    skin: std(SKIN, 0.62), ink: std(INK, 0.4), shoeMat: std(SHOE, 0.8),
    cheekMat: new THREE.MeshBasicMaterial({ color: "#f3a59a", transparent: true, opacity: 0.55, depthWrite: false }),
  };
  return shared;
}

function buildRig(color: string): Rig {
  const g = geos();
  const tint = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: 0.75, metalness: 0 });
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = false;
    return m;
  };
  const root = new THREE.Group();
  root.userData.teraPlayer = true;
  const hipY = 0.66;
  const body = new THREE.Group();
  body.position.y = hipY;
  root.add(body);

  const torso = mesh(g.torso, tint);
  torso.position.y = 0.36;
  body.add(torso);

  const head = new THREE.Group();
  head.position.y = 0.36 + 0.42 + 0.06;
  body.add(head);
  head.add(mesh(g.head, g.skin));
  const cap = mesh(g.cap, dark);
  cap.rotation.x = -0.12;
  head.add(cap);
  const pom = mesh(g.pom, dark);
  pom.position.set(0, 0.205, -0.02);
  head.add(pom);
  for (const s of [-1, 1]) {
    const eye = mesh(g.eye, g.ink, false);
    eye.position.set(0.07 * s, 0.01, 0.185);
    head.add(eye);
    const cheek = mesh(g.cheek, g.cheekMat, false);
    cheek.position.set(0.115 * s, -0.055, 0.164);
    cheek.rotation.y = 0.55 * s;
    head.add(cheek);
  }

  const legL = new THREE.Group(), legR = new THREE.Group();
  for (const [leg, s] of [[legL, -1], [legR, 1]] as const) {
    leg.position.set(0.1 * s, hipY, 0);
    leg.add(mesh(g.limb, dark));
    const shoe = mesh(g.shoe, g.shoeMat);
    shoe.position.set(0, -0.6, 0.04);
    leg.add(shoe);
    root.add(leg);
  }
  const armL = new THREE.Group(), armR = new THREE.Group();
  for (const [arm, s] of [[armL, -1], [armR, 1]] as const) {
    arm.position.set(0.252 * s, 0.6, 0);
    arm.rotation.z = 0.1 * s;
    arm.add(mesh(g.arm, tint));
    const hand = mesh(g.pom, g.skin);
    hand.scale.setScalar(1.15);
    hand.position.y = -0.42;
    arm.add(hand);
    body.add(arm);
  }
  return { root, body, legL, legR, armL, armR, head, mats: [tint, dark] };
}

export interface AvatarPose {
  position: V3;
  heading: number; // degrees
  mode: "walk" | "fly" | "orbit";
  speed: number; // m/s, drives the walk cycle
  pitch?: number; // radians (flying: lean into the climb / dive)
}

class Avatar {
  rig: Rig;
  phase = 0;
  lean = 0;
  tag: HTMLElement | null = null;
  id: string;
  name: string;
  color: string;
  private readonly reduced: boolean;
  constructor(id: string, name: string, color: string, reduced: boolean) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.reduced = reduced;
    this.rig = buildRig(color);
  }
  pose(p: AvatarPose, dt: number, t: number) {
    const r = this.rig;
    r.root.position.set(p.position[0], p.position[1], p.position[2]);
    r.root.rotation.y = (p.heading * Math.PI) / 180;
    const flying = p.mode === "fly";
    const walk = Math.min(1, p.speed / 3);
    if (!this.reduced) this.phase += dt * (flying ? 2 : 1.6 + 2.2 * Math.min(2, p.speed / 2.5)) * Math.PI;
    const swing = this.reduced ? 0 : Math.sin(this.phase) * 0.62 * walk;
    const targetLean = flying ? 0.5 + 0.3 * Math.min(1, p.speed / 10) : 0.06 * walk;
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-6 * dt));
    r.body.rotation.x = this.lean * (flying ? 0.9 : 1);
    r.legL.rotation.x = flying ? this.lean * 0.6 : swing;
    r.legR.rotation.x = flying ? this.lean * 0.6 + 0.25 : -swing;
    // flying: arms out like a glider; walking: swing opposite the legs; standing: a little breath
    const breathe = this.reduced ? 0 : Math.sin(t * 1.7 + this.id.length) * 0.03;
    r.armL.rotation.x = flying ? -0.3 : -swing * 0.8;
    r.armR.rotation.x = flying ? -0.3 : swing * 0.8;
    r.armL.rotation.z = flying ? -1.15 : -0.1 - breathe;
    r.armR.rotation.z = flying ? 1.15 : 0.1 + breathe;
    const bob = this.reduced ? 0 : flying ? Math.sin(t * 2.2) * 0.04 : Math.abs(Math.sin(this.phase)) * 0.045 * walk;
    r.body.position.y = 0.66 + bob;
    r.head.rotation.x = flying ? -this.lean * 0.7 : 0;
  }
  dispose() {
    this.rig.root.removeFromParent();
    for (const m of this.rig.mats) m.dispose();
    this.tag?.remove();
  }
}

/** All avatars in the scene (the local player's too) and their name tags. */
export class Avatars {
  private list = new Map<string, Avatar>();
  private tags: HTMLElement;
  private group = new THREE.Group();
  private t = 0;
  private reduced: boolean;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private canvasOf: () => HTMLCanvasElement | null;
  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvasOf: () => HTMLCanvasElement | null, parent: HTMLElement | null) {
    this.scene = scene;
    this.camera = camera;
    this.canvasOf = canvasOf;
    this.reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.group.name = "tera-players";
    scene.add(this.group);
    this.tags = document.createElement("div");
    this.tags.className = "tv-tags";
    this.tags.setAttribute("aria-hidden", "true");
    (parent ?? document.body).appendChild(this.tags);
  }

  has(id: string) { return this.list.has(id); }
  ids() { return [...this.list.keys()]; }

  upsert(id: string, name: string, color: string, local = false) {
    let a = this.list.get(id);
    if (a && a.color !== color) { a.dispose(); this.list.delete(id); a = undefined; }
    if (!a) {
      a = new Avatar(id, name, color, this.reduced);
      this.group.add(a.rig.root);
      if (!local) {
        const tag = document.createElement("span");
        tag.className = "tv-tag-name";
        tag.style.setProperty("--c", color);
        a.tag = tag;
        this.tags.appendChild(tag);
      }
      this.list.set(id, a);
    }
    a.name = name;
    if (a.tag && a.tag.textContent !== name) a.tag.textContent = name;
    // the group is re-added if a world reload cleared the scene
    if (!this.group.parent) this.scene.add(this.group);
  }

  remove(id: string) {
    this.list.get(id)?.dispose();
    this.list.delete(id);
  }

  clear() { for (const id of [...this.list.keys()]) this.remove(id); }

  setVisible(id: string, on: boolean) {
    const a = this.list.get(id);
    if (a) a.rig.root.visible = on;
  }

  pose(id: string, p: AvatarPose, dt: number) {
    this.list.get(id)?.pose(p, dt, this.t);
  }

  /** Per frame, after poses: advance the clock and place the name tags. */
  frame(dt: number) {
    this.t += dt;
    const canvas = this.canvasOf();
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cam = this.camera;
    const v = new THREE.Vector3();
    const near: { id: string; dist: number }[] = [];
    for (const a of this.list.values()) {
      if (!a.tag) continue;
      if (!a.rig.root.visible) { a.tag.style.opacity = "0"; continue; }
      near.push({ id: a.id, dist: cam.position.distanceTo(a.rig.root.position) });
    }
    const show = visibleTags(near, 8);
    for (const { id, dist } of near) {
      const a = this.list.get(id)!;
      const tag = a.tag!;
      if (!show.has(id)) { tag.style.opacity = "0"; continue; }
      v.copy(a.rig.root.position);
      v.y += AVATAR_HEIGHT + 0.28;
      v.project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { tag.style.opacity = "0"; continue; }
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      // smaller far away, never bigger than 1 (CSS px of the base font)
      const s = Math.max(0.72, Math.min(1, 9 / Math.max(1, dist)));
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${s.toFixed(3)})`;
      tag.style.opacity = tagOpacity(dist).toFixed(3);
    }
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
    this.tags.remove();
  }
}
