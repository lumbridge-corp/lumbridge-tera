import gzip
import math
import random
import struct
import tempfile
import unittest
from pathlib import Path

from tera_worker import splat

try:
    import numpy as np
except ImportError:
    np = None


def rand_cloud(n=300, deg=3, seed=1):
    r = random.Random(seed)
    dim = splat.SH_DIM[deg]
    pos = [r.uniform(-50, 50) for _ in range(3 * n)]
    col = [r.uniform(-2, 2) for _ in range(3 * n)]
    alp = [r.uniform(-6, 6) for _ in range(n)]
    sca = [r.uniform(-8, 1) for _ in range(3 * n)]
    rot = [r.uniform(-1, 1) for _ in range(4 * n)]
    sh = [r.uniform(-0.9, 0.9) for _ in range(3 * dim * n)]
    return splat.Cloud(n, pos, col, alp, sca, rot, sh, deg)


def decode_spz(data):
    """Reference decoder, following nianticlabs/spz unpack (no coordinate conversion)."""
    raw = gzip.decompress(data)
    magic, version, n, deg, fb, flags, _ = struct.unpack("<IIIBBBB", raw[:16])
    assert magic == splat.SPZ_MAGIC
    dim = splat.SH_DIM[deg]
    o = 16
    pos = []
    for i in range(3 * n):
        b = raw[o + 3 * i:o + 3 * i + 3]
        v = b[0] | (b[1] << 8) | (b[2] << 16)
        if v & 0x800000:
            v -= 1 << 24
        pos.append(v / (1 << fb))
    o += 9 * n
    alphas = list(raw[o:o + n]); o += n
    colors = [((c / 255) - 0.5) / splat.COLOR_SCALE for c in raw[o:o + 3 * n]]; o += 3 * n
    scales = [s / 16 - 10 for s in raw[o:o + 3 * n]]; o += 3 * n
    rots = []
    rb = 4 if version >= 3 else 3
    for i in range(n):
        b = raw[o + rb * i:o + rb * i + rb]
        if version >= 3:
            comp = struct.unpack("<I", b)[0]
            il = comp >> 30
            q = [0.0] * 4
            ss = 0.0
            for j in range(3, -1, -1):
                if j == il:
                    continue
                mag = comp & 511
                neg = (comp >> 9) & 1
                comp >>= 10
                q[j] = splat.SQRT1_2 * mag / 511 * (-1 if neg else 1)
                ss += q[j] ** 2
            q[il] = math.sqrt(max(0.0, 1 - ss))
        else:
            xyz = [c / 127.5 - 1 for c in b]
            q = xyz + [math.sqrt(max(0.0, 1 - sum(v * v for v in xyz)))]
        rots.append(q)  # x, y, z, w
    o += rb * n
    sh = list(raw[o:o + n * dim * 3])
    return dict(n=n, version=version, deg=deg, pos=pos, alphas=alphas, colors=colors,
                scales=scales, rots=rots, sh=sh)


def same_rotation(q1, q2, tol):
    dot = abs(sum(a * b for a, b in zip(q1, q2)))
    return dot > 1 - tol


