/** Keep enough samples to average out one-off misses, but stay responsive. */
export const VINYL_TIMING_CALIBRATION_MAX_SAMPLES = 6;
/** Ignore absurd matches (skip to a much later track, provider glitch). */
export const VINYL_TIMING_CALIBRATION_MAX_ABS_MS = 45_000;

export type VinylTimingCalibration = {
  /** How late the previous predicted boundary was, in ms. Positive = late. */
  offsetMs: number;
  samples: number;
};

export function emptyVinylTimingCalibration(): VinylTimingCalibration {
  return { offsetMs: 0, samples: 0 };
}

/**
 * Fold one post-advance measurement into the running average.
 * Positive error means the previous track's boundary was that many ms late.
 */
export function updateVinylTimingCalibration(
  calibration: VinylTimingCalibration,
  errorMs: number,
  options: { maxAbsMs?: number; maxSamples?: number } = {},
): VinylTimingCalibration {
  const maxAbsMs = options.maxAbsMs ?? VINYL_TIMING_CALIBRATION_MAX_ABS_MS;
  const maxSamples = options.maxSamples ?? VINYL_TIMING_CALIBRATION_MAX_SAMPLES;
  if (!Number.isFinite(errorMs) || Math.abs(errorMs) > maxAbsMs) return calibration;

  const samples = Math.min(maxSamples, calibration.samples + 1);
  const offsetMs = Math.round(((calibration.offsetMs * calibration.samples) + errorMs) / samples);
  return { offsetMs, samples };
}
