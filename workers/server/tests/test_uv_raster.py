import unittest

try:
    import torch
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "torch not installed (runs inside the trellis image)")
class TestUvRaster(unittest.TestCase):
    def test_two_triangles_cover_the_square(self):
        from tera_worker.adapters.trellis2_run import rasterize_uv

        uvs = torch.tensor([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])
        faces = torch.tensor([[0, 1, 2], [0, 2, 3]])
        fid, bary = rasterize_uv(uvs, faces, 16, chunk=50)
        self.assertTrue(bool((fid >= 0).all()))
        self.assertTrue(torch.allclose(bary.sum(1), torch.ones(256), atol=1e-5))
        # texel (x=15, y=0) is in the lower-right triangle (face 0)
        self.assertEqual(int(fid[0 * 16 + 15]), 0)
        self.assertEqual(int(fid[15 * 16 + 0]), 1)
        # barycentric interpolation reproduces texel centre uv
        pos = (uvs[faces[fid]] * bary.unsqueeze(-1)).sum(1)
        ys, xs = torch.meshgrid(torch.arange(16), torch.arange(16), indexing="ij")
        want = torch.stack([(xs.reshape(-1) + 0.5) / 16, (ys.reshape(-1) + 0.5) / 16], 1)
        self.assertTrue(torch.allclose(pos, want, atol=1e-5))

    def test_small_triangle_partial(self):
        from tera_worker.adapters.trellis2_run import rasterize_uv

        uvs = torch.tensor([[0.1, 0.1], [0.4, 0.1], [0.1, 0.4]])
        fid, _ = rasterize_uv(uvs, torch.tensor([[0, 1, 2]]), 32)
        n = int((fid >= 0).sum())
        area = 0.5 * (0.3 * 32) ** 2
        self.assertLess(abs(n - area) / area, 0.2)


if __name__ == "__main__":
    unittest.main()
