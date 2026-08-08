import type { ProviderOutcome } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timecodeToMs(timecode?: string): number | undefined {
  if (!timecode) return undefined;
  const parts = timecode.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return undefined;
}

export async function recognizeWithAudd(audio: File, token: string): Promise<ProviderOutcome> {
  const form = new FormData();
  form.append("api_token", token);
  // One metadata provider keeps AudD's response smaller and faster than requesting both.
  form.append("return", "apple_music");
  const filename = audio.type.includes("wav") ? "capture.wav" : audio.type.includes("mp4") ? "capture.m4a" : "capture.webm";
  form.append("file", audio, filename);
  const response = await fetch("https://api.audd.io/", { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
  const data = record(await response.json());
  const result = record(data.result);
  console.info(`[recognize] AudD response http=${response.status} status=${text(data.status) ?? "unknown"} matched=${Boolean(data.result)} title=${text(result.title) ?? "none"}`);
  if (!response.ok || data.status === "error") {
    const error = record(data.error);
    const detail = text(error.error_message) ?? text(error.message) ?? "AudD recognition failed.";
    const errorCode = typeof error.error_code === "number" ? error.error_code : Number(error.error_code);
    // AudD 300 = could not fingerprint the capture (silence, noise, unsupported codec).
    // Treat as a soft miss so the UI does not look like a server outage.
    if (errorCode === 300) {
      console.info(`[recognize] AudD fingerprint miss: ${detail}`);
      return { kind: "miss", warning: "Could not hear the music clearly enough to identify." };
    }
    const code = Number.isFinite(errorCode) ? ` (AudD ${errorCode})` : !response.ok ? ` (HTTP ${response.status})` : "";
    console.error(`[recognize] AudD failure${code}: ${detail}`);
    return { kind: "error", error: `${detail}${code}`, status: 502 };
  }
  if (!data.result) return { kind: "miss" };

  const apple = record(result.apple_music);
  const playParams = record(apple.playParams);
  const artwork = record(apple.artwork);
  const timecode = text(result.timecode);
  const appleGenres = Array.isArray(apple.genreNames)
    ? apple.genreNames.filter((item): item is string => typeof item === "string")
    : [];

  return {
    kind: "match",
    match: {
      artist: text(result.artist) ?? "Unknown artist",
      title: text(result.title) ?? "Unknown track",
      album: text(apple.albumName) ?? text(result.album),
      releaseDate: text(apple.releaseDate) ?? text(result.release_date),
      timecode,
      timecodeMs: timecodeToMs(timecode),
      isrc: text(apple.isrc),
      appleTrackId: text(apple.id) ?? text(playParams.id),
      artworkUrl: text(artwork.url),
      genres: appleGenres,
      durationMs: typeof apple.durationInMillis === "number" ? apple.durationInMillis : undefined,
    },
  };
}
