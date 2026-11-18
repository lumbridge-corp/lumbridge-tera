"""Gaussian splat files: read/write 3DGS .ply, write Niantic .spz (v2/v3, gzip).

Spark.js loads both. The .spz encoding follows nianticlabs/spz (MIT) `packGaussians` /
`serializePackedGaussians`, written from scratch here so the worker needs no native build.

Coordinates are copied as-is: this module never converts between OpenCV (RDF, what 3DGS
.ply files usually hold) and three.js (RUB). Spark.js does not convert either, so a .ply
and the .spz made from it look the same in Tera. Use `flip_upright()` to turn an
OpenCV-frame cloud (+Y down, +Z forward) into a three.js-frame cloud (+Y up) when needed.

Works with numpy when it is installed (fast, millions of splats) and falls back to pure
Python for small clouds (the mock backend and tests).
"""

from __future__ import annotations

import gzip
import math
import struct
from dataclasses import dataclass
from pathlib import Path

try:  # numpy is in every GPU image; the mock backend and CI can run without it
    import numpy as np
except ImportError:  # pragma: no cover - exercised in the no-numpy test env
    np = None

SPZ_MAGIC = 0x5053474E  # "NGSP"
COLOR_SCALE = 0.15
SH_C0 = 0.28209479177387814
SQRT1_2 = 0.7071067811865476
SH_DIM = {0: 0, 1: 3, 2: 8, 3: 15}

# Sign of each real SH basis function (3DGS order, degree 1..3) under a 180-degree turn
# about X, i.e. (x, y, z) -> (x, -y, -z).
_SH_FLIP_X180 = [
    -1, -1, 1,  # deg 1: y, z, x
    -1, 1, 1, -1, 1,  # deg 2: xy, yz, 3z^2-1, xz, x^2-y^2
    -1, 1, -1, -1, 1, -1, 1,  # deg 3
]


@dataclass
class Cloud:
    """Flat arrays (numpy arrays or Python lists), 3DGS conventions:
    positions N*3; colors N*3 = SH DC coefficients (f_dc); alphas N = opacity logits;
    scales N*3 = log scales; rotations N*4 = quaternion (w, x, y, z) like ply rot_0..3;
    sh N*(3*dim) = f_rest in .ply order (all R coeffs, then G, then B)."""

    n: int
    positions: object
    colors: object
    alphas: object
    scales: object
    rotations: object
    sh: object
    sh_degree: int = 0


def _sh_degree_for(rest: int) -> int:
    for deg, dim in SH_DIM.items():
        if dim * 3 == rest:
            return deg
    raise ValueError(f"unsupported f_rest count {rest}")


# ---------------------------------------------------------------- PLY

_PLY_TYPES = {
    "float": "f", "float32": "f", "double": "d", "float64": "d",
    "uchar": "B", "uint8": "B", "char": "b", "int8": "b",
    "ushort": "H", "uint16": "H", "short": "h", "int16": "h",
    "uint": "I", "uint32": "I", "int": "i", "int32": "i",
}


def read_ply(path: str | Path) -> Cloud:
    data = Path(path).read_bytes()
    end = data.find(b"end_header\n")
    if not data.startswith(b"ply") or end < 0:
        raise ValueError("not a PLY file")
    header = data[:end].decode("ascii", "replace").splitlines()
    body = data[end + len(b"end_header\n"):]
    if "format binary_little_endian 1.0" not in header:
        raise ValueError("only binary_little_endian PLY is supported")
    n = 0
    props: list[tuple[str, str]] = []
    in_vertex = False
    for line in header:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                n = int(parts[2])
        elif parts[0] == "property" and in_vertex:
            if parts[1] == "list":
                raise ValueError("list properties in vertex element are not supported")
            props.append((parts[2], _PLY_TYPES[parts[1]]))
    names = [p[0] for p in props]
    rest_names = sorted((p for p in names if p.startswith("f_rest_")), key=lambda s: int(s[7:]))
    deg = _sh_degree_for(len(rest_names))
    fmt = "<" + "".join(t for _, t in props)
    stride = struct.calcsize(fmt)
    if len(body) < n * stride:
        raise ValueError("PLY body is shorter than the header says")

    def need(*keys):
        for k in keys:
            if k not in names:
                raise ValueError(f"PLY is missing property {k}")

    need("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
         "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")

    if np is not None:
        dt = np.dtype([(nm, "<" + t) for nm, t in props])
        a = np.frombuffer(body, dtype=dt, count=n)

        def cols(keys):
            return np.stack([a[k].astype(np.float32) for k in keys], axis=1).reshape(-1) if keys \
                else np.zeros(0, np.float32)

        return Cloud(
            n=n,
            positions=cols(["x", "y", "z"]),
            colors=cols(["f_dc_0", "f_dc_1", "f_dc_2"]),
            alphas=a["opacity"].astype(np.float32),
            scales=cols(["scale_0", "scale_1", "scale_2"]),
            rotations=cols(["rot_0", "rot_1", "rot_2", "rot_3"]),
            sh=cols(rest_names),
            sh_degree=deg,
        )

    idx = {nm: i for i, nm in enumerate(names)}
    pos, col, alp, sca, rot, sh = [], [], [], [], [], []
    for rec in struct.iter_unpack(fmt, body[: n * stride]):
        pos += [rec[idx["x"]], rec[idx["y"]], rec[idx["z"]]]
        col += [rec[idx[f"f_dc_{i}"]] for i in range(3)]
        alp.append(rec[idx["opacity"]])
        sca += [rec[idx[f"scale_{i}"]] for i in range(3)]
        rot += [rec[idx[f"rot_{i}"]] for i in range(4)]
        sh += [rec[idx[k]] for k in rest_names]
    return Cloud(n, pos, col, alp, sca, rot, sh, deg)


