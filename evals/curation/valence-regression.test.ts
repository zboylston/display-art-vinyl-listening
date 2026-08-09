import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { demoteToneMismatches, toneMismatch } from "../../app/lib/art-tone";
import type { ArtTone } from "../../app/lib/art-tone";
import type { Valence } from "../../app/lib/visual-brief";

type Work = { id: string; title: string; tone: ArtTone };
type CurationCase = {
  complaint: string;
  track: { artist: string; title: string };
  expected: { energy: string; valence: Valence };
  rejected: Work[];
  tolerated?: Work[];
  preferred: Work[];
};

const directory = fileURLToPath(new URL("../fixtures/curation", import.meta.url));
const cases = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => [file, JSON.parse(readFileSync(`${directory}/${file}`, "utf8")) as CurationCase] as const);

it("has curation cases to check", () => {
  expect(cases.length).toBeGreaterThan(0);
});

describe.each(cases)("%s", (_file, testCase) => {
  const { valence } = testCase.expected;

  it.each(testCase.rejected)("keeps $title away from the curator", (work) => {
    expect(toneMismatch(valence, work.tone)?.severity).toBe("hard");
  });

  it.each(testCase.tolerated ?? [])("treats $title as a soft clash only", (work) => {
    expect(toneMismatch(valence, work.tone)?.severity).toBe("soft");
  });

  it.each(testCase.preferred)("leaves $title unflagged", (work) => {
    expect(toneMismatch(valence, work.tone)).toBeNull();
  });

  it("demotes the reported mismatch out of a healthy pool", () => {
    const filler = Array.from({ length: 6 }, (_, index) => ({
      ...testCase.preferred[0],
      id: `filler${index}`,
    }));
    const pool = [...testCase.rejected, ...filler];
    const kept = demoteToneMismatches(pool, valence, 6).map((work) => work.id);
    for (const work of testCase.rejected) expect(kept).not.toContain(work.id);
  });
});
