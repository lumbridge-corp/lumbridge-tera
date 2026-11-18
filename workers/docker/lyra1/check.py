"""Build-time check (no GPU): import Lyra-1's inference modules and list compiled archs."""

import glob
import importlib
import os
import subprocess
import sys

import torch

print("torch", torch.__version__, "cuda", torch.version.cuda, "arch list", torch.cuda.get_arch_list())
mods = ["transformer_engine.pytorch", "flash_attn", "megatron.core", "warp", "moge.model.v1", "gsplat",
        "mamba_ssm", "causal_conv1d", "kiui", "decord", "accelerate",
        "cosmos_predict1.diffusion.module.attention",
        "cosmos_predict1.diffusion.inference.world_generation_pipeline",
        "src.models.data.radym", "src.models.utils.render", "tera_worker.backends.lyra"]
bad = []
gpu_only = []
GPU_MARKERS = ("CUDA driver is a stub", "no CUDA GPUs", "cudaGetDeviceCount", "Found no NVIDIA driver")
for m in mods:
    try:
        importlib.import_module(m)
        print("import ok:", m)
    except Exception as e:  # noqa: BLE001
        if any(k in repr(e) for k in GPU_MARKERS):
            # built fine, but queries the device at import time -> verify on the GPU run
            print("import needs a GPU (deferred):", m)
            gpu_only.append(m)
            continue
        print("import FAIL:", m, repr(e)[:300])
        bad.append(m)
for pkg in ("gsplat", "mamba_ssm", "causal_conv1d", "selective_scan_cuda", "causal_conv1d_cuda"):
    spec = importlib.util.find_spec(pkg)
    if not spec or not spec.origin:
        continue
    base = os.path.dirname(spec.origin)
    sos = glob.glob(os.path.join(base, "**", "*.so"), recursive=True) if spec.submodule_search_locations else [spec.origin]
    for so in sos:
        out = subprocess.run(["cuobjdump", "--list-elf", so], capture_output=True, text=True).stdout
        archs = sorted({line.split(".")[-2] for line in out.splitlines() if ".sm_" in line})
        print(f"{os.path.basename(so)}: {archs or 'no cubins'}")
print("deferred to first GPU run:", gpu_only or "none")
sys.exit(1 if bad else 0)
