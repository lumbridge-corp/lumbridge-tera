// Screens without three.js (pure, runs in Node): the screen spec with its defaults, the face
// aspect, cover-fit texture transforms, thumbnail URLs and the youtube card layout.
// The drawing lives in screen.ts; CONTRACT.md section 1 "Screens".
import type { ScreenContent, ScreenSpec } from "../schema/index.ts";

export const SCREEN_DEFAULTS = { glare: 0.3, brightness: 0.9 } as const;

export interface ResolvedScreen {
  content: ScreenContent;
  glare: number;
  brightness: number;
  youtubeThumb?: string;
}

/** material.screen (true or a spec) with its defaults; no content = off. */
export function resolveScreen(s: true | ScreenSpec): ResolvedScreen {
  const spec = s === true ? {} : s;
  return {
    content: spec.content ?? { kind: "off" },
    glare: spec.glare ?? SCREEN_DEFAULTS.glare,
    brightness: spec.brightness ?? SCREEN_DEFAULTS.brightness,
    ...(spec.youtubeThumb ? { youtubeThumb: spec.youtubeThumb } : {}),
  };
}

/** Width / height of the face that shows the picture: a box's +Z face (x by y), a plane's +Y face (x by z). */
export function faceAspect(shape: string, size: number[] | undefined): number {
  const s = size ?? [];
  if (shape === "plane") {
    const w = s[0] ?? 10;
    return w / (s[1] ?? w);
  }
  const w = s[0] ?? 1;
  return w / (s[1] ?? w);
}

/**
 * Texture repeat + offset that fills a face of aspect `face` with a picture of aspect `src`
 * without stretching (cover: the overflow is cropped evenly on both sides).
 */
export function coverFit(src: number, face: number): { repeat: [number, number]; offset: [number, number] } {
  if (!(src > 0) || !(face > 0)) return { repeat: [1, 1], offset: [0, 0] };
  if (src > face) {
    const rx = face / src;
    return { repeat: [rx, 1], offset: [(1 - rx) / 2, 0] };
  }
  const ry = src / face;
  return { repeat: [1, ry], offset: [0, (1 - ry) / 2] };
}

/** Where to draw a picture of size sw x sh so it covers a dw x dh canvas (centred crop). */
export function coverRect(sw: number, sh: number, dw: number, dh: number): { x: number; y: number; w: number; h: number } {
  const k = Math.max(dw / sw, dh / sh);
  const w = sw * k, h = sh * k;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/** The thumbnail URL of youtube content: its own `thumb`, else the screen's template with `{id}` filled in. */
export function youtubeThumbUrl(c: Extract<ScreenContent, { kind: "youtube" }>, template?: string): string | null {
  if (c.thumb) return c.thumb;
  if (!template) return null;
  return template.split("{id}").join(encodeURIComponent(c.videoId));
}

export type Measure = (text: string, px: number) => number;

/** Greedy word wrap into at most `maxLines` lines no wider than `maxW`; the last line ends in "…" when text is left over. */
export function wrapLines(text: string, maxW: number, maxLines: number, px: number, measure: Measure): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i]!;
    i++;
    while (i < words.length && measure(`${line} ${words[i]}`, px) <= maxW) line += ` ${words[i++]}`;
    lines.push(line);
  }
  const fit = (s: string) => {
    let t = s;
    while (t.length > 1 && measure(`${t}…`, px) > maxW) t = t.slice(0, -1).trimEnd();
    return `${t}…`;
  };
  if (lines.length) {
    const last = lines.length - 1;
    if (i < words.length) lines[last] = fit(lines[last]!);
    else if (measure(lines[last]!, px) > maxW) lines[last] = fit(lines[last]!); // one very long word
  }
  return lines;
}

/** Two lines that fit: move the break so the lines are as even as possible (no lonely last word). */
export function balanceLines(lines: string[], maxW: number, px: number, measure: Measure): string[] {
  if (lines.length !== 2 || lines[1]!.endsWith("…")) return lines;
  const words = `${lines[0]} ${lines[1]}`.split(" ");
  let best = lines, bestW = Math.max(measure(lines[0]!, px), measure(lines[1]!, px));
  for (let k = words.length - 1; k >= 1; k--) { // from the longest first line: ties keep the top line longer
    const a = words.slice(0, k).join(" "), b = words.slice(k).join(" ");
    const wa = measure(a, px), wb = measure(b, px);
    if (wa <= maxW && wb <= maxW && Math.max(wa, wb) < bestW - 1e-9) { best = [a, b]; bestW = Math.max(wa, wb); }
  }
  return best;
}

export interface CardLayout {
  pad: number;
  /** Top of the dark gradient that carries the text (canvas px from the top). */
  shadeTop: number;
  badge: { kind: "live" | "playing" | "paused"; x: number; y: number; h: number; px: number } | null;
  title: { lines: string[]; px: number; x: number; y: number; lineH: number } | null;
  channel: { text: string; px: number; x: number; y: number } | null;
}

/**
 * The youtube card on a w x h canvas: a badge top-left (LIVE, or a play / pause mark), the
 * title (up to two lines) and the channel along the bottom over a soft dark gradient.
 * Sizes scale with the canvas height so a 16:9 and a 21:9 screen look alike. y values are
 * text baselines ("alphabetic").
 */
