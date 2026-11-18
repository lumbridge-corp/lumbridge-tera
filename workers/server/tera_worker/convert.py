"""ply -> spz on the command line: python -m tera_worker.convert in.ply out.spz [--upright]"""

from __future__ import annotations

import argparse
import sys

from . import splat


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tera-convert", description=__doc__)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--upright", action="store_true",
                    help="rotate 180 degrees about X (OpenCV +Y-down frame -> three.js +Y-up)")
    ap.add_argument("--spz-version", type=int, default=3, choices=(2, 3))
    a = ap.parse_args(argv)
    n = splat.ply_to_spz(a.src, a.dst, upright=a.upright, version=a.spz_version)
    print(f"{n} splats -> {a.dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
