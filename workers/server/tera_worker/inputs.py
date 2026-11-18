"""Decode a job's input image: data: URI, bare base64, or http(s) URL."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import socket
import urllib.parse
import urllib.request
from pathlib import Path


class InputError(Exception):
    pass


def sniff(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _fetch(url: str, limit: int) -> bytes:
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise InputError("image URL must be http(s)")
    # Refuse link-local / metadata addresses; private tailnet IPs are fine (that is the use).
    try:
        for info in socket.getaddrinfo(u.hostname, u.port or 80, proto=socket.IPPROTO_TCP):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
                raise InputError("image URL points at a forbidden address")
    except socket.gaierror as e:
        raise InputError(f"cannot resolve image host: {e}") from None
    req = urllib.request.Request(url, headers={"User-Agent": "tera-worker"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - scheme checked above
            data = r.read(limit + 1)
    except OSError as e:
        raise InputError(f"cannot fetch image: {e}") from None
    if len(data) > limit:
        raise InputError("image is too large")
    return data


def decode(src: str, config) -> bytes:
    if not isinstance(src, str) or not src:
        raise InputError("input.image must be a URL, a data: URI or base64")
    limit = config.max_input_bytes
    if src.startswith(("http://", "https://")):
        if not config.allow_url_input:
            raise InputError("URL inputs are disabled on this worker; send base64")
        return _fetch(src, limit)
    if src.startswith("data:"):
        head, _, payload = src.partition(",")
        if ";base64" not in head:
            raise InputError("data: URI must be base64")
        src = payload
    if len(src) > limit * 4 // 3 + 16:
        raise InputError("image is too large")
    try:
        return base64.b64decode(src, validate=False)
    except (binascii.Error, ValueError):
        raise InputError("input.image is not valid base64") from None


def save_image(src: str, job_dir: Path, config) -> Path:
    data = decode(src, config)
    ext = sniff(data)
    if ext is None:
        raise InputError("input.image must be a PNG, JPEG or WebP")
    p = job_dir / f"input.{ext}"
    p.write_bytes(data)
    return p
