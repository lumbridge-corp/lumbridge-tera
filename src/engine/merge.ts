// Deep merge for `update` / `sky` / `env` ops. Pure: no three.js, runs in Node.
//
// Rules: plain objects merge key by key; arrays and everything else replace;
// `undefined` in the patch is ignored; `null` in the patch deletes the key.
// Neither input is mutated.

export type Plain = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Plain {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cloneValue<T>(v: T): T {
  return v !== null && typeof v === "object" ? structuredClone(v) : v;
}

export function deepMerge<T extends Plain>(base: T, patch: Plain): T {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : cloneValue(v);
  }
  return out as T;
}
