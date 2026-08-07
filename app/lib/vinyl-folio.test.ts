import { describe, expect, it } from "vitest";
import { vinylFolioCopy } from "./vinyl-folio";

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

  it("counts within the confirmed vinyl side", () => {
    expect(vinylFolioCopy({ side: "B", sideTrackIndex: 0, sideTrackTotal: 2, trackIndex: 3, totalTracks: 5 }).sequence)
      .toBe("SIDE B · TRACK 01 OF 02");
  });

  it("prefers the confirmed side over disc metadata", () => {
    expect(vinylFolioCopy({ discNumber: 1, side: "B", sideTrackIndex: 1, sideTrackTotal: 2, trackIndex: 4, totalTracks: 5 }).sequence)
      .toBe("SIDE B · TRACK 02 OF 02");
  });
});
