import { describe, expect, it } from "vitest";
import { planVinylHeartbeats } from "./vinyl-heartbeats";

describe("Vinyl heartbeats", () => {
  it("uses a bounded midpoint check and a pre-transition check", () => {
    expect(planVinylHeartbeats(0, 160_000)).toEqual({ midpointAt: 75_000, preTransitionAt: 135_000 });
  });

  it("keeps the midpoint useful for short tracks without scheduling it after the boundary", () => {
    expect(planVinylHeartbeats(0, 50_000)).toEqual({ midpointAt: 30_000, preTransitionAt: 25_000 });
  });

  it("skips heartbeats when a boundary is already too close or passed", () => {
    expect(planVinylHeartbeats(0, 30_000)).toEqual({ midpointAt: 0, preTransitionAt: 5_000 });
    expect(planVinylHeartbeats(100, 100)).toEqual({ midpointAt: 0, preTransitionAt: 0 });
  });
});
