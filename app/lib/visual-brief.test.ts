import { describe, expect, it } from "vitest";
import {
  cleanTrackPayload,
  isBlockedSearchTerm,
  pickGenreLabel,
  sanitizeMuseumSearchTerms,
} from "./visual-brief";

describe("cleanTrackPayload", () => {
  it("keeps curatorial identity and drops empty album placeholders", () => {
    expect(cleanTrackPayload({
      artist: "Hiss Golden Messenger",
      title: "In the Middle of It",
      album: "I'm People",
      year: "2026",
      genre: "Folk",
    })).toEqual({
      artist: "Hiss Golden Messenger",
      title: "In the Middle of It",
      album: "I'm People",
      year: "2026",
      genre: "Folk",
    });
    expect(cleanTrackPayload({ artist: "A", title: "B", album: "Album unknown" })).toEqual({
      artist: "A",
      title: "B",
    });
  });
});

describe("sanitizeMuseumSearchTerms", () => {
  const track = { artist: "Hiss Golden Messenger", title: "In the Middle of It", album: "I'm People", genre: "Folk" };

  it("blocks music jargon, artist tokens, and excess title echoes", () => {
    expect(isBlockedSearchTerm("folk guitar", track)).toBe(true);
    expect(isBlockedSearchTerm("Messenger", track)).toBe(true);
    expect(isBlockedSearchTerm("dirt road at dusk under clouds", track)).toBe(true);

    const terms = sanitizeMuseumSearchTerms([
      "dirt road",
      "porch light",
      "In the Middle of It",
      "middle",
      "hiss golden messenger",
      "song lyric",
      "winter trees",
      "southern dusk",
      "empty highway",
      "amber field",
      "rural porch",
      "morning mist",
      "dirt road",
    ], track);

    expect(terms).toEqual([
      "dirt road",
      "porch light",
      "middle",
      "winter trees",
      "southern dusk",
      "empty highway",
      "amber field",
      "rural porch",
      "morning mist",
    ]);
    expect(terms.filter((term) => /middle|in the middle/i.test(term))).toHaveLength(1);
  });

  it("keeps concrete catalog nouns that museums can match", () => {
    expect(sanitizeMuseumSearchTerms(["winter trees", "porch light", "empty highway"], track))
      .toEqual(["winter trees", "porch light", "empty highway"]);
  });
});

describe("pickGenreLabel", () => {
  it("skips the generic Music label", () => {
    expect(pickGenreLabel("Music", "Alternative Folk")).toBe("Alternative Folk");
    expect(pickGenreLabel("Music")).toBeUndefined();
  });
});
