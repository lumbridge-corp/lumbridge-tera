// asset_import: copy a local file or download an http(s) URL into <world>/assets/.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { safeName } from "./paths.ts";

export const ASSET_EXTS = ["glb", "gltf", "spz", "ply", "splat", "ksplat", "hdr", "png", "jpg", "jpeg", "webp", "wav", "mp3"] as const;
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

export interface ImportOptions {
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

function checkExt(name: string) {
  const ext = extOf(name);
  if (!(ASSET_EXTS as readonly string[]).includes(ext))
    throw new Error(`file type ".${ext || "?"}" is not allowed — allowed: ${ASSET_EXTS.join(" ")}`);
}

function sameFile(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  const h = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return h(a) === h(b);
}

/** Pick assets/<name>, adding -1, -2… if a different file already has that name. */
function target(assetsDir: string, name: string, incoming?: string): { abs: string; existing: boolean } {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const n = i === 0 ? name : `${stem}-${i}${ext}`;
    const abs = join(assetsDir, n);
    if (!existsSync(abs)) return { abs, existing: false };
    if (incoming && sameFile(abs, incoming)) return { abs, existing: true };
  }
  throw new Error("too many files with that name");
}

/**
 * Import `src` (local path or http(s) URL) into `<worldDir>/assets/`. `as` renames the
 * file (a plain file name). Returns the path relative to the world folder.
 */
export async function importAsset(worldDir: string, src: string, as: string | undefined, opts: ImportOptions = {}): Promise<{ path: string; bytes: number; reused: boolean }> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const assetsDir = join(worldDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const isUrl = /^https?:\/\//i.test(src);
  let name: string;
  if (as) name = safeName(basename(as));
  else if (isUrl) name = safeName(decodeURIComponent(basename(new URL(src).pathname)) || "download");
  else name = safeName(basename(src));
  checkExt(name);

  if (!isUrl) {
    if (/^[a-z]+:/i.test(src) && !/^[a-z]:\\/i.test(src)) throw new Error(`only local paths and http(s) URLs can be imported (got "${src.slice(0, 40)}")`);
    const abs = resolve(src.startsWith("~/") ? join(process.env.HOME ?? "", src.slice(2)) : src);
    if (!existsSync(abs)) throw new Error(`no such file: ${abs}`);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`not a file: ${abs}`);
    if (st.size > max) throw new Error(`file is ${(st.size / 1e6).toFixed(1)} MB, over the ${(max / 1e6).toFixed(0)} MB limit`);
    checkExt(abs); // the source itself must be an allowed type; `as` only renames
    const t = target(assetsDir, name, abs);
    if (!t.existing) await copyFile(abs, t.abs);
    return { path: `assets/${basename(t.abs)}`, bytes: st.size, reused: t.existing };
  }

  const res = await (opts.fetchImpl ?? fetch)(src, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${src}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error(`download is ${(len / 1e6).toFixed(1)} MB, over the ${(max / 1e6).toFixed(0)} MB limit`);
  const tmp = join(assetsDir, `.part-${process.pid}-${Date.now()}-${name}`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > max) cb(new Error(`download passed the ${(max / 1e6).toFixed(0)} MB limit — aborted`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), limiter, createWriteStream(tmp));
    const t = target(assetsDir, name, tmp);
    if (t.existing) rmSync(tmp);
    else renameSync(tmp, t.abs);
    return { path: `assets/${basename(t.abs)}`, bytes, reused: t.existing };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
