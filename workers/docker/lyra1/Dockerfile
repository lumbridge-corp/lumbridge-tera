# NVIDIA Lyra 1.0 image -> 3DGS worker. Build context: workers/
#   docker build -f docker/lyra1/Dockerfile -t tera-worker-lyra1 .
# Upstream pins Python 3.10 / torch 2.6 / CUDA 12.4 / TE 1.12; this image keeps NGC's
# torch + Transformer Engine (sm_121 capable) and patches the one TE 2.x import change.
ARG BASE=tera-worker-base:latest
FROM ${BASE}

ARG LYRA_REV=9fffc9adc37004091ecf26ef03abfb3abdf4d59a
ARG GSPLAT_REV=73fad53c31ec4d6b088470715a63f432990493de
ARG MOGE_REV=74fbce054ebed49800de42d0ad0e83495065719a

ENV TERA_BACKENDS=lyra1,mock \
    TERA_LYRA1_CODE=/opt/lyra/Lyra-1 \
    TERA_LYRA1_CKPT=/models/tera/lyra1/checkpoints \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN git clone https://github.com/nv-tlabs/lyra.git /opt/lyra && git -C /opt/lyra checkout ${LYRA_REV}

# Inference deps from requirements_gen3c.txt + requirements_lyra.txt, minus: torch/torchvision
# (NGC), flash_attn (NGC FA2), transformer-engine (NGC), deepspeed + fused-ssim (training),
# decord (no aarch64 wheel -> PyAV shim), numpy/opencv/pillow/protobuf/setuptools pins (NGC).
RUN pip list --format=freeze 2>/dev/null | grep -i -E "^(nvidia-cutlass-dsl|quack-kernels)==" >> /etc/pip/constraint.txt \
 && nice -n 19 pip install \
      attrs einops==0.8.1 hydra-core==1.3.2 "imageio[pyav,ffmpeg]" iopath==0.1.10 loguru mediapy \
      nltk omegaconf==2.3.0 pandas peft==0.14.0 pynvml nvidia-ml-py pyyaml retinaface-py==0.0.2 \
      safetensors scikit-image sentencepiece termcolor tqdm transformers==4.49.0 diffusers==0.32.2 \
      warp-lang==1.7.2 better-profanity boto3 huggingface_hub timm==1.0.19 kiui==0.2.17 lru-dict \
      plyfile==1.1.2 accelerate==1.10.0 openexr av opencv-python-headless click scipy matplotlib \
 && nice -n 19 pip install --no-deps "git+https://github.com/microsoft/MoGe.git@${MOGE_REV}" \
      "git+https://github.com/EasternJournalist/utils3d-moge.git@62f09d58509485564e24d5d9f6aac9ee9ebc0c37" \
      "git+https://github.com/EasternJournalist/pipeline.git@1c511390d90226c00c101f34b84df26a0f8789b4"
# (MoGe without deps: its gradio / flex-gemm / torch requirements are not needed for
#  `moge.model.v1` inference and would fight the NGC torch.)
RUN nice -n 19 pip install --no-build-isolation --no-deps megatron-core==0.10.0

# torch >= 2.10 headers require C++20; these setup.py files ask for C++17.
# gsplat (CUDA, honours TORCH_CUDA_ARCH_LIST)
WORKDIR /opt/src
RUN git clone https://github.com/nerfstudio-project/gsplat.git && git -C gsplat checkout ${GSPLAT_REV} \
 && git -C gsplat submodule update --init --recursive \
 && sed -i 's/c++17/c++20/g' gsplat/setup.py \
 && BUILD_NO_CUDA=0 nice -n 19 pip install --no-build-isolation --no-deps ./gsplat

# mamba-ssm 2.2.4 + causal-conv1d 1.4.0: their setup.py hard-codes -gencode lists without
# Blackwell; patch them to sm_121 only. Lyra-1 uses mamba's Triton ops, but the package
# must build and import. CUDA 13's CCCL 3 removed cub::LaneId / cub::CTA_SYNC; swap in
# the plain CUDA equivalents.
RUN git clone -b v1.4.0 --depth 1 https://github.com/Dao-AILab/causal-conv1d.git \
 && git clone -b v2.2.4 --depth 1 https://github.com/state-spaces/mamba.git
COPY docker/lyra1/patch_gencode.py /opt/src/patch_gencode.py
RUN python patch_gencode.py causal-conv1d/setup.py mamba/setup.py \
 && sed -i 's/c++17/c++20/g' causal-conv1d/setup.py mamba/setup.py \
 && sed -i 's/cub::LaneId()/(threadIdx.x % 32)/g; s/cub::CTA_SYNC()/__syncthreads()/g' \
      mamba/csrc/selective_scan/*.cuh \
 && CAUSAL_CONV1D_FORCE_BUILD=TRUE nice -n 19 pip install --no-build-isolation --no-deps ./causal-conv1d \
 && MAMBA_FORCE_BUILD=TRUE nice -n 19 pip install --no-build-isolation --no-deps ./mamba

# Transformer Engine 2.x moved apply_rotary_pos_emb out of transformer_engine.pytorch.attention.
COPY docker/lyra1/patch_lyra.py /opt/src/patch_lyra.py
RUN python patch_lyra.py /opt/lyra/Lyra-1

# Some deps pull GUI opencv-python (needs libxcb); keep only the headless build.
RUN pip uninstall -y opencv-python opencv-contrib-python 2>/dev/null; \
    pip install --force-reinstall --no-deps opencv-python-headless \
 && python -c "import cv2; print('cv2', cv2.__version__)"

COPY docker/lyra1/shims /opt/tera/shims
ENV PYTHONPATH=/opt/tera/server:/opt/lyra/Lyra-1:/opt/tera/shims

COPY docker/lyra1/check.py /opt/tera/check_lyra1.py
# No driver at build time: libraries that dlopen libcuda (Transformer Engine) get the
# toolkit's stub, for this check only.
RUN mkdir -p /tmp/cudastub && ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cudastub/libcuda.so.1 \
 && cd /opt/lyra/Lyra-1 && LD_LIBRARY_PATH=/tmp/cudastub:$LD_LIBRARY_PATH python /opt/tera/check_lyra1.py

WORKDIR /data
