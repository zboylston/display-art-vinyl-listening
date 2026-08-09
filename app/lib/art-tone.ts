import sharp from "sharp";
import type { Valence } from "./visual-brief";

/** Measured appearance of a candidate image, averaged over a downscaled copy. */
export type ArtTone = {
  /** Perceived brightness, 0 (black) to 1 (white). */
  luminance: number;
  /** Mean chroma, 0 (grayscale) to 1 (fully saturated). */
  saturation: number;
  /** Colour temperature, -1 (cold blue) to 1 (warm amber). */
  warmth: number;
};

export type ToneMismatch = {
  /** Hard mismatches are demoted before the curator ever sees them. */
  severity: "hard" | "soft";
  reason: string;
};

export type TonedCandidate = { tone?: ArtTone };

const DARK_LUMINANCE = 0.38;
const BRIGHT_LUMINANCE = 0.62;
const MONOCHROME_SATURATION = 0.1;
const VIVID_SATURATION = 0.28;
/** Sampling beyond this adds cost without moving the averages. */
const SAMPLE_EDGE = 48;

/** Mean luminance, chroma, and warmth of raw interleaved RGB pixels. */
export function artToneFromPixels(pixels: Uint8Array | Buffer, channels: number): ArtTone | null {
  if (channels < 3) return null;
  let luminance = 0;
  let saturation = 0;
  let warmth = 0;
  let count = 0;

  for (let index = 0; index + channels <= pixels.length; index += channels) {
    const red = pixels[index] / 255;
    const green = pixels[index + 1] / 255;
    const blue = pixels[index + 2] / 255;
    luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    saturation += Math.max(red, green, blue) - Math.min(red, green, blue);
    warmth += red - blue;
    count += 1;
  }

  if (!count) return null;
  return { luminance: luminance / count, saturation: saturation / count, warmth: warmth / count };
}

/**
 * Decode a downscaled copy so a black-and-white or funereal image is a measured
 * fact rather than something the curator model has to notice on its own.
 */
export async function measureArtTone(bytes: Buffer): Promise<ArtTone | null> {
  try {
    const { data, info } = await sharp(bytes)
      .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: "inside" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    return artToneFromPixels(data, info.channels);
  } catch {
    return null;
  }
}

export function isDark(tone: ArtTone) {
  return tone.luminance <= DARK_LUMINANCE;
}

export function isNearMonochrome(tone: ArtTone) {
  return tone.saturation <= MONOCHROME_SATURATION;
}

/** Short phrase stating what the image actually looks like, for curator prompts. */
export function describeArtTone(tone: ArtTone) {
  const brightness = tone.luminance <= DARK_LUMINANCE
    ? "dark"
    : tone.luminance >= BRIGHT_LUMINANCE ? "bright" : "mid-toned";
  const colour = tone.saturation <= MONOCHROME_SATURATION
    ? "near-monochrome"
    : tone.saturation >= VIVID_SATURATION ? "vivid" : "muted colour";
  const temperature = Math.abs(tone.warmth) < 0.02 ? "neutral" : tone.warmth > 0 ? "warm" : "cool";
  return `${brightness}, ${colour}, ${temperature}`;
}

/**
 * Energy alone cannot separate "tender" from "bleak" — both read as low. This is
 * the valence guard: it compares the brief's emotional temperature against the
 * image's measured one so a funereal picture cannot win a gentle song.
 */
export function toneMismatch(valence: Valence, tone: ArtTone | undefined): ToneMismatch | null {
  if (!tone) return null;
  const dark = isDark(tone);
  const monochrome = isNearMonochrome(tone);
  const bright = tone.luminance >= BRIGHT_LUMINANCE;
  const vivid = tone.saturation >= VIVID_SATURATION;

  if (valence === "tender" || valence === "warm") {
    if (dark && monochrome) {
      return { severity: "hard", reason: "bleak and near-monochrome against a tender, warm reading" };
    }
    if (dark) return { severity: "soft", reason: "darker than the brief's warmth" };
    if (monochrome) return { severity: "soft", reason: "drained of the brief's colour" };
    if (tone.warmth < -0.06) return { severity: "soft", reason: "colder than the brief's warmth" };
    return null;
  }

  if (valence === "ominous") {
    if (bright && vivid) {
      return { severity: "hard", reason: "bright and vivid against an ominous reading" };
    }
    return null;
  }

  if (valence === "melancholy" && bright && vivid) {
    return { severity: "soft", reason: "brighter and more vivid than the brief's melancholy" };
  }
  return null;
}

/**
 * Drop hard valence conflicts, but never starve the curator: conflicting works
 * come back when too few aligned candidates survive retrieval.
 */
export function demoteToneMismatches<T extends TonedCandidate>(
  candidates: T[],
  valence: Valence,
  minimum: number,
): T[] {
  const aligned: T[] = [];
  const conflicted: T[] = [];
  for (const candidate of candidates) {
    if (toneMismatch(valence, candidate.tone)?.severity === "hard") conflicted.push(candidate);
    else aligned.push(candidate);
  }
  if (aligned.length >= minimum) return aligned;
  return [...aligned, ...conflicted.slice(0, minimum - aligned.length)];
}
