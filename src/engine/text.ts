// Text entities: the string is drawn into a canvas texture and shown on a plane (or a
// camera-facing sprite when `billboard`). Plain textures and basic materials work the
// same on WebGPU and WebGL.
import * as THREE from "three";

const FONT_PX = 160;
const FONT = `600 ${FONT_PX}px "Inter", "Helvetica Neue", "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
const LINE = 1.18;

export interface TextSpec {
  text: string;
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  billboard?: boolean;
}

/**
 * Build a text object. `size` is the em size in metres (capital letters are ~0.7 of
 * it). The entity position is the anchor: the left / centre / right end of the text
 * by `align`, vertically centred.
 */
export function buildText(spec: TextSpec): THREE.Object3D {
  const lines = spec.text.split("\n");
  const pad = Math.round(FONT_PX * 0.25);
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = FONT;
  const widths = lines.map((l) => Math.ceil(measure.measureText(l).width));
  const w = Math.max(8, ...widths) + pad * 2;
  const lineH = Math.round(FONT_PX * LINE);
  const h = lines.length * lineH + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.font = FONT;
  ctx.fillStyle = spec.color ?? "#ffffff";
  ctx.textBaseline = "middle";
  const align = spec.align ?? "center";
  ctx.textAlign = align;
  const x = align === "left" ? pad : align === "right" ? w - pad : w / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, pad + lineH * (i + 0.5)));

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.premultiplyAlpha = false;

  const m = (spec.size ?? 1) / FONT_PX; // metres per pixel
  const ww = w * m, hh = h * m;
  const anchorX = align === "left" ? 0 : align === "right" ? 1 : 0.5;
  // Pull the pad out so the anchor sits on the glyphs, not the canvas edge.
  const padShift = align === "left" ? -pad * m : align === "right" ? pad * m : 0;

  let content: THREE.Object3D;
  if (spec.billboard) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(anchorX, 0.5);
    sprite.scale.set(ww, hh, 1);
    sprite.position.x = padShift;
    content = sprite;
  } else {
    const geo = new THREE.PlaneGeometry(ww, hh);
    geo.translate((0.5 - anchorX) * ww + padShift, 0, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false });
    content = new THREE.Mesh(geo, mat);
  }
  content.renderOrder = 10;
  const g = new THREE.Group();
  g.add(content);
  return g;
}
