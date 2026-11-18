"""Backend interface. A backend turns one job's input into files in the job's out/ folder."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

KINDS = ("image_to_splat", "image_to_model", "text_to_motion")

# Licence strings reported in /v1/health. "research-only" is the exact string the
# contract requires for weights that may not be used commercially.
RESEARCH_ONLY = "research-only"


class JobCancelled(Exception):
    pass


class BackendError(Exception):
    pass


@dataclass
class Output:
    path: Path  # absolute path inside the job's out/ folder
    format: str  # "ply", "spz", "glb", "bvh", "npz", "mp4", ...


@dataclass
class JobContext:
    id: str
    kind: str
    dir: Path
    out_dir: Path
    image: Path | None
    prompt: str | None
    params: dict
    timeout_s: float
    set_progress: Callable[[float], None]
    cancel_event: threading.Event = field(default_factory=threading.Event)
    _proc: subprocess.Popen | None = None

    @property
    def log_path(self) -> Path:
        return self.dir / "log.txt"

    def log(self, msg: str) -> None:
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")

    def check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled("cancelled")

    def run(self, argv: Sequence[str], *, env: dict | None = None, cwd: str | Path | None = None,
            progress_span: tuple[float, float] = (0.0, 1.0)) -> None:
        """Run a command, append its output to log.txt, map `TERA_PROGRESS <0..1>` lines
        to job progress inside `progress_span`. Raises BackendError on non-zero exit."""
        self.check_cancel()
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        self.log("$ " + " ".join(str(a) for a in argv))
        tail: deque[str] = deque(maxlen=40)
        lo, hi = progress_span
        proc = subprocess.Popen([str(a) for a in argv], cwd=str(cwd) if cwd else None, env=full_env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                errors="replace", start_new_session=True)
        self._proc = proc
        timer = threading.Timer(self.timeout_s, lambda: _kill(proc))
        timer.start()
        try:
            assert proc.stdout is not None
            with open(self.log_path, "a", encoding="utf-8") as logf:
                for line in proc.stdout:
                    logf.write(line)
                    logf.flush()
                    tail.append(line.rstrip())
                    if line.startswith("TERA_PROGRESS"):
                        try:
                            p = float(line.split()[1])
                            self.set_progress(lo + (hi - lo) * max(0.0, min(1.0, p)))
                        except (IndexError, ValueError):
                            pass
                    if self.cancel_event.is_set():
                        _kill(proc)
            rc = proc.wait()
        finally:
            timer.cancel()
            self._proc = None
        if self.cancel_event.is_set():
            raise JobCancelled("cancelled")
        if rc != 0:
            last = "\n".join(list(tail)[-12:])
            raise BackendError(f"{Path(str(argv[0])).name} exited with code {rc}:\n{last}")

    def kill(self) -> None:
        self.cancel_event.set()
        if self._proc is not None:
            _kill(self._proc)


def _kill(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, 15)
        except (ProcessLookupError, PermissionError):
            pass


class Backend:
    """Subclass and set the class attributes. One instance per worker process."""

    name: str = ""
    kinds: tuple[str, ...] = ()
    license: str = ""  # SPDX id, model licence name, or "research-only"
    license_url: str = ""
    research_only: bool = False
    description: str = ""

    def __init__(self, config) -> None:
        self.config = config

    def unavailable_reason(self) -> str | None:
        """None when the backend can take jobs, else a short reason (missing weights...)."""
        return None

    def run(self, ctx: JobContext) -> list[Output]:  # pragma: no cover - interface
        raise NotImplementedError
