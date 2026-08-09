import { describe, expect, it } from "vitest";
import { vinylCountdownSeconds, vinylFolioCopy } from "./vinyl-folio";

describe("vinylFolioCopy", () => {
  it("formats a side and padded record position", () => {
    expect(vinylFolioCopy({ discNumber: 1, trackIndex: 2, totalTracks: 12 }).sequence).toBe("SIDE A · TRACK 03 OF 12");
  });

  it("uses the next side letter when catalog metadata provides it", () => {
    expect(vinylFolioCopy({ discNumber: 2, trackIndex: 0, totalTracks: 7 }).sequence).toBe("SIDE B · TRACK 01 OF 07");
  });

  it("omits an unknown side instead of guessing", () => {
    expect(vinylFolioCopy({ trackIndex: 3, totalTracks: 9 }).sequence).toBe("TRACK 04 OF 09");
  });
});

describe("vinylCountdownSeconds", () => {
  it("counts down the final 10 seconds before the predicted boundary", () => {
    const now = 1_000_000;
    expect(vinylCountdownSeconds(now + 10_000, now)).toBe(10);
    expect(vinylCountdownSeconds(now + 9_400, now)).toBe(10);
    expect(vinylCountdownSeconds(now + 3_000, now)).toBe(3);
    expect(vinylCountdownSeconds(now + 500, now)).toBe(1);
  });

  it("stays hidden outside the last 10 seconds", () => {
    const now = 1_000_000;
    expect(vinylCountdownSeconds(now + 10_001, now)).toBeUndefined();
    expect(vinylCountdownSeconds(now, now)).toBeUndefined();
    expect(vinylCountdownSeconds(now - 2_000, now)).toBeUndefined();
    expect(vinylCountdownSeconds(undefined, now)).toBeUndefined();
  });
});
