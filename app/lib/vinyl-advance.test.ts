import { describe, expect, it } from "vitest";
import {
  VINYL_ADVANCE_VERIFY_MS,
  VINYL_END_CONFIRM_CAPTURE_MS,
  VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS,
  VINYL_END_CONFIRM_TIMEOUT_MS,
  VINYL_GAP_LATCH_EXPIRE_MS,
  VINYL_SUSTAINED_SILENCE_PARK_MS,
  advanceVerificationAt,
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
} from "./vinyl-advance";

describe("vinyl gap latch", () => {
  it("arms with the silence timestamp", () => {
    expect(armVinylGapLatch(50_000)).toEqual({ armedAt: 50_000 });
  });

  it("expires only after the latch window", () => {
    const latch = armVinylGapLatch(10_000);
    expect(isVinylGapLatchExpired(latch, 10_000 + VINYL_GAP_LATCH_EXPIRE_MS - 1)).toBe(false);
    expect(isVinylGapLatchExpired(latch, 10_000 + VINYL_GAP_LATCH_EXPIRE_MS)).toBe(true);
    expect(isVinylGapLatchExpired(null, 30_000)).toBe(false);
  });

  it("advances only on confirmed music-resumed, not the first resuming frame", () => {
    expect(shouldAdvanceOnGapResume(true, "music-resumed")).toBe(true);
    expect(shouldAdvanceOnGapResume(true, null)).toBe(false);
    expect(shouldAdvanceOnGapResume(true, "change-suspected")).toBe(false);
    expect(shouldAdvanceOnGapResume(false, "music-resumed")).toBe(false);
  });
});

describe("vinyl advance verification", () => {
  it("schedules a confirm check after every predicted advance", () => {
    expect(advanceVerificationAt(1_000)).toBe(1_000 + VINYL_ADVANCE_VERIFY_MS);
    expect(advanceVerificationAt(1_000, 8_000)).toBe(9_000);
  });

  it("rolls back when a pending advance verify hears no music", () => {
    expect(shouldRollbackUnverifiedAdvance({ pendingVerify: true, outcome: "none" })).toBe(true);
    expect(shouldRollbackUnverifiedAdvance({ pendingVerify: true, outcome: "error" })).toBe(true);
    expect(shouldRollbackUnverifiedAdvance({ pendingVerify: true, outcome: "same" })).toBe(false);
    expect(shouldRollbackUnverifiedAdvance({ pendingVerify: true, outcome: "match" })).toBe(false);
    expect(shouldRollbackUnverifiedAdvance({ pendingVerify: false, outcome: "none" })).toBe(false);
  });

  it("restores the previous album index after a failed verify", () => {
    expect(rollbackAdvanceIndex(3)).toBe(2);
    expect(rollbackAdvanceIndex(1)).toBe(0);
    expect(rollbackAdvanceIndex(0)).toBeNull();
  });
});

describe("vinyl sustained silence", () => {
  it("parks only after a long quiet stretch", () => {
    expect(shouldParkVinylOnSilence(10_000, 10_000 + VINYL_SUSTAINED_SILENCE_PARK_MS - 1)).toBe(false);
    expect(shouldParkVinylOnSilence(10_000, 10_000 + VINYL_SUSTAINED_SILENCE_PARK_MS)).toBe(true);
    expect(shouldParkVinylOnSilence(0, 40_000)).toBe(false);
  });
});

describe("predictive advance gates", () => {
  it("blocks timer/spectral advances once silence has armed a gap or parked the album", () => {
    expect(canPredictiveAdvance({ parked: false, paused: false, gapPending: false, detectorState: "stable", requireStable: true })).toBe(true);
    expect(canPredictiveAdvance({ parked: false, paused: false, gapPending: true, detectorState: "stable", requireStable: true })).toBe(false);
    expect(canPredictiveAdvance({ parked: false, paused: true, gapPending: false, detectorState: "stable", requireStable: true })).toBe(false);
    expect(canPredictiveAdvance({ parked: true, paused: false, gapPending: false, detectorState: "stable", requireStable: true })).toBe(false);
  });

  it("rejects timer advances on resuming noise instead of stable music", () => {
    expect(canPredictiveAdvance({ parked: false, paused: false, gapPending: false, detectorState: "resuming", requireStable: true })).toBe(false);
    expect(canPredictiveAdvance({ parked: false, paused: false, gapPending: false, detectorState: "suspected", requireStable: true })).toBe(false);
    expect(canPredictiveAdvance({ parked: false, paused: false, gapPending: false, detectorState: "stable" })).toBe(true);
  });

  it("silence-first forbids blind boundary advances", () => {
    expect(silenceFirstAllowsBlindBoundaryAdvance()).toBe(false);
  });
});

describe("end-confirm arming", () => {
  it("arms only past the boundary without gap/park/verify already active", () => {
    expect(shouldArmEndConfirm({
      pastBoundary: true,
      parked: false,
      gapPending: false,
      pendingVerify: false,
      endConfirmPending: false,
    })).toBe(true);
    expect(shouldArmEndConfirm({
      pastBoundary: true,
      parked: false,
      gapPending: true,
      pendingVerify: false,
      endConfirmPending: false,
    })).toBe(false);
  });

  it("fires only after enough audible capture", () => {
    expect(shouldFireEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_CAPTURE_MS - 1,
      audible: true,
    })).toBe(false);
    expect(shouldFireEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_CAPTURE_MS,
      audible: true,
    })).toBe(true);
    expect(shouldFireEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_CAPTURE_MS,
      audible: false,
    })).toBe(false);
  });

  it("uses a shorter capture window for gapless (already-audible) end-confirm", () => {
    expect(endConfirmCaptureMs(true)).toBe(VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS);
    expect(endConfirmCaptureMs(false)).toBe(VINYL_END_CONFIRM_CAPTURE_MS);
    expect(shouldFireEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS - 1,
      audible: true,
      gapless: true,
    })).toBe(false);
    expect(shouldFireEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_GAPLESS_CAPTURE_MS,
      audible: true,
      gapless: true,
    })).toBe(true);
  });

  it("times out when sound never returns after the end timer", () => {
    expect(shouldTimeoutEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 0,
      boundaryAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_TIMEOUT_MS,
      audible: false,
    })).toBe(true);
    expect(shouldTimeoutEndConfirm({
      endConfirmPending: true,
      endConfirmArmedAt: 0,
      boundaryAt: 1_000,
      now: 1_000 + VINYL_END_CONFIRM_TIMEOUT_MS,
      audible: true,
    })).toBe(false);
  });
});
