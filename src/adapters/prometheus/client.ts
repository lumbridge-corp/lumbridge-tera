// A small, read-only Prometheus HTTP API client (instant + range queries) for adapters.
//
// - Only two endpoints are ever called: POST /api/v1/query and POST /api/v1/query_range
//   (form-encoded, so long queries fit and stay out of access-log URLs).
// - Every call has a timeout, a response size cap and a series cap.
// - Failures of the server (network, timeout, 5xx, bad answers) back off exponentially: while
//   backing off, calls fail fast with kind "backoff" and touch nothing. A query Prometheus
//   rejects (4xx: bad PromQL) is the caller's problem and does not trip the backoff.
// - Errors never carry the URL, the headers or Prometheus's own message (which can echo label
//   values): only a kind, an HTTP status and Prometheus's errorType.

export type PromErrorKind = "config" | "http" | "timeout" | "parse" | "prometheus" | "limit" | "backoff";

export class PromError extends Error {
  readonly kind: PromErrorKind;
  readonly status: number | undefined;
  constructor(kind: PromErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PromError";
    this.kind = kind;
    this.status = status;
  }
}

/** One series of an instant vector (or a scalar, with no labels). */
export interface PromSample {
  labels: Record<string, string>;
  value: number;
  /** sample time, ms */
  ts: number;
}

/** One series of a range query. */
export interface PromSeries {
  labels: Record<string, string>;
  /** [ms, value] pairs, finite values only */
  values: [number, number][];
}

export interface InstantResult {
  type: "vector" | "scalar";
  samples: PromSample[];
}

export interface PromClientOptions {
  /** base URL, e.g. http://prometheus:9090 (http/https, no credentials in the URL) */
  url: string;
  timeoutMs?: number;
  /** most series one answer may carry (more = a "limit" error, nothing is returned) */
  maxSeries?: number;
  /** most bytes one answer may carry */
  maxBytes?: number;
  maxQueryLength?: number;
  backoff?: { baseMs?: number; maxMs?: number; jitter?: number };
  /** extra request headers (e.g. Authorization). Never logged, never in errors. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

/** What the binding loop needs from a client (tests use a fake). */
export interface PromQuerier {
  instant(query: string, o?: { time?: number; signal?: AbortSignal }): Promise<InstantResult>;
}

const DEF = { timeoutMs: 5000, maxSeries: 500, maxBytes: 2 * 1024 * 1024, maxQueryLength: 16_000, baseMs: 1000, maxMs: 60_000, jitter: 0.2 };

export class PromClient implements PromQuerier {
  private readonly base: string;
  private readonly o: Required<Omit<PromClientOptions, "url" | "headers" | "fetch" | "now" | "random" | "backoff">>;
  private readonly bo: { baseMs: number; maxMs: number; jitter: number };
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private failures = 0;
  private retryAt = 0;

