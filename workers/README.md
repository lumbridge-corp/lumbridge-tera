# Tera gen workers

A gen worker is a small HTTP service on a GPU box. It turns an image into a Gaussian splat
scene (`image_to_splat`), an image into a textured mesh (`image_to_model`), or text into
skeletal motion (`text_to_motion`). The API is section 7 of [CONTRACT.md](../CONTRACT.md).
`tera-mcp`'s `gen_*` tools call it.

- `server/`: the worker. Python 3.10+, standard library only (numpy is optional and makes
  splat conversion fast). It has one runner thread, so one GPU job runs at a time. Each
  job gets a folder on disk, and outputs are served at `/v1/files/<job>/<file>`.
- `server/tera_worker/backends/`: `mock`, `lyra1`, `lyra2` (research-only), `trellis`
  (TRELLIS.2) and `kimodo`. GPU backends run upstream code in a subprocess, so the GPU
  memory is freed when a job ends.
- `docker/<backend>/Dockerfile`: one image per backend. Each is built on
  `docker/base` = `nvcr.io/nvidia/pytorch:26.09-py3` (arm64 + amd64, Blackwell-ready).

## Models and licences

| backend | kind | model | weights licence | commercial | default |
|---|---|---|---|---|---|
| `lyra1` | image_to_splat | NVIDIA Lyra 1.0 (+ GEN3C-Cosmos-7B, Cosmos tokenizer, MoGe) | NVIDIA Open Model License (MoGe: MIT) | yes¹ | **yes** |
| `trellis` | image_to_model | Microsoft TRELLIS.2-4B (+ DINOv3 ViT-L, BiRefNet) | MIT (DINOv3 License², BiRefNet MIT) | yes³ | **yes** |
| `kimodo` | text_to_motion | NVIDIA Kimodo-SOMA-RP-v1.2 (+ LLM2Vec / Llama-3-8B-Instruct) | NVIDIA Open Model License (Llama 3 Community License⁴) | yes⁴ | yes, if available |
| `lyra2` | image_to_splat | NVIDIA Lyra 2.0 | NVIDIA Internal Scientific Research and Development Model License | **no**: `research-only` | never |
| `mock` | all three | none (generated test files) | Apache-2.0 | yes | only if nothing else is available |

