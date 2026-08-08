#!/usr/bin/env python3
"""Compare Python ShazamIO against the local /api/recognize provider=shazam route.

Usage:
  # Terminal A: pnpm dev
  # Terminal B:
  source scripts/shazamio-smoke/.venv/bin/activate
  python scripts/shazamio-smoke/compare.py

Optional env:
  RECOGNIZE_URL   default http://127.0.0.1:3000/api/recognize
  SAMPLE_OGG      default scripts/shazamio-smoke/gloria.ogg
  SAMPLE_WAV      default scripts/shazamio-smoke/gloria-clip.wav
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from shazamio import Shazam


ROOT = Path(__file__).resolve().parent
SAMPLE_OGG = Path(os.environ.get("SAMPLE_OGG", ROOT / "gloria.ogg"))
SAMPLE_WAV = Path(os.environ.get("SAMPLE_WAV", ROOT / "gloria-clip.wav"))
RECOGNIZE_URL = os.environ.get("RECOGNIZE_URL", "http://127.0.0.1:3000/api/recognize")
OFFSET_TOLERANCE_MS = 2500


def post_recognize(wav_path: Path, provider: str) -> dict:
    boundary = "----shazamCompareBoundary"
    body = bytearray()
    wav_bytes = wav_path.read_bytes()

    def part(name: str, value: bytes, filename: str | None = None, content_type: str | None = None) -> None:
        body.extend(f"--{boundary}\r\n".encode())
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        body.extend(f"{disposition}\r\n".encode())
        if content_type:
            body.extend(f"Content-Type: {content_type}\r\n".encode())
        body.extend(b"\r\n")
        body.extend(value)
        body.extend(b"\r\n")

    part("provider", provider.encode())
    part("mode", b"live")
    part("audio", wav_bytes, filename="capture.wav", content_type="audio/wav")
    body.extend(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        RECOGNIZE_URL,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode())


async def shazamio_summary(path: Path) -> dict:
    result = await Shazam().recognize(str(path))
    track = result.get("track") or {}
    matches = result.get("matches") or []
    offset = matches[0].get("offset") if matches else None
    return {
        "title": track.get("title"),
        "artist": track.get("subtitle"),
        "offset_ms": int(round(offset * 1000)) if isinstance(offset, (int, float)) else None,
        "albumadamid": track.get("albumadamid"),
    }


def route_summary(payload: dict) -> dict:
    result = payload.get("result") or {}
    return {
        "provider": payload.get("provider"),
        "title": result.get("title"),
        "artist": result.get("artist"),
        "offset_ms": result.get("timecodeMs"),
        "album": result.get("album"),
        "collectionId": result.get("collectionId"),
        "error": payload.get("error"),
        "warning": payload.get("warning"),
    }


def agree(python_hit: dict, node_hit: dict) -> list[str]:
    problems: list[str] = []
    if not node_hit.get("title"):
        problems.append(f"node miss error={node_hit.get('error')!r} warning={node_hit.get('warning')!r}")
        return problems
    if (python_hit.get("title") or "").lower() != (node_hit.get("title") or "").lower():
        problems.append(f"title mismatch python={python_hit.get('title')!r} node={node_hit.get('title')!r}")
    if (python_hit.get("artist") or "").lower() != (node_hit.get("artist") or "").lower():
        problems.append(f"artist mismatch python={python_hit.get('artist')!r} node={node_hit.get('artist')!r}")
    py_ms = python_hit.get("offset_ms")
    node_ms = node_hit.get("offset_ms")
    if isinstance(py_ms, int) and isinstance(node_ms, int):
        if abs(py_ms - node_ms) > OFFSET_TOLERANCE_MS:
            problems.append(f"offset mismatch python={py_ms} node={node_ms} tol={OFFSET_TOLERANCE_MS}")
    else:
        problems.append(f"missing offset python={py_ms} node={node_ms}")
    return problems


async def main() -> int:
    sample_for_python = SAMPLE_WAV if SAMPLE_WAV.exists() else SAMPLE_OGG
    if not sample_for_python.exists():
        print(f"missing sample: {sample_for_python}", file=sys.stderr)
        return 1
    if not SAMPLE_WAV.exists():
        print(
            f"missing sample wav: {SAMPLE_WAV}\n"
            "Generate a ~15s mono 48 kHz clip, e.g.:\n"
            f"  ./scripts/shazamio-smoke/ffmpeg -ss 90 -t 15 -i {SAMPLE_OGG} "
            f"-ac 1 -ar 48000 -sample_fmt s16 {SAMPLE_WAV}",
            file=sys.stderr,
        )
        return 1

    print(f"ShazamIO recognize {sample_for_python.name}…", flush=True)
    python_hit = await shazamio_summary(sample_for_python)
    print(json.dumps({"python": python_hit}, indent=2))

    print(f"\nPOST provider=shazam {SAMPLE_WAV.name} → {RECOGNIZE_URL}…", flush=True)
    try:
        node_payload = post_recognize(SAMPLE_WAV, "shazam")
    except urllib.error.URLError as error:
        print(f"route unreachable: {error}", file=sys.stderr)
        print("Start the app with `pnpm dev` and retry.", file=sys.stderr)
        return 3
    node_hit = route_summary(node_payload)
    print(json.dumps({"node": node_hit}, indent=2))

    # Also hit AudD on the same clip for a side-by-side scorecard when the token is configured.
    print(f"\nPOST provider=audd {SAMPLE_WAV.name}…", flush=True)
    try:
        audd_payload = post_recognize(SAMPLE_WAV, "audd")
        audd_hit = route_summary(audd_payload)
        print(json.dumps({"audd": audd_hit}, indent=2))
    except Exception as error:  # noqa: BLE001 - comparison helper should keep going
        print(json.dumps({"audd_error": str(error)}, indent=2))

    problems = agree(python_hit, node_hit)
    if problems:
        print("\nDISAGREE:")
        for problem in problems:
            print(f"- {problem}")
        return 2

    print("\nAGREE: title/artist/offset within tolerance")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
