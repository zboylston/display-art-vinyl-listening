import {
  VINYL_END_CONFIRM_TIMEOUT_MS,
  armVinylGapLatch,
  canPredictiveAdvance,
  endConfirmCaptureMs,
  isVinylGapLatchExpired,
  rollbackAdvanceIndex,
  shouldAdvanceOnGapResume,
  shouldArmEndConfirm,
  shouldFireEndConfirm,
  shouldParkVinylOnSilence,
  shouldRollbackUnverifiedAdvance,
  shouldTimeoutEndConfirm,
  silenceFirstAllowsBlindBoundaryAdvance,
  type VinylGapLatch,
} from "./vinyl-advance";

/**
 * Desired near-end handoff (silence-first):
 * silence arms a gap → music-resumed advances → background verify.
 * If no gap by the predicted end: wait for audible music, collect a clip, identify.
 * Blind timer/spectral advances without a silence gap are unsafe.
 */
export type VinylHandoffState = {
  index: number;
  parked: boolean;
  gapPending: boolean;
  pauseAt: number;
  gapLatch: VinylGapLatch | null;
  pendingVerify: boolean;
  endConfirmPending: boolean;
  endConfirmArmedAt: number;
  /** True when end-confirm armed while music was already playing (gapless). */
  endConfirmGapless: boolean;
  /** Wall-clock predicted end of the current track. */
  boundaryAt: number;
};

export type VinylHandoffEvent =
  | { type: "silence"; now: number; nearBoundary: boolean }
  | { type: "music-resumed"; now: number }
  | {
      type: "boundary-tick";
      now: number;
      detectorState: string;
      /** Spectral change near the predicted boundary. */
      changeSuspected?: boolean;
    }
  | { type: "verify"; outcome: "same" | "match" | "none" | "error" }
  | { type: "end-confirm"; outcome: "same" | "match" | "none" | "error" };

export type VinylHandoffAction =
  | { type: "none" }
  | { type: "arm-gap" }
  | { type: "advance"; reason: "gap" }
  | { type: "arm-end-confirm" }
  | { type: "fire-end-confirm" }
  | { type: "park"; reason: "gap-expired" | "sustained-silence" | "end-confirm-timeout" | "end-confirm-miss" }
  | { type: "rollback-and-park" }
  | { type: "keep-advance" }
  | { type: "reanchor" }
  | { type: "push-boundary" };

export function initialVinylHandoffState(input: {
  index: number;
  boundaryAt: number;
}): VinylHandoffState {
  return {
    index: input.index,
    parked: false,
    gapPending: false,
    pauseAt: 0,
    gapLatch: null,
    pendingVerify: false,
    endConfirmPending: false,
    endConfirmArmedAt: 0,
    endConfirmGapless: false,
    boundaryAt: input.boundaryAt,
  };
}

/**
 * Legacy low-level gate: still returns true for stable ambient with no gap.
 * Page orchestration must use silence-first instead of this alone.
 */
export function currentAllowsBlindTimerAdvance(input: {
  parked: boolean;
  paused: boolean;
  gapPending: boolean;
  detectorState: string;
}) {
  return canPredictiveAdvance({
    parked: input.parked,
    paused: input.paused,
    gapPending: input.gapPending,
    detectorState: input.detectorState,
    requireStable: true,
  });
}

function isAudibleDetectorState(state: string) {
  return state === "stable" || state === "suspected" || state === "resuming";
}

/**
 * Pure reducer for the locked silence-first handoff contract.
 * Scenario tests use this to prove freeze/false-advance behavior without a mic.
 */
