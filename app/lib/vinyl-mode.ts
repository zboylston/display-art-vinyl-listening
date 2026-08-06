export const VINYL_BOUNDARY_EARLY_MS = 12_000;
export const VINYL_BOUNDARY_LATE_MS = 45_000;

export function remainingTrackMs(durationMs?: number, timecodeMs?: number) {
  if (!durationMs || durationMs <= 0) return undefined;
  return Math.max(5_000, durationMs - Math.max(0, timecodeMs ?? 0));
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
