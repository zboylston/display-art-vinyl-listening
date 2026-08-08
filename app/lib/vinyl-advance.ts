/** How long a near-boundary silence may wait for real music before we abandon the advance. */
export const VINYL_GAP_LATCH_EXPIRE_MS = 15_000;
/** Mid-track quiet long enough to treat the record as stopped, not paused. */
export const VINYL_SUSTAINED_SILENCE_PARK_MS = 20_000;
/** After any predicted advance, confirm the next song actually started. */
export const VINYL_ADVANCE_VERIFY_MS = 12_000;

export type VinylGapLatch = {
  armedAt: number;
};

export function armVinylGapLatch(now: number): VinylGapLatch {
  return { armedAt: now };
}

export function isVinylGapLatchExpired(latch: VinylGapLatch | null | undefined, now: number) {
  if (!latch?.armedAt) return false;
  return now - latch.armedAt >= VINYL_GAP_LATCH_EXPIRE_MS;
}

export function shouldParkVinylOnSilence(silentSince: number, now: number) {
  return silentSince > 0 && now - silentSince >= VINYL_SUSTAINED_SILENCE_PARK_MS;
}

export function advanceVerificationAt(now: number, verifyMs = VINYL_ADVANCE_VERIFY_MS) {
  return now + verifyMs;
}

/**
 * A near-boundary silence latch may only advance after the detector confirms
 * sustained music again. The first quiet→resuming frame is not enough —
 * that fires on a cough or needle lift.
 */
export function shouldAdvanceOnGapResume(gapPending: boolean, event: string | null) {
  return gapPending && event === "music-resumed";
}

/**
 * Blind timer/spectral advances are only safe while music has been continuous.
 * Once we've heard silence (gap pending), parked, or paused, wait for confirmed
 * music-resumed / recognition instead of trusting the clock or spectrum.
 */
export function canPredictiveAdvance(input: {
  parked: boolean;
  paused: boolean;
  gapPending: boolean;
  detectorState?: string;
  /** Timer advances require stable continuous music through the boundary. */
  requireStable?: boolean;
}) {
  if (input.parked || input.paused || input.gapPending) return false;
  if (input.requireStable && input.detectorState !== "stable") return false;
  return true;
}

/** A predicted advance whose background verify returned no music should undo the guess. */
export function shouldRollbackUnverifiedAdvance(input: {
  pendingVerify: boolean;
  outcome: "match" | "same" | "none" | "error";
}) {
  return input.pendingVerify && (input.outcome === "none" || input.outcome === "error");
}

/** Index to restore after a failed advance verify; null if there is nothing to roll back to. */
export function rollbackAdvanceIndex(currentIndex: number) {
  if (currentIndex <= 0) return null;
  return currentIndex - 1;
}
