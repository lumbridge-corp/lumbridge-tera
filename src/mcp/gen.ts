// Gen-worker HTTP client (CONTRACT section 7): submit a job, poll, return outputs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

export type GenKind = "image_to_splat" | "image_to_model" | "text_to_motion";

export interface GenJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress?: number;
  outputs?: { url: string; format: string }[];
  error?: string;
}

export const NO_WORKER =
  "No gen worker configured. Set TERA_GEN_URL to a gen worker's base URL (for example http://gpu-box:8874) in the MCP server's environment and restart it. Until then, import ready-made files with asset_import.";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** An image argument → what the worker accepts: an http(s) URL, or a data: URL. */
export function imageInput(image: string, resolveLocal: (p: string) => string): string {
  if (/^https?:\/\//i.test(image) || image.startsWith("data:")) return image;
  const abs = resolveLocal(image);
  if (!existsSync(abs)) throw new Error(`image not found: ${image}`);
  const mime = MIME[extname(abs).toLowerCase()];
  if (!mime) throw new Error(`image must be .png .jpg .jpeg or .webp (got ${extname(abs) || "no extension"})`);
  if (statSync(abs).size > 50 * 1024 * 1024) throw new Error("image is over 50 MB");
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

export interface RunOptions {
  pollMs?: number;
  timeoutMs?: number;
  onProgress?: (p: number, status: string) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`gen worker ${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`gen worker ${what}: not JSON: ${text.slice(0, 200)}`); }
}

export async function health(base: string, fetchImpl: typeof fetch = fetch) {
  return json<{ ok: boolean; models: { kind: string; name: string; license: string }[] }>(await fetchImpl(new URL("/v1/health", base)), "health");
}

export async function runJob(base: string, kind: GenKind, input: { image?: string; prompt?: string }, params: Record<string, unknown> | undefined, opts: RunOptions = {}): Promise<{ job: GenJob; outputs: { url: string; format: string }[] }> {
  const f = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000);
  let created: { id: string };
  try {
    created = await json<{ id: string }>(
      await f(new URL("/v1/jobs", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input, params: params ?? {} }), signal: opts.signal }),
      "submit",
    );
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.cause?.code === "ECONNREFUSED" || /fetch failed/.test(e.message)) throw new Error(`gen worker at ${base} is not reachable (${e.cause?.code ?? e.message})`);
    throw err;
  }
  if (!created.id) throw new Error("gen worker did not return a job id");
  for (;;) {
    const job = await json<GenJob>(await f(new URL(`/v1/jobs/${encodeURIComponent(created.id)}`, base), { signal: opts.signal }), "poll");
    await opts.onProgress?.(job.progress ?? (job.status === "done" ? 1 : 0), job.status);
    if (job.status === "done") {
      const outputs = (job.outputs ?? []).map((o) => ({ ...o, url: new URL(o.url, base).toString() }));
      if (!outputs.length) throw new Error(`gen job ${job.id} finished without outputs`);
      return { job, outputs };
    }
    if (job.status === "failed") throw new Error(`gen job ${job.id} failed: ${job.error ?? "no reason given"}`);
    if (Date.now() > deadline) throw new Error(`gen job ${job.id} still ${job.status} after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s — it keeps running on the worker`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const SPLAT = ["spz", "ply", "splat", "ksplat"];
const MODEL = ["glb", "gltf"];

/** Pick the output the engine can use for this kind. */
export function pickOutput(kind: GenKind, outputs: { url: string; format: string }[]) {
  const want = kind === "image_to_splat" ? SPLAT : MODEL;
  const fmt = (o: { url: string; format: string }) => (o.format || extname(new URL(o.url).pathname).slice(1)).toLowerCase().replace(/^\./, "");
  const hit = outputs.find((o) => want.includes(fmt(o)));
  if (!hit) throw new Error(`gen worker returned ${outputs.map(fmt).join(", ")}; need one of ${want.join(", ")}`);
  return { ...hit, format: fmt(hit) };
}
