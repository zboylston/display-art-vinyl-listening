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
  primaryGenreName?: string;
};

const COMPILATION_TERMS = /\b(best of|box\s*set|collection|compilation|complete|essential|greatest|hits|anthology|remasters?|samples|sessions|soundtrack|various|dj mix)\b/i;
const SINGLE_RELEASE = /-\s*single\b/i;

export type SelectCatalogOptions = {
  preferredAlbum?: string;
  /** Vinyl discovery: the first ID is assumed to be side A / track 1. */
  preferAlbumOpener?: boolean;
};

function isSingleRelease(track: CatalogTrack) {
  return track.trackCount === 1 || SINGLE_RELEASE.test(track.collectionName ?? "");
}

/** Disc 1 / track 1 — the usual place a needle drops when Vinyl Mode starts. */
export function isAlbumOpener(track: CatalogTrack) {
  return (track.trackNumber ?? 0) === 1 && (track.discNumber ?? 1) === 1;
}

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

/** Prefer an original-looking exact recording over compilations, DJ mixes, and single-only releases. */
export function selectCatalogTrack(
  artist: string,
  title: string,
  tracks: CatalogTrack[],
  preferredAlbumOrOptions?: string | SelectCatalogOptions,
  maybeOptions?: SelectCatalogOptions,
) {
  const options: SelectCatalogOptions = typeof preferredAlbumOrOptions === "string" || preferredAlbumOrOptions === undefined
    ? { preferredAlbum: preferredAlbumOrOptions, ...maybeOptions }
    : preferredAlbumOrOptions;
  const wantedArtist = normalize(artist);
  const wantedTitle = normalizeRecordingTitle(title);
  const wantedAlbum = normalize(options.preferredAlbum);
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
    // AudD/Apple can point to a same-title single even when the recognized song belongs
    // to an album. Prefer an explicitly matching album and, absent that, an album release
    // with a real track list. This makes Vinyl Mode useful without changing live matching.
    const preferredAlbumBonus = wantedAlbum && !isSingleRelease(track) && normalize(track.collectionName) === wantedAlbum ? 80 : 0;
    const albumLengthBonus = Math.min(12, Math.max(0, (track.trackCount ?? 1) - 1));
    const singlePenalty = isSingleRelease(track) ? 24 : 0;
    // Vinyl discovery only: assume the needle is at the start of the record.
    // Strong enough to beat AudD's preferred compilation/box-set album (+80).
    const openerAdjustment = options.preferAlbumOpener
      ? (isAlbumOpener(track) ? 50 : -90)
      : 0;
    const score = artistScore + titleScore + preferredAlbumBonus + albumLengthBonus + openerAdjustment
      - compilationPenalty - singlePenalty;
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
