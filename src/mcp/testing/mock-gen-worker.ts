// Mock gen worker (CONTRACT section 7) for tests and the eval. Jobs finish after a few
// polls and return a tiny valid GLB (image_to_model) or PLY (image_to_splat).
// A prompt or image containing "fail" makes the job fail.
//   node src/mcp/testing/mock-gen-worker.ts [port]
import { createServer, type Server } from "node:http";

export function tinyGlb(): Buffer {
  let json = JSON.stringify({ asset: { version: "2.0", generator: "tera-mock" }, scenes: [{ nodes: [] }], scene: 0 });
  while (json.length % 4) json += " ";
  const j = Buffer.from(json);
  const head = Buffer.alloc(20);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.write("JSON", 16, "latin1");
  return Buffer.concat([head, j]);
}

export function tinyPly(): Buffer {
  return Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n");
}

export interface MockWorker {
  url: string;
  server: Server;
  jobs: Map<string, { kind: string; polls: number; fail: boolean; input: unknown }>;
  close(): Promise<void>;
}

export async function startMockWorker(port = 0, pollsToFinish = 2): Promise<MockWorker> {
  const jobs: MockWorker["jobs"] = new Map();
  let n = 0;
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/v1/health")
      return send(200, { ok: true, models: [{ kind: "image_to_model", name: "mock-trellis", license: "MIT" }, { kind: "image_to_splat", name: "mock-lyra", license: "test-only" }] });
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      let raw = "";
      for await (const c of req) raw += c;
      let body: { kind?: string; input?: { image?: string; prompt?: string } };
      try { body = JSON.parse(raw); } catch { return send(400, { error: "bad json" }); }
      if (!body.kind || !["image_to_splat", "image_to_model", "text_to_motion"].includes(body.kind)) return send(400, { error: "bad kind" });
      const id = `j_${++n}`;
      const text = `${body.input?.prompt ?? ""} ${(body.input?.image ?? "").slice(0, 200)}`;
      jobs.set(id, { kind: body.kind, polls: 0, fail: /fail/.test(text), input: body.input });
      return send(200, { id });
    }
    const m = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]!);
      if (!job) return send(404, { error: "no such job" });
      job.polls++;
      if (job.polls < pollsToFinish) return send(200, { id: m[1], status: job.polls === 1 ? "queued" : "running", progress: job.polls / pollsToFinish });
      if (job.fail) return send(200, { id: m[1], status: "failed", error: "mock failure requested" });
      const ext = job.kind === "image_to_splat" ? "ply" : "glb";
      return send(200, { id: m[1], status: "done", progress: 1, outputs: [{ url: `/files/${m[1]}.${ext}`, format: ext }] });
    }
    const f = url.pathname.match(/^\/files\/(j_\d+)\.(glb|ply)$/);
    if (req.method === "GET" && f) return send(200, f[2] === "glb" ? tinyGlb() : tinyPly(), "application/octet-stream");
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${p}`, server, jobs, close: () => new Promise((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await startMockWorker(Number(process.argv[2] ?? 8794));
  console.error(`mock gen worker on ${w.url}`);
}
