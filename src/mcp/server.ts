#!/usr/bin/env node
// tera-mcp: stdio MCP server. One session = one open world in one headless engine page.
//   node src/mcp/server.ts
// Env: TERA_WORLDS (worlds root, default ~/tera-worlds), TERA_GEN_URL (gen worker),
//      TERA_CHROME (browser binary), TERA_AUTOSAVE=0 (no autosave), TERA_ASSET_MAX_BYTES,
//      TERA_SNAPSHOT_DIR (keep a copy of every image returned), TERA_DEBUG (stack traces on stderr).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.ts";
import { createServer } from "./tools.ts";

const session = new Session();
const server = createServer(session);

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await session.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));

await server.connect(new StdioServerTransport());
process.stderr.write(`tera-mcp ready (worlds root ${session.root})\n`);
