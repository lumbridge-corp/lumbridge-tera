// Adapters: Node-side sources that turn someone's telemetry into world ops (CONTRACT.md
// section 10). Prometheus is the first (src/adapters/prometheus/); a Langfuse or OpenTelemetry
// adapter sits beside it with the same shape. Adapters never import three.js or the DOM: they
// run in a feed server (or a test) and hand their ops to whatever drives the page (a live
// WebSocket, a replay recorder, the bridge).

/** The only op an adapter emits: a partial entity update (section 2). */
export interface UpdateOp {
  op: "update";
  id: string;
  set: Record<string, unknown>;
}

/** Where one configured item (a binding, a journey source …) stands right now. */
export type AdapterState = "pending" | "live" | "stale" | "error" | "missing";

export interface AdapterItemStatus {
  id: string;
  kind: string;
  state: AdapterState;
  /** seconds since the last successful evaluation (null: never) */
  ageS: number | null;
  /** entities this item drives in the current world */
  entities: number;
  /** a short, scrubbed reason (no URLs, queries, label values or credentials) */
  error?: string;
}

/**
 * The shape every adapter has. `tick` does whatever is due (it may do nothing) and returns
 * op lists; each list is meant to travel as its own message, so one list that fails (an
 * entity the page does not have) never stops another.
 */
export interface WorldAdapter {
  readonly name: string;
  /** The world's entity ids (null = unknown: drive everything). Items whose entities are missing go quiet. */
  setEntities(ids: Iterable<string> | null): void;
  tick(nowMs?: number): Promise<UpdateOp[][]>;
  /** Ops that put a freshly connected page in the current state. */
  welcome(): UpdateOp[][];
  status(): AdapterItemStatus[];
}
