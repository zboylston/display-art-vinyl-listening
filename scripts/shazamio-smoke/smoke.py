#!/usr/bin/env python3
"""Minimal ShazamIO recognition smoke test."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from shazamio import Shazam


async def main() -> int:
    sample = Path(__file__).with_name("gloria.ogg")
    if not sample.exists():
        print(f"missing sample: {sample}", file=sys.stderr)
        return 1

    print(f"recognizing {sample.name} ({sample.stat().st_size} bytes)…")
    shazam = Shazam()
    result = await shazam.recognize(str(sample))

    track = result.get("track") or {}
    matches = result.get("matches") or []
    summary = {
        "title": track.get("title"),
        "subtitle": track.get("subtitle"),
        "key": track.get("key"),
        "isrc": track.get("isrc"),
        "albumadamid": track.get("albumadamid"),
        "genres": (track.get("genres") or {}).get("primary"),
        "match_count": len(matches),
        "offset": matches[0].get("offset") if matches else None,
        "hub_provider": ((track.get("hub") or {}).get("type")),
    }
    print(json.dumps(summary, indent=2))
    if not track.get("title"):
        print("no track match", file=sys.stderr)
        print(json.dumps({k: result.get(k) for k in ("matches", "tagid", "location")}, indent=2))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
