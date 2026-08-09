/** How long a near-boundary silence may wait for real music before we abandon the advance. */
export const VINYL_GAP_LATCH_EXPIRE_MS = 15_000;
/** Mid-track quiet long enough to treat the record as stopped, not paused. */
export const VINYL_SUSTAINED_SILENCE_PARK_MS = 20_000;
/**
 * After a gap advance, wait this long before the verify snapshot so the new
 * track is clearly underway. Too early and the ring still holds the old track's
 * tail, so the verify clip is ambiguous and can false-match the previous song
 * (the advance-then-revert ping-pong).
 */
export const VINYL_ADVANCE_VERIFY_MS = 8_000;
/**
 * Snapshot length for post-advance verify and post-silence end-confirm. Keep it
 * short — a brief clip taken once the new song is playing cannot match the old
 * track, unlike a long window that spans the gap.
 */
export const VINYL_VERIFY_SNAPSHOT_SECONDS = 5;
/**
 * Gapless (already audible at the boundary): wait this long past the predicted
 * end before identifying — long enough for a mostly-new-track ring window,
 * short enough that the display does not feel stuck.
 */
export const VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS = 4_000;
/** After silence past the end timer, collect this much audible audio before identifying. */
export const VINYL_END_CONFIRM_CAPTURE_MS = 10_000;
/** Snapshot length when identifying a gapless end-confirm (favor post-boundary audio). */
export const VINYL_END_CONFIRM_GAPLESS_SNAPSHOT_SECONDS = 5;
/**
 * Prediction-first: arm the boundary identify this early, so the 5s capture
 * window straddles the predicted transition (a little old-track tail, mostly
 * new track) and the result lands right as the next song starts — instead of
 * arming at the boundary and identifying ~7s late.
 */
export const VINYL_BOUNDARY_IDENTIFY_LEAD_MS = 3_000;
/** How long to wait for sound after the end timer before parking. */
export const VINYL_END_CONFIRM_TIMEOUT_MS = 15_000;

/** Capture window for end-confirm: shorter when music never went silent (gapless). */
export function endConfirmCaptureMs(gapless: boolean) {
  return gapless ? VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS : VINYL_END_CONFIRM_CAPTURE_MS;
}

/** Start the gapless capture clock at the predicted boundary, even when armed early. */
export function boundaryIdentifyCaptureStartAt(now: number, leadMs = VINYL_BOUNDARY_IDENTIFY_LEAD_MS) {
  return now + leadMs;
}

/**
 * Cooldown and warming still represent audible playback; recognition resets the
 * detector into those states. Only confirmed silence should block boundary capture.
 */
export function isVinylDetectorStateAudible(state: string) {
  return state !== "silence";
}

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
 * Low-level pause/park/gap gate used by gap advances and end-confirm arming.
 * Blind timer/spectral album walks are no longer allowed — see
 * `silenceFirstAllowsBlindBoundaryAdvance`.
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

/** Silence-first policy: never walk the album on a clock/spectrum alone. */
export function silenceFirstAllowsBlindBoundaryAdvance() {
  return false;
}

/** Arm end-of-song identify once we pass the predicted boundary without a gap handoff. */
export function shouldArmEndConfirm(input: {
  pastBoundary: boolean;
  parked: boolean;
  gapPending: boolean;
  pendingVerify: boolean;
  endConfirmPending: boolean;
}) {
  return (
    input.pastBoundary
    && !input.parked
    && !input.gapPending
    && !input.pendingVerify
    && !input.endConfirmPending
  );
}

/**
 * Fire end-confirm once we have collected enough audible post-boundary audio.
 * If sound never returns, `shouldTimeoutEndConfirm` parks instead.
 */
export function shouldFireEndConfirm(input: {
  endConfirmPending: boolean;
  endConfirmArmedAt: number;
  now: number;
  audible: boolean;
  /** True when capture started while music was already playing (gapless). */
  gapless?: boolean;
  captureMs?: number;
}) {
  if (!input.endConfirmPending || !input.audible || !input.endConfirmArmedAt) return false;
  const captureMs = input.captureMs ?? endConfirmCaptureMs(Boolean(input.gapless));
  return input.now - input.endConfirmArmedAt >= captureMs;
}

export function shouldTimeoutEndConfirm(input: {
  endConfirmPending: boolean;
  endConfirmArmedAt: number;
  /** Used when we armed while silent and have not started the audible capture clock. */
  boundaryAt?: number;
  now: number;
  audible: boolean;
  timeoutMs?: number;
}) {
  if (!input.endConfirmPending || input.audible) return false;
  const startedAt = input.endConfirmArmedAt || input.boundaryAt || 0;
  if (!startedAt) return false;
  return input.now - startedAt >= (input.timeoutMs ?? VINYL_END_CONFIRM_TIMEOUT_MS);
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
