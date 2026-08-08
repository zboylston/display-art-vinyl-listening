#!/usr/bin/env python3
"""Replay saved WAV clips through AudD and Shazam providers and print a hit-rate table.

Usage:
  # Terminal A: pnpm dev
  # Terminal B:
  source scripts/shazamio-smoke/.venv/bin/activate
  python scripts/shazamio-smoke/replay.py [evals/local-audio]

Drops capture.wav files into evals/local-audio/ from the in-app audio-debug panel
(or copy gloria-clip.wav there) then run this script.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "evals" / "local-audio"
RECOGNIZE_URL = os.environ.get("RECOGNIZE_URL", "http://127.0.0.1:3000/api/recognize")


def post_recognize(wav_path: Path, provider: str) -> dict:
    boundary = "----shazamReplayBoundary"
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
    part("mode", b"vinyl")
    part("audio", wav_bytes, filename=wav_path.name, content_type="audio/wav")
    body.extend(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        RECOGNIZE_URL,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode())


def summarize(payload: dict) -> str:
    if payload.get("error"):
        return f"error:{payload['error']}"
    result = payload.get("result")
    if not result:
        return f"miss:{payload.get('warning') or 'no-match'}"
    title = result.get("title") or "?"
    artist = result.get("artist") or "?"
    offset = result.get("timecodeMs")
    offset_bit = f" @{offset}ms" if isinstance(offset, int) else ""
    return f"hit:{artist} — {title}{offset_bit}"


def main() -> int:
    audio_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR
    audio_dir.mkdir(parents=True, exist_ok=True)
    clips = sorted(audio_dir.glob("*.wav"))
    if not clips:
        # Seed with the Gloria smoke clip when nothing has been captured yet.
        seed = ROOT / "scripts" / "shazamio-smoke" / "gloria-clip.wav"
        if seed.exists():
            target = audio_dir / "gloria-clip.wav"
            if not target.exists():
                target.write_bytes(seed.read_bytes())
            clips = [target]
        else:
            print(f"no wav clips in {audio_dir}", file=sys.stderr)
            return 1

    print(f"replaying {len(clips)} clip(s) from {audio_dir} against {RECOGNIZE_URL}\n")
    scores = {"audd": 0, "shazam": 0}
    for clip in clips:
        print(f"== {clip.name} ==")
        for provider in ("audd", "shazam"):
            try:
                payload = post_recognize(clip, provider)
                line = summarize(payload)
                if line.startswith("hit:"):
                    scores[provider] += 1
                print(f"  {provider:6} {line}")
            except urllib.error.URLError as error:
                print(f"  {provider:6} unreachable:{error}")
                print("Start the app with `pnpm dev` and retry.", file=sys.stderr)
                return 3
            except Exception as error:  # noqa: BLE001
                print(f"  {provider:6} error:{error}")
        print()

    print(f"hits audd={scores['audd']}/{len(clips)} shazam={scores['shazam']}/{len(clips)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
