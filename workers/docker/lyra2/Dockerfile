# NVIDIA Lyra 2.0 — RESEARCH-ONLY weights (NVIDIA Internal Scientific Research and
# Development Model License). Never a default; the worker refuses to load it unless
# TERA_ALLOW_RESEARCH=1. Build context: workers/
#   docker build -f docker/lyra2/Dockerfile -t tera-worker-lyra2 .
# Status: written from Lyra-2/INSTALL.md, NOT built yet (see workers/README.md). Known
# arm64 work: flash-attn pin 2.6.3 has no Blackwell kernels (use NGC FA2), tensorstore /
# numcodecs / pycolmap lack aarch64 wheels, DA3 wants numpy<2.
ARG BASE=tera-worker-base:latest
FROM ${BASE}

ARG LYRA_REV=9fffc9adc37004091ecf26ef03abfb3abdf4d59a
ARG MOGE_REV=74fbce054ebed49800de42d0ad0e83495065719a
ENV TERA_BACKENDS=lyra2,mock \
    TERA_ALLOW_RESEARCH=0 \
    TERA_LYRA2_CODE=/opt/lyra/Lyra-2 \
    TERA_LYRA2_CKPT=/models/tera/lyra2/checkpoints \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN apt-get update && apt-get install -y --no-install-recommends libeigen3-dev && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/nv-tlabs/lyra.git /opt/lyra && git -C /opt/lyra checkout ${LYRA_REV}
WORKDIR /opt/lyra/Lyra-2
# requirements.txt minus torch/flash-attn pins and the packages without aarch64 wheels
RUN grep -v -i -E "^(torch|torchvision|flash.attn|transformer.engine|tensorstore|numcodecs|decord|pycolmap|numpy)" requirements.txt > /tmp/req.txt \
 && nice -n 19 pip install --no-deps -r /tmp/req.txt \
 && nice -n 19 pip install tensorstore numcodecs "git+https://github.com/microsoft/MoGe.git@${MOGE_REV}"
RUN USE_SYSTEM_EIGEN=1 nice -n 19 pip install --no-build-isolation -e lyra_2/_src/inference/vipe \
 && nice -n 19 pip install --no-build-isolation --no-deps -e lyra_2/_src/inference/depth_anything_3
# upstream resolves checkpoints/... relative to the repo
RUN ln -s /models/tera/lyra2/checkpoints /opt/lyra/Lyra-2/checkpoints
COPY docker/lyra1/shims /opt/tera/shims
ENV PYTHONPATH=/opt/tera/server:/opt/lyra/Lyra-2:/opt/tera/shims
WORKDIR /data
