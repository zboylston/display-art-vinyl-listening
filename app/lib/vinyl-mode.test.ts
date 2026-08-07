import { describe, expect, it } from "vitest";
import {
  findVinylAlbumIndex,
  isNearVinylBoundary,
  refinedVinylBoundaryAt,
  remainingTrackMs,
  shiftedBoundaryAfterPause,
  timecodeAtCaptureMs,
} from "./vinyl-mode";

describe("vinyl timing", () => {
  it("uses recognition timecode to estimate the remaining track", () => {
    expect(remainingTrackMs(180_000, 25_000)).toBe(155_000);
    expect(remainingTrackMs(undefined, 25_000)).toBeUndefined();
  });

  it("advances a rolling capture's timecode to the live playback position", () => {
    expect(timecodeAtCaptureMs(85_000, 15_000, 700)).toBe(100_700);
    expect(timecodeAtCaptureMs(undefined, 15_000, 700)).toBeUndefined();
  });

  it("only treats changes close to the predicted ending as album progression", () => {
    expect(isNearVinylBoundary(100_000, 89_000)).toBe(true);
    expect(isNearVinylBoundary(100_000, 70_000)).toBe(false);
    expect(isNearVinylBoundary(100_000, 145_000)).toBe(true);
    expect(isNearVinylBoundary(100_000, 146_000)).toBe(false);
  });

  it("freezes the predicted ending during a mid-track pause", () => {
    expect(shiftedBoundaryAfterPause(100_000, 40_000, 55_000)).toBe(115_000);
  });

  it("accepts small heartbeat boundary corrections and rejects large jumps", () => {
    expect(refinedVinylBoundaryAt(100_000, 112_000)).toBe(112_000);
    expect(refinedVinylBoundaryAt(100_000, 130_000)).toBe(100_000);
    expect(refinedVinylBoundaryAt(0, 100_000)).toBe(100_000);
  });
});

describe("findVinylAlbumIndex", () => {
  const keyFor = (track: { artist: string; title: string }) => `${track.artist}|${track.title}`.toLowerCase();

  it("finds the heard track inside a locked sequence", () => {
    const tracks = [
      { artist: "Herbie Hancock", title: "Maiden Voyage" },
      { artist: "Herbie Hancock", title: "The Eye of the Hurricane" },
      { artist: "Herbie Hancock", title: "Little One" },
    ];
    expect(findVinylAlbumIndex(tracks, { artist: "Herbie Hancock", title: "Little One" }, keyFor)).toBe(2);
    expect(findVinylAlbumIndex(tracks, { artist: "Herbie Hancock", title: "Cantaloupe Island" }, keyFor)).toBe(-1);
  });

  it("prefers the upcoming duplicate title over an earlier reprise", () => {
    const tracks = [
      { artist: "The Beatles", title: "Sgt. Pepper's Lonely Hearts Club Band" },
      { artist: "The Beatles", title: "With a Little Help from My Friends" },
      { artist: "The Beatles", title: "Sgt. Pepper's Lonely Hearts Club Band" },
    ];
    expect(findVinylAlbumIndex(
      tracks,
      { artist: "The Beatles", title: "Sgt. Pepper's Lonely Hearts Club Band" },
      keyFor,
      1,
    )).toBe(2);
  });

  it("wraps to an earlier track when rolling back after a false advance", () => {
    const tracks = [
      { artist: "Herbie Hancock", title: "Maiden Voyage" },
      { artist: "Herbie Hancock", title: "The Eye of the Hurricane" },
      { artist: "Herbie Hancock", title: "Little One" },
    ];
    // Optimistically advanced to track 3; AudD still hears track 1.
    expect(findVinylAlbumIndex(
      tracks,
      { artist: "Herbie Hancock", title: "Maiden Voyage" },
      keyFor,
      2,
    )).toBe(0);
  });
});
