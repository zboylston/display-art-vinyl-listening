import { describe, expect, it } from "vitest";
import {
  generateDisplayCode,
  isDisplayCode,
  normalizeDisplayCode,
  parseDisplaySnapshot,
} from "./display-snapshot";

describe("display codes", () => {
  it("normalizes and validates pairing codes", () => {
    expect(normalizeDisplayCode(" ab-12cd ")).toBe("AB12CD");
    expect(isDisplayCode("AB12CD")).toBe(true);
    expect(isDisplayCode("short")).toBe(false);
  });

  it("generates six-character codes from the safe alphabet", () => {
    const code = generateDisplayCode(() => 0);
    expect(code).toHaveLength(6);
    expect(isDisplayCode(code)).toBe(true);
  });
});

describe("parseDisplaySnapshot", () => {
  it("accepts a minimal presentation payload", () => {
    const snapshot = parseDisplaySnapshot({
      act: "gallery",
      listeningMode: "vinyl",
      isListening: true,
      status: "Artwork selected",
      currentTrack: { artist: "Nick Drake", title: "Pink Moon", album: "Pink Moon", year: "1972" },
      artwork: {
        title: "Composition VIII",
        artist: "Wassily Kandinsky",
        date: "1923",
        museum: "Guggenheim",
        image: "/art.jpg",
        rationale: "Geometry",
      },
      vinylProgress: { trackIndex: 0, totalTracks: 11 },
      updatedAt: 1,
    });
    expect(snapshot?.act).toBe("gallery");
    expect(snapshot?.currentTrack?.title).toBe("Pink Moon");
    expect(snapshot?.vinylProgress?.totalTracks).toBe(11);
  });

  it("keeps a waiting snapshot when track details are still absent", () => {
    const snapshot = parseDisplaySnapshot({ act: "gallery", listeningMode: "live" });
    expect(snapshot?.act).toBe("gallery");
    expect(snapshot?.currentTrack).toBeNull();
    expect(parseDisplaySnapshot(null)).toBeNull();
  });
});
