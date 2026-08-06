export const MIDPOINT_MIN_REMAINING_MS = 45_000;
export const MIDPOINT_MIN_DELAY_MS = 30_000;
export const MIDPOINT_MAX_DELAY_MS = 75_000;
export const PRE_TRANSITION_LEAD_MS = 25_000;
export const MIN_SCHEDULED_CHECK_DELAY_MS = 5_000;

export type VinylHeartbeatPlan = {
  midpointAt: number;
  preTransitionAt: number;
};

/**
 * Plan two low-cost timing checks from a predicted track boundary.
 * The midpoint check is skipped on short remaining windows; the second check
 * stays close enough to the boundary to repair timecode drift before handoff.
 */
export function planVinylHeartbeats(now: number, boundaryAt: number): VinylHeartbeatPlan {
  const remaining = boundaryAt - now;
  if (remaining <= 0) return { midpointAt: 0, preTransitionAt: 0 };

  const midpointDelay = Math.min(
    MIDPOINT_MAX_DELAY_MS,
    Math.max(MIDPOINT_MIN_DELAY_MS, Math.round(remaining * 0.5)),
  );
  const midpointAt = remaining >= MIDPOINT_MIN_REMAINING_MS && midpointDelay < remaining
    ? now + midpointDelay
    : 0;

  const preTransitionAt = boundaryAt - PRE_TRANSITION_LEAD_MS;
  return {
    midpointAt,
    preTransitionAt: preTransitionAt >= now + MIN_SCHEDULED_CHECK_DELAY_MS ? preTransitionAt : 0,
  };
}
