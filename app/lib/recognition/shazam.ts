import { Shazam, s16LEToSamplesArray } from "shazam-api";
import type { ProviderMatch, ProviderOutcome } from "./types";
import { decodeMonoPcm16Wav, floatToS16le, resampleLinear } from "./wav";

const SHAZAM_SAMPLE_RATE = 16_000;

/** Package keeps this type internal; derive it from the public recognize API. */
type ShazamRoot = NonNullable<Awaited<ReturnType<Shazam["fullRecognizeSong"]>>>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataText(root: ShazamRoot, title: string): string | undefined {
  for (const section of root.track?.sections ?? []) {
    if (section.type !== "SONG") continue;
    for (const item of section.metadata ?? []) {
      if (item.title === title) return text(item.text);
    }
  }
  return undefined;
}

/** Map a full Shazam discovery payload into the provider-neutral match shape. */
export function mapShazamRoot(root: ShazamRoot): ProviderMatch | null {
  const track = root.track;
  if (!track?.title) return null;
  const appleAction = track.hub?.actions?.find((action) => action.type === "applemusicplay");
  const offsetSeconds = root.matches?.[0]?.offset;
  const released = metadataText(root, "Released");
  const album = metadataText(root, "Album");
  const genre = text(track.genres?.primary);

  return {
    artist: text(track.subtitle) ?? "Unknown artist",
    title: text(track.title) ?? "Unknown track",
    album,
    releaseDate: released,
    timecodeMs: typeof offsetSeconds === "number" && Number.isFinite(offsetSeconds)
      ? Math.round(offsetSeconds * 1000)
      : undefined,
    isrc: text(track.isrc),
    appleTrackId: text(appleAction?.id),
    appleAlbumId: text(track.albumadamid),
    artworkUrl: text(track.images?.coverarthq) ?? text(track.images?.coverart),
    genres: genre ? [genre] : [],
  };
}

export async function recognizeWithShazam(audio: ArrayBuffer): Promise<ProviderOutcome> {
  try {
    const decoded = decodeMonoPcm16Wav(audio);
    const resampled = resampleLinear(decoded.samples, decoded.sampleRate, SHAZAM_SAMPLE_RATE);
    if (resampled.length < SHAZAM_SAMPLE_RATE * 3) {
      return { kind: "miss", warning: "Could not hear the music clearly enough to identify." };
    }
    const samples = s16LEToSamplesArray(floatToS16le(resampled));
    const shazam = new Shazam();
    const root = await shazam.fullRecognizeSong(samples);
    if (!root?.track?.title) {
      console.info("[recognize] Shazam response matched=false");
      return { kind: "miss" };
    }
    const match = mapShazamRoot(root);
    if (!match) return { kind: "miss" };
    console.info(`[recognize] Shazam response matched=true title=${match.title} offsetMs=${match.timecodeMs ?? "none"}`);
    return { kind: "match", match };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shazam recognition failed.";
    console.error(`[recognize] Shazam failure: ${detail}`);
    return { kind: "error", error: detail, status: 502 };
  }
}
