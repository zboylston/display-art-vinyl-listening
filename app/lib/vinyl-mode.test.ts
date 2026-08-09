import { describe, expect, it } from "vitest";
import {
  estimatedRemainingMs,
  isNearVinylBoundary,
  planVinylBoundaryAfterIdentify,
  refinedVinylBoundaryAt,
  remainingTrackMs,
  shiftedBoundaryAfterPause,
  shouldSkipArtworkForRemaining,
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
    expect(isNearVinylBoundary(100_000, 80_000)).toBe(true);
    expect(isNearVinylBoundary(100_000, 79_000)).toBe(false);
    expect(isNearVinylBoundary(100_000, 145_000)).toBe(true);
    expect(isNearVinylBoundary(100_000, 146_000)).toBe(false);
  });

  it("freezes the predicted ending during a mid-track pause", () => {
    expect(shiftedBoundaryAfterPause(100_000, 40_000, 55_000)).toBe(115_000);
  });

  it("skips museum artwork when less than 30s remain on the identified track", () => {
    expect(estimatedRemainingMs({ durationMs: 180_000, timecodeMs: 160_000 })).toBe(20_000);
    expect(shouldSkipArtworkForRemaining(20_000)).toBe(true);
    expect(shouldSkipArtworkForRemaining(30_000)).toBe(false);
    expect(shouldSkipArtworkForRemaining(undefined)).toBe(false);
    expect(estimatedRemainingMs({ boundaryAt: 50_000, now: 40_000, durationMs: 180_000, timecodeMs: 0 })).toBe(10_000);
  });

  it("arms end-confirm immediately when a near-end lock has under 15s left", () => {
    const forced = planVinylBoundaryAfterIdentify({ now: 1_000_000, durationMs: 180_000, timecodeMs: 170_000 });
    expect(forced.remainingMs).toBe(10_000);
    expect(forced.armEndConfirmNow).toBe(true);
    expect(forced.boundaryAt).toBe(1_000_000);

    const shortTail = planVinylBoundaryAfterIdentify({ now: 1_000_000, durationMs: 180_000, timecodeMs: 155_000 });
    expect(shortTail.remainingMs).toBe(25_000);
    expect(shortTail.armEndConfirmNow).toBe(false);
    expect(shortTail.boundaryAt).toBe(1_000_000 + 25_000);

    const normal = planVinylBoundaryAfterIdentify({ now: 1_000_000, durationMs: 180_000, timecodeMs: 20_000 });
    expect(normal.armEndConfirmNow).toBe(false);
    expect(normal.boundaryAt).toBe(1_000_000 + 160_000);
  });
});
