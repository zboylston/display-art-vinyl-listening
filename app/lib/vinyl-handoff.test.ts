import { describe, expect, it } from "vitest";
import {
  VINYL_END_CONFIRM_CAPTURE_MS,
  VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS,
  VINYL_END_CONFIRM_TIMEOUT_MS,
  VINYL_GAP_LATCH_EXPIRE_MS,
  VINYL_SUSTAINED_SILENCE_PARK_MS,
  silenceFirstAllowsBlindBoundaryAdvance,
} from "./vinyl-advance";
import {
  currentAllowsBlindTimerAdvance,
  initialVinylHandoffState,
  reduceVinylHandoff,
} from "./vinyl-handoff";

describe("silence-first policy vs legacy gate", () => {
  it("legacy canPredictiveAdvance still returns true for stable ambient with no gap", () => {
    expect(
      currentAllowsBlindTimerAdvance({
        parked: false,
        paused: false,
        gapPending: false,
        detectorState: "stable",
      }),
    ).toBe(true);
  });

  it("silence-first policy forbids blind boundary advances", () => {
    expect(silenceFirstAllowsBlindBoundaryAdvance()).toBe(false);
  });
});

describe("silence-first handoff scenarios", () => {
  it("silence → no resume → parks and does not advance", () => {
    let state = initialVinylHandoffState({ index: 2, boundaryAt: 100_000 });

    ({ state } = reduceVinylHandoff(state, {
      type: "silence",
      now: 95_000,
      nearBoundary: true,
    }));
    expect(state.gapPending).toBe(true);
    expect(state.index).toBe(2);

    const expired = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 95_000 + VINYL_GAP_LATCH_EXPIRE_MS,
      detectorState: "silence",
    });
    expect(expired.action).toEqual({ type: "park", reason: "gap-expired" });
    expect(expired.state.index).toBe(2);
    expect(expired.state.parked).toBe(true);
  });

  it("silence → music-resumed → advances with pending verify", () => {
    let state = initialVinylHandoffState({ index: 1, boundaryAt: 100_000 });

    ({ state } = reduceVinylHandoff(state, {
      type: "silence",
      now: 98_000,
      nearBoundary: true,
    }));
    const advanced = reduceVinylHandoff(state, { type: "music-resumed", now: 103_000 });

    expect(advanced.action).toEqual({ type: "advance", reason: "gap" });
    expect(advanced.state.index).toBe(2);
    expect(advanced.state.pendingVerify).toBe(true);
    expect(advanced.state.gapPending).toBe(false);
  });

  it("does not advance on boundary tick + stable ambient with no silence gap", () => {
    const state = initialVinylHandoffState({ index: 0, boundaryAt: 50_000 });

    const tick = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 60_000,
      detectorState: "stable",
    });
    // Arms end-confirm instead of walking the album.
    expect(tick.action).toEqual({ type: "arm-end-confirm" });
    expect(tick.state.index).toBe(0);
    expect(tick.state.pendingVerify).toBe(false);
    expect(tick.state.endConfirmPending).toBe(true);
  });

  it("does not spectral-advance without a silence gap", () => {
    const state = initialVinylHandoffState({ index: 0, boundaryAt: 50_000 });
    const tick = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 49_000,
      detectorState: "suspected",
      changeSuspected: true,
    });
    expect(tick.action).toEqual({ type: "none" });
    expect(tick.state.index).toBe(0);
  });

  it("verify same → keep advance", () => {
    let state = initialVinylHandoffState({ index: 1, boundaryAt: 100_000 });
    ({ state } = reduceVinylHandoff(state, { type: "silence", now: 98_000, nearBoundary: true }));
    ({ state } = reduceVinylHandoff(state, { type: "music-resumed", now: 103_000 }));

    const verified = reduceVinylHandoff(state, { type: "verify", outcome: "same" });
    expect(verified.action).toEqual({ type: "keep-advance" });
    expect(verified.state.index).toBe(2);
    expect(verified.state.pendingVerify).toBe(false);
    expect(verified.state.parked).toBe(false);
  });

  it("verify different song → reanchor (update display + album)", () => {
    let state = initialVinylHandoffState({ index: 1, boundaryAt: 100_000 });
    ({ state } = reduceVinylHandoff(state, { type: "silence", now: 98_000, nearBoundary: true }));
    ({ state } = reduceVinylHandoff(state, { type: "music-resumed", now: 103_000 }));

    const verified = reduceVinylHandoff(state, { type: "verify", outcome: "match" });
    expect(verified.action).toEqual({ type: "reanchor" });
    expect(verified.state.pendingVerify).toBe(false);
  });

  it("verify none → rollback and park", () => {
    let state = initialVinylHandoffState({ index: 1, boundaryAt: 100_000 });
    ({ state } = reduceVinylHandoff(state, { type: "silence", now: 98_000, nearBoundary: true }));
    ({ state } = reduceVinylHandoff(state, { type: "music-resumed", now: 103_000 }));
    expect(state.index).toBe(2);

    const verified = reduceVinylHandoff(state, { type: "verify", outcome: "none" });
    expect(verified.action).toEqual({ type: "rollback-and-park" });
    expect(verified.state.index).toBe(1);
    expect(verified.state.parked).toBe(true);
    expect(verified.state.pendingVerify).toBe(false);
  });

  it("mid-track sustained silence parks without advancing", () => {
    let state = initialVinylHandoffState({ index: 3, boundaryAt: 200_000 });
    const startedAt = 120_000;

    ({ state } = reduceVinylHandoff(state, {
      type: "silence",
      now: startedAt,
      nearBoundary: false,
    }));
    expect(state.parked).toBe(false);
    expect(state.index).toBe(3);

    const parked = reduceVinylHandoff(state, {
      type: "silence",
      now: startedAt + VINYL_SUSTAINED_SILENCE_PARK_MS,
      nearBoundary: false,
    });
    expect(parked.action).toEqual({ type: "park", reason: "sustained-silence" });
    expect(parked.state.index).toBe(3);
    expect(parked.state.parked).toBe(true);
  });
});

