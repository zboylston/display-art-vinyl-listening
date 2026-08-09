import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Shazam } from "shazam-api";
import { mapShazamRoot } from "./shazam";
import { SHAZAM_MAX_FINGERPRINT_MS, shazamFingerprintDurationMs, takeTrailingShazamFingerprint } from "./shazam-timing";

type ShazamRoot = NonNullable<Awaited<ReturnType<Shazam["fullRecognizeSong"]>>>;

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

describe("trailing Shazam fingerprint window", () => {
  it("keeps short clips intact", () => {
    const samples = new Float32Array(16_000 * 8);
    const result = takeTrailingShazamFingerprint(samples, 16_000);
    expect(result.samples).toBe(samples);
    expect(result.discardedMs).toBe(0);
    expect(result.fingerprintMs).toBe(8_000);
  });

  it("keeps only the newest 12 seconds of a longer clip", () => {
    const samples = new Float32Array(16_000 * 24);
    for (let index = 0; index < samples.length; index += 1) samples[index] = index;
    const result = takeTrailingShazamFingerprint(samples, 16_000);
    expect(result.samples.length).toBe(16_000 * 12);
    expect(result.samples[0]).toBe(16_000 * 12);
    expect(result.samples[result.samples.length - 1]).toBe(samples.length - 1);
    expect(result.discardedMs).toBe(12_000);
    expect(result.fingerprintMs).toBe(SHAZAM_MAX_FINGERPRINT_MS);
  });

  it("caps the timing advance at the fingerprint window", () => {
    expect(shazamFingerprintDurationMs(24_000)).toBe(12_000);
    expect(shazamFingerprintDurationMs(15_000)).toBe(12_000);
    expect(shazamFingerprintDurationMs(10_000)).toBe(10_000);
    expect(shazamFingerprintDurationMs(0)).toBe(0);
  });
});
