import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  artToneFromPixels,
  demoteToneMismatches,
  describeArtTone,
  measureArtTone,
  toneMismatch,
  type ArtTone,
} from "./art-tone";

function pixels(red: number, green: number, blue: number, count = 16) {
  return Uint8Array.from(Array.from({ length: count }, () => [red, green, blue]).flat());
}

const bleak: ArtTone = { luminance: 0.22, saturation: 0.02, warmth: 0 };
const sunlit: ArtTone = { luminance: 0.68, saturation: 0.34, warmth: 0.22 };

describe("artToneFromPixels", () => {
  it("reads a grayscale image as dark and unsaturated", () => {
    const tone = artToneFromPixels(pixels(40, 40, 40), 3)!;
    expect(tone.luminance).toBeCloseTo(0.157, 2);
    expect(tone.saturation).toBeCloseTo(0, 5);
    expect(tone.warmth).toBeCloseTo(0, 5);
  });

  it("reads a warm image as bright, saturated, and warm", () => {
    const tone = artToneFromPixels(pixels(230, 180, 120), 3)!;
    expect(tone.luminance).toBeGreaterThan(0.62);
    expect(tone.saturation).toBeGreaterThan(0.28);
    expect(tone.warmth).toBeGreaterThan(0);
  });

  it("ignores an alpha channel and rejects single-channel input", () => {
    expect(artToneFromPixels(Uint8Array.from([40, 40, 40, 255]), 4)!.luminance).toBeCloseTo(0.157, 2);
    expect(artToneFromPixels(Uint8Array.from([40]), 1)).toBeNull();
  });
});

describe("measureArtTone", () => {
  it("measures an encoded image through the decoder", async () => {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 40, b: 40 } } })
      .jpeg()
      .toBuffer();
    const tone = (await measureArtTone(bytes))!;
    expect(tone.luminance).toBeCloseTo(0.157, 1);
    expect(tone.saturation).toBeLessThan(0.05);
  });

  it("returns null rather than throwing on undecodable bytes", async () => {
    expect(await measureArtTone(Buffer.from("not an image"))).toBeNull();
  });
});

describe("describeArtTone", () => {
  it("states brightness, colour, and temperature", () => {
    expect(describeArtTone(bleak)).toBe("dark, near-monochrome, neutral");
    expect(describeArtTone(sunlit)).toBe("bright, vivid, warm");
  });
});

describe("toneMismatch", () => {
  it("hard-rejects a bleak monochrome image for a tender reading", () => {
    expect(toneMismatch("tender", bleak)).toEqual({
      severity: "hard",
      reason: "bleak and near-monochrome against a tender, warm reading",
    });
  });

  it("accepts a warm sunlit image for a tender reading", () => {
    expect(toneMismatch("tender", sunlit)).toBeNull();
  });

  it("hard-rejects a bright vivid image for an ominous reading", () => {
    expect(toneMismatch("ominous", sunlit)?.severity).toBe("hard");
    expect(toneMismatch("ominous", bleak)).toBeNull();
  });

  it("flags a single-axis clash softly rather than hard", () => {
    expect(toneMismatch("warm", { luminance: 0.2, saturation: 0.4, warmth: 0.3 })?.severity).toBe("soft");
    expect(toneMismatch("melancholy", sunlit)?.severity).toBe("soft");
  });

  it("stays neutral without a valence lean or a measurement", () => {
    expect(toneMismatch("neutral", bleak)).toBeNull();
    expect(toneMismatch("tender", undefined)).toBeNull();
  });
});

describe("demoteToneMismatches", () => {
  it("drops hard conflicts while the aligned pool stays large enough", () => {
    const candidates = [
      { id: "bleak", tone: bleak },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `sunlit${index}`, tone: sunlit })),
    ];
    expect(demoteToneMismatches(candidates, "tender", 6).map((candidate) => candidate.id))
      .toEqual(["sunlit0", "sunlit1", "sunlit2", "sunlit3", "sunlit4", "sunlit5"]);
  });

  it("restores conflicts rather than starving the curator", () => {
    const candidates = [
      { id: "bleak", tone: bleak },
      { id: "sunlit", tone: sunlit },
    ];
    expect(demoteToneMismatches(candidates, "tender", 2).map((candidate) => candidate.id))
      .toEqual(["sunlit", "bleak"]);
  });

  it("keeps unmeasured candidates in the pool", () => {
    const unmeasured = [{ id: "unknown", tone: undefined }];
    expect(demoteToneMismatches(unmeasured, "tender", 6).map((candidate) => candidate.id))
      .toEqual(["unknown"]);
  });
});
