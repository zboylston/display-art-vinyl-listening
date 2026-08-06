import { describe, expect, it } from "vitest";
import { largeAlbumArtwork, orderedCatalogAlbum, selectCatalogTrack } from "./track-metadata";

describe("selectCatalogTrack", () => {
  it("prefers the original album over an exact-title compilation match", () => {
    const selected = selectCatalogTrack("Ahmad Jamal Trio", "I Love Music", [
      { artistName: "Ahmad Jamal Trio", trackName: "I Love Music", collectionName: "The Greatest Samples", artworkUrl100: "wrong" },
      { artistName: "Ahmad Jamal Trio", trackName: "I Love Music", collectionName: "The Awakening", artworkUrl100: "correct" },
      { artistName: "Ahmad Jamal Trio", trackName: "I Love Music (Mixed)", collectionName: "DJ Mix", artworkUrl100: "mixed" },
    ]);
    expect(selected?.collectionName).toBe("The Awakening");
    expect(selected?.artworkUrl100).toBe("correct");
  });

  it("does not borrow metadata from a different artist with the same title", () => {
    expect(selectCatalogTrack("Ahmad Jamal Trio", "I Love Music", [
      { artistName: "The O'Jays", trackName: "I Love Music", collectionName: "Family Reunion" },
    ])).toBeUndefined();
  });

  it("matches AudD album-version labels to the catalog's clean track title", () => {
    expect(selectCatalogTrack("John Mayer", "Paper Doll (Album Version)", [
      { artistName: "John Mayer", trackName: "Paper Doll", collectionName: "Paradise Valley", collectionId: 123 },
    ])?.collectionId).toBe(123);
  });

  it("prefers the full album over a same-title single for Vinyl Mode", () => {
    const candidates = [
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "In the Middle of It - Single", collectionId: 1, trackCount: 1 },
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "I'm People", collectionId: 2, trackCount: 12 },
    ];
    expect(selectCatalogTrack("Hiss Golden Messenger", "In the Middle of It", candidates, "I'm People")?.collectionId).toBe(2);
    expect(selectCatalogTrack("Hiss Golden Messenger", "In the Middle of It", candidates)?.collectionId).toBe(2);
  });

  it("prefers the full album even when AudD points at the standalone single", () => {
    const candidates = [
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "In the Middle of It - Single", collectionId: 1, trackCount: 1 },
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "I'm People", collectionId: 2, trackCount: 12 },
    ];
    expect(selectCatalogTrack("Hiss Golden Messenger", "In the Middle of It", candidates, "In the Middle of It - Single")?.collectionId).toBe(2);
  });

  it("prefers the parent album over a multi-track single EP with the same song", () => {
    const candidates = [
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "Shaky Eyes - Single", collectionId: 3, trackCount: 2 },
      { artistName: "Hiss Golden Messenger", trackName: "In the Middle of It", collectionName: "I'm People", collectionId: 2, trackCount: 12 },
    ];
    expect(selectCatalogTrack("Hiss Golden Messenger", "In the Middle of It", candidates, "Shaky Eyes - Single")?.collectionId).toBe(2);
  });
});

describe("largeAlbumArtwork", () => {
  it("expands Apple artwork URLs and AudD templates", () => {
    expect(largeAlbumArtwork("https://example.test/cover/100x100bb.jpg")).toBe("https://example.test/cover/1000x1000bb.jpg");
    expect(largeAlbumArtwork("https://example.test/cover/{w}x{h}bb.jpg")).toBe("https://example.test/cover/1000x1000bb.jpg");
  });
});

describe("orderedCatalogAlbum", () => {
  it("filters collection records, sorts discs and tracks, and removes duplicates", () => {
    const tracks = orderedCatalogAlbum(42, [
      { collectionId: 42, trackId: 3, trackName: "Third", discNumber: 1, trackNumber: 3 },
      { collectionId: 7, trackId: 9, trackName: "Wrong album", trackNumber: 1 },
      { collectionId: 42, trackId: 1, trackName: "First", discNumber: 1, trackNumber: 1 },
      { collectionId: 42, trackId: 1, trackName: "First", discNumber: 1, trackNumber: 1 },
      { collectionId: 42, trackId: 4, trackName: "Side two", discNumber: 2, trackNumber: 1 },
    ]);
    expect(tracks.map((track) => track.trackName)).toEqual(["First", "Third", "Side two"]);
  });
});
