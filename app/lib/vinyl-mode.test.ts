import { describe, expect, it } from "vitest";
import {
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
