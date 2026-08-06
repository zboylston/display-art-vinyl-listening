import { describe, expect, it } from "vitest";
import { balanceBySource, landscapeFirstPool } from "./art-orientation";

type Candidate = { id: string; aspectRatio?: number };

describe("landscapeFirstPool", () => {
  it("excludes portrait and square works when a landscape is available", () => {
    const result = landscapeFirstPool<Candidate>([
      { id: "portrait", aspectRatio: 0.65 },
      { id: "square", aspectRatio: 1 },
      { id: "landscape", aspectRatio: 1.35 },
    ]);
    expect(result.map((candidate) => candidate.id)).toEqual(["landscape"]);
  });

  it("orders landscapes by their fit to a widescreen display", () => {
    const result = landscapeFirstPool<Candidate>([
      { id: "very-wide", aspectRatio: 2.6 },
      { id: "tv-like", aspectRatio: 1.7 },
      { id: "horizontal", aspectRatio: 1.2 },
    ]);
    expect(result.map((candidate) => candidate.id)).toEqual(["tv-like", "horizontal", "very-wide"]);
  });

  it("uses square work before unknown or portrait fallbacks", () => {
    const result = landscapeFirstPool<Candidate>([
      { id: "portrait", aspectRatio: 0.7 },
      { id: "unknown" },
      { id: "square", aspectRatio: 1 },
    ]);
    expect(result.map((candidate) => candidate.id)).toEqual(["square"]);
  });
});

describe("balanceBySource", () => {
  it("round-robins museums while preserving each source's ranking", () => {
    const result = balanceBySource([
      { id: "m1", source: "met" },
      { id: "m2", source: "met" },
      { id: "c1", source: "cleveland" },
      { id: "c2", source: "cleveland" },
      { id: "a1", source: "artic" },
    ], 5);
    expect(result.map((candidate) => candidate.id)).toEqual(["m1", "c1", "a1", "m2", "c2"]);
  });
});
