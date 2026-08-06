export type CatalogTrack = {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  collectionId?: number;
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  releaseDate?: string;
  artworkUrl100?: string;
  trackNumber?: number;
  trackCount?: number;
  discNumber?: number;
  discCount?: number;
  trackTimeMillis?: number;
};

const COMPILATION_TERMS = /\b(best of|collection|compilation|essential|greatest|hits|samples|soundtrack|various|dj mix)\b/i;

function normalize(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeRecordingTitle(value: string | undefined) {
  return normalize((value ?? "")
    .replace(/[([]\s*(?:album version|album mix|original album version|single version|radio edit|remaster(?:ed)?(?:\s+\d{4})?)\s*[)\]]/gi, " ")
    .replace(/\b(?:album version|album mix|original album version)\b$/gi, " "));
}

/** Prefer an original-looking exact recording over compilations and DJ mixes. */
export function selectCatalogTrack(artist: string, title: string, tracks: CatalogTrack[]) {
  const wantedArtist = normalize(artist);
  const wantedTitle = normalizeRecordingTitle(title);
  let best: { track: CatalogTrack; score: number } | undefined;

  for (const track of tracks) {
    const candidateArtist = normalize(track.artistName);
    const candidateTitle = normalizeRecordingTitle(track.trackName);
    const hasArtists = Boolean(candidateArtist && wantedArtist);
    const artistScore = hasArtists && candidateArtist === wantedArtist
      ? 60
      : hasArtists && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist)) ? 35 : 0;
    const titleScore = candidateTitle === wantedTitle ? 80 : 0;
    if (!artistScore || !titleScore) continue;
    const compilationPenalty = COMPILATION_TERMS.test(track.collectionName ?? "") ? 45 : 0;
    const score = artistScore + titleScore - compilationPenalty;
    if (!best || score > best.score) best = { track, score };
  }

  return best?.track;
}

export function largeAlbumArtwork(url: string | undefined) {
  if (!url) return undefined;
  return url
    .replace("{w}x{h}bb.jpg", "1000x1000bb.jpg")
    .replace(/\/\d+x\d+bb\.(jpg|jpeg|png)$/i, "/1000x1000bb.$1");
}

/** Normalize an Apple collection lookup into record playback order. */
export function orderedCatalogAlbum(collectionId: number, results: CatalogTrack[]) {
  const seen = new Set<string>();
  return results
    .filter((track) => track.collectionId === collectionId && track.trackName && (!track.kind || track.kind === "song"))
    .sort((left, right) => (left.discNumber ?? 1) - (right.discNumber ?? 1)
      || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER))
    .filter((track) => {
      const key = track.trackId ? `id:${track.trackId}` : `${track.discNumber ?? 1}:${track.trackNumber ?? 0}:${normalize(track.trackName)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
