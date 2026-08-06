import { describe, expect, it } from "vitest";
import {
  excludeRecentCandidates,
  parseRecentArtworkIds,
  pushRecentArtworkId,
  shouldRefreshCachedArtwork,
} from "./recent-artwork";

describe("pushRecentArtworkId", () => {
  it("moves an id to the front and caps the list", () => {
    expect(pushRecentArtworkId(["a", "b", "c"], "b", 3)).toEqual(["b", "a", "c"]);
    expect(pushRecentArtworkId(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("excludeRecentCandidates", () => {
  it("removes recent ids when enough alternatives remain", () => {
    const pool = Array.from({ length: 12 }, (_, index) => ({ id: String.fromCharCode(97 + index) }));
    expect(excludeRecentCandidates(pool, ["a", "c"], 8).map((item) => item.id))
      .toEqual(["b", "d", "e", "f", "g", "h", "i", "j", "k", "l"]);
  });

  it("keeps the full pool when exclusion would leave too few works", () => {
    const pool = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(excludeRecentCandidates(pool, ["a", "b"], 8).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("shouldRefreshCachedArtwork", () => {
  it("refreshes when the cached work was already shown recently", () => {
    expect(shouldRefreshCachedArtwork("met:1", ["met:2", "met:1"])).toBe(true);
    expect(shouldRefreshCachedArtwork("met:1", ["met:2"])).toBe(false);
    expect(shouldRefreshCachedArtwork(undefined, ["met:1"])).toBe(false);
  });
});

describe("parseRecentArtworkIds", () => {
  it("dedupes and truncates stored history", () => {
    expect(parseRecentArtworkIds([" met:1 ", "met:1", "met:2", 3], 2)).toEqual(["met:1", "met:2"]);
  });
});
