"""Worker settings, read from environment variables (see workers/README.md)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _flag(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8874
    data_dir: Path = Path("./tera-jobs")
    # Base URL put in front of /v1/files/... in job outputs. Empty = derive from the
    # request's Host header.
    public_url: str = ""
    # Backend names to enable, in priority order. The first available, non-research
    # backend for a kind is that kind's default.
    backends: list[str] = field(default_factory=lambda: ["mock"])
    allow_research: bool = False
    allow_url_input: bool = True
    token: str = ""  # optional bearer token; empty = no auth (bind to a private IP!)
    max_body_bytes: int = 48 * 1024 * 1024
    max_input_bytes: int = 32 * 1024 * 1024
    job_timeout_s: float = 3600.0
    keep_jobs: int = 200  # job folders kept on disk; oldest finished ones are pruned
    models_dir: Path = Path(os.path.expanduser("~/models/tera"))

    @classmethod
    def from_env(cls) -> "Config":
        c = cls()
        c.host = os.environ.get("TERA_HOST", c.host)
        c.port = int(os.environ.get("TERA_PORT", c.port))
        c.data_dir = Path(os.environ.get("TERA_DATA_DIR", str(c.data_dir)))
        c.public_url = os.environ.get("TERA_PUBLIC_URL", "").rstrip("/")
        b = os.environ.get("TERA_BACKENDS", "")
        if b.strip():
            c.backends = [x.strip() for x in b.split(",") if x.strip()]
        c.allow_research = _flag("TERA_ALLOW_RESEARCH")
        c.allow_url_input = _flag("TERA_ALLOW_URL_INPUT", True)
        c.token = os.environ.get("TERA_TOKEN", "")
        c.job_timeout_s = float(os.environ.get("TERA_JOB_TIMEOUT", c.job_timeout_s))
        c.keep_jobs = int(os.environ.get("TERA_KEEP_JOBS", c.keep_jobs))
        c.models_dir = Path(os.environ.get("TERA_MODELS_DIR", str(c.models_dir)))
        return c
