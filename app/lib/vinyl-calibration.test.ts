import { describe, expect, it } from "vitest";
import {
  VINYL_TIMING_CALIBRATION_MAX_ABS_MS,
  emptyVinylTimingCalibration,
  updateVinylTimingCalibration,
} from "./vinyl-calibration";

describe("vinyl timing calibration", () => {
  it("starts with no correction", () => {
    expect(emptyVinylTimingCalibration()).toEqual({ offsetMs: 0, samples: 0 });
  });

  it("averages a late boundary measurement", () => {
    const first = updateVinylTimingCalibration(emptyVinylTimingCalibration(), 4_000);
    expect(first).toEqual({ offsetMs: 4_000, samples: 1 });

    const second = updateVinylTimingCalibration(first, 6_000);
    expect(second).toEqual({ offsetMs: 5_000, samples: 2 });
  });

  it("ignores implausible jumps", () => {
    const calibrated = updateVinylTimingCalibration(emptyVinylTimingCalibration(), 5_000);
    expect(updateVinylTimingCalibration(calibrated, VINYL_TIMING_CALIBRATION_MAX_ABS_MS + 1)).toBe(calibrated);
    expect(updateVinylTimingCalibration(calibrated, Number.NaN)).toBe(calibrated);
  });

  it("caps the sample count while keeping the average fresh", () => {
    let calibration = emptyVinylTimingCalibration();
    for (let index = 0; index < 10; index += 1) {
      calibration = updateVinylTimingCalibration(calibration, 10_000, { maxSamples: 6 });
    }
    expect(calibration.samples).toBe(6);
    // Capped rolling average: (prevAvg * 5 + new) / 6, starting from 10_000.
    expect(calibration.offsetMs).toBe(16_668);
  });
});