def write_ply(path: str | Path, c: Cloud) -> None:
    dim = SH_DIM[c.sh_degree]
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    names += [f"f_rest_{i}" for i in range(dim * 3)]
    names += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {c.n}"]
    head += [f"property float {nm}" for nm in names]
    head += ["end_header"]
    with open(path, "wb") as f:
        f.write(("\n".join(head) + "\n").encode("ascii"))
        if np is not None:
            cols = [
                np.asarray(c.positions, np.float32).reshape(c.n, 3),
                np.zeros((c.n, 3), np.float32),
                np.asarray(c.colors, np.float32).reshape(c.n, 3),
                np.asarray(c.sh, np.float32).reshape(c.n, dim * 3),
                np.asarray(c.alphas, np.float32).reshape(c.n, 1),
                np.asarray(c.scales, np.float32).reshape(c.n, 3),
                np.asarray(c.rotations, np.float32).reshape(c.n, 4),
            ]
            f.write(np.ascontiguousarray(np.concatenate(cols, axis=1)).astype("<f4").tobytes())
            return
        rec = struct.Struct("<" + "f" * len(names))
        k = dim * 3
        for i in range(c.n):
            vals = list(c.positions[3 * i:3 * i + 3]) + [0.0, 0.0, 0.0] + list(c.colors[3 * i:3 * i + 3])
            vals += list(c.sh[k * i:k * i + k]) + [c.alphas[i]] + list(c.scales[3 * i:3 * i + 3])
            vals += list(c.rotations[4 * i:4 * i + 4])
            f.write(rec.pack(*vals))


# ---------------------------------------------------------------- transforms

def flip_upright(c: Cloud) -> Cloud:
    """Rotate 180 degrees about X: OpenCV frame (RDF) <-> three.js frame (RUB)."""
    dim = SH_DIM[c.sh_degree]
    signs = _SH_FLIP_X180[:dim]
    if np is not None:
        p = np.asarray(c.positions, np.float32).reshape(-1, 3) * np.array([1, -1, -1], np.float32)
        r = np.asarray(c.rotations, np.float32).reshape(-1, 4) * np.array([1, 1, -1, -1], np.float32)
        sh = np.asarray(c.sh, np.float32).reshape(c.n, 3, dim) * np.array(signs, np.float32) if dim \
            else np.zeros((c.n, 0), np.float32)
        return Cloud(c.n, p.reshape(-1), c.colors, c.alphas, c.scales, r.reshape(-1),
                     sh.reshape(-1), c.sh_degree)
    p = [v * (-1 if i % 3 else 1) for i, v in enumerate(c.positions)]
    r = [v * (-1 if i % 4 >= 2 else 1) for i, v in enumerate(c.rotations)]
    sh = [v * signs[i % dim] for i, v in enumerate(c.sh)] if dim else []
    return Cloud(c.n, p, list(c.colors), list(c.alphas), list(c.scales), r, sh, c.sh_degree)