export function reduceVinylHandoff(
  state: VinylHandoffState,
  event: VinylHandoffEvent,
): { state: VinylHandoffState; action: VinylHandoffAction } {
  if (event.type === "silence") {
    if (state.parked) return { state, action: { type: "none" } };
    if (event.nearBoundary) {
      return {
        state: {
          ...state,
          gapPending: true,
          pauseAt: event.now,
          gapLatch: armVinylGapLatch(event.now),
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "arm-gap" },
      };
    }
    const pauseAt = state.pauseAt || event.now;
    if (shouldParkVinylOnSilence(pauseAt, event.now)) {
      return {
        state: {
          ...state,
          parked: true,
          gapPending: false,
          gapLatch: null,
          pauseAt,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "park", reason: "sustained-silence" },
      };
    }
    return { state: { ...state, pauseAt }, action: { type: "none" } };
  }

  if (event.type === "music-resumed") {
    if (shouldAdvanceOnGapResume(state.gapPending, "music-resumed")) {
      return {
        state: {
          ...state,
          index: state.index + 1,
          gapPending: false,
          gapLatch: null,
          pauseAt: 0,
          parked: false,
          pendingVerify: true,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "advance", reason: "gap" },
      };
    }
    if (state.endConfirmPending) {
      // Sound returned after the end timer — start the post-boundary capture clock once.
      return {
        state: {
          ...state,
          pauseAt: 0,
          parked: false,
          endConfirmArmedAt: state.endConfirmArmedAt || event.now,
          endConfirmGapless: false,
        },
        action: { type: "none" },
      };
    }
    if (state.parked) {
      return {
        state: { ...state, parked: false, pauseAt: 0 },
        action: { type: "none" },
      };
    }
    return { state: { ...state, pauseAt: 0 }, action: { type: "none" } };
  }

  if (event.type === "boundary-tick") {
    if (state.gapPending && isVinylGapLatchExpired(state.gapLatch, event.now)) {
      return {
        state: {
          ...state,
          parked: true,
          gapPending: false,
          gapLatch: null,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "park", reason: "gap-expired" },
      };
    }

    const pastBoundary = state.boundaryAt > 0 && event.now >= state.boundaryAt;
    const audible = isAudibleDetectorState(event.detectorState);

    if (
      shouldTimeoutEndConfirm({
        endConfirmPending: state.endConfirmPending,
        endConfirmArmedAt: state.endConfirmArmedAt,
        boundaryAt: state.boundaryAt,
        now: event.now,
        audible,
        timeoutMs: VINYL_END_CONFIRM_TIMEOUT_MS,
      })
    ) {
      return {
        state: {
          ...state,
          parked: true,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "park", reason: "end-confirm-timeout" },
      };
    }

    if (
      shouldFireEndConfirm({
        endConfirmPending: state.endConfirmPending,
        endConfirmArmedAt: state.endConfirmArmedAt,
        now: event.now,
        audible,
        gapless: state.endConfirmGapless,
        captureMs: endConfirmCaptureMs(state.endConfirmGapless),
      })
    ) {
      return {
        state: {
          ...state,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "fire-end-confirm" },
      };
    }

    if (
      shouldArmEndConfirm({
        pastBoundary,
        parked: state.parked,
        gapPending: state.gapPending,
        pendingVerify: state.pendingVerify,
        endConfirmPending: state.endConfirmPending,
      })
    ) {
      return {
        state: {
          ...state,
          endConfirmPending: true,
          // If music is already audible (gapless), start the short capture clock now.
          endConfirmArmedAt: audible ? event.now : 0,
          endConfirmGapless: audible,
        },
        action: { type: "arm-end-confirm" },
      };
    }

    // Silence-first: never blind-advance on timer/spectral.
    if (
      pastBoundary
      && silenceFirstAllowsBlindBoundaryAdvance()
      && currentAllowsBlindTimerAdvance({
        parked: state.parked,
        paused: Boolean(state.pauseAt),
        gapPending: state.gapPending,
        detectorState: event.detectorState,
      })
    ) {
      // Unreachable under silence-first; kept for clarity in policy tests.
      return { state, action: { type: "none" } };
    }

    void event.changeSuspected;
    return { state, action: { type: "none" } };
  }

  if (event.type === "verify") {
    if (shouldRollbackUnverifiedAdvance({ pendingVerify: state.pendingVerify, outcome: event.outcome })) {
      const previous = rollbackAdvanceIndex(state.index);
      return {
        state: {
          ...state,
          index: previous ?? state.index,
          pendingVerify: false,
          parked: true,
          gapPending: false,
          gapLatch: null,
          pauseAt: 0,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
        },
        action: { type: "rollback-and-park" },
      };
    }
    if (!state.pendingVerify) return { state, action: { type: "none" } };
    if (event.outcome === "same") {
      return {
        state: { ...state, pendingVerify: false },
        action: { type: "keep-advance" },
      };
    }
    if (event.outcome === "match") {
      return {
        state: { ...state, pendingVerify: false },
        action: { type: "reanchor" },
      };
    }
  }

  if (event.type === "end-confirm") {
    if (event.outcome === "same") {
      return {
        state: {
          ...state,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
          parked: false,
        },
        action: { type: "push-boundary" },
      };
    }
    if (event.outcome === "match") {
      return {
        state: {
          ...state,
          endConfirmPending: false,
          endConfirmArmedAt: 0,
          endConfirmGapless: false,
          parked: false,
        },
        action: { type: "reanchor" },
      };
    }
    return {
      state: {
        ...state,
        endConfirmPending: false,
        endConfirmArmedAt: 0,
        endConfirmGapless: false,
        parked: true,
      },
      action: { type: "park", reason: "end-confirm-miss" },
    };
  }

  return { state, action: { type: "none" } };
}
