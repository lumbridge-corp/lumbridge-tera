"""Microsoft TRELLIS.2 (github.com/microsoft/TRELLIS.2): one image -> textured .glb.

Code and weights MIT. Runs tera_worker.adapters.trellis2_run in a subprocess inside the
trellis image, so GPU memory is freed after each job. TRELLIS v1 is not supported: it
needs spconv (no aarch64 wheels) and bakes GLB textures through the Inria rasteriser
(non-commercial).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .base import Backend, BackendError, JobContext, Output


class TrellisBackend(Backend):
    name = "trellis"
    kinds = ("image_to_model",)
    license = "MIT"
    license_url = "https://huggingface.co/microsoft/TRELLIS.2-4B"
    description = ("TRELLIS.2-4B image -> PBR GLB. Encoder DINOv3 (DINOv3 License, commercial OK), "
                   "background removal BiRefNet (MIT); no nvdiffrast.")

    def __init__(self, config) -> None:
        super().__init__(config)
        root = Path(config.models_dir) / "trellis2"
        self.model_dir = Path(os.environ.get("TERA_TRELLIS2_DIR", str(root / "TRELLIS.2-4B")))
        self.ss_dec = Path(os.environ.get(
            "TERA_TRELLIS2_SS_DEC", str(root / "TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16")))

    def unavailable_reason(self) -> str | None:
        try:
            import importlib.util

            if importlib.util.find_spec("trellis2") is None:
                return "trellis2 package not importable (run inside the trellis image)"
        except (ImportError, ValueError):
            return "trellis2 package not importable"
        if not (self.model_dir / "pipeline.json").is_file():
            return f"missing weights: {self.model_dir}/pipeline.json"
        if not Path(str(self.ss_dec) + ".safetensors").is_file():
            return f"missing weights: {self.ss_dec}.safetensors"
        return None

    def run(self, ctx: JobContext) -> list[Output]:
        if ctx.image is None:
            raise BackendError("trellis needs input.image (text prompts are not supported by TRELLIS.2)")
        p = ctx.params
        out = ctx.out_dir / "model.glb"
        argv = [sys.executable, "-m", "tera_worker.adapters.trellis2_run",
                "--image", str(ctx.image), "--out", str(out),
                "--model-dir", str(self.model_dir), "--ss-dec", str(self.ss_dec),
                "--pipeline-type", str(p.get("resolution", "1024_cascade")),
                "--seed", str(int(p.get("seed", 42))),
                "--decimate", str(int(p.get("faces", 500000))),
                "--texture", str(p.get("texture", "uv")),
                "--texture-size", str(int(p.get("texture_size", 2048)))]
        if p.get("steps"):
            argv += ["--steps", str(int(p["steps"]))]
        env = {"HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE", "1")}
        ctx.run(argv, env=env, progress_span=(0.0, 0.99))
        if not out.is_file():
            raise BackendError("TRELLIS.2 finished without writing model.glb")
        for line in ctx.log_path.read_text(errors="replace").splitlines()[::-1]:
            if line.startswith("TERA_STATS "):
                (ctx.dir / "stats.json").write_text(json.dumps(json.loads(line[11:])))
                break
        return [Output(out, "glb")]
