// A fake Prometheus for the adapter tests: a real HTTP server on loopback that answers
// /api/v1/query and /api/v1/query_range from a table, understands the loop's batched
// `label_replace((q), "tera_binding", "id", "", "") or …` form, and records every request.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeSeries = { metric: Record<string, string>; value: number | string };
export type FakeAnswer = FakeSeries[] | { scalar: number } | { status: number; errorType?: string; error?: string } | { delayMs: number; then: FakeSeries[] } | { raw: string };

export interface FakeProm {
  url: string;
  table: Map<string, FakeAnswer>;
  requests: { path: string; method: string; query: string; headers: Record<string, string | string[] | undefined> }[];
  close(): Promise<void>;
}

const BATCH = /^label_replace\(\(([\s\S]*)\), "tera_binding", "([a-z0-9._-]+)", "", ""\)$/;

export async function fakeProm(entries: Record<string, FakeAnswer> = {}): Promise<FakeProm> {
  const table = new Map(Object.entries(entries));
  const requests: FakeProm["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const form = new URLSearchParams(body);
      const query = form.get("query") ?? "";
      const path = (req.url ?? "").split("?")[0]!;
      requests.push({ path, method: req.method ?? "", query, headers: req.headers });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      const now = Date.now() / 1000;
      if (path === "/api/v1/query_range") {
        const a = table.get(query);
        if (!a || !Array.isArray(a)) return send(400, { status: "error", errorType: "bad_data", error: "unknown" });
        return send(200, { status: "success", data: { resultType: "matrix", result: a.map((s) => ({ metric: s.metric, values: [[now - 60, String(s.value)], [now, String(s.value)]] })) } });
      }
      if (path !== "/api/v1/query") return send(404, { status: "error", errorType: "not_found" });
      const parts = query.split("\nor\n");
      const out: { metric: Record<string, string>; value: [number, string] }[] = [];
      for (const part of parts) {
        const m = parts.length > 1 ? BATCH.exec(part) : null;
        const q = m ? m[1]! : part;
        const a = table.get(q);
        if (a === undefined) return send(400, { status: "error", errorType: "bad_data", error: `parse error: unknown "${q}"` });
        if ("status" in a) return send(a.status, { status: "error", errorType: a.errorType ?? "internal", error: a.error ?? "boom https://secret.example/x" });
        if ("raw" in a) return send(200, a.raw);
        if ("scalar" in a) {
          if (m) return send(400, { status: "error", errorType: "bad_data", error: "expected type instant vector in call to function label_replace, got scalar" });
          return send(200, { status: "success", data: { resultType: "scalar", result: [now, String(a.scalar)] } });
        }
        let series: FakeSeries[];
        if ("delayMs" in a) {
          await new Promise((r) => setTimeout(r, a.delayMs));
          series = a.then;
        } else series = a;
        for (const s of series) out.push({ metric: m ? { ...s.metric, tera_binding: m[2]! } : s.metric, value: [now, String(s.value)] });
      }
      send(200, { status: "success", data: { resultType: "vector", result: out } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    table,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
