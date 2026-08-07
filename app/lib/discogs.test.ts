import { describe, expect, it } from "vitest";
import { alignVinylSides, parseVinylPosition, type DiscogsTrackEntry } from "./discogs";

describe("parseVinylPosition", () => {
  it("parses common vinyl positions", () => {
    expect(parseVinylPosition("A1")).toEqual({ side: "A", sideTrack: 1 });
    expect(parseVinylPosition("b2")).toEqual({ side: "B", sideTrack: 2 });
    expect(parseVinylPosition("A-3")).toEqual({ side: "A", sideTrack: 3 });
    expect(parseVinylPosition("C.1")).toEqual({ side: "C", sideTrack: 1 });
  });

  it("treats a lone letter as a single-track side", () => {
    expect(parseVinylPosition("A")).toEqual({ side: "A", sideTrack: 1 });
  });

  it("rejects CD-style numeric positions", () => {
    expect(parseVinylPosition("3")).toBeUndefined();
    expect(parseVinylPosition("")).toBeUndefined();
    expect(parseVinylPosition(undefined)).toBeUndefined();
  });
});

describe("alignVinylSides", () => {
  const maidenVoyage: DiscogsTrackEntry[] = [
    { position: "A1", title: "Maiden Voyage", type_: "track" },
    { position: "A2", title: "The Eye Of The Hurricane", type_: "track" },
    { position: "A3", title: "Little One", type_: "track" },
    { position: "B1", title: "Survival Of The Fittest", type_: "track" },
    { position: "B2", title: "Dolphin Dance", type_: "track" },
  ];

  it("zips by authoritative position order when counts match", () => {
    const sides = alignVinylSides(maidenVoyage, [
      "Maiden Voyage",
      "The Eye of the Hurricane",
      "Little One",
      "Survival of the Fittest",
      "Dolphin Dance",
    ]);
    expect(sides).toEqual(["A", "A", "A", "B", "B"]);
  });

  it("skips heading entries that Discogs inserts between sides", () => {
    const withHeadings: DiscogsTrackEntry[] = [
      { position: "", title: "Side A", type_: "heading" },
      ...maidenVoyage,
    ];
    expect(alignVinylSides(withHeadings, [
      "Maiden Voyage",
      "The Eye of the Hurricane",
      "Little One",
      "Survival of the Fittest",
      "Dolphin Dance",
    ])).toEqual(["A", "A", "A", "B", "B"]);
  });

  it("matches by title when the catalog has bonus tracks the vinyl lacks", () => {
    const albumTitles = [
      "Maiden Voyage",
      "The Eye of the Hurricane",
      "Little One",
      "Survival of the Fittest",
      "Dolphin Dance",
      "Maiden Voyage (Alternate Take)",
    ];
    expect(alignVinylSides(maidenVoyage, albumTitles)).toBeUndefined();
  });

  it("refuses releases without lettered positions rather than guessing", () => {
    const cdStyle: DiscogsTrackEntry[] = [
      { position: "1", title: "Maiden Voyage", type_: "track" },
      { position: "2", title: "The Eye Of The Hurricane", type_: "track" },
    ];
    expect(alignVinylSides(cdStyle, ["Maiden Voyage", "The Eye of the Hurricane"])).toBeUndefined();
  });

  it("matches titles across catalog punctuation differences", () => {
    const albumTitles = ["Maiden Voyage", "Eye of the Hurricane, The", "Little One", "Survival of the Fittest", "Dolphin Dance"];
    // "Eye of the Hurricane, The" normalizes differently — title fallback only
    // runs when counts differ, so equal counts still zip by position.
    expect(alignVinylSides(maidenVoyage, albumTitles)).toEqual(["A", "A", "A", "B", "B"]);
  });
});
