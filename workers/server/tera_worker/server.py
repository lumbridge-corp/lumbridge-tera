"""HTTP API (CONTRACT.md section 7), standard library only.

POST   /v1/jobs            submit            -> {"id"}
GET    /v1/jobs/:id        status            -> {"id","status","progress","outputs":[{"url","format"}],"error"}
DELETE /v1/jobs/:id        cancel (queued: dropped, running: killed)
GET    /v1/jobs            recent jobs (extra)
GET    /v1/health          {"ok": true, "models": [{"kind","name","license",...}]}
GET    /v1/files/:id/:path job outputs
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import re
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .config import Config
from .jobs import RequestError, Worker

_JOB = re.compile(r"^/v1/jobs/(j_[0-9a-f]+)$")
_FILE = re.compile(r"^/v1/files/(j_[0-9a-f]+)/(.+)$")
_TYPES = {".spz": "application/octet-stream", ".ply": "application/octet-stream",
          ".glb": "model/gltf-binary", ".bvh": "text/plain; charset=utf-8",
          ".npz": "application/octet-stream", ".mp4": "video/mp4", ".png": "image/png",
          ".json": "application/json"}


def public_job(job: dict, base: str) -> dict:
    out = {"id": job["id"], "status": job["status"], "progress": job.get("progress", 0.0),
           "kind": job["kind"], "model": job["model"], "license": job.get("license")}
    if job.get("outputs"):
        out["outputs"] = [{"url": f"{base}/v1/files/{job['id']}/{o['path']}", "format": o["format"],
                           "bytes": o.get("bytes")} for o in job["outputs"]]
    if job.get("error"):
        out["error"] = job["error"]
    return out


def make_handler(worker: Worker, config: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"tera-worker/{__version__}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter than the default, still on stderr
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        # ---------------------------------------------------- helpers
        def _base(self) -> str:
            if config.public_url:
                return config.public_url
            host = self.headers.get("Host") or f"{config.host}:{config.port}"
            return f"http://{host}"

        def _json(self, status: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if not config.token:
                return True
            got = self.headers.get("Authorization", "")
            if hmac.compare_digest(got.encode(), f"Bearer {config.token}".encode()):
                return True
            self._json(401, {"error": "unauthorized"})
            return False

        def _guard(self, fn):
            try:
                if self.path.split("?")[0] != "/v1/health" and not self._authorized():
                    return
                fn()
            except RequestError as e:
                self._json(e.status, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": f"internal error: {e}"})

        # ---------------------------------------------------- verbs
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            self._guard(self._get)

        def do_HEAD(self):
            self._guard(self._get)

        def do_POST(self):
            self._guard(self._post)

        def do_DELETE(self):
            self._guard(self._delete)

        def _get(self):
            path = self.path.split("?")[0]
            if path == "/v1/health":
                self._json(200, {"ok": True, "worker": "tera-worker", "version": __version__,
                                 "models": worker.models(), "disabled": worker.disabled,
                                 "queue": worker.queue_depth(),
                                 "running": worker.current.id if worker.current else None})
                return
            if path == "/v1/jobs":
                base = self._base()
                self._json(200, {"jobs": [public_job(j, base) for j in worker.list()]})
                return
            m = _JOB.match(path)
            if m:
                self._json(200, public_job(worker.get(m.group(1)), self._base()))
                return
            m = _FILE.match(path)
            if m:
                p = worker.file_path(m.group(1), m.group(2))
                ctype = _TYPES.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] \
                    or "application/octet-stream"
                size = p.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.end_headers()
                if self.command == "HEAD":
                    return
                with open(p, "rb") as f:
                    while chunk := f.read(1 << 20):
                        self.wfile.write(chunk)
                return
            raise RequestError("not found", 404)

        def _post(self):
            if self.path.split("?")[0] != "/v1/jobs":
                raise RequestError("not found", 404)
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                raise RequestError("empty body")
            if n > config.max_body_bytes:
                raise RequestError("body too large", 413)
            try:
                body = json.loads(self.rfile.read(n))
            except ValueError:
                raise RequestError("body is not valid JSON") from None
            job = worker.submit(body)
            self._json(202, {"id": job["id"], "status": job["status"], "model": job["model"],
                             "license": job["license"]})

        def _delete(self):
            m = _JOB.match(self.path.split("?")[0])
            if not m:
                raise RequestError("not found", 404)
            self._json(200, public_job(worker.cancel(m.group(1)), self._base()))

    return Handler


def serve(config: Config, ready: threading.Event | None = None):
    worker = Worker(config)
    httpd = ThreadingHTTPServer((config.host, config.port), make_handler(worker, config))
    httpd.daemon_threads = True
    httpd.worker = worker  # type: ignore[attr-defined]
    if ready is not None:
        ready.set()
    return httpd


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="tera-worker", description="Lumbridge Tera gen worker")
    ap.add_argument("--host", help="bind address (default TERA_HOST or 127.0.0.1)")
    ap.add_argument("--port", type=int, help="port (default TERA_PORT or 8874)")
    ap.add_argument("--backends", help="comma list, e.g. lyra1,mock (default TERA_BACKENDS or mock)")
    ap.add_argument("--data-dir", help="job folders (default TERA_DATA_DIR or ./tera-jobs)")
    a = ap.parse_args(argv)
    config = Config.from_env()
    if a.host:
        config.host = a.host
    if a.port:
        config.port = a.port
    if a.backends:
        config.backends = [x.strip() for x in a.backends.split(",") if x.strip()]
    if a.data_dir:
        from pathlib import Path

        config.data_dir = Path(a.data_dir)
    if config.host in ("0.0.0.0", "::") and not config.token:
        print("refusing to listen on all interfaces without TERA_TOKEN; bind a private IP",
              file=sys.stderr)
        return 2
    httpd = serve(config)
    w = httpd.worker  # type: ignore[attr-defined]
    print(f"tera-worker {__version__} on http://{config.host}:{config.port} "
          f"models={[m['name'] + ':' + m['kind'] for m in w.models()]} disabled={w.disabled}",
          flush=True)

    def _stop(*_):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        httpd.serve_forever()
    finally:
        w.stop()
        httpd.server_close()
    return 0
