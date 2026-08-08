import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ShazamRoot } from "shazam-api";
import { mapShazamRoot } from "./shazam";

const fixture = JSON.parse(
  readFileSync(new URL("../../../evals/fixtures/shazam/i-will-survive.raw.json", import.meta.url), "utf8"),
) as ShazamRoot;

describe("mapShazamRoot", () => {
  it("maps the Gloria Gaynor fixture into ProviderMatch fields", () => {
    const match = mapShazamRoot(fixture);
    expect(match).toEqual({
      artist: "Gloria Gaynor",
      title: "I Will Survive",
      album: "Love Tracks",
      releaseDate: "1978",
      timecodeMs: 93916,
      isrc: "USUR10200634",
      appleTrackId: "1475006475",
      appleAlbumId: "1475006468",
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music123/v4/0c/72/a1/0c72a174-9208-6c86-e479-79865376e904/19UMGIM66006.rgb.jpg/400x400cc.jpg",
      genres: ["Pop"],
    });
  });

  it("returns null when the track title is missing", () => {
    expect(mapShazamRoot({ ...fixture, track: { ...fixture.track, title: "" } })).toBeNull();
  });
});
