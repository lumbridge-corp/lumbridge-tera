"""NVIDIA Kimodo (github.com/nv-tlabs/kimodo): text -> skeletal motion (stretch backend).

Only the SOMA checkpoints are used: nvidia/Kimodo-SOMA-RP-v1.2 is NVIDIA Open Model License
(commercial use allowed) and the SOMA skeleton (NVlabs/SOMA-X) is Apache-2.0. The SMPL-X
variant is R&D-only and is never loaded here.

Blocker for a fully local run: the text encoder is LLM2Vec (MIT) on top of the gated
meta-llama/Meta-Llama-3-8B-Instruct (Llama 3 Community License: commercial use with
conditions). It needs an HF token with Meta's approval, or a running `kimodo_textencoder`
server (TEXT_ENCODER_URL).

Outputs: Kimodo .npz (joints, rotations, contacts) and .bvh (SOMA 77-joint skeleton,
centimetres, 30 fps, at most 10 s).
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .base import Backend, BackendError, JobContext, Output


class KimodoBackend(Backend):
    name = "kimodo"
    kinds = ("text_to_motion",)
    license = "NVIDIA Open Model License"
    license_url = "https://huggingface.co/nvidia/Kimodo-SOMA-RP-v1.2"
    description = "Kimodo-SOMA-RP-v1.2 text -> motion (BVH/NPZ). Text encoder needs gated Llama 3 8B."

    def __init__(self, config) -> None:
        super().__init__(config)
        self.model = os.environ.get("TERA_KIMODO_MODEL", "Kimodo-SOMA-RP-v1.2")
        self.ckpt_dir = Path(os.environ.get("TERA_KIMODO_CKPT", str(Path(config.models_dir) / "kimodo")))
        self.text_encoders = os.environ.get("TERA_KIMODO_TEXT_ENCODERS", "")

    def unavailable_reason(self) -> str | None:
        if shutil.which("kimodo_gen") is None:
            return "kimodo_gen not installed (run inside the kimodo image)"
        if "SMPLX" in self.model.upper():
            return "SMPL-X Kimodo checkpoints are research-only; use a SOMA checkpoint"
        if not (self.ckpt_dir / self.model / "config.yaml").is_file():
            return f"missing weights: {self.ckpt_dir / self.model}"
        if not os.environ.get("TEXT_ENCODER_URL") and not (
                self.text_encoders and Path(self.text_encoders).is_dir()):
            return ("no text encoder: set TEXT_ENCODER_URL (kimodo_textencoder server) or "
                    "TERA_KIMODO_TEXT_ENCODERS to a folder with the LLM2Vec + Llama-3-8B weights")
        return None

    def run(self, ctx: JobContext) -> list[Output]:
        if not ctx.prompt:
            raise BackendError("kimodo needs input.prompt")
        dur = max(1.0, min(10.0, float(ctx.params.get("duration", 5.0))))
        stem = ctx.out_dir / "motion"
        argv = ["kimodo_gen", ctx.prompt, "--model", self.model, "--duration", str(dur),
                "--output", str(stem), "--bvh",
                "--diffusion_steps", str(int(ctx.params.get("steps", 100)))]
        if "seed" in ctx.params:
            argv += ["--seed", str(int(ctx.params["seed"]))]
        env = {"CHECKPOINT_DIR": str(self.ckpt_dir), "LOCAL_CACHE": "true", "HF_HUB_OFFLINE": "1"}
        if self.text_encoders:
            env["TEXT_ENCODERS_DIR"] = self.text_encoders
        ctx.run(argv, env=env, progress_span=(0.05, 0.98))
        outs = []
        for ext in ("bvh", "npz"):
            p = stem.with_suffix(f".{ext}")
            if p.is_file():
                outs.append(Output(p, ext))
        if not outs:
            raise BackendError("kimodo_gen wrote no motion.bvh / motion.npz")
        return outs
