# TRELLIS.2 (MIT) image -> GLB worker. Build context: workers/
#   docker build -f docker/trellis/Dockerfile -t tera-worker-trellis .
# CPU-only build; CUDA extensions are compiled for TORCH_CUDA_ARCH_LIST=12.1 (GB10, sm_121).
ARG BASE=tera-worker-base:latest
FROM ${BASE}

ARG TRELLIS2_REV=75fbf0183001ed9876c8dbb35de6b68552ee08bd
ARG CUMESH_REV=12289e1062f0603f2f0d0771b02e1395d247f26f
ARG FLEXGEMM_REV=6dd94a859c26ee8246888502eada3dd8ad85532e
ARG UTILS3D_REV=9a4eb15e4021b67b12c460c7057d642626897ec8

ENV TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas \
    ATTN_BACKEND=flash_attn \
    SPARSE_CONV_BACKEND=flex_gemm \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    TERA_BACKENDS=trellis,mock

# Pure-python deps. Plain Pillow (pillow-simd does not build on arm64). No torch reinstall:
# the NGC torch already targets Blackwell. PIP_CONSTRAINT keeps NGC's pinned packages.
RUN nice -n 19 pip install imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja \
      trimesh "transformers>=4.56" zstandard kornia timm plyfile safetensors huggingface_hub \
 && nice -n 19 pip install --no-deps "git+https://github.com/EasternJournalist/utils3d.git@${UTILS3D_REV}"
# (utils3d is only used by TRELLIS.2's preview renderers; --no-deps skips moderngl/glcontext,
#  which need X11/EGL headers.)

# Attention: TRELLIS.2 sparse attention needs flash_attn (or xformers). NGC ships FA2;
# fail the build loudly if it is missing rather than at the first job.
RUN python -c "import flash_attn; print('flash_attn', flash_attn.__version__)"

# torch >= 2.10 headers require C++20; the extensions' setup.py files ask for C++17.
WORKDIR /opt/src
RUN git clone --recursive https://github.com/JeffreyXiang/CuMesh.git && git -C CuMesh checkout ${CUMESH_REV} \
 && git -C CuMesh submodule update --init --recursive \
 && sed -i 's/c++17/c++20/g' CuMesh/setup.py \
 && nice -n 19 pip install ./CuMesh --no-build-isolation --no-deps
RUN git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git && git -C FlexGEMM checkout ${FLEXGEMM_REV} \
 && git -C FlexGEMM submodule update --init --recursive \
 && sed -i 's/c++17/c++20/g' FlexGEMM/setup.py \
 && nice -n 19 pip install ./FlexGEMM --no-build-isolation --no-deps
RUN git clone https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS.2 && git -C /opt/TRELLIS.2 checkout ${TRELLIS2_REV} \
 && git -C /opt/TRELLIS.2 submodule update --init --recursive \
 && sed -i 's/c++17/c++20/g' /opt/TRELLIS.2/o-voxel/setup.py \
 && nice -n 19 pip install /opt/TRELLIS.2/o-voxel --no-build-isolation --no-deps

# nvdiffrast stub (real one is non-commercial; never called by Tera's adapter)
COPY docker/trellis/shims /opt/tera/shims
ENV PYTHONPATH=/opt/tera/server:/opt/TRELLIS.2:/opt/tera/shims

# Prove what we can without a GPU: imports, compiled arch of the extensions.
COPY docker/trellis/check.py /opt/tera/check_trellis.py
# No driver at build time: libraries that dlopen libcuda (Transformer Engine) get the
# toolkit's stub, for this check only.
RUN mkdir -p /tmp/cudastub && ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cudastub/libcuda.so.1 \
 && LD_LIBRARY_PATH=/tmp/cudastub:$LD_LIBRARY_PATH python /opt/tera/check_trellis.py

WORKDIR /data
