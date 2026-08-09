import { describe, expect, it } from "vitest";
import {
  cleanTrackPayload,
  isBlockedSearchTerm,
  normalizeBrief,
  pickGenreLabel,
  sanitizeLiteralSearchTerms,
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

  it("preserves two concrete literal-title queries in their own lane", () => {
    expect(sanitizeLiteralSearchTerms([
      "starry night",
      "night sky",
      "Stargazing",
      "jazz music",
    ], { artist: "Dinner Party", title: "Stargazing", genre: "R&B" })).toEqual([
      "starry night",
      "night sky",
    ]);
  });
});

describe("normalizeBrief", () => {
  it("keeps literal and interpretive retrieval lanes separate", () => {
    const dossier = {
      confidence: "medium" as const,
      known_facts: [],
      uncertain: [],
      sonic_and_thematic_reading: "Dreamy, groove-led R&B.",
      literal_traps_to_avoid: [],
      artist_or_album_priors: [],
    };
    const brief = normalizeBrief({
      semantic_anchors: ["wonder"],
      sonic_character: ["floating"],
      emotional_tone: ["dreamy"],
      formal_qualities: ["layered"],
      cultural_context: [],
      visual_direction: ["luminous"],
      avoid: [],
      mood: ["nocturnal"],
      energy: "medium",
      palette: ["indigo"],
      visual_motifs: ["stars"],
      art_movements: [],
      literal_search_terms: ["starry night", "night sky"],
      museum_search_terms: ["luminous blue", "night landscape"],
      curatorial_rationale: "A luminous nocturne fits.",
    }, dossier, { artist: "Dinner Party", title: "Stargazing", genre: "R&B" });

    expect(brief.literal_search_terms).toEqual(["starry night", "night sky"]);
    expect(brief.museum_search_terms).toEqual(["luminous blue", "night landscape"]);
  });
});

describe("pickGenreLabel", () => {
  it("skips the generic Music label", () => {
    expect(pickGenreLabel("Music", "Alternative Folk")).toBe("Alternative Folk");
    expect(pickGenreLabel("Music")).toBeUndefined();
  });
});
