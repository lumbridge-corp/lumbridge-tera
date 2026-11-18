"""Stub for nvdiffrast.torch. Any use raises: Tera bakes textures without nvdiffrast."""


def __getattr__(name):
    raise RuntimeError(
        f"nvdiffrast.torch.{name}: nvdiffrast is not installed in this image (non-commercial licence). "
        "Use texture=uv or texture=vertex.")
