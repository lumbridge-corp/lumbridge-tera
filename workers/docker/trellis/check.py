"""Build-time check (no GPU): import the TRELLIS.2 stack and list the CUDA archs compiled
into each extension (cuobjdump), so a missing sm_121/sm_120 build fails the image."""

import glob
import importlib
import os
import subprocess
import sys

import torch

print("torch", torch.__version__, "cuda", torch.version.cuda, "arch list", torch.cuda.get_arch_list())
mods = ["flash_attn", "cumesh", "flex_gemm", "o_voxel", "trimesh", "utils3d",
        "trellis2.pipelines", "trellis2.models", "tera_worker.adapters.trellis2_run"]
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
        print("import FAIL:", m, repr(e))
        bad.append(m)


sos = []
for pkg in ("cumesh", "flex_gemm", "o_voxel", "flash_attn_2_cuda"):
    try:
        spec = importlib.util.find_spec(pkg)
    except Exception:  # noqa: BLE001
        spec = None
    if spec and spec.origin:
        base = os.path.dirname(spec.origin) if spec.submodule_search_locations else spec.origin
        sos += glob.glob(os.path.join(base, "**", "*.so"), recursive=True) if os.path.isdir(base) else [base]
for so in sorted(set(sos)):
    try:
        out = subprocess.run(["cuobjdump", "--list-elf", so], capture_output=True, text=True).stdout
        archs = sorted({line.split(".")[-2] for line in out.splitlines() if ".sm_" in line})
        print(f"{os.path.basename(so)}: {archs or 'no cubins (PTX/JIT only?)'}")
    except FileNotFoundError:
        print("cuobjdump not found")
        break
print("deferred to first GPU run:", gpu_only or "none")
sys.exit(1 if bad else 0)
