"""Backend registry. Import is lazy-free: backends only touch heavy libraries in run()."""

from __future__ import annotations

from .base import KINDS, RESEARCH_ONLY, Backend, BackendError, JobCancelled, JobContext, Output

_REGISTRY: dict[str, str] = {
    "mock": "tera_worker.backends.mock:MockBackend",
    "lyra1": "tera_worker.backends.lyra:Lyra1Backend",
    "lyra2": "tera_worker.backends.lyra:Lyra2Backend",
    "trellis": "tera_worker.backends.trellis:TrellisBackend",
    "kimodo": "tera_worker.backends.kimodo:KimodoBackend",
}


def names() -> list[str]:
    return list(_REGISTRY)


def load(name: str, config) -> Backend:
    import importlib

    if name not in _REGISTRY:
        raise KeyError(f"unknown backend {name!r}; known: {', '.join(_REGISTRY)}")
    mod, cls = _REGISTRY[name].split(":")
    return getattr(importlib.import_module(mod), cls)(config)


__all__ = ["KINDS", "RESEARCH_ONLY", "Backend", "BackendError", "JobCancelled", "JobContext",
           "Output", "names", "load"]