  constructor(opts: PromClientOptions) {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      throw new PromError("config", "prometheus url is not a URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new PromError("config", "prometheus url must be http or https");
    if (u.username || u.password) throw new PromError("config", "no credentials in the prometheus url (use headers)");
    if (u.search || u.hash) throw new PromError("config", "prometheus url takes no query or fragment");
    this.base = u.href.replace(/\/+$/, "");
    this.o = {
      timeoutMs: opts.timeoutMs ?? DEF.timeoutMs,
      maxSeries: opts.maxSeries ?? DEF.maxSeries,
      maxBytes: opts.maxBytes ?? DEF.maxBytes,
      maxQueryLength: opts.maxQueryLength ?? DEF.maxQueryLength,
    };
    this.bo = { baseMs: opts.backoff?.baseMs ?? DEF.baseMs, maxMs: opts.backoff?.maxMs ?? DEF.maxMs, jitter: opts.backoff?.jitter ?? DEF.jitter };
    this.headers = { ...(opts.headers ?? {}) };
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Backoff state: consecutive server failures and when the next call may go out (ms, 0 = now). */
  health(): { failures: number; retryAt: number } {
    return { failures: this.failures, retryAt: this.retryAt };
  }

  async instant(query: string, o: { time?: number; signal?: AbortSignal } = {}): Promise<InstantResult> {
    const form: Record<string, string> = { query };
    if (o.time !== undefined) form.time = String(o.time / 1000);
    const data = await this.call("/api/v1/query", query, form, o.signal);
    const type = data.resultType;
    if (type === "scalar") {
      const s = sample(data.result, {});
      return { type: "scalar", samples: s ? [s] : [] };
    }
    if (type !== "vector" || !Array.isArray(data.result)) throw new PromError("parse", `expected an instant vector, got ${String(type).slice(0, 16)}`);
    if (data.result.length > this.o.maxSeries) throw new PromError("limit", `${data.result.length} series > ${this.o.maxSeries}`);
    const samples: PromSample[] = [];
    for (const r of data.result as { metric?: unknown; value?: unknown }[]) {
      const s = sample(r?.value, r?.metric);
      if (s) samples.push(s);
    }
    return { type: "vector", samples };
  }

  /** A range query: start/end in ms, step in seconds. */
  async range(query: string, r: { start: number; end: number; step: number }, signal?: AbortSignal): Promise<PromSeries[]> {
    if (!(r.end > r.start) || !(r.step > 0)) throw new PromError("config", "range: end must be after start and step > 0");
    if ((r.end - r.start) / 1000 / r.step > 11_000) throw new PromError("config", "range: more than 11 000 points per series");
    const data = await this.call("/api/v1/query_range", query, { query, start: String(r.start / 1000), end: String(r.end / 1000), step: String(r.step) }, signal);
    if (data.resultType !== "matrix" || !Array.isArray(data.result)) throw new PromError("parse", "expected a range matrix");
    if (data.result.length > this.o.maxSeries) throw new PromError("limit", `${data.result.length} series > ${this.o.maxSeries}`);
    return (data.result as { metric?: unknown; values?: unknown }[]).map((s) => ({
      labels: labels(s?.metric),
      values: (Array.isArray(s?.values) ? s.values : []).flatMap((p: unknown) => {
        const x = point(p);
        return x ? [[x.ts, x.value] as [number, number]] : [];
      }),
    }));
  }

  private async call(path: string, query: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ resultType?: unknown; result?: unknown }> {
    if (typeof query !== "string" || !query.trim()) throw new PromError("config", "empty query");
    if (query.length > this.o.maxQueryLength) throw new PromError("config", `query longer than ${this.o.maxQueryLength} chars`);
    const now = this.now();
    if (now < this.retryAt) throw new PromError("backoff", `backing off for ${Math.ceil((this.retryAt - now) / 1000)} s after ${this.failures} failure(s)`);
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(this.base + path, {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: sig,
        redirect: "error",
      });
      text = await readCapped(res, this.o.maxBytes);
    } catch (e) {
      if (e instanceof PromError) throw this.fail(e);
      const aborted = timeout.aborted || (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      throw this.fail(new PromError(aborted ? "timeout" : "http", aborted ? `no answer within ${this.o.timeoutMs} ms` : "request failed"));
    }
    let body: { status?: unknown; data?: { resultType?: unknown; result?: unknown }; errorType?: unknown } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const errorType = typeof body?.errorType === "string" ? body.errorType.replace(/[^a-z_]/gi, "").slice(0, 24) : "";
    if (res.status >= 400 && res.status < 500) {
      // the query is wrong (bad_data …): not the server's fault, no backoff
      this.ok();
      throw new PromError("prometheus", `rejected (${res.status}${errorType ? ` ${errorType}` : ""})`, res.status);
    }
    if (!res.ok) throw this.fail(new PromError("http", `HTTP ${res.status}${errorType ? ` ${errorType}` : ""}`, res.status));
    if (!body || body.status !== "success" || !body.data) throw this.fail(new PromError("parse", "not a Prometheus API answer"));
    this.ok();
    return body.data;
  }

  private ok(): void {
    this.failures = 0;
    this.retryAt = 0;
  }

  private fail(e: PromError): PromError {
    if (e.kind === "limit") return e; // a too-big answer is the query's problem
    this.failures++;
    const exp = Math.min(this.bo.maxMs, this.bo.baseMs * 2 ** (this.failures - 1));
    const j = 1 + this.bo.jitter * (this.random() * 2 - 1);
    this.retryAt = this.now() + Math.max(0, Math.round(exp * j));
    return e;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {});
    throw new PromError("limit", `answer larger than ${max} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new PromError("limit", `answer larger than ${max} bytes`);
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

function labels(m: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m || typeof m !== "object") return out;
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

function point(p: unknown): { ts: number; value: number } | null {
  if (!Array.isArray(p) || p.length !== 2) return null;
  const ts = Number(p[0]) * 1000;
  const value = Number(p[1]);
  return Number.isFinite(ts) && Number.isFinite(value) ? { ts, value } : null;
}

function sample(p: unknown, m: unknown): PromSample | null {
  const x = point(p);
  return x ? { labels: labels(m), value: x.value, ts: x.ts } : null;
}
