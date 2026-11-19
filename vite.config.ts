import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// satellite.js re-exports an optional WASM bulk propagator (pthreads, top-level await) that the
// engine never uses; point that one re-export at an empty module so the browser build stays plain.
const noSatelliteWasm: Plugin = {
  name: "tera:no-satellite-wasm",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./wasm/index.js" && importer && /satellite\.js[\\/]dist[\\/]index\.js$/.test(importer)) return fileURLToPath(new URL("./src/engine/satellite-wasm-stub.ts", import.meta.url));
    return null;
  },
};

// HTTPS for WebXR on a headset over the LAN (docs/xr.md): TERA_HTTPS_CERT + TERA_HTTPS_KEY = PEM files.
const cert = process.env.TERA_HTTPS_CERT, key = process.env.TERA_HTTPS_KEY;

export default defineConfig({
  plugins: [noSatelliteWasm],
  server: { port: 8790, host: "127.0.0.1", ...(cert && key ? { https: { cert: readFileSync(cert), key: readFileSync(key) } } : {}) },
  build: { target: "es2023", outDir: "dist" },
});
