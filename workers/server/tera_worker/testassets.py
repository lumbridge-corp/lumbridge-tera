"""Tiny, valid test files the mock backend returns: a .glb cube and a .bvh motion."""

from __future__ import annotations

import json
import math
import struct


def cube_glb(size: float = 1.0, color: tuple[float, float, float, float] = (0.85, 0.45, 0.2, 1.0)) -> bytes:
    """A single-mesh glTF 2.0 binary: a cube resting on y=0, with normals and a PBR colour."""
    h = size / 2
    faces = [  # normal, then 4 corners counter-clockwise seen from outside
        ((1, 0, 0), [(h, 0, -h), (h, size, -h), (h, size, h), (h, 0, h)]),
        ((-1, 0, 0), [(-h, 0, h), (-h, size, h), (-h, size, -h), (-h, 0, -h)]),
        ((0, 1, 0), [(-h, size, h), (h, size, h), (h, size, -h), (-h, size, -h)]),
        ((0, -1, 0), [(-h, 0, -h), (h, 0, -h), (h, 0, h), (-h, 0, h)]),
        ((0, 0, 1), [(h, 0, h), (h, size, h), (-h, size, h), (-h, 0, h)]),
        ((0, 0, -1), [(-h, 0, -h), (-h, size, -h), (h, size, -h), (h, 0, -h)]),
    ]
    pos, nor, idx = [], [], []
    for n, quad in faces:
        b = len(pos)
        pos += quad
        nor += [n] * 4
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    # make sure winding is CCW from outside: check with the first triangle of each face
    fixed = []
    for f in range(6):
        a, b_, c = (pos[idx[6 * f + k]] for k in range(3))
        u = [b_[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        n = nor[idx[6 * f]]
        tri = idx[6 * f:6 * f + 6]
        if sum(cross[i] * n[i] for i in range(3)) < 0:
            tri = [tri[0], tri[2], tri[1], tri[3], tri[5], tri[4]]
        fixed += tri
    idx = fixed

    pos_b = b"".join(struct.pack("<3f", *p) for p in pos)
    nor_b = b"".join(struct.pack("<3f", *n) for n in nor)
    idx_b = b"".join(struct.pack("<H", i) for i in idx)
    idx_b += b"\x00" * ((4 - len(idx_b) % 4) % 4)
    binbuf = pos_b + nor_b + idx_b
    gltf = {
        "asset": {"version": "2.0", "generator": "lumbridge-tera mock worker"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "mock-cube"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": list(color), "metallicFactor": 0.0,
                                                "roughnessFactor": 0.6}}],
        "buffers": [{"byteLength": len(binbuf)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_b), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_b), "byteLength": len(nor_b), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_b) + len(nor_b), "byteLength": len(idx) * 2, "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": [-h, 0, -h], "max": [h, size, h]},
            {"bufferView": 1, "componentType": 5126, "count": len(nor), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binbuf)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(binbuf), 0x004E4942) + binbuf
    return out


def wave_bvh(frames: int = 60, fps: int = 30) -> str:
    """A 3-joint arm that waves; enough to test a motion import path."""
    lines = [
        "HIERARCHY",
        "ROOT hips", "{", "  OFFSET 0 1 0", "  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation",
        "  JOINT shoulder", "  {", "    OFFSET 0.2 0.4 0", "    CHANNELS 3 Zrotation Xrotation Yrotation",
        "    JOINT elbow", "    {", "      OFFSET 0.3 0 0", "      CHANNELS 3 Zrotation Xrotation Yrotation",
        "      End Site", "      {", "        OFFSET 0.25 0 0", "      }", "    }", "  }", "}",
        "MOTION", f"Frames: {frames}", f"Frame Time: {1.0 / fps:.6f}",
    ]
    for f in range(frames):
        a = math.sin(2 * math.pi * f / frames)
        lines.append(f"0 1 0 0 0 0 {60 + 30 * a:.3f} 0 0 {45 * a:.3f} 0 0")
    return "\n".join(lines) + "\n"