def filter_opacity(c: Cloud, min_alpha: float) -> Cloud:
    """Drop splats whose opacity (after sigmoid) is below min_alpha (0..1)."""
    if min_alpha <= 0:
        return c
    logit = math.log(min_alpha / (1 - min_alpha)) if min_alpha < 1 else float("inf")
    dim3 = SH_DIM[c.sh_degree] * 3
    if np is not None and not isinstance(c.alphas, list):
        keep = np.asarray(c.alphas) >= logit
        n = int(keep.sum())

        def sel(a, k):
            return np.asarray(a).reshape(c.n, k)[keep].reshape(-1) if k else np.zeros(0, np.float32)

        return Cloud(n, sel(c.positions, 3), sel(c.colors, 3), np.asarray(c.alphas)[keep],
                     sel(c.scales, 3), sel(c.rotations, 4), sel(c.sh, dim3), c.sh_degree)
    idx = [i for i in range(c.n) if c.alphas[i] >= logit]

    def pick(a, k):
        return [v for i in idx for v in a[k * i:k * i + k]]

    return Cloud(len(idx), pick(c.positions, 3), pick(c.colors, 3), [c.alphas[i] for i in idx],
                 pick(c.scales, 3), pick(c.rotations, 4), pick(c.sh, dim3) if dim3 else [], c.sh_degree)


# ---------------------------------------------------------------- SPZ

def _u8(x: float) -> int:
    # std::round rounds half away from zero; Python round() is banker's rounding.
    v = math.floor(x + 0.5) if x >= 0 else -math.floor(-x + 0.5)
    return 0 if v < 0 else 255 if v > 255 else int(v)


