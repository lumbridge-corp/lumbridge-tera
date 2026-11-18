// Worlds root + path traversal guard. Every path an agent gives us resolves inside
// TERA_WORLDS (default ~/tera-worlds) or is refused.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function worldsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TERA_WORLDS?.trim() || join(homedir(), "tera-worlds");
  const abs = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  mkdirSync(abs, { recursive: true });
  return realpathSync(abs);
}

/** realpath of the deepest existing ancestor, plus the rest — catches symlinks pointing out of root. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `p` (relative to `base`, default the root; or absolute) and refuse anything
 * outside `root`. Returns the absolute path.
 */
export function guardPath(root: string, p: string, base: string = root): string {
  if (typeof p !== "string" || p.trim() === "") throw new Error("path is empty");
  if (p.includes("\0")) throw new Error("path contains a NUL byte");
  const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  const abs = resolve(base, expanded);
  if (!isInside(root, abs) || !isInside(root, realish(abs)))
    throw new Error(`path "${p}" is outside the worlds root ${root} — use a path inside it (set TERA_WORLDS to change the root)`);
  return abs;
}

/** A single safe file/folder name: no slashes, no dots-only, limited charset. */
export function safeName(name: string): string {
  const n = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!n || /^\.+$/.test(n)) throw new Error(`"${name}" is not a usable file name`);
  return n;
}