class TestSpz(unittest.TestCase):
    def check_roundtrip(self, c, version):
        d = decode_spz(splat.encode_spz(c, version=version))
        self.assertEqual((d["n"], d["version"], d["deg"]), (c.n, version, c.sh_degree))
        for a, b in zip(c.positions, d["pos"]):
            self.assertAlmostEqual(a, b, delta=1 / 4096 + 1e-9)
        for a, b in zip(c.alphas, d["alphas"]):
            self.assertAlmostEqual(255 / (1 + math.exp(-a)), b, delta=0.51)
        for a, b in zip(c.colors, d["colors"]):
            if abs(a * 0.15 * 255 + 127.5) < 255 and a * 0.15 * 255 + 127.5 > 0:
                self.assertAlmostEqual(a, b, delta=0.02)
        for a, b in zip(c.scales, d["scales"]):
            self.assertAlmostEqual(a, b, delta=1 / 32 + 1e-9)
        tol = 2e-3 if version >= 3 else 2e-2
        for i in range(c.n):
            w, x, y, z = c.rotations[4 * i:4 * i + 4]
            nrm = math.sqrt(w * w + x * x + y * y + z * z)
            self.assertTrue(same_rotation([x / nrm, y / nrm, z / nrm, w / nrm], d["rots"][i], tol), i)
        dim = splat.SH_DIM[c.sh_degree]
        for i in range(c.n):
            for k in range(dim):
                for ch in range(3):
                    want = c.sh[i * 3 * dim + ch * dim + k]
                    got = (d["sh"][i * 3 * dim + k * 3 + ch] - 128) / 128
                    self.assertAlmostEqual(want, got, delta=(8 if k < 3 else 16) / 128 + 1e-6)

    def test_roundtrip_v3(self):
        self.check_roundtrip(rand_cloud(), 3)

    def test_roundtrip_v2(self):
        self.check_roundtrip(rand_cloud(deg=1), 2)

    def test_roundtrip_deg0(self):
        self.check_roundtrip(splat.test_cloud(64), 3)

    @unittest.skipIf(np is None, "numpy not installed")
    def test_numpy_matches_pure_python(self):
        for deg in (0, 1, 2, 3):
            for version in (2, 3):
                c = rand_cloud(200, deg, seed=deg)
                cn = splat.Cloud(c.n, *(np.asarray(getattr(c, k), np.float32) for k in
                                        ("positions", "colors", "alphas", "scales", "rotations", "sh")),
                                 c.sh_degree)
                # compare against pure python on the same float32-rounded values
                cp = splat.Cloud(c.n, *(np.asarray(getattr(cn, k), np.float64).tolist() for k in
                                        ("positions", "colors", "alphas", "scales", "rotations", "sh")),
                                 c.sh_degree)
                a = gzip.decompress(splat.encode_spz(cn, version=version))
                b = gzip.decompress(splat.encode_spz(cp, version=version))
                self.assertEqual(len(a), len(b))
                diff = sum(1 for x, y in zip(a, b) if x != y)
                self.assertLessEqual(diff, len(a) // 2000 + 2, (deg, version, diff))


class TestPly(unittest.TestCase):
    def test_ply_roundtrip_and_convert(self):
        c = rand_cloud(100, 3)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.ply"
            splat.write_ply(p, c)
            r = splat.read_ply(p)
            self.assertEqual((r.n, r.sh_degree), (100, 3))
            for k in ("positions", "colors", "alphas", "scales", "rotations", "sh"):
                for a, b in zip(getattr(c, k), list(getattr(r, k))):
                    self.assertAlmostEqual(a, float(b), places=4)
            n = splat.ply_to_spz(p, Path(d) / "a.spz", upright=True)
            self.assertEqual(n, 100)
            self.assertEqual(splat.read_spz_header(Path(d) / "a.spz")["points"], 100)

    def test_flip_twice_is_identity(self):
        c = rand_cloud(50, 3)
        f = splat.flip_upright(splat.flip_upright(c))
        for k in ("positions", "rotations", "sh"):
            for a, b in zip(getattr(c, k), list(getattr(f, k))):
                self.assertAlmostEqual(a, float(b), places=5)

    def test_filter_opacity(self):
        c = rand_cloud(200, 1)
        f = splat.filter_opacity(c, 0.5)
        self.assertEqual(f.n, sum(1 for a in c.alphas if a >= 0))
        self.assertEqual(len(f.sh), f.n * 9)

    def test_flip_moves_up_to_down(self):
        c = splat.Cloud(1, [0.0, 1.0, 2.0], [0, 0, 0], [0.0], [0, 0, 0], [1.0, 0, 0, 0], [], 0)
        f = splat.flip_upright(c)
        self.assertEqual([float(v) for v in f.positions], [0.0, -1.0, -2.0])


if __name__ == "__main__":
    unittest.main()
