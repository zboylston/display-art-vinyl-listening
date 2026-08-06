import { describe, expect, it } from "vitest";
import { isNearVinylBoundary, remainingTrackMs, shiftedBoundaryAfterPause } from "./vinyl-mode";

describe("vinyl timing", () => {
  it("uses recognition timecode to estimate the remaining track", () => {
    expect(remainingTrackMs(180_000, 25_000)).toBe(155_000);
    expect(remainingTrackMs(undefined, 25_000)).toBeUndefined();
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
});
