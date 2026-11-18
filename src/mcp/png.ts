// Tiny zero-dependency PNG decode/encode (8-bit, non-interlaced) plus a contact sheet
// composer with a 5x7 bitmap font for timestamps. Enough for frames Chrome gives us.
import { deflateSync, inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function decodePng(buf: Buffer): Image {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; ctype = body[9]!; interlace = body[12]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} not supported`);
  if (interlace) throw new Error("interlaced PNG not supported");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels) throw new Error(`PNG colour type ${ctype} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (ctype === 6) { data[o] = px[j]!; data[o + 1] = px[j + 1]!; data[o + 2] = px[j + 2]!; data[o + 3] = px[j + 3]!; }
    else if (ctype === 2) { data[o] = px[j]!; data[o + 1] = px[j + 1]!; data[o + 2] = px[j + 2]!; data[o + 3] = 255; }
    else if (ctype === 0) { data[o] = data[o + 1] = data[o + 2] = px[j]!; data[o + 3] = 255; }
    else if (ctype === 4) { data[o] = data[o + 1] = data[o + 2] = px[j]!; data[o + 3] = px[j + 1]!; }
    else {
      const k = px[j]!;
      data[o] = palette?.[k * 3] ?? 0; data[o + 1] = palette?.[k * 3 + 1] ?? 0; data[o + 2] = palette?.[k * 3 + 2] ?? 0;
      data[o + 3] = trns?.[k] ?? 255;
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(img: Image): Buffer {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())]);
}

export function blank(width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 255]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

/** Copy src into dst at (dx, dy), nearest-neighbour scaled to (w, h). */
export function blit(dst: Image, src: Image, dx: number, dy: number, w = src.width, h = src.height) {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const s = (sy * src.width + sx) * 4, d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s]!; dst.data[d + 1] = src.data[s + 1]!; dst.data[d + 2] = src.data[s + 2]!; dst.data[d + 3] = 255;
    }
  }
}

function fill(img: Image, x0: number, y0: number, w: number, h: number, rgba: [number, number, number, number]) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) img.data.set(rgba, (y * img.width + x) * 4);
}

// 5x7 glyphs, rows top→bottom, '#' = on.
const FONT: Record<string, string[]> = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
  s: ["     ", "     ", " ####", "#    ", " ### ", "    #", "#### "],
  t: ["  #  ", "  #  ", "#####", "  #  ", "  #  ", "  #  ", "   ##"],
  "=": ["     ", "     ", "#####", "     ", "#####", "     ", "     "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
};

export function drawText(img: Image, text: string, x: number, y: number, scale = 2, rgba: [number, number, number, number] = [255, 255, 255, 255]) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] ?? FONT[" "]!;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r]![c] === "#") fill(img, cx + c * scale, y + r * scale, scale, scale, rgba);
    cx += 6 * scale;
  }
  return cx - x;
}

/** Tile frames into one sheet, each labelled. All frames are drawn at the first frame's size. */
export function contactSheet(frames: { png: Buffer; label: string }[], cols?: number): Buffer {
  if (frames.length === 0) throw new Error("no frames");
  const imgs = frames.map((f) => decodePng(f.png));
  const w = imgs[0]!.width, h = imgs[0]!.height;
  const n = imgs.length;
  const c = Math.max(1, Math.min(n, cols ?? (n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4)));
  const rows = Math.ceil(n / c);
  const gap = 6;
  const sheet = blank(c * w + (c + 1) * gap, rows * h + (rows + 1) * gap, [16, 18, 24, 255]);
  imgs.forEach((im, i) => {
    const x = gap + (i % c) * (w + gap), y = gap + Math.floor(i / c) * (h + gap);
    blit(sheet, im, x, y, w, h);
    const scale = w >= 480 ? 3 : 2;
    const tw = frames[i]!.label.length * 6 * scale;
    fill(sheet, x, y, tw + 4 * scale, 7 * scale + 4 * scale, [0, 0, 0, 255]);
    drawText(sheet, frames[i]!.label, x + 2 * scale, y + 2 * scale, scale);
  });
  return encodePng(sheet);
}

/** Cheap image statistics for agent hints (blank frames, camera inside an object). */
export function imageStats(png: Buffer): { mean: number; std: number; distinct: number } {
  const im = decodePng(png);
  let sum = 0, sum2 = 0;
  const seen = new Set<number>();
  const n = im.width * im.height;
  const step = Math.max(1, Math.floor(n / 20000));
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    const l = 0.2126 * im.data[o]! + 0.7152 * im.data[o + 1]! + 0.0722 * im.data[o + 2]!;
    sum += l; sum2 += l * l; count++;
    seen.add(((im.data[o]! >> 3) << 10) | ((im.data[o + 1]! >> 3) << 5) | (im.data[o + 2]! >> 3));
  }
  const mean = sum / count;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / count - mean * mean)), distinct: seen.size };
}
