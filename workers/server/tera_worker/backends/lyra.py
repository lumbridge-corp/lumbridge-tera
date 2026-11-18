"""NVIDIA Lyra: one image -> 3D Gaussian splat scene.

lyra1  Lyra 1.0 (github.com/nv-tlabs/lyra, Lyra-1/). Code Apache-2.0, weights NVIDIA Open
       Model License (commercial use allowed). Two stages:
         1. GEN3C-Cosmos-7B turns the image into 6 camera-trajectory videos (latents),
            depth from MoGe;
         2. the Lyra 3DGS decoder turns the latents into Gaussians (.ply).
lyra2  Lyra 2.0 (Lyra-2/). Weights are NVIDIA *Internal Scientific Research and Development*
       Model License: research-only, never default, disabled unless TERA_ALLOW_RESEARCH=1.

Both run upstream scripts in a subprocess inside the backend's Docker image, so the GPU
memory is released when a job ends (the GPU may be shared with other services).
"""

from __future__ import annotations

import glob
import os
import shutil
import sys
from pathlib import Path

from .. import splat
from .base import Backend, BackendError, JobContext, Output


def _pythonpath(code: Path) -> str:
    """Upstream code first, then whatever the image set (shims such as the decord stand-in)."""
    rest = os.environ.get("PYTHONPATH", "")
    return f"{code}:{rest}" if rest else str(code)


def _finish_splat(ctx: JobContext, ply_in: Path) -> list[Output]:
    """Normalise a 3DGS .ply into out/scene.spz + out/scene.ply (three.js frame by default)."""
    c = splat.read_ply(ply_in)
    min_alpha = float(ctx.params.get("min_opacity", 0.0))
    if min_alpha > 0:
        c = splat.filter_opacity(c, min_alpha)
    if ctx.params.get("upright", True):
        c = splat.flip_upright(c)  # Lyra writes OpenCV camera frame (+Y down); three.js is +Y up
    out = ctx.out_dir
    splat.write_spz(out / "scene.spz", c)
    outputs = [Output(out / "scene.spz", "spz")]
    if ctx.params.get("ply", True):
        splat.write_ply(out / "scene.ply", c)
        outputs.append(Output(out / "scene.ply", "ply"))
    ctx.log(f"splats: {c.n}, sh degree {c.sh_degree}")
    return outputs


