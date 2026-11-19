// The page host — CONTRACT.md section 5a. One helper that serves the built engine plus a
// world folder from a local static server and drives it in headless Chrome, so the render
// CLI and the MCP server share one implementation.
//
// GPU flags (verified on Linux + a desktop AMD GPU (Vulkan), Chrome 155, new headless):
//   --use-angle=vulkan --enable-features=Vulkan   real GPU for WebGL2 (ANGLE on RADV) and WebGPU
//   --enable-unsafe-webgpu --ignore-gpu-blocklist  expose WebGPU on Linux
// Without --use-angle=vulkan Chrome falls back to SwiftShader (CPU). Do NOT add
// --disable-vulkan-surface: it removes the WebGPU adapter. WebGPU also needs a secure
// context, which http://127.0.0.1 is. Override with TERA_CHROME_FLAGS (space separated)
// and pick a browser with TERA_CHROME (path) — default is the installed Chrome channel.
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { TeraBridge } from "../bridge/types.ts";

export interface OpenOptions {
  worldDir?: string;
  width?: number;
  height?: number;
  renderer?: "auto" | "webgpu" | "webgl2";
  mode?: "render" | "live";
  headless?: boolean;
  /** Static server port; default a random free port. */
  port?: number;
  /** Per bridge call timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Rebuild dist/ even if it looks fresh. */
  rebuild?: boolean;
  /** Render mode: "fit" sizes actor name tags like the live viewer (`?labels=fit`). */
  labels?: "fit";
}

export interface TeraPage {
  bridge: TeraBridge;
  png(): Promise<Buffer>;
  close(): Promise<void>;
  /** Extras beyond contract 5a: the page URL, the static server origin and the Playwright page. */
  url: string;
  origin: string;
  page: Page;
}

export const GPU_FLAGS = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(REPO_ROOT, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".hdr": "application/octet-stream", ".exr": "application/octet-stream",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".ktx2": "image/ktx2",
  ".spz": "application/octet-stream", ".ply": "application/octet-stream", ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ttf": "font/ttf",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function newestMtime(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const name of readdirSync(p)) if (!name.endsWith(".test.ts")) m = Math.max(m, newestMtime(join(p, name)));
  return m;
}

/** Build dist/ with Vite when it is missing or older than the engine sources. */
export function ensureBuilt(force = false): void {
  const built = existsSync(join(DIST, "index.html")) ? statSync(join(DIST, "index.html")).mtimeMs : 0;
  const src = Math.max(
    ...["src/engine", "src/camera", "src/schema", "src/bridge", "index.html", "vite.config.ts", "package.json"].map((p) => newestMtime(join(REPO_ROOT, p))),
  );
  if (!force && built && built >= src) return;
  const vite = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--logLevel", "warn"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tera: vite build failed:\n${r.stdout}${r.stderr}`);
}

function safeJoin(root: string, urlPath: string): string | null {
  const p = normalize(join(root, decodeURIComponent(urlPath)));
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep) ? p : null;
}

/** Static server: dist/ at /, worldDir at /world/. */
export function startStaticServer(worldDir: string | undefined, port = 0, host = "127.0.0.1"): Promise<{ server: http.Server; origin: string }> {
  const world = worldDir ? resolve(worldDir) : undefined;
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let file: string | null;
    if (path.startsWith("/world/")) file = world ? safeJoin(world, path.slice("/world/".length)) : null;
    else file = safeJoin(DIST, path === "/" ? "index.html" : path.slice(1));
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${path}`);
      return;
    }
    const headers = {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "accept-ranges": "bytes",
    };
    // byte ranges: <video> (screens) needs them to seek
    const size = statSync(file).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const a = server.address();
      ok({ server, origin: `http://${host}:${typeof a === "object" && a ? a.port : port}` });
    });
  });
}

export function chromeArgs(): string[] {
  return process.env.TERA_CHROME_FLAGS ? process.env.TERA_CHROME_FLAGS.split(/\s+/).filter(Boolean) : GPU_FLAGS;
}

export async function launchChrome(headless = true): Promise<Browser> {
  const exe = process.env.TERA_CHROME;
  try {
    return await chromium.launch({ ...(exe ? { executablePath: exe } : { channel: "chrome" }), headless, args: chromeArgs() });
  } catch (err) {
    throw new Error(`tera: could not start Chrome (${exe ?? "channel chrome"}). Install Google Chrome or set TERA_CHROME.\n${(err as Error).message}`);
  }
}

const METHODS = ["load", "apply", "get", "setCamera", "setSize", "loadScript", "seek", "render", "bounds", "capture", "info"] as const;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`tera: ${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export async function openTera(opts: OpenOptions = {}): Promise<TeraPage> {
  const width = opts.width ?? 1280, height = opts.height ?? 720, mode = opts.mode ?? "render", timeoutMs = opts.timeoutMs ?? 30_000;
  ensureBuilt(opts.rebuild);
  const { server, origin } = await startStaticServer(opts.worldDir, opts.port);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome(opts.headless ?? true);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    const q = new URLSearchParams({ mode, renderer: opts.renderer ?? "auto" });
    if (mode === "live" && opts.worldDir) q.set("world", "/world/world.json");
    if (opts.labels === "fit") q.set("labels", "fit");
    const url = `${origin}/?${q}`;
    await page.goto(url);
    await page.waitForFunction(() => !!window.tera, undefined, { timeout: timeoutMs }).catch(() => {
      throw new Error(`tera: engine page never exposed window.tera at ${url}${errors.length ? `\n${errors.join("\n")}` : ""}`);
    });

    const gfx = await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return {
        webgl2: !!document.createElement("canvas").getContext("webgl2"),
        webgpu: !!(gpu && (await gpu.requestAdapter().catch(() => null))),
      };
    });
    if (opts.renderer === "webgpu" && !gfx.webgpu) throw new Error("tera: WebGPU is not available in this Chrome (no adapter). Try --renderer webgl2.");
    if (!gfx.webgl2 && !gfx.webgpu) throw new Error("tera: neither WebGL2 nor WebGPU is available in this Chrome.");

    const call = (m: string, args: unknown[]) =>
      withTimeout(
        page.evaluate(
          ([m, args]) => (window.tera as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m as string]!(...(args as unknown[])),
          [m, args] as const,
        ),
        timeoutMs,
        `bridge.${m}(${args.length && typeof args[0] !== "object" ? JSON.stringify(args[0]) : ""})`,
      ).catch((err: Error) => {
        const extra = errors.splice(0).join("\n");
        throw new Error(extra ? `${err.message}\npage errors:\n${extra}` : err.message);
      });
    const bridge: Record<string, unknown> = { version: "bridge/v1" };
    for (const m of METHODS) bridge[m] = (...args: unknown[]) => call(m, args);
    const tera = bridge as unknown as TeraBridge;

    await tera.setSize(width, height);
    if (opts.worldDir) {
      const world = JSON.parse(readFileSync(join(resolve(opts.worldDir), "world.json"), "utf8"));
      await tera.load(world, `${origin}/world/`);
    }

    let closed = false;
    const b = browser;
    return {
      bridge: tera,
      url,
      origin,
      page,
      async png() {
        return Buffer.from(await tera.capture(), "base64");
      },
      async close() {
        if (closed) return;
        closed = true;
        await b.close().catch(() => {});
        await new Promise<void>((ok) => server.close(() => ok()));
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    server.close();
    throw err;
  }
}
