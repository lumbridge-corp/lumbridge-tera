# Lumbridge Tera gen worker — shared base (NVIDIA arm64/amd64 PyTorch container).
# Build context: workers/   e.g.  docker build -f docker/base/Dockerfile -t tera-worker-base .
# 26.09 is the newest tag NVIDIA's DGX Spark playbooks use (torch 2.14/2.15, CUDA 13.4,
# Python 3.12, FA2 preinstalled). Override with --build-arg NGC=nvcr.io/nvidia/pytorch:25.11-py3.
ARG NGC=nvcr.io/nvidia/pytorch:26.09-py3
FROM ${NGC}

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TORCH_CUDA_ARCH_LIST="12.1" \
    MAX_JOBS=4 \
    TERA_HOST=127.0.0.1 \
    TERA_PORT=8874 \
    TERA_DATA_DIR=/data \
    TERA_MODELS_DIR=/models/tera \
    HF_HOME=/models/tera/hf-cache \
    HF_HUB_OFFLINE=1 \
    PYTHONPATH=/opt/tera/server

# Pin the NGC torch stack so no later `pip install` can swap in a PyPI wheel
# (NGC ships an empty /etc/pip/constraint.txt).
RUN pip list --format=freeze 2>/dev/null \
    | grep -i -E "^(torch|torchvision|torchaudio|triton|flash.attn|transformer.engine|numpy)==" \
    > /etc/pip/constraint.txt && cat /etc/pip/constraint.txt

COPY server /opt/tera/server
RUN python -c "import tera_worker, numpy, torch; print('tera', tera_worker.__version__, 'torch', torch.__version__, 'cuda', torch.version.cuda, 'arch', torch.cuda.get_arch_list())" \
 && python -m unittest discover -s /opt/tera/server/tests -t /opt/tera/server

EXPOSE 8874
WORKDIR /data
ENTRYPOINT ["python", "-m", "tera_worker"]
