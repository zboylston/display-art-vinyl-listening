export type RecognitionProvider = "audd" | "shazam";

export type ProviderMatch = {
  artist: string;
  title: string;
  album?: string;
  releaseDate?: string;
  /** Position in the song at match time, in milliseconds. */
  timecodeMs?: number;
  /** AudD-style mm:ss string when the provider supplies one. */
  timecode?: string;
  isrc?: string;
  appleTrackId?: string;
  appleAlbumId?: string;
  artworkUrl?: string;
  genres: string[];
  durationMs?: number;
};

export type ProviderOutcome =
  | { kind: "match"; match: ProviderMatch }
  | { kind: "miss"; warning?: string }
  | { kind: "error"; error: string; status: number };
