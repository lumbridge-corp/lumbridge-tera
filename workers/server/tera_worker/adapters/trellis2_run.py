"""Run TRELLIS.2 once: image -> .glb. Executed by the trellis backend inside the trellis image.

    python -m tera_worker.adapters.trellis2_run --image in.png --out out/model.glb [options]

Licence notes (see workers/README.md):
- TRELLIS.2 code + weights: MIT. DINOv3 image encoder: DINOv3 License (commercial use OK,
  gated download). Background removal: ZhengPeng7/BiRefNet (MIT) instead of the upstream
  default briaai/RMBG-2.0 (CC BY-NC 4.0).
- Upstream's o_voxel.postprocess.to_glb bakes textures with nvdiffrast, whose licence is
  non-commercial. This adapter does not use nvdiffrast: `--texture uv` (default) unwraps
  with CuMesh (MIT) and rasterises the UV atlas with a small PyTorch rasteriser below;
  `--texture vertex` writes vertex colours. The image ships a stub `nvdiffrast` module
  so `import o_voxel` works without the real library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def progress(p: float, msg: str = "") -> None:
    print(f"TERA_PROGRESS {p:.3f} {msg}", flush=True)


# ------------------------------------------------------------------ UV rasteriser (torch)

def rasterize_uv(uvs, faces, size: int, chunk: int = 1 << 22):
    """Rasterise triangles given in UV space [0,1]^2 onto a size x size grid of texel centres.

    Returns (face_id [size*size] long, -1 = empty; bary [size*size, 3] float).
    Row index = v * size, like nvdiffrast's output when fed uv*2-1 as clip coordinates
    (upstream then flips V when writing glTF). Pure torch; runs on CPU or CUDA.
    """
    import torch

    dev = uvs.device
    tri = uvs[faces.long()].double() * size - 0.5  # (F,3,2), texel centres at integers
    lo = torch.ceil(tri.min(dim=1).values).clamp(0, size - 1).long()
    hi = torch.floor(tri.max(dim=1).values).clamp(0, size - 1).long()
    w = (hi[:, 0] - lo[:, 0] + 1).clamp(min=0)
    h = (hi[:, 1] - lo[:, 1] + 1).clamp(min=0)
    counts = w * h
    face_id = torch.full((size * size,), -1, dtype=torch.long, device=dev)
    bary = torch.zeros((size * size, 3), dtype=torch.float32, device=dev)
    nf = faces.shape[0]
    start = 0
    csum = torch.cumsum(counts, 0)
    while start < nf:
        base = csum[start - 1].item() if start > 0 else 0
        end = int(torch.searchsorted(csum, torch.tensor(base + chunk, device=dev), right=True).item())
        end = max(end, start + 1)
        fidx = torch.arange(start, min(end, nf), device=dev)
        cnt = counts[fidx]
        total = int(cnt.sum().item())
        if total == 0:
            start = end
            continue
        rep = torch.repeat_interleave(fidx, cnt)
        offs = torch.arange(total, device=dev) - torch.repeat_interleave(torch.cumsum(cnt, 0) - cnt, cnt)
        ww = w[rep]
        px = lo[rep, 0] + offs % ww
        py = lo[rep, 1] + offs // ww
        a, b, c = tri[rep, 0], tri[rep, 1], tri[rep, 2]
        p = torch.stack([px, py], dim=1).double()

        def edge(p0, p1, q):
            return (p1[:, 0] - p0[:, 0]) * (q[:, 1] - p0[:, 1]) - (p1[:, 1] - p0[:, 1]) * (q[:, 0] - p0[:, 0])

        area = edge(a, b, c)
        ok = area.abs() > 1e-12
        w0 = edge(b, c, p) / torch.where(ok, area, torch.ones_like(area))
        w1 = edge(c, a, p) / torch.where(ok, area, torch.ones_like(area))
        w2 = 1 - w0 - w1
        eps = -1e-6
        inside = ok & (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
        lin = (py * size + px)[inside]
        face_id[lin] = rep[inside]
        bary[lin] = torch.stack([w0, w1, w2], dim=1)[inside].float()
        start = end
    return face_id, bary


# ------------------------------------------------------------------ export

def export_glb(mesh, out: Path, *, texture: str, texture_size: int, decimate: int, verbose: bool) -> dict:
    import numpy as np
    import torch
    import trimesh
    import cumesh

    aabb = torch.tensor([[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], dtype=torch.float32, device="cuda")
    vertices = mesh.vertices.cuda()
    faces = mesh.faces.cuda()
    cm = cumesh.CuMesh()
    cm.init(vertices, faces)
    cm.fill_holes(max_hole_perimeter=3e-2)
    vertices, faces = cm.read()
    bvh = cumesh.cuBVH(vertices, faces)
    # upstream to_glb "standard pipeline" (no remesh): simplify, clean, simplify, clean
    cm.simplify(decimate * 3, verbose=verbose)
    for _ in range(2):
        cm.remove_duplicate_faces()
        cm.repair_non_manifold_edges()
        cm.remove_small_connected_components(1e-5)
        cm.fill_holes(max_hole_perimeter=3e-2)
        if _ == 0:
            cm.simplify(decimate, verbose=verbose)
    cm.unify_face_orientations()
    layout = mesh.layout

    def query(points):
        # project onto the original high-res surface first (as upstream does), then sample
        _, face_id, uvw = bvh.unsigned_distance(points, return_uvw=True)
        tri = vertices[faces[face_id.long()]]
        return mesh.query_attrs((tri * uvw.unsqueeze(-1)).sum(dim=1))

    def to_u8(x):
        return np.clip(x.detach().float().cpu().numpy() * 255, 0, 255).astype(np.uint8)

    def gl(v):  # TRELLIS is Z-up; glTF is Y-up (same swap as upstream to_glb)
        v = v.copy()
        v[:, 1], v[:, 2] = v[:, 2].copy(), -v[:, 1].copy()
        return v

    if texture == "vertex":
        cm.compute_vertex_normals()
        v, f = cm.read()
        normals = cm.read_vertex_normals()
        attrs = query(v)
        rgba = np.concatenate([to_u8(attrs[:, layout["base_color"]]), to_u8(attrs[:, layout["alpha"]])], 1)
        metallic = float(attrs[:, layout["metallic"]].mean())
        roughness = float(attrs[:, layout["roughness"]].mean())
        material = trimesh.visual.material.PBRMaterial(baseColorFactor=[255, 255, 255, 255],
                                                       metallicFactor=metallic, roughnessFactor=roughness)
        tm = trimesh.Trimesh(vertices=gl(v.cpu().numpy()), faces=f.cpu().numpy(),
                             vertex_normals=gl(normals.cpu().numpy()), process=False)
        tm.visual = trimesh.visual.ColorVisuals(tm, vertex_colors=rgba)
        tm.visual.material = material  # type: ignore[attr-defined]
    elif texture == "uv":
        import cv2
        from PIL import Image

        ov, of, ouv, vmap = cm.uv_unwrap(return_vmaps=True, verbose=verbose)
        ov, of, ouv, vmap = ov.cuda(), of.cuda(), ouv.cuda(), vmap.cuda()
        cm.compute_vertex_normals()
        onorm = cm.read_vertex_normals()[vmap]
        fid, bary = rasterize_uv(ouv, of, texture_size)
        mask = fid >= 0
        tri = ov[of[fid[mask]].long()]  # (M,3,3)
        pos = (tri * bary[mask].unsqueeze(-1)).sum(1)
        attrs = torch.zeros(texture_size * texture_size, mesh.attrs.shape[1], device="cuda")
        attrs[mask] = query(pos).float()
        attrs = attrs.reshape(texture_size, texture_size, -1)
        m = mask.reshape(texture_size, texture_size).cpu().numpy()
        inv = (~m).astype(np.uint8)
        base = cv2.inpaint(to_u8(attrs[..., layout["base_color"]]), inv, 3, cv2.INPAINT_TELEA)
        met = cv2.inpaint(to_u8(attrs[..., layout["metallic"]]), inv, 1, cv2.INPAINT_TELEA)[..., None]
        rou = cv2.inpaint(to_u8(attrs[..., layout["roughness"]]), inv, 1, cv2.INPAINT_TELEA)[..., None]
        alp = cv2.inpaint(to_u8(attrs[..., layout["alpha"]]), inv, 1, cv2.INPAINT_TELEA)[..., None]
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=Image.fromarray(np.concatenate([base, alp], -1)),
            baseColorFactor=np.array([255, 255, 255, 255], dtype=np.uint8),
            metallicRoughnessTexture=Image.fromarray(np.concatenate([np.zeros_like(met), rou, met], -1)),
            metallicFactor=1.0, roughnessFactor=1.0, alphaMode="OPAQUE", doubleSided=True)
        uv = ouv.cpu().numpy().copy()
        uv[:, 1] = 1 - uv[:, 1]
        tm = trimesh.Trimesh(vertices=gl(ov.cpu().numpy()), faces=of.cpu().numpy(),
                             vertex_normals=gl(onorm.cpu().numpy()), process=False,
                             visual=trimesh.visual.TextureVisuals(uv=uv, material=material))
    elif texture == "nvdiffrast":
        if os.environ.get("TERA_ALLOW_NONCOMMERCIAL") != "1":
            raise SystemExit("texture=nvdiffrast uses a non-commercial library; set TERA_ALLOW_NONCOMMERCIAL=1")
        import o_voxel

        tm = o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
                                        coords=mesh.coords, attr_layout=layout, voxel_size=mesh.voxel_size,
                                        aabb=[[-0.5] * 3, [0.5] * 3], decimation_target=decimate,
                                        texture_size=texture_size, remesh=True, remesh_band=1,
                                        remesh_project=0, verbose=verbose)
    else:
        raise SystemExit(f"unknown texture mode {texture}")
    tm.export(str(out))
    return {"vertices": int(len(tm.vertices)), "faces": int(len(tm.faces))}


def prepare_model_dir(model_dir: Path, ss_dec: Path, rembg: str, cache: Path) -> Path:
    """A view of the TRELLIS.2 folder with a pipeline.json that points at local files and
    the MIT BiRefNet background remover (upstream default is non-commercial RMBG-2.0)."""
    cache.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((model_dir / "pipeline.json").read_text())
    cfg["args"]["models"]["sparse_structure_decoder"] = str(ss_dec)
    cfg["args"]["rembg_model"]["args"]["model_name"] = rembg
    (cache / "pipeline.json").write_text(json.dumps(cfg, indent=1))
    link = cache / "ckpts"
    if not link.exists():
        link.symlink_to(model_dir / "ckpts")
    return cache


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model-dir", default=os.environ.get("TERA_TRELLIS2_DIR", "/models/tera/trellis2/TRELLIS.2-4B"))
    ap.add_argument("--ss-dec", default=os.environ.get(
        "TERA_TRELLIS2_SS_DEC", "/models/tera/trellis2/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16"))
    ap.add_argument("--rembg", default=os.environ.get("TERA_TRELLIS2_REMBG", "ZhengPeng7/BiRefNet"))
    ap.add_argument("--pipeline-type", default="1024_cascade", choices=["512", "1024", "1024_cascade", "1536_cascade"])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--decimate", type=int, default=500000)
    ap.add_argument("--texture", default="uv", choices=["uv", "vertex", "nvdiffrast"])
    ap.add_argument("--texture-size", type=int, default=2048)
    ap.add_argument("--steps", type=int, default=0, help="override sampler steps per stage (0 = upstream 12)")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)

    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    t0 = time.time()
    progress(0.02, "loading")
    import torch
    from PIL import Image
    from trellis2.pipelines import Trellis2ImageTo3DPipeline

    mdir = prepare_model_dir(Path(a.model_dir), Path(a.ss_dec), a.rembg, Path(a.out).parent.parent / "trellis-model")
    pipe = Trellis2ImageTo3DPipeline.from_pretrained(str(mdir))
    pipe.low_vram = False  # unified memory: moving stages CPU<->GPU only costs time
    pipe.cuda()
    progress(0.2, "loaded")
    image = Image.open(a.image)
    kw = {}
    if a.steps:
        kw = {k: {"steps": a.steps} for k in
              ("sparse_structure_sampler_params", "shape_slat_sampler_params", "tex_slat_sampler_params")}
    with torch.inference_mode():
        mesh = pipe.run(image, seed=a.seed, pipeline_type=a.pipeline_type, **kw)[0]
    progress(0.75, "generated")
    mesh.simplify(16777216)
    del pipe
    torch.cuda.empty_cache()
    stats = export_glb(mesh, Path(a.out), texture=a.texture, texture_size=a.texture_size,
                       decimate=a.decimate, verbose=a.verbose)
    stats["seconds"] = round(time.time() - t0, 1)
    stats["peak_gpu_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    print("TERA_STATS " + json.dumps(stats), flush=True)
    progress(1.0, "done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
