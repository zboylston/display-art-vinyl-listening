import type { VinylProgress } from "./vinyl-folio";

export type PresentationAct = "ready" | "track" | "handoff" | "art" | "art-fade" | "gallery" | "return";
export type ListeningMode = "live" | "vinyl";

export type DisplayTrack = {
  artist: string;
  title: string;
  album: string;
  year: string;
  albumCover?: string;
  genre?: string;
};

export type DisplayArtwork = {
  id?: string;
  title: string;
  artist: string;
  date: string;
  museum: string;
  image: string;
  rationale: string;
};

/** Compact presentation state shared from phone controller → TV display. */
export type DisplaySnapshot = {
  act: PresentationAct;
  listeningMode: ListeningMode;
  isListening: boolean;
  status: string;
  currentTrack: DisplayTrack | null;
  artwork: DisplayArtwork | null;
  vinylProgress: VinylProgress | null;
  updatedAt: number;
};

export const DISPLAY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DISPLAY_SESSION_TTL_SECONDS = 60 * 60 * 4;

export function createEmptySnapshot(partial?: Partial<DisplaySnapshot>): DisplaySnapshot {
  return {
    act: "ready",
    listeningMode: "live",
    isListening: false,
    status: "Ready to listen.",
    currentTrack: null,
    artwork: null,
    vinylProgress: null,
    updatedAt: Date.now(),
    ...partial,
  };
}

export function normalizeDisplayCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function isDisplayCode(value: string) {
  return /^[A-Z0-9]{6}$/.test(normalizeDisplayCode(value));
}

export function generateDisplayCode(random: () => number = Math.random) {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += DISPLAY_CODE_ALPHABET[Math.floor(random() * DISPLAY_CODE_ALPHABET.length)]!;
  }
  return code;
}

export function isPresentationAct(act: PresentationAct) {
  return act === "track" || act === "handoff" || act === "art" || act === "art-fade" || act === "gallery" || act === "return";
}

/** Strip controller recognition failures so the TV never mirrors AudD/HTTP errors. */
export function sanitizeDisplayStatus(status: string, isListening = false) {
  if (/recognition error|\b502\b|\b503\b|audd|fingerprint|could not hear the music clearly/i.test(status)) {
    return isListening ? "Listening for the next piece…" : "Ready when you are.";
  }
  return status;
}

export function parseDisplaySnapshot(value: unknown): DisplaySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const act = raw.act;
  if (typeof act !== "string" || !isKnownAct(act)) return null;
  const listeningMode = raw.listeningMode === "vinyl" ? "vinyl" : "live";
  const isListening = Boolean(raw.isListening);
  const status = typeof raw.status === "string" ? raw.status : "";
  return {
    act,
    listeningMode,
    isListening,
    status: sanitizeDisplayStatus(status, isListening),
    currentTrack: parseTrack(raw.currentTrack),
    artwork: parseArtwork(raw.artwork),
    vinylProgress: parseVinylProgress(raw.vinylProgress),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function isKnownAct(value: string): value is PresentationAct {
  return value === "ready" || value === "track" || value === "handoff" || value === "art" || value === "art-fade" || value === "gallery" || value === "return";
}

function parseTrack(value: unknown): DisplayTrack | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.artist !== "string" || typeof raw.title !== "string") return null;
  return {
    artist: raw.artist,
    title: raw.title,
    album: typeof raw.album === "string" ? raw.album : "Album unknown",
    year: typeof raw.year === "string" ? raw.year : "",
    ...(typeof raw.albumCover === "string" ? { albumCover: raw.albumCover } : {}),
    ...(typeof raw.genre === "string" ? { genre: raw.genre } : {}),
  };
}

function parseArtwork(value: unknown): DisplayArtwork | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || typeof raw.artist !== "string" || typeof raw.image !== "string") return null;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    title: raw.title,
    artist: raw.artist,
    date: typeof raw.date === "string" ? raw.date : "",
    museum: typeof raw.museum === "string" ? raw.museum : "",
    image: raw.image,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
  };
}

function parseVinylProgress(value: unknown): VinylProgress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.trackIndex !== "number" || typeof raw.totalTracks !== "number") return null;
  return {
    ...(typeof raw.discNumber === "number" ? { discNumber: raw.discNumber } : {}),
    trackIndex: raw.trackIndex,
    totalTracks: raw.totalTracks,
  };
}
