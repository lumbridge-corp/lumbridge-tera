import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// HTTPS for WebXR on a headset over the LAN (docs/xr.md): TERA_HTTPS_CERT + TERA_HTTPS_KEY = PEM files.
const cert = process.env.TERA_HTTPS_CERT, key = process.env.TERA_HTTPS_KEY;

export default defineConfig({
  server: { port: 8790, host: "127.0.0.1", ...(cert && key ? { https: { cert: readFileSync(cert), key: readFileSync(key) } } : {}) },
  build: { target: "es2023", outDir: "dist" },
});
