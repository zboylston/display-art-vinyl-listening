/** Open the near-end silence watch this far before the predicted boundary. */
export const VINYL_BOUNDARY_EARLY_MS = 20_000;
export const VINYL_BOUNDARY_LATE_MS = 45_000;
/** Ignore heartbeat re-anchors that jump the predicted ending by more than this. */
export const VINYL_BOUNDARY_REFINE_MAX_DELTA_MS = 20_000;
/**
 * When a track is identified with less than this much left, skip museum
 * curation — the art arrives too late and leaves the display stuck on the
 * wrong work through the next song.
 */
export const SKIP_ARTWORK_REMAINING_MS = 30_000;
/**
 * Remaining below this at identify time: treat the ending as imminent and
 * arm end-confirm immediately instead of waiting out a soft boundary timer.
 */
export const NEAR_END_FORCE_CONFIRM_MS = 15_000;

export function remainingTrackMs(durationMs?: number, timecodeMs?: number) {
  if (!durationMs || durationMs <= 0) return undefined;
  return Math.max(5_000, durationMs - Math.max(0, timecodeMs ?? 0));
}

/** Exact remaining time for presentation decisions (no 5s floor). */
export function estimatedRemainingMs(input: {
  durationMs?: number;
  timecodeMs?: number;
  boundaryAt?: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  if (input.boundaryAt && input.boundaryAt > now) return input.boundaryAt - now;
  if (!input.durationMs || input.durationMs <= 0 || input.timecodeMs === undefined) return undefined;
  return Math.max(0, input.durationMs - Math.max(0, input.timecodeMs));
}

export function shouldSkipArtworkForRemaining(remainingMs: number | undefined, thresholdMs = SKIP_ARTWORK_REMAINING_MS) {
  return remainingMs !== undefined && remainingMs < thresholdMs;
}

export type VinylBoundaryPlan = {
  boundaryAt: number;
  remainingMs: number | undefined;
  /** Start gapless end-confirm capture now — do not wait for the predicted end. */
  armEndConfirmNow: boolean;
};

/**
 * Schedule the post-identify boundary. Near-end locks are tightened: under
 * 15s remaining we arm end-confirm immediately; under 30s we avoid the 5s
 * padding floor so a short tail is not stretched.
 */
export function planVinylBoundaryAfterIdentify(input: {
  now: number;
  durationMs?: number;
  timecodeMs?: number;
}): VinylBoundaryPlan {
  const remainingMs = estimatedRemainingMs({
    durationMs: input.durationMs,
    timecodeMs: input.timecodeMs,
    now: input.now,
  });
  if (remainingMs === undefined) {
    return { boundaryAt: 0, remainingMs: undefined, armEndConfirmNow: false };
  }
  if (remainingMs < NEAR_END_FORCE_CONFIRM_MS) {
    return { boundaryAt: input.now, remainingMs, armEndConfirmNow: true };
  }
  if (remainingMs < SKIP_ARTWORK_REMAINING_MS) {
    return { boundaryAt: input.now + Math.max(1_000, remainingMs), remainingMs, armEndConfirmNow: false };
  }
  return { boundaryAt: input.now + Math.max(5_000, remainingMs), remainingMs, armEndConfirmNow: false };
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