def _q_sh(x: float, bucket: int) -> int:
    q = (math.floor(x * 128.0 + 0.5) if x >= 0 else -math.floor(-x * 128.0 + 0.5)) + 128
    q = (q + bucket // 2) // bucket * bucket
    return 0 if q < 0 else 255 if q > 255 else int(q)


def _pack_quat(w: float, x: float, y: float, z: float, version: int) -> bytes:
    norm = math.sqrt(w * w + x * x + y * y + z * z) or 1.0
    q = [x / norm, y / norm, z / norm, w / norm]  # spz order: x, y, z, w
    if version < 3:
        s = -127.5 if q[3] < 0 else 127.5
        return bytes(_u8(q[i] * s + 127.5) for i in range(3))
    il = max(range(4), key=lambda i: abs(q[i]))
    negate = 1 if q[il] < 0 else 0
    comp = il
    for i in range(4):
        if i != il:
            negbit = (1 if q[i] < 0 else 0) ^ negate
            mag = int(511.0 * (abs(q[i]) / SQRT1_2) + 0.5)
            comp = ((comp << 10) | (negbit << 9) | mag) & 0xFFFFFFFF
    return struct.pack("<I", comp)


def encode_spz(c: Cloud, version: int = 3, fractional_bits: int = 12, sh1_bits: int = 5,
               sh_rest_bits: int = 4, antialiased: bool = False) -> bytes:
    """Return gzipped SPZ bytes (legacy single-stream layout, versions 2 and 3)."""
    if version not in (2, 3):
        raise ValueError("version must be 2 or 3")
    n, deg = c.n, c.sh_degree
    dim = SH_DIM[deg]
    header = struct.pack("<IIIBBBB", SPZ_MAGIC, version, n, deg, fractional_bits,
                         1 if antialiased else 0, 0)
    if np is not None and not isinstance(c.positions, list):
        body = _encode_np(c, version, fractional_bits, sh1_bits, sh_rest_bits)
    else:
        scale = float(1 << fractional_bits)
        pos = bytearray()
        for v in c.positions:
            f = int(_round_half_away(v * scale))
            pos += bytes((f & 0xFF, (f >> 8) & 0xFF, (f >> 16) & 0xFF))
        alphas = bytes(_u8(255.0 / (1.0 + math.exp(-a))) for a in c.alphas)
        colors = bytes(_u8(v * (COLOR_SCALE * 255.0) + 127.5) for v in c.colors)
        scales = bytes(_u8((v + 10.0) * 16.0) for v in c.scales)
        rots = b"".join(_pack_quat(*c.rotations[4 * i:4 * i + 4], version) for i in range(n))
        sh = bytearray()
        k3 = dim * 3
        for i in range(n):
            rest = c.sh[k3 * i:k3 * i + k3]
            for k in range(dim):  # spz: coefficient-major, RGB interleaved
                bits = sh1_bits if k < 3 else sh_rest_bits
                for ch in range(3):
                    sh.append(_q_sh(rest[ch * dim + k], 1 << (8 - bits)))
        body = bytes(pos) + alphas + colors + scales + rots + bytes(sh)
    return gzip.compress(header + body, compresslevel=6, mtime=0)


def _round_half_away(x: float) -> float:
    return math.floor(x + 0.5) if x >= 0 else -math.floor(-x + 0.5)


def _encode_np(c: Cloud, version, fractional_bits, sh1_bits, sh_rest_bits) -> bytes:
    n = c.n
    dim = SH_DIM[c.sh_degree]

    def rnd(x):  # round half away from zero, like std::round
        return np.sign(x) * np.floor(np.abs(x) + 0.5)

    def u8(x):
        return np.clip(rnd(x), 0, 255).astype(np.uint8)

    p = rnd(np.asarray(c.positions, np.float64) * (1 << fractional_bits)).astype(np.int64)
    p = (p & 0xFFFFFF).astype(np.uint32)
    pos = np.stack([p & 0xFF, (p >> 8) & 0xFF, (p >> 16) & 0xFF], axis=1).astype(np.uint8)
    alphas = u8(255.0 / (1.0 + np.exp(-np.asarray(c.alphas, np.float64))))
    colors = u8(np.asarray(c.colors, np.float64) * (COLOR_SCALE * 255.0) + 127.5)
    scales = u8((np.asarray(c.scales, np.float64) + 10.0) * 16.0)

    r = np.asarray(c.rotations, np.float64).reshape(n, 4)
    q = r[:, [1, 2, 3, 0]]  # (w,x,y,z) -> (x,y,z,w)
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    q = q / norm
    if version < 3:
        s = np.where(q[:, 3:4] < 0, -127.5, 127.5)
        rots = u8(q[:, :3] * s + 127.5)
    else:
        il = np.argmax(np.abs(q), axis=1)
        negate = (q[np.arange(n), il] < 0).astype(np.uint32)
        comp = il.astype(np.uint32)
        for i in range(4):
            keep = il != i
            negbit = (q[:, i] < 0).astype(np.uint32) ^ negate
            mag = (511.0 * (np.abs(q[:, i]) / SQRT1_2) + 0.5).astype(np.uint32)
            comp = np.where(keep, ((comp << 10) | (negbit << 9) | mag) & 0xFFFFFFFF, comp)
        comp = comp.astype("<u4")
        rots = comp.view(np.uint8).reshape(n, 4)

    if dim:
        rest = np.asarray(c.sh, np.float64).reshape(n, 3, dim).transpose(0, 2, 1)  # n, dim, 3
        bucket = np.full((dim, 1), 1 << (8 - sh_rest_bits), np.int64)
        bucket[:3] = 1 << (8 - sh1_bits)
        qv = rnd(rest * 128.0).astype(np.int64) + 128
        qv = (qv + bucket // 2) // bucket * bucket
        sh = np.clip(qv, 0, 255).astype(np.uint8).reshape(-1)
    else:
        sh = np.zeros(0, np.uint8)
    return b"".join(a.tobytes() for a in (pos, alphas, colors, scales, rots, sh))


def write_spz(path: str | Path, c: Cloud, **kw) -> None:
    Path(path).write_bytes(encode_spz(c, **kw))


def ply_to_spz(src: str | Path, dst: str | Path, *, upright: bool = False, **kw) -> int:
    """Convert a 3DGS .ply to .spz. Returns the number of splats."""
    c = read_ply(src)
    if upright:
        c = flip_upright(c)
    write_spz(dst, c, **kw)
    return c.n


def read_spz_header(path: str | Path) -> dict:
    with gzip.open(path, "rb") as f:
        magic, version, n, deg, fb, flags, _ = struct.unpack("<IIIBBBB", f.read(16))
    if magic != SPZ_MAGIC:
        raise ValueError("not an SPZ file")
    return {"version": version, "points": n, "sh_degree": deg, "fractional_bits": fb, "flags": flags}


def test_cloud(n: int = 512, seed: int = 7) -> Cloud:
    """A small coloured ball of splats (pure Python), used by the mock backend."""
    import random

    rnd = random.Random(seed)
    pos, col, alp, sca, rot = [], [], [], [], []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (i / max(1, n - 1)) * 2
        rad = math.sqrt(max(0.0, 1 - y * y))
        th = golden * i
        x, z = math.cos(th) * rad, math.sin(th) * rad
        pos += [x * 0.5, y * 0.5 + 0.5, z * 0.5]
        rgb = (0.5 + 0.5 * x, 0.5 + 0.5 * y, 0.5 + 0.5 * z)
        col += [(v - 0.5) / SH_C0 for v in rgb]
        alp.append(2.0)
        s = math.log(0.04 + 0.01 * rnd.random())
        sca += [s, s, s]
        rot += [1.0, 0.0, 0.0, 0.0]
    return Cloud(n, pos, col, alp, sca, rot, [], 0)