export function cardLayout(w: number, h: number, c: Extract<ScreenContent, { kind: "youtube" }>, measure: Measure): CardLayout {
  const pad = Math.round(h * 0.075);
  const titlePx = Math.round(h * 0.068);
  const chanPx = Math.round(h * 0.046);
  const maxW = w - pad * 2;
  const lines = c.title ? balanceLines(wrapLines(c.title, maxW, 2, titlePx, measure), maxW, titlePx, measure) : [];
  const lineH = Math.round(titlePx * 1.22);
  let y = h - pad;
  const channel = c.channel ? { text: wrapLines(c.channel, maxW, 1, chanPx, measure)[0] ?? "", px: chanPx, x: pad, y } : null;
  if (channel) y -= Math.round(chanPx * 1.65);
  const title = lines.length ? { lines, px: titlePx, x: pad, y: y - (lines.length - 1) * lineH, lineH } : null;
  const textTop = title ? title.y - titlePx * 1.1 : channel ? channel.y - chanPx * 1.1 : h;
  const shadeTop = Math.max(0, Math.min(h * 0.55, textTop - h * 0.18));
  const bh = Math.round(h * 0.075);
  const kind = c.live ? "live" : c.playing === undefined ? null : c.playing ? "playing" : "paused";
  return {
    pad,
    shadeTop: title || channel ? shadeTop : h,
    badge: kind ? { kind, x: pad, y: pad, h: bh, px: Math.round(bh * 0.52) } : null,
    title,
    channel,
  };
}

export interface PanelLayout {
  pad: number;
  title: { text: string; px: number; x: number; y: number } | null;
  subtitle: { text: string; px: number; x: number; y: number } | null;
  /** The status pill (right-aligned at the top): box + dot + text. */
  status: { text: string; px: number; x: number; y: number; w: number; h: number } | null;
  rows: { label: string; text: string; value: number | null; px: number; y: number; labelX: number; bar: { x: number; y: number; w: number; h: number }; textX: number }[];
  /** The sparkline box (bottom band), or null. */
  series: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The `panel` screen content on a w x h canvas: title + subtitle top left, a status pill top
 * right, rows (label | bar | value) in the middle, a sparkline along the bottom. Sizes scale
 * with the canvas height; text is fitted with an ellipsis, never wrapped. Text y values are
 * baselines ("alphabetic"); boxes are top-left + size.
 */
export function panelLayout(w: number, h: number, c: Extract<ScreenContent, { kind: "panel" }>, measure: Measure): PanelLayout {
  const pad = Math.round(Math.min(w, h) * 0.075);
  const inner = w - pad * 2;
  const fit = (text: string, px: number, maxW: number) => wrapLines(text, maxW, 1, px, measure)[0] ?? "";
  let y = pad;
  const titlePx = Math.round(h * 0.085);
  const subPx = Math.round(h * 0.05);
  let status: PanelLayout["status"] = null;
  if (c.status) {
    const px = Math.round(h * 0.048);
    const text = fit(c.status, px, inner * 0.4);
    const sh = Math.round(px * 1.75);
    const sw = Math.round(measure(text, px) + px * 2.4);
    status = { text, px, x: w - pad - sw, y: pad, w: sw, h: sh };
  }
  const titleMax = inner - (status ? status.w + pad * 0.5 : 0);
  const title = c.title ? { text: fit(c.title, titlePx, titleMax), px: titlePx, x: pad, y: (y += titlePx) } : null;
  if (title) y += Math.round(titlePx * 0.25);
  const subtitle = c.subtitle ? { text: fit(c.subtitle, subPx, titleMax), px: subPx, x: pad, y: (y += Math.round(subPx * 1.25)) } : null;
  if (title || subtitle || status) y = Math.max(y, status ? status.y + status.h : 0) + Math.round(h * 0.06);
  const seriesH = c.series && c.series.length > 1 ? Math.round(h * 0.2) : 0;
  const series = seriesH ? { x: pad, y: h - pad - seriesH, w: inner, h: seriesH } : null;
  const bottom = series ? series.y - Math.round(h * 0.05) : h - pad;
  const list = c.rows ?? [];
  const rowH = list.length ? Math.max(0, Math.min(Math.round(h * 0.12), Math.floor((bottom - y) / list.length))) : 0;
  const rowPx = Math.round(rowH * 0.48);
  const labelW = Math.round(inner * 0.36), textW = Math.round(inner * 0.2), gap = Math.round(inner * 0.03);
  const rows = list.map((r, i) => {
    const top = y + i * rowH;
    const barH = Math.max(2, Math.round(rowH * 0.17));
    return {
      label: fit(r.label, rowPx, labelW),
      text: r.text ? fit(r.text, rowPx, textW) : "",
      value: r.value ?? null,
      px: rowPx,
      y: top + Math.round(rowH * 0.5 + rowPx * 0.36),
      labelX: pad,
      bar: { x: pad + labelW + gap, y: top + Math.round((rowH - barH) / 2), w: inner - labelW - textW - gap * 2, h: barH },
      textX: w - pad,
    };
  });
  return { pad, title, subtitle, status, rows, series };
}
