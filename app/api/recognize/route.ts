import { NextResponse } from "next/server";
import { largeAlbumArtwork, orderedCatalogAlbum, selectCatalogTrack, type CatalogTrack } from "../../lib/track-metadata";
import { pickGenreLabel } from "../../lib/visual-brief";
import { recognizeWithAudd } from "../../lib/recognition/audd";
import { recognizeWithShazam } from "../../lib/recognition/shazam";
import type { ProviderMatch, RecognitionProvider } from "../../lib/recognition/types";

const MAX_CAPTURE_BYTES = 3_000_000;
const MIN_CAPTURE_BYTES = 8_000;
const ALLOWED_TYPES = new Set(["audio/wav", "audio/webm", "audio/mp4", "audio/x-m4a"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function msToTimecode(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resolveProvider(requested: FormDataEntryValue | null): RecognitionProvider {
  const fromForm = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (fromForm === "audd" || fromForm === "shazam") return fromForm;
  const fromEnv = (process.env.RECOGNITION_PROVIDER ?? "audd").trim().toLowerCase();
  return fromEnv === "shazam" ? "shazam" : "audd";
}

async function catalogSearch(artist: string, title: string): Promise<CatalogTrack[]> {
  try {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", `${artist} ${title}`);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("country", "US");
    url.searchParams.set("limit", "20");
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) return [];
    const data = await response.json() as { results?: CatalogTrack[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

async function catalogTrackById(trackId: string | undefined) {
  if (!trackId || !/^\d+$/.test(trackId)) return undefined;
  try {
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("id", trackId);
    url.searchParams.set("entity", "song");
    url.searchParams.set("country", "US");
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) return undefined;
    const data = await response.json() as { results?: CatalogTrack[] };
    return data.results?.find((track) => track.trackId === Number(trackId) && track.trackName);
  } catch {
    return undefined;
  }
}

async function catalogAlbum(collectionId: number) {
  try {
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("id", String(collectionId));
    url.searchParams.set("entity", "song");
    url.searchParams.set("country", "US");
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) return [];
    const data = await response.json() as { results?: CatalogTrack[] };
    return orderedCatalogAlbum(collectionId, data.results ?? []);
  } catch {
    return [];
  }
}

async function identifyCapture(audio: File, provider: RecognitionProvider) {
  if (provider === "shazam") {
    const mime = (audio.type || "").split(";")[0];
    if (mime && mime !== "audio/wav") {
      console.info(`[recognize] Shazam requires WAV; falling back to AudD for type=${mime || "unknown"}`);
      const token = process.env.AUDD_API_TOKEN;
      if (!token) {
        return {
          provider: "audd" as const,
          outcome: {
            kind: "error" as const,
            error: "AudD is not configured for non-WAV fallback. Add AUDD_API_TOKEN to .env.local.",
            status: 503,
          },
        };
      }
      return { provider: "audd" as const, outcome: await recognizeWithAudd(audio, token) };
    }
    return { provider, outcome: await recognizeWithShazam(await audio.arrayBuffer()) };
  }

  const token = process.env.AUDD_API_TOKEN;
  if (!token) {
    return {
      provider,
      outcome: {
        kind: "error" as const,
        error: "AudD is not configured. Add AUDD_API_TOKEN to .env.local.",
        status: 503,
      },
    };
  }
  return { provider, outcome: await recognizeWithAudd(audio, token) };
}

export async function POST(request: Request) {
  try {
    const input = await request.formData().catch(() => null);
    if (!input) return NextResponse.json({ error: "Expected a multipart audio capture." }, { status: 400 });
    const audio = input.get("audio");
    const vinylMode = input.get("mode") === "vinyl";
    let provider = resolveProvider(input.get("provider"));
    if (!(audio instanceof File)) return NextResponse.json({ error: "Missing audio capture." }, { status: 400 });
    if (audio.size < MIN_CAPTURE_BYTES) return NextResponse.json({ error: "Audio capture is too short." }, { status: 400 });
    if (audio.size > MAX_CAPTURE_BYTES) return NextResponse.json({ error: "Audio capture is too large." }, { status: 413 });
    if (audio.type && !ALLOWED_TYPES.has(audio.type.split(";")[0])) return NextResponse.json({ error: "Unsupported audio format." }, { status: 415 });
    console.info(`[recognize] provider=${provider} capture bytes=${audio.size} type=${audio.type || "unknown"}`);

    const identified = await identifyCapture(audio, provider);
    provider = identified.provider;
    const outcome = identified.outcome;
    if (outcome.kind === "error") return NextResponse.json({ error: outcome.error, provider }, { status: outcome.status });
    if (outcome.kind === "miss") {
      return NextResponse.json({
        result: null,
        provider,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      });
    }

    const match: ProviderMatch = outcome.match;
    const artist = match.artist;
    const title = match.title;
    const preferredAlbum = match.album;
    const [catalogById, catalogCandidates] = await Promise.all([
      catalogTrackById(match.appleTrackId),
      catalogSearch(artist, title),
    ]);
    const catalog = selectCatalogTrack(
      artist,
      title,
      [...(catalogById ? [catalogById] : []), ...catalogCandidates],
      preferredAlbum,
    );
    // Prefer Shazam's album adam id when iTunes search picked a different collection.
    const collectionId = catalog?.collectionId
      ?? (match.appleAlbumId && /^\d+$/.test(match.appleAlbumId) ? Number(match.appleAlbumId) : undefined);
    const genre = pickGenreLabel(match.genres[0], match.genres[1], catalog?.primaryGenreName, catalogById?.primaryGenreName);
    const discoveredAlbumTracks = vinylMode && collectionId ? await catalogAlbum(collectionId) : [];
    // A one-track result is generally a single, not a usable vinyl sequence. Keep
    // recognition live in that case instead of falsely locking at “Track 1 of 1”.
    const albumTracks = discoveredAlbumTracks.length > 1 ? discoveredAlbumTracks : [];
    const sequenceIndex = albumTracks.findIndex((track) => (
      (Boolean(catalog?.trackId) && track.trackId === catalog?.trackId)
      || (Boolean(match.appleTrackId) && track.trackId === Number(match.appleTrackId))
      || (Boolean(catalog) && track.trackName === catalog?.trackName && track.artistName === catalog?.artistName)
    ));
    const albumSequence = albumTracks.map((track) => ({
      artist: track.artistName ?? artist,
      title: track.trackName ?? "Unknown track",
      album: track.collectionName ?? catalog?.collectionName ?? preferredAlbum ?? "Album unknown",
      year: (track.releaseDate ?? catalog?.releaseDate ?? match.releaseDate ?? "").slice(0, 4),
      albumCover: largeAlbumArtwork(track.artworkUrl100 ?? catalog?.artworkUrl100 ?? match.artworkUrl),
      durationMs: track.trackTimeMillis,
      collectionId: track.collectionId,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      genre,
    }));
    const durationMs = match.durationMs ?? catalog?.trackTimeMillis ?? catalogById?.trackTimeMillis;
    const timecodeMs = match.timecodeMs;
    console.info(`[recognize] provider=${provider} mode=${vinylMode ? "vinyl" : "live"} catalog=${collectionId ?? "none"} sequence=${albumSequence.length} index=${sequenceIndex}`);
    return NextResponse.json({
      provider,
      result: {
        artist,
        title,
        album: text(catalog?.collectionName) ?? preferredAlbum ?? "Album unknown",
        releaseDate: text(catalog?.releaseDate) ?? match.releaseDate ?? "",
        timecode: match.timecode ?? msToTimecode(timecodeMs),
        timecodeMs,
        isrc: match.isrc,
        durationMs,
        albumCover: largeAlbumArtwork(text(catalog?.artworkUrl100) ?? match.artworkUrl),
        collectionId,
        trackNumber: catalog?.trackNumber,
        discNumber: catalog?.discNumber,
        genre,
        albumSequence,
        sequenceIndex: sequenceIndex >= 0 ? sequenceIndex : undefined,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Recognition failed." }, { status: 500 });
  }
}
