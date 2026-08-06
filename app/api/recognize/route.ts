import { NextResponse } from "next/server";
import { largeAlbumArtwork, orderedCatalogAlbum, selectCatalogTrack, type CatalogTrack } from "../../lib/track-metadata";

const MAX_CAPTURE_BYTES = 3_000_000;
const MIN_CAPTURE_BYTES = 8_000;
const ALLOWED_TYPES = new Set(["audio/wav", "audio/webm", "audio/mp4", "audio/x-m4a"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

export async function POST(request: Request) {
  const token = process.env.AUDD_API_TOKEN;
  if (!token) return NextResponse.json({ error: "AudD is not configured. Add AUDD_API_TOKEN to .env.local." }, { status: 503 });
  try {
    const input = await request.formData().catch(() => null);
    if (!input) return NextResponse.json({ error: "Expected a multipart audio capture." }, { status: 400 });
    const audio = input.get("audio");
    const vinylMode = input.get("mode") === "vinyl";
    if (!(audio instanceof File)) return NextResponse.json({ error: "Missing audio capture." }, { status: 400 });
    if (audio.size < MIN_CAPTURE_BYTES) return NextResponse.json({ error: "Audio capture is too short." }, { status: 400 });
    if (audio.size > MAX_CAPTURE_BYTES) return NextResponse.json({ error: "Audio capture is too large." }, { status: 413 });
    if (audio.type && !ALLOWED_TYPES.has(audio.type.split(";")[0])) return NextResponse.json({ error: "Unsupported audio format." }, { status: 415 });
    console.info(`[recognize] capture bytes=${audio.size} type=${audio.type || "unknown"}`);
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
      return NextResponse.json({ error: text(error.error_message) ?? "AudD recognition failed." }, { status: 502 });
    }
    if (!data.result) return NextResponse.json({ result: null });

    const apple = record(result.apple_music);
    const playParams = record(apple.playParams);
    const artwork = record(apple.artwork);
    const artworkTemplate = text(artwork.url);
    const artist = text(result.artist) ?? "Unknown artist";
    const title = text(result.title) ?? "Unknown track";
    const appleTrackId = text(apple.id) ?? text(playParams.id);
    const preferredAlbum = text(apple.albumName) ?? text(result.album);
    const [catalogById, catalogCandidates] = await Promise.all([
      catalogTrackById(appleTrackId),
      catalogSearch(artist, title),
    ]);
    const catalog = selectCatalogTrack(
      artist,
      title,
      [...(catalogById ? [catalogById] : []), ...catalogCandidates],
      preferredAlbum,
    );
    const discoveredAlbumTracks = vinylMode && catalog?.collectionId ? await catalogAlbum(catalog.collectionId) : [];
    // A one-track result is generally a single, not a usable vinyl sequence. Keep
    // recognition live in that case instead of falsely locking at “Track 1 of 1”.
    const albumTracks = discoveredAlbumTracks.length > 1 ? discoveredAlbumTracks : [];
    const sequenceIndex = albumTracks.findIndex((track) => (
      (Boolean(catalog?.trackId) && track.trackId === catalog?.trackId)
      || (Boolean(catalog) && track.trackName === catalog?.trackName && track.artistName === catalog?.artistName)
    ));
    const albumSequence = albumTracks.map((track) => ({
      artist: track.artistName ?? artist,
      title: track.trackName ?? "Unknown track",
      album: track.collectionName ?? catalog?.collectionName ?? "Album unknown",
      year: (track.releaseDate ?? catalog?.releaseDate ?? "").slice(0, 4),
      albumCover: largeAlbumArtwork(track.artworkUrl100 ?? catalog?.artworkUrl100),
      durationMs: track.trackTimeMillis,
      collectionId: track.collectionId,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
    }));
    console.info(`[recognize] mode=${vinylMode ? "vinyl" : "live"} catalog=${catalog?.collectionId ?? "none"} sequence=${albumSequence.length} index=${sequenceIndex}`);
    return NextResponse.json({
      result: {
        artist,
        title,
        album: text(catalog?.collectionName) ?? text(apple.albumName) ?? text(result.album) ?? "Album unknown",
        releaseDate: text(catalog?.releaseDate) ?? text(apple.releaseDate) ?? text(result.release_date) ?? "",
        timecode: text(result.timecode),
        isrc: text(apple.isrc),
        durationMs: typeof apple.durationInMillis === "number" ? apple.durationInMillis : undefined,
        albumCover: largeAlbumArtwork(text(catalog?.artworkUrl100) ?? artworkTemplate),
        collectionId: catalog?.collectionId,
        trackNumber: catalog?.trackNumber,
        discNumber: catalog?.discNumber,
        albumSequence,
        sequenceIndex: sequenceIndex >= 0 ? sequenceIndex : undefined,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Recognition failed." }, { status: 500 });
  }
}
