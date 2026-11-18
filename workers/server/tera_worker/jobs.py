"""Job store and the single GPU runner thread (one job at a time)."""

from __future__ import annotations

import json
import os
import queue
import secrets
import shutil
import threading
import time
import traceback
from pathlib import Path

from . import backends as B
from .inputs import InputError, save_image

_TERMINAL = ("done", "failed")


class RequestError(Exception):
    """Bad request from the client (HTTP 400 / 404)."""

    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


class Worker:
    def __init__(self, config):
        self.config = config
        self.data_dir = Path(config.data_dir)
        self.jobs_dir = self.data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.queue: "queue.Queue[str | None]" = queue.Queue()
        self.current: B.JobContext | None = None
        self.backends: dict[str, B.Backend] = {}
        self.disabled: list[dict] = []
        for name in config.backends:
            try:
                be = B.load(name, config)
            except Exception as e:  # noqa: BLE001 - report, keep serving the others
                self.disabled.append({"name": name, "reason": f"failed to load: {e}"})
                continue
            if be.research_only and not config.allow_research:
                self.disabled.append({"name": name, "license": B.RESEARCH_ONLY,
                                      "reason": "research-only weights; set TERA_ALLOW_RESEARCH=1"})
                continue
            self.backends[name] = be
        self._recover()
        self.thread = threading.Thread(target=self._loop, name="tera-gpu-runner", daemon=True)
        self.thread.start()

    # ------------------------------------------------------------ models

    def models(self) -> list[dict]:
        out = []
        defaults = {k: self.default_for(k) for k in B.KINDS}
        for be in self.backends.values():
            reason = be.unavailable_reason()
            for kind in be.kinds:
                m = {"kind": kind, "name": be.name,
                     "license": B.RESEARCH_ONLY if be.research_only else be.license,
                     "license_url": be.license_url,
                     "default": defaults.get(kind) == be.name,
                     "available": reason is None}
                if reason:
                    m["reason"] = reason
                out.append(m)
        return out

    def default_for(self, kind: str) -> str | None:
        """First enabled, available, non-research backend for this kind (config order)."""
        for be in self.backends.values():
            if kind in be.kinds and not be.research_only and be.unavailable_reason() is None:
                return be.name
        return None

    # ------------------------------------------------------------ jobs

    def submit(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise RequestError("body must be a JSON object")
        kind = body.get("kind")
        if kind not in B.KINDS:
            raise RequestError(f"kind must be one of {', '.join(B.KINDS)}")
        inp = body.get("input") or {}
        params = body.get("params") or {}
        if not isinstance(inp, dict) or not isinstance(params, dict):
            raise RequestError("input and params must be objects")
        name = params.get("model") or body.get("model")
        if name:
            be = self.backends.get(name)
            if be is None:
                hint = next((d["reason"] for d in self.disabled if d["name"] == name), "not enabled")
                raise RequestError(f"model {name!r} is not available: {hint}")
            if kind not in be.kinds:
                raise RequestError(f"model {name!r} does not do {kind}")
            reason = be.unavailable_reason()
            if reason:
                raise RequestError(f"model {name!r} is not available: {reason}", 503)
        else:
            name = self.default_for(kind)
            if name is None:
                raise RequestError(f"no available model for {kind} on this worker", 503)
            be = self.backends[name]

        image_src = inp.get("image")
        prompt = inp.get("prompt")
        if kind in ("image_to_splat",) and not image_src:
            raise RequestError("input.image is required for image_to_splat")
        if kind == "image_to_model" and not (image_src or prompt):
            raise RequestError("input.image (or input.prompt where the model supports it) is required")
        if kind == "text_to_motion" and not prompt:
            raise RequestError("input.prompt is required for text_to_motion")
        if prompt is not None and (not isinstance(prompt, str) or len(prompt) > 4000):
            raise RequestError("input.prompt must be a string of at most 4000 characters")

        jid = "j_" + secrets.token_hex(8)
        jdir = self.jobs_dir / jid
        (jdir / "out").mkdir(parents=True)
        image_name = None
        if image_src:
            try:
                image_name = save_image(image_src, jdir, self.config).name
            except InputError as e:
                shutil.rmtree(jdir, ignore_errors=True)
                raise RequestError(str(e)) from None
        job = {"id": jid, "status": "queued", "progress": 0.0, "kind": kind, "model": name,
               "license": B.RESEARCH_ONLY if be.research_only else be.license,
               "created": time.time(), "image": image_name, "prompt": prompt,
               "params": params, "outputs": []}
        with self.lock:
            self.jobs[jid] = job
            self._save(job)
        self.queue.put(jid)
        self._prune()
        return job

    def get(self, jid: str) -> dict:
        with self.lock:
            job = self.jobs.get(jid)
            if job is None:
                raise RequestError("no such job", 404)
            return dict(job)

    def list(self, limit: int = 50) -> list[dict]:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j["created"], reverse=True)
            return [dict(j) for j in jobs[:limit]]

    def cancel(self, jid: str) -> dict:
        with self.lock:
            job = self.jobs.get(jid)
            if job is None:
                raise RequestError("no such job", 404)
            if job["status"] == "queued":
                job.update(status="failed", error="cancelled", finished=time.time())
                self._save(job)
            elif job["status"] == "running" and self.current and self.current.id == jid:
                self.current.kill()
            return dict(job)

    def queue_depth(self) -> int:
        with self.lock:
            return sum(1 for j in self.jobs.values() if j["status"] == "queued")

    def file_path(self, jid: str, rel: str) -> Path:
        if not jid.startswith("j_") or not jid[2:].isalnum():
            raise RequestError("no such file", 404)
        base = (self.jobs_dir / jid / "out").resolve()
        p = (base / rel).resolve()
        if base not in p.parents or not p.is_file():
            raise RequestError("no such file", 404)
        return p

    def stop(self) -> None:
        if self.current:
            self.current.kill()
        self.queue.put(None)

    # ------------------------------------------------------------ internals

    def _save(self, job: dict) -> None:
        p = self.jobs_dir / job["id"] / "job.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, indent=1))
        os.replace(tmp, p)

    def _update(self, jid: str, **kw) -> None:
        with self.lock:
            job = self.jobs[jid]
            job.update(kw)
            self._save(job)

    def _recover(self) -> None:
        """Load jobs from disk; anything that was queued/running died with the old process."""
        for jf in self.jobs_dir.glob("j_*/job.json"):
            try:
                job = json.loads(jf.read_text())
            except (OSError, ValueError):
                continue
            if job.get("status") not in _TERMINAL:
                job.update(status="failed", error="worker restarted before the job finished")
                self._save(job)
            self.jobs[job["id"]] = job

    def _prune(self) -> None:
        with self.lock:
            done = sorted((j for j in self.jobs.values() if j["status"] in _TERMINAL),
                          key=lambda j: j["created"])
            extra = len(self.jobs) - self.config.keep_jobs
            victims = done[:max(0, extra)]
            for j in victims:
                self.jobs.pop(j["id"], None)
        for j in victims:
            shutil.rmtree(self.jobs_dir / j["id"], ignore_errors=True)

    def _loop(self) -> None:
        while True:
            jid = self.queue.get()
            if jid is None:
                return
            with self.lock:
                job = self.jobs.get(jid)
                if job is None or job["status"] != "queued":
                    continue
                job.update(status="running", started=time.time(), progress=0.0)
                self._save(job)
            self._run(job)

    def _run(self, job: dict) -> None:
        jid = job["id"]
        jdir = self.jobs_dir / jid
        last = [0.0]

        def set_progress(p: float) -> None:
            p = round(max(0.0, min(0.99, p)), 3)
            if p > last[0]:
                last[0] = p
                with self.lock:
                    self.jobs[jid]["progress"] = p  # not persisted every tick

        ctx = B.JobContext(id=jid, kind=job["kind"], dir=jdir, out_dir=jdir / "out",
                           image=(jdir / job["image"]) if job.get("image") else None,
                           prompt=job.get("prompt"), params=job.get("params") or {},
                           timeout_s=self.config.job_timeout_s, set_progress=set_progress)
        self.current = ctx
        be = self.backends[job["model"]]
        try:
            outs = be.run(ctx)
            outputs = []
            for o in outs:
                rel = o.path.resolve().relative_to(ctx.out_dir.resolve()).as_posix()
                outputs.append({"path": rel, "format": o.format, "bytes": o.path.stat().st_size})
            if not outputs:
                raise B.BackendError("backend produced no outputs")
            self._update(jid, status="done", progress=1.0, outputs=outputs, finished=time.time())
        except B.JobCancelled:
            self._update(jid, status="failed", error="cancelled", finished=time.time())
        except Exception as e:  # noqa: BLE001 - every failure becomes a failed job
            ctx.log(traceback.format_exc())
            self._update(jid, status="failed", error=str(e)[-2000:] or type(e).__name__,
                         finished=time.time())
        finally:
            self.current = None