Sources: [nvidia/Lyra](https://huggingface.co/nvidia/Lyra) ("ready for commercial use"),
[NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/),
[nvidia/Lyra-2.0](https://huggingface.co/nvidia/Lyra-2.0),
[R&D licence](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/),
[microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) + [TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B) (MIT),
[DINOv3 licence](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md),
[nvidia/Kimodo-SOMA-RP-v1.2](https://huggingface.co/nvidia/Kimodo-SOMA-RP-v1.2), [SOMA-X](https://github.com/NVlabs/SOMA-X) (Apache-2.0).

1. The Open Model License ends if you *bypass a model's safety guardrail without a
   substantially similar guardrail appropriate for your use case*. NVIDIA's own
   single-image script hard-codes `disable_guardrail = True`, and our worker runs it the
   same way, because the Cosmos guardrail needs the gated Llama-Guard-3-8B. Before you
   serve Lyra to the public, put an input/output content filter in front of it. Whether
   your filter is enough is a legal call for whoever runs the worker.
2. DINOv3 allows commercial use, with restrictions on military, ITAR and weapons use. The
   download is **gated (manual approval)**, so it needs an HF token whose account has
   accepted the licence.
3. Two upstream TRELLIS.2 defaults are non-commercial, and the worker avoids both:
   - **RMBG-2.0** background removal (CC BY-NC 4.0). The worker uses
     `ZhengPeng7/BiRefNet` (MIT) instead. Images with an alpha channel skip background
     removal entirely.
   - **nvdiffrast** in `o_voxel.postprocess.to_glb` (the NVIDIA Source Code License says
     "non-commercially … research or evaluation purposes only"). Our adapter bakes the UV
     texture with CuMesh (MIT) and a small PyTorch rasteriser
     (`adapters/trellis2_run.py`). The image ships an `nvdiffrast` stub, so the real library
     is never installed. `texture=nvdiffrast` exists only behind `TERA_ALLOW_NONCOMMERCIAL=1`
     and does not work in our image.
4. Kimodo's text encoder runs on the gated `meta-llama/Meta-Llama-3-8B-Instruct`, which is
   commercial with conditions (700M MAU cap, "Built with Meta Llama 3", AUP). The SMPL-X
   Kimodo checkpoint is R&D-only, and the backend refuses it.

TRELLIS v1 is not supported. It needs `spconv` (no aarch64 wheels), and it bakes GLB
textures through the Inria rasteriser (non-commercial).

## API (quick reference)

```bash
W=http://gpu-box:8874                 # your worker's private address
curl -s $W/v1/health | jq             # models, licences, availability, queue
curl -s -XPOST $W/v1/jobs -H 'content-type: application/json' \
  -d "{\"kind\":\"image_to_splat\",\"input\":{\"image\":\"data:image/png;base64,$(base64 -w0 room.png)\"}}"
# -> {"id":"j_...","status":"queued","model":"lyra1","license":"NVIDIA Open Model License"}
curl -s $W/v1/jobs/j_...              # status, progress 0..1, outputs [{url, format, bytes}]
curl -s -XDELETE $W/v1/jobs/j_...     # cancel (queued: dropped; running: killed)
```

- `input.image` can be a `data:` URI, bare base64, or an http(s) URL. URLs can be turned
  off with `TERA_ALLOW_URL_INPUT=0`.
- `params.model` picks a backend. Otherwise the worker uses the first enabled, available,
  non-research backend for the kind.
- Other `params`:
  - lyra1: `seed`, `movement` (camera distance factor, default 1), `min_opacity` (prune
    splats below this opacity, 0..1), `upright` (default true), `ply` (also return
    .ply, default true), `keep_intermediate`.
  - trellis: `seed`, `resolution` (`512` / `1024` / `1024_cascade` (default) /
    `1536_cascade`), `faces` (decimation target, default 500000), `texture` (`uv` (default)
    or `vertex`), `texture_size` (default 2048), `steps`.
  - kimodo: `duration` (1-10 s), `seed`, `steps`.
  - mock: `mock_delay`, `mock_fail`, `mock_points`.
- Outputs:
  - Splats come out as `scene.spz` (Niantic SPZ v3, gzip; Spark.js reads it) plus
    `scene.ply` (standard 3DGS layout). With `upright` (the default), the worker turns
    Lyra's OpenCV camera frame (+Y down, +Z forward) into the three.js frame (+Y up), so
    the splat drops into a Tera world without a rotation.
  - Meshes come out as `model.glb` (glTF 2.0, PBR, Y-up).
  - Motion comes out as `motion.bvh` (centimetres, 30 fps) plus `motion.npz`.
- Auth: set `TERA_TOKEN` to require `Authorization: Bearer <token>` on everything except
  `/v1/health`. The worker refuses to bind `0.0.0.0` without a token, so bind a private
  address (a LAN or VPN IP).

Convert any 3DGS .ply yourself: `python -m tera_worker.convert in.ply out.spz [--upright]`.

### Settings (env)

| var | default | |
|---|---|---|
| `TERA_HOST` / `TERA_PORT` | `127.0.0.1` / `8874` | bind address; use a private IP, never `0.0.0.0` |
| `TERA_BACKENDS` | `mock` (images set their own) | comma list in priority order |
| `TERA_ALLOW_RESEARCH` | `0` | `1` enables research-only backends (lyra2); they are never default |
| `TERA_DATA_DIR` | `./tera-jobs` (`/data` in images) | job folders; the oldest finished jobs are pruned past `TERA_KEEP_JOBS` (200) |
| `TERA_MODELS_DIR` | `~/models/tera` (`/models/tera` in images) | weights root |
| `TERA_PUBLIC_URL` | from the Host header | base URL put in front of output `url`s |
| `TERA_TOKEN` | none | bearer token |
| `TERA_JOB_TIMEOUT` | `3600` | seconds before a job's process is killed |

## Run without a GPU (mock): CI and development

```bash
cd workers/server
python3 -m unittest discover -s tests -t .           # tests (numpy/torch tests skip if missing)
python3 -m tera_worker --host 127.0.0.1 --port 8874  # mock backend, all three kinds
```

## Weights

The GPU backends read weights from `TERA_MODELS_DIR` in this layout. Download them from
Hugging Face (gated ones need an HF token whose account accepted the licence).

| path | from | size |
|---|---|---|
| `lyra1/checkpoints/Lyra/` | `nvidia/Lyra` (lyra_static.pt + lyra_dynamic.pt) | 132 MB |
| `lyra1/checkpoints/GEN3C-Cosmos-7B/` | `nvidia/GEN3C-Cosmos-7B` | 29 GB |
| `lyra1/checkpoints/Cosmos-Tokenize1-CV8x8x8-720p/` | `nvidia/Cosmos-Tokenize1-CV8x8x8-720p` | 2.0 GB |
| `hf-cache/` (MoGe) | `Ruicheng/moge-vitl` (MIT) | 1.3 GB |
| `trellis2/TRELLIS.2-4B/` | `microsoft/TRELLIS.2-4B`, without the shape/tex encoders (training only) | 15 GB |
| `trellis2/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16.*` | `microsoft/TRELLIS-image-large` (only the sparse-structure decoder TRELLIS.2 uses) | 148 MB |
| `hf-cache/` (BiRefNet) | `ZhengPeng7/BiRefNet` (MIT) | 445 MB |
| `kimodo/Kimodo-SOMA-RP-v1.2/` | `nvidia/Kimodo-SOMA-RP-v1.2` | 1.2 GB |
| `kimodo/SOMA-X/` | `nvidia/SOMA-X` (Apache-2.0) | 863 MB |
| **total** | | **47 GB** (Lyra 1 set 32 GB, TRELLIS.2 set 16.6 GB) |

Not downloaded:
- `google-t5/t5-11b` (45 GB). The worker runs GEN3C with `--disable_prompt_encoder`, which
  loads a dummy T5, so T5 is never read.
- The Cosmos guardrails and Pixtral, which are disabled.
- Lyra 2 (98 GB, research-only).
- DINOv3 and Llama-3-8B-Instruct, which are gated and need an HF token (see Known gaps).

## Images (built CPU-only)

```bash
cd workers
B="nice -n 19 docker build --network host"
$B -f docker/base/Dockerfile    -t tera-worker-base    .
$B -f docker/trellis/Dockerfile -t tera-worker-trellis .
$B -f docker/lyra1/Dockerfile   -t tera-worker-lyra1   .
$B -f docker/kimodo/Dockerfile  -t tera-worker-kimodo  .
# docker/lyra2 is written but not built (research-only; see Known gaps)
```

Each image runs a `check.py` at build time, with no GPU. It imports the whole inference
stack and lists the cubins compiled into every CUDA extension (`cuobjdump`), so a wrong
arch list fails the build instead of the first job.

Results of the first build on a GB10-class box with large unified memory (aarch64, CPU-only build; NGC 26.09 = torch
2.14.0a0, CUDA 13.4, Python 3.12):

| image | built | extensions compiled (cubins) | imports | notes |
|---|---|---|---|---|
| `tera-worker-base` | yes | none | worker plus all 23 tests (numpy and torch included) | 25.3 GB; NGC torch arch list `sm_80…sm_120 + compute_120` (sm_120 cubins run on sm_121) |
| `tera-worker-trellis` | yes | CuMesh, cuBVH, FlexGEMM, o-voxel: `sm_121`; NGC flash-attn 2.8.3: `sm_80…sm_120` | trellis2 pipelines/models, cumesh, adapter OK. `flex_gemm` and `o_voxel` query the GPU at import time, so they are checked on the first GPU run | `/v1/health` inside the image: trellis `available: true` with the downloaded weights |
| `tera-worker-lyra1` | yes | gsplat, mamba-ssm `selective_scan_cuda`, causal-conv1d: `sm_121` | TE 2.19, flash-attn, megatron-core 0.10, warp, MoGe v1, GEN3C pipeline, Lyra data/render modules: all OK | `/v1/health` inside the image: lyra1 `available: true` |
| `tera-worker-kimodo` | yes | MotionCorrection (CPU C++, SSE via sse2neon) | kimodo, `kimodo.scripts.generate` OK | `available: false` until a text encoder is configured (Llama 3 gated) |
| `tera-worker-lyra2` | **no** | | | written only; research-only, so not worth the build time now |

Upstream changes the images make, so they build on arm64 + CUDA 13 + torch 2.14:
- All extension `setup.py` files: `-std=c++17` → `c++20`. torch ≥ 2.10 headers require C++20.
- mamba-ssm / causal-conv1d: hard-coded `-gencode` → `sm_121`. CUDA 13's CCCL removed
  `cub::LaneId` / `cub::CTA_SYNC`, so they become `threadIdx.x % 32` / `__syncthreads()`.
- Lyra-1:
  - Transformer Engine 2.x moved `apply_rotary_pos_emb`; the import is patched with a TE 1.x
    fallback.
  - The unused autoregressive (Pixtral upsampler) TE imports are made optional.
  - `decord` has no aarch64 wheel, so it is replaced by a PyAV shim (`docker/lyra1/shims`).
  - GUI opencv is swapped for headless.
  - MoGe is installed without its deps (gradio, flex-gemm).
- TRELLIS.2:
  - utils3d is installed without moderngl.
  - Plain Pillow instead of pillow-simd (x86-only).
  - nvdiffrast stub.
  - BiRefNet replaces RMBG-2.0 at run time (patched `pipeline.json` view in the job folder).
- Kimodo:
  - MotionCorrection's SSE intrinsics go through sse2neon plus a one-function AVX polyfill.
  - The demo stack (gradio, scenepic/cholespy, viser) is skipped.
- Build-time checks use the CUDA toolkit's `libcuda` stub, because Transformer Engine dlopens
  it on import.

## First GPU run: checklist

Estimates for a GB10-class box with large unified memory:

| job | peak memory (estimate) | time per job (estimate) |
|---|---|---|
| trellis `1024_cascade` | 24-30 GB (upstream: "at least 24 GB") | about 1-3 min (H100: 17 s + GLB export; GB10 is several times slower). Try the `512` resolution first |
| lyra1 | about 43 GB with offloading (upstream max on H100). Unified memory makes offloading pointless, so plan for 45-75 GB | stage 1: several min to tens of min (35-step 7B video diffusion for 6 trajectories × 121 frames at 704×1280); stage 2: about 1-2 min |
| kimodo | 3 GB (text encoder on CPU) to 17 GB | seconds |

1. Make sure the GPU has enough free memory: at least the job's peak plus 8 GB.
2. Start the worker for one job, published on a private address only:
   ```bash
   docker run --rm -d --name tera-worker --gpus all --ipc=host --ulimit memlock=-1 \
     -v ~/models/tera:/models/tera:ro -v ~/tera-jobs:/data \
     -p <private-ip>:8874:8874 -e TERA_HOST=0.0.0.0 -e TERA_TOKEN=$(openssl rand -hex 16) \
     tera-worker-trellis            # or tera-worker-lyra1
   ```
   Inside the container the worker listens on 0.0.0.0 with a token; Docker publishes it on
   the private address only.
3. Smoke test: `curl -s <private-ip>:8874/v1/health`. Then POST one job (see above),
   watch `docker stats tera-worker`, and read `~/tera-jobs/jobs/<id>/log.txt`. trellis
   writes measured `seconds` and `peak_gpu_gb` to `stats.json`.
4. Stop: `docker stop tera-worker`.

First things to check on the GPU:
- `torch.cuda.get_arch_list()` in the image. NGC builds torch for `…12.0+PTX`, and sm_120
  cubins run on sm_121.
- flash-attn FA2 kernels on sm_121.
- FlexGEMM's Triton kernels with `TRITON_PTXAS_PATH`.
- Transformer Engine attention for GEN3C.

## Notes

- **Cosmos3-Edge** (8.6 GB, OpenMDW-1.1 licence, "ready for
  commercial use") is a Cosmos 3 omnimodal world model: text/image/video → video/image. It
  is not part of Lyra 1, which needs GEN3C-Cosmos-7B, a Cosmos-Predict1 model. It is a good
  base for a later `restyle` or `image_to_video` backend (a Cosmos 3 transfer-style
  restyle of a rendered Tera video).
- Lyra 1's dynamic model (`lyra_dynamic.pt`, video → 4D splats) is downloaded but not
  wired up yet.
- Splat orientation: Lyra writes Gaussians in the first camera's OpenCV frame. TRELLIS
  GLBs are already Y-up.

## Known gaps

1. **Gated downloads.** Two need an HF token whose account accepted the licence:
   - `facebook/dinov3-vitl16-pretrain-lvd1689m`, TRELLIS.2's image encoder (manual approval,
     DINOv3 License). **TRELLIS.2 cannot run without it.**
     `HF_HOME=~/models/tera/hf-cache hf download facebook/dinov3-vitl16-pretrain-lvd1689m`.
   - `meta-llama/Meta-Llama-3-8B-Instruct` and
     `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp(-supervised)`, Kimodo's text encoder.
2. **Lyra guardrail clause.** NVIDIA's Open Model License ends if a model's guardrail is
   bypassed without a substantially similar one. Upstream's single-image script disables
   the Cosmos guardrail, and so does the worker. Put your own input/output filter in
   front of it before Lyra serves anyone outside your team.
3. **Not yet run on a GPU:** flex_gemm/o_voxel import, FA2 on sm_121, Triton
   kernels, the TE attention path in GEN3C, and real memory/time numbers. See the first-run
   checklist.
4. **Lyra 2**: Dockerfile written, not built. Known arm64 work remains:
   - tensorstore / numcodecs / pycolmap wheels.
   - DA3's numpy<2 pin.
   - UniDepth (used by ViPE) is CC-BY-NC.

   Its weights are research-only anyway.
5. **TRELLIS.2 texture bake**: the PyTorch UV rasteriser is unit-tested on CPU. The end-to-end
   GLB export (CuMesh unwrap → bake) runs for the first time on the GPU. `texture=vertex` is
   the fallback.
