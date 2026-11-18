# NVIDIA Kimodo text -> motion (SOMA checkpoints only: NVIDIA Open Model License).
# Build context: workers/    docker build -f docker/kimodo/Dockerfile -t tera-worker-kimodo .
# Needs at run time either TEXT_ENCODER_URL (a kimodo_textencoder server) or the LLM2Vec +
# meta-llama/Meta-Llama-3-8B-Instruct weights (gated, Llama 3 Community License) in
# TERA_KIMODO_TEXT_ENCODERS.
ARG BASE=tera-worker-base:latest
FROM ${BASE}
ARG KIMODO_REV=e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954
ARG SSE2NEON_REV=2272251cc3ad9cba8b8c47c4065811cfb396b802
ENV TERA_BACKENDS=kimodo,mock \
    TERA_KIMODO_CKPT=/models/tera/kimodo \
    TEXT_ENCODER_DEVICE=cuda
RUN apt-get update && apt-get install -y --no-install-recommends cmake build-essential && rm -rf /var/lib/apt/lists/* \
 && (rm -f /usr/local/bin/cmake || true)
RUN git clone https://github.com/nv-tlabs/kimodo.git /opt/kimodo && git -C /opt/kimodo checkout ${KIMODO_REV}
# MotionCorrection (foot-skate post-process, C++) is written with SSE intrinsics and
# -msse4.1 -mavx. On arm64, translate them with sse2neon (MIT, header-only) plus a
# one-function AVX polyfill.
COPY docker/kimodo/arm64/tera_simd_arm64.h /opt/src/tera_simd_arm64.h
RUN if [ "$(uname -m)" = "aarch64" ]; then \
      curl -fsSL https://raw.githubusercontent.com/DLTcollab/sse2neon/${SSE2NEON_REV}/sse2neon.h \
        -o /opt/kimodo/MotionCorrection/src/cpp/Math/sse2neon.h \
      && cp /opt/src/tera_simd_arm64.h /opt/kimodo/MotionCorrection/src/cpp/Math/ \
      && sed -i 's|#include <immintrin.h>|#include "tera_simd_arm64.h"|' /opt/kimodo/MotionCorrection/src/cpp/Math/SIMD.h \
      && sed -i 's/ -msse4.1 -mavx//' /opt/kimodo/MotionCorrection/CMakeLists.txt; fi
# NGC torch stays pinned by /etc/pip/constraint.txt (see base). Kimodo's own deps minus
# the demo/visualisation stack (gradio, scenepic -> cholespy, viser), which kimodo_gen does
# not import and which do not build on arm64 + Python 3.12.
RUN cd /opt/kimodo && nice -n 19 pip install "./MotionCorrection" \
 && nice -n 19 pip install "hydra-core>=1.3" "omegaconf>=2.3" "scipy>=1.10" "transformers==5.1.0" \
      "urllib3>=2.6.3" boto3 "peft>=0.18" "einops>=0.7" tqdm packaging "pydantic>=2.0" "filelock>=3.20.3" \
      "trimesh>=3.21.7" pillow "av>=16.1.0" bvhio huggingface_hub safetensors accelerate \
 && nice -n 19 pip install --no-deps "py-soma-x @ git+https://github.com/NVlabs/SOMA-X.git" \
 && SKIP_MOTION_CORRECTION_IN_SETUP=1 nice -n 19 pip install --no-deps -e .
# (Transformer Engine dlopens libcuda on import; no driver at build time -> toolkit stub.)
RUN mkdir -p /tmp/cudastub && ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cudastub/libcuda.so.1 \
 && LD_LIBRARY_PATH=/tmp/cudastub:$LD_LIBRARY_PATH python -c "import kimodo, motion_correction, kimodo.scripts.generate, kimodo.exports.motion_io; print('kimodo ok')" \
 && which kimodo_gen
WORKDIR /data