class Lyra1Backend(Backend):
    name = "lyra1"
    kinds = ("image_to_splat",)
    license = "NVIDIA Open Model License"
    license_url = "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/"
    description = "NVIDIA Lyra 1.0 (GEN3C-Cosmos-7B + Lyra 3DGS decoder), static scenes."

    def __init__(self, config) -> None:
        super().__init__(config)
        self.code = Path(os.environ.get("TERA_LYRA1_CODE", "/opt/lyra/Lyra-1"))
        self.ckpt = Path(os.environ.get("TERA_LYRA1_CKPT", str(Path(config.models_dir) / "lyra1" / "checkpoints")))

    def unavailable_reason(self) -> str | None:
        if not (self.code / "sample.py").is_file():
            return f"Lyra-1 code not found at {self.code} (run inside the lyra1 image)"
        need = ["Lyra/lyra_static.pt", "GEN3C-Cosmos-7B/model.pt",
                "Cosmos-Tokenize1-CV8x8x8-720p/mean_std.pt"]
        missing = [n for n in need if not (self.ckpt / n).is_file()]
        if missing:
            return f"missing weights in {self.ckpt}: {', '.join(missing)}"
        return None

    def run(self, ctx: JobContext) -> list[Output]:
        if ctx.image is None:
            raise BackendError("lyra1 needs input.image")
        stage1 = ctx.dir / "stage1"
        stage2 = ctx.dir / "stage2"
        work = ctx.dir / "work"
        # sample.py resolves configs/, checkpoints/ and the dataset root relative to cwd.
        (work / "assets/demo/static").mkdir(parents=True, exist_ok=True)
        for name, target in (("configs", self.code / "configs"), ("checkpoints", self.ckpt)):
            if not (work / name).exists():
                (work / name).symlink_to(target)
        link = work / "assets/demo/static/diffusion_output_generated"
        if not link.exists():
            link.symlink_to(stage1)
        env = {"PYTHONPATH": _pythonpath(self.code), "CUDA_HOME": os.environ.get("CUDA_HOME", "/usr/local/cuda"),
               "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}

        # Stage 1: image -> 6 trajectory latents (GEN3C). Guardrail and T5 prompt encoder off:
        # the prompt is empty for single-image generation (see upstream script).
        argv = [sys.executable, "-m", "torch.distributed.run", "--nproc_per_node=1",
                str(self.code / "cosmos_predict1/diffusion/inference/gen3c_single_image_sdg.py"),
                "--checkpoint_dir", str(self.ckpt), "--num_gpus", "1",
                "--input_image_path", str(ctx.image),
                "--video_save_folder", str(stage1),
                "--foreground_masking", "--multi_trajectory",
                "--total_movement_distance_factor", str(float(ctx.params.get("movement", 1.0))),
                "--disable_guardrail", "--disable_prompt_encoder"]
        if "seed" in ctx.params:
            argv += ["--seed", str(int(ctx.params["seed"]))]
        if ctx.params.get("offload", False):  # no benefit on unified memory; kept for discrete GPUs
            argv += ["--offload_diffusion_transformer", "--offload_tokenizer"]
        ctx.set_progress(0.02)
        ctx.run(argv, env=env, cwd=work, progress_span=(0.02, 0.8))
        ctx.set_progress(0.8)

        # Stage 2: latents -> Gaussians (Lyra decoder).
        argv = [sys.executable, "-m", "accelerate.commands.launch", "--num_processes", "1",
                str(self.code / "sample.py"), "--config", "configs/demo/lyra_static.yaml",
                "dataset_name=lyra_static_demo_generated", "save_gaussians_orig=true",
                f"out_dir_inference={stage2}", "save_gt_input=false", "save_gt_depth=false",
                "ckpt_path=checkpoints/Lyra/lyra_static.pt"]
        ctx.run(argv, env=env, cwd=work, progress_span=(0.8, 0.95))
        plys = sorted(glob.glob(str(stage2 / "**/gaussians_orig/*.ply"), recursive=True))
        if not plys:
            raise BackendError("Lyra finished but wrote no gaussians_orig/*.ply")
        outs = _finish_splat(ctx, Path(plys[0]))
        if ctx.params.get("keep_intermediate") is not True:
            shutil.rmtree(stage1, ignore_errors=True)
        return outs


class Lyra2Backend(Backend):
    name = "lyra2"
    kinds = ("image_to_splat",)
    license = "research-only"  # NVIDIA Internal Scientific Research and Development Model License
    license_url = ("https://www.nvidia.com/en-us/agreements/enterprise-software/"
                   "nvidia-internal-scientific-research-and-development-model-license/")
    research_only = True
    description = "NVIDIA Lyra 2.0 (Wan-2.1-14B based zoom video + ViPE/DA3 reconstruction). Research only."

    def __init__(self, config) -> None:
        super().__init__(config)
        self.code = Path(os.environ.get("TERA_LYRA2_CODE", "/opt/lyra/Lyra-2"))
        self.ckpt = Path(os.environ.get("TERA_LYRA2_CKPT", str(Path(config.models_dir) / "lyra2" / "checkpoints")))

    def unavailable_reason(self) -> str | None:
        if not (self.code / "lyra_2").is_dir():
            return f"Lyra-2 code not found at {self.code} (run inside the lyra2 image)"
        if not (self.ckpt / "model").is_dir():
            return f"missing weights in {self.ckpt} (hf download nvidia/Lyra-2.0)"
        return None

    def run(self, ctx: JobContext) -> list[Output]:
        if ctx.image is None:
            raise BackendError("lyra2 needs input.image")
        samples = ctx.dir / "samples"
        samples.mkdir(exist_ok=True)
        img = samples / f"0{ctx.image.suffix}"
        shutil.copy(ctx.image, img)
        (samples / "0.txt").write_text(ctx.prompt or "")  # upstream wants a caption per image
        outdir = ctx.dir / "zoomgs"
        # Upstream resolves checkpoints/... relative to cwd; the lyra2 image links
        # /opt/lyra/Lyra-2/checkpoints -> /models/tera/lyra2/checkpoints.
        env = {"PYTHONPATH": _pythonpath(self.code), "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
        argv = [sys.executable, "-m", "lyra_2._src.inference.lyra2_zoomgs_inference",
                "--input_image_path", str(samples), "--sample_id", "0", "--experiment", "lyra2",
                "--checkpoint_dir", str(self.ckpt / "model"), "--prompt_dir", str(samples),
                "--output_path", str(outdir),
                "--num_frames_zoom_in", str(int(ctx.params.get("frames_in", 81))),
                "--num_frames_zoom_out", str(int(ctx.params.get("frames_out", 241))),
                "--zoom_in_strength", str(float(ctx.params.get("zoom_in", 0.5))),
                "--zoom_out_strength", str(float(ctx.params.get("zoom_out", 1.5)))]
        if ctx.params.get("dmd", True):
            argv.append("--use_dmd")  # ~35 s per 80 frames on H100 instead of ~9 min
        ctx.run(argv, env=env, cwd=self.code, progress_span=(0.02, 0.75))
        video = outdir / "videos" / "0.mp4"
        if not video.is_file():
            raise BackendError(f"Lyra 2 wrote no {video}")
        ctx.run([sys.executable, "-m", "lyra_2._src.inference.vipe_da3_gs_recon",
                 "--input_video_path", str(video)], env=env, cwd=self.code, progress_span=(0.75, 0.95))
        plys = sorted(glob.glob(str(outdir / "**/reconstructed_scene.ply"), recursive=True))
        if not plys:
            raise BackendError("Lyra 2 reconstruction wrote no reconstructed_scene.ply")
        return _finish_splat(ctx, Path(plys[0]))
