#!/usr/bin/env python3
"""Probe ShazamIO recognize response shape vs AudD field usage."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from shazamio import Shazam


def pick(obj: Any, *path: str) -> Any:
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def summarize_sections(result: dict[str, Any]) -> dict[str, Any]:
    track = result.get("track") or {}
    matches = result.get("matches") or []
    hub = track.get("hub") or {}
    hub_actions = hub.get("actions") or []
    sections = track.get("sections") or []
    metadata = []
    lyrics_preview = None
    for section in sections:
        if section.get("type") == "SONG":
            metadata = section.get("metadata") or []
        if section.get("type") == "LYRICS":
            text = section.get("text") or []
            lyrics_preview = text[:3] if isinstance(text, list) else None

    apple_action = next((a for a in hub_actions if a.get("type") == "applemusicplay"), None)
    uri_action = next((a for a in hub_actions if a.get("type") == "uri"), None)

    # Fields our /api/recognize currently consumes from AudD:
    # artist, title, album, release_date, timecode, apple_music.{id,albumName,artwork,isrc,durationInMillis,genreNames}
    audd_analog = {
        "artist": track.get("subtitle"),
        "title": track.get("title"),
        "album_from_metadata": next(
            (m.get("text") for m in metadata if m.get("title") == "Album"), None
        ),
        "release_from_metadata": next(
            (m.get("text") for m in metadata if m.get("title") == "Released"), None
        ),
        "label_from_metadata": next(
            (m.get("text") for m in metadata if m.get("title") == "Label"), None
        ),
        "timecode_audd_style": None,  # AudD returns mm:ss; Shazam uses match.offset seconds
        "offset_seconds": matches[0].get("offset") if matches else None,
        "isrc": track.get("isrc"),
        "apple_music_id": (apple_action or {}).get("id") or track.get("key"),
        "albumadamid": track.get("albumadamid"),
        "artwork_url": pick(track, "images", "coverarthq") or pick(track, "images", "coverart"),
        "genre": pick(track, "genres", "primary"),
        "hub_type": hub.get("type"),
        "hub_provider_name": (hub.get("provider") or [{}])[0].get("type")
        if isinstance(hub.get("provider"), list)
        else pick(hub, "provider", "type"),
        "apple_uri": (uri_action or {}).get("uri"),
    }

    return {
        "top_level_keys": sorted(result.keys()),
        "track_keys": sorted(track.keys()) if isinstance(track, dict) else [],
        "match_keys": sorted(matches[0].keys()) if matches else [],
        "section_types": [s.get("type") for s in sections],
        "metadata_titles": [m.get("title") for m in metadata],
        "hub_action_types": [a.get("type") for a in hub_actions],
        "audd_field_map": audd_analog,
        "lyrics_preview": lyrics_preview,
        "raw_matches": matches[:3],
        "raw_images": track.get("images"),
        "raw_share": track.get("share"),
        "raw_url": track.get("url"),
        "raw_hub_options": {
            "explicit": hub.get("explicit"),
            "displayname": hub.get("displayname"),
            "image": hub.get("image"),
        },
    }


async def main() -> int:
    sample = Path(__file__).with_name("gloria.ogg")
    if not sample.exists():
        print(f"missing sample: {sample}", file=sys.stderr)
        return 1

    out_dir = Path(__file__).parent
    shazam = Shazam()
    print(f"recognizing {sample.name}…", flush=True)
    result = await shazam.recognize(str(sample))

    full_path = out_dir / "last-response.json"
    summary_path = out_dir / "last-probe.json"
    full_path.write_text(json.dumps(result, indent=2))
    summary = summarize_sections(result)
    summary_path.write_text(json.dumps(summary, indent=2))

    print(json.dumps(summary, indent=2))
    print(f"\nwrote {full_path.name} and {summary_path.name}", flush=True)

    track = result.get("track") or {}
    album_id = track.get("albumadamid")
    if album_id:
        print(f"\nfetching album {album_id}…", flush=True)
        album = await shazam.search_album(album_id=int(album_id))
        album_path = out_dir / "last-album.json"
        album_path.write_text(json.dumps(album, indent=2))
        tracks = (
            ((album.get("data") or [{}])[0].get("relationships") or {})
            .get("tracks", {})
            .get("data", [])
        )
        attrs = ((album.get("data") or [{}])[0].get("attributes") or {})
        album_summary = {
            "album_name": attrs.get("name"),
            "artist_name": attrs.get("artistName"),
            "release_date": attrs.get("releaseDate"),
            "track_count": len(tracks),
            "artwork": pick(attrs, "artwork", "url"),
            "tracks_preview": [
                {
                    "id": t.get("id"),
                    "name": pick(t, "attributes", "name"),
                    "artist": pick(t, "attributes", "artistName"),
                    "durationMs": pick(t, "attributes", "durationInMillis"),
                    "trackNumber": pick(t, "attributes", "trackNumber"),
                    "discNumber": pick(t, "attributes", "discNumber"),
                    "isrc": pick(t, "attributes", "isrc"),
                }
                for t in tracks[:8]
            ],
        }
        print(json.dumps(album_summary, indent=2))
        print(f"wrote {album_path.name}", flush=True)

    return 0 if track.get("title") else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
