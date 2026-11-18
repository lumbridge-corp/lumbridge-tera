"""Minimal stand-in for decord.VideoReader (no aarch64 wheels exist), backed by PyAV.

Covers what Lyra-1 uses: len(reader), reader.get_batch(indices).asnumpy(), reader[i].
"""

from __future__ import annotations

import numpy as np

__version__ = "0.0-tera-shim"


class _Batch:
    def __init__(self, arr):
        self._a = arr

    def asnumpy(self):
        return self._a

    def numpy(self):
        return self._a


class VideoReader:
    def __init__(self, uri, ctx=None, width=-1, height=-1, num_threads=0, **_):
        import av

        frames = []
        with av.open(str(uri)) as c:
            stream = c.streams.video[0]
            self._fps = float(stream.average_rate or 0)
            for f in c.decode(stream):
                img = f.to_ndarray(format="rgb24")
                frames.append(img)
        self._frames = np.stack(frames) if frames else np.zeros((0, 1, 1, 3), np.uint8)

    def __len__(self):
        return len(self._frames)

    def __getitem__(self, i):
        return _Batch(self._frames[i])

    def get_batch(self, indices):
        return _Batch(self._frames[np.asarray(list(indices), dtype=np.int64)])

    def get_avg_fps(self):
        return self._fps


def bridge_set_bridge(*_a, **_k):  # decord.bridge.set_bridge compatibility no-op
    return None


class cpu:  # noqa: N801 - decord API
    def __init__(self, *_a, **_k):
        pass


gpu = cpu
