/** Open the near-end silence watch this far before the predicted boundary. */
export const VINYL_BOUNDARY_EARLY_MS = 20_000;
export const VINYL_BOUNDARY_LATE_MS = 45_000;
/** Ignore heartbeat re-anchors that jump the predicted ending by more than this. */
export const VINYL_BOUNDARY_REFINE_MAX_DELTA_MS = 20_000;

export function remainingTrackMs(durationMs?: number, timecodeMs?: number) {
  if (!durationMs || durationMs <= 0) return undefined;
  return Math.max(5_000, durationMs - Math.max(0, timecodeMs ?? 0));
}

/**
 * Apply a heartbeat/pre-transition boundary estimate only when it agrees with
 * the existing prediction. Large jumps usually mean a noisy fingerprint, not a
 * real timing correction — keeping the prior boundary avoids mid-song advances.
 */
export function refinedVinylBoundaryAt(currentBoundaryAt: number, proposedBoundaryAt: number) {
  if (!proposedBoundaryAt) return currentBoundaryAt;
  if (!currentBoundaryAt) return proposedBoundaryAt;
  return Math.abs(proposedBoundaryAt - currentBoundaryAt) <= VINYL_BOUNDARY_REFINE_MAX_DELTA_MS
    ? proposedBoundaryAt
    : currentBoundaryAt;
}

/**
 * AudD's timecode identifies the song position of the rolling fragment we
 * submit, rather than the wall-clock instant when its response arrives. Our
 * ring buffer ends at capture time, so advance the reported position by the
 * captured window before scheduling the next record boundary.
 */
export function timecodeAtCaptureMs(timecodeMs: number | undefined, sampleDurationMs = 0, elapsedSinceCaptureMs = 0) {
  if (timecodeMs === undefined) return undefined;
  return Math.max(0, timecodeMs + Math.max(0, sampleDurationMs) + Math.max(0, elapsedSinceCaptureMs));
}

export function isNearVinylBoundary(boundaryAt: number, now: number) {
  if (!boundaryAt) return false;
  const remaining = boundaryAt - now;
  return remaining <= VINYL_BOUNDARY_EARLY_MS && remaining >= -VINYL_BOUNDARY_LATE_MS;
}

export function shiftedBoundaryAfterPause(boundaryAt: number, pausedAt: number, resumedAt: number) {
  if (!boundaryAt || resumedAt <= pausedAt) return boundaryAt;
  return boundaryAt + (resumedAt - pausedAt);
}