describe("end-timer wait-for-sound confirm", () => {
  it("gapless past boundary → arm and fire after the short capture window", () => {
    let state = initialVinylHandoffState({ index: 0, boundaryAt: 90_000 });

    const armed = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000,
      detectorState: "stable",
    });
    expect(armed.action).toEqual({ type: "arm-end-confirm" });
    expect(armed.state.endConfirmPending).toBe(true);
    expect(armed.state.endConfirmArmedAt).toBe(90_000);
    expect(armed.state.endConfirmGapless).toBe(true);
    expect(armed.state.index).toBe(0);

    state = armed.state;
    const early = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000 + VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS - 1,
      detectorState: "stable",
    });
    expect(early.action).toEqual({ type: "none" });

    const fired = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000 + VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS,
      detectorState: "stable",
    });
    expect(fired.action).toEqual({ type: "fire-end-confirm" });
    expect(fired.state.endConfirmPending).toBe(false);
  });

  it("past boundary with no sound times out and parks", () => {
    let state = initialVinylHandoffState({ index: 1, boundaryAt: 90_000 });

    const armed = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000,
      detectorState: "silence",
    });
    expect(armed.action).toEqual({ type: "arm-end-confirm" });
    expect(armed.state.endConfirmArmedAt).toBe(0);
    expect(armed.state.endConfirmGapless).toBe(false);
    expect(armed.state.endConfirmPending).toBe(true);

    state = armed.state;
    const timedOut = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000 + VINYL_END_CONFIRM_TIMEOUT_MS,
      detectorState: "silence",
    });
    expect(timedOut.action).toEqual({ type: "park", reason: "end-confirm-timeout" });
    expect(timedOut.state.parked).toBe(true);
    expect(timedOut.state.index).toBe(1);
  });

  it("silent past boundary then music → longer capture, then fire", () => {
    let state = initialVinylHandoffState({ index: 0, boundaryAt: 90_000 });

    ({ state } = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000,
      detectorState: "silence",
    }));
    expect(state.endConfirmPending).toBe(true);
    expect(state.endConfirmArmedAt).toBe(0);
    expect(state.endConfirmGapless).toBe(false);

    const resumed = reduceVinylHandoff(state, { type: "music-resumed", now: 95_000 });
    expect(resumed.state.endConfirmArmedAt).toBe(95_000);
    expect(resumed.state.endConfirmGapless).toBe(false);
    state = resumed.state;

    const tooEarly = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 95_000 + VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS,
      detectorState: "stable",
    });
    expect(tooEarly.action).toEqual({ type: "none" });

    const fired = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 95_000 + VINYL_END_CONFIRM_CAPTURE_MS,
      detectorState: "stable",
    });
    expect(fired.action).toEqual({ type: "fire-end-confirm" });
  });

  it("does not reset the capture clock on repeated music-resumed flaps", () => {
    let state = initialVinylHandoffState({ index: 0, boundaryAt: 90_000 });
    ({ state } = reduceVinylHandoff(state, {
      type: "boundary-tick",
      now: 90_000,
      detectorState: "silence",
    }));
    ({ state } = reduceVinylHandoff(state, { type: "music-resumed", now: 95_000 }));
    expect(state.endConfirmArmedAt).toBe(95_000);

    const flapped = reduceVinylHandoff(state, { type: "music-resumed", now: 97_000 });
    expect(flapped.state.endConfirmArmedAt).toBe(95_000);
  });

  it("end-confirm same → push boundary timers", () => {
    const state = {
      ...initialVinylHandoffState({ index: 0, boundaryAt: 90_000 }),
      endConfirmPending: true,
      endConfirmArmedAt: 90_000,
    };
    const result = reduceVinylHandoff(state, { type: "end-confirm", outcome: "same" });
    expect(result.action).toEqual({ type: "push-boundary" });
    expect(result.state.parked).toBe(false);
    expect(result.state.endConfirmPending).toBe(false);
  });

  it("end-confirm different → reanchor", () => {
    const state = {
      ...initialVinylHandoffState({ index: 0, boundaryAt: 90_000 }),
      endConfirmPending: true,
      endConfirmArmedAt: 90_000,
    };
    const result = reduceVinylHandoff(state, { type: "end-confirm", outcome: "match" });
    expect(result.action).toEqual({ type: "reanchor" });
  });

  it("end-confirm none → park without advancing", () => {
    const state = {
      ...initialVinylHandoffState({ index: 2, boundaryAt: 90_000 }),
      endConfirmPending: true,
      endConfirmArmedAt: 90_000,
    };
    const result = reduceVinylHandoff(state, { type: "end-confirm", outcome: "none" });
    expect(result.action).toEqual({ type: "park", reason: "end-confirm-miss" });
    expect(result.state.index).toBe(2);
    expect(result.state.parked).toBe(true);
  });
});
