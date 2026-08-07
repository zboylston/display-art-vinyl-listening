/**
 * Discogs vinyl side lookups. Server-only — requires DISCOGS_API_TOKEN.
 * Vinyl sides are facts taken from release tracklist positions (A1, B2…);
 * when Discogs cannot confirm them, callers get undefined and the flip
 * experience simply stays off rather than guessing.
 */

export type DiscogsTrackEntry = {
  position?: string;
  title?: string;
  type_?: string;
  duration?: string;
};

type DiscogsSearchResult = {
  id?: number;
  title?: string;
  year?: number;
  type?: string;
};

export type VinylSideAssignment = (string | undefined)[];

const DISCOGS_API = "https://api.discogs.com";
const USER_AGENT = "NeedleAndFrame/1.0";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RELEASE_CANDIDATES = 3;

const sidesCache = new Map<string, { at: number; sides: VinylSideAssignment | undefined }>();

/** "A1" / "A-1" / "A.1" → side A, track 1. Lone "A" (single-track side) → A1. CD-style "3" → undefined. */
export function parseVinylPosition(position: string | undefined) {
  if (!position) return undefined;
  const cleaned = position.trim().toUpperCase();
  const full = cleaned.match(/^([A-Z]{1,2})[\s.\-]?(\d+)$/);
  if (full) return { side: full[1], sideTrack: Number(full[2]) };
  const loneSide = cleaned.match(/^([A-Z]{1,2})$/);
  if (loneSide) return { side: loneSide[1], sideTrack: 1 };
  return undefined;
}

function normalizeTitle(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesMatch(a: string | undefined, b: string | undefined) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/**
 * Align a Discogs vinyl tracklist to the ordered album tracks we play.
 * Positions are authoritative when counts match; otherwise fall back to
 * unique normalized-title matches. Returns undefined unless every album
 * track gets a side — a partial map would guess at the boundary.
 */
export function alignVinylSides(entries: DiscogsTrackEntry[], albumTitles: string[]): VinylSideAssignment | undefined {
  const tracks = entries
    .filter((entry) => (entry.type_ === undefined || entry.type_ === "track") && entry.title)
    .map((entry) => ({ title: entry.title ?? "", parsed: parseVinylPosition(entry.position) }));
  if (!tracks.length || tracks.some((track) => !track.parsed)) return undefined;

  if (tracks.length === albumTitles.length) {
    return tracks.map((track) => track.parsed?.side);
  }

  const used = new Set<number>();
  const sides: VinylSideAssignment = albumTitles.map(() => undefined);
  let matched = 0;
  albumTitles.forEach((albumTitle, albumIndex) => {
    const foundAt = tracks.findIndex((track, trackIndex) => !used.has(trackIndex) && titlesMatch(track.title, albumTitle));
    if (foundAt >= 0) {
      used.add(foundAt);
      sides[albumIndex] = tracks[foundAt].parsed?.side;
      matched += 1;
    }
  });
  return matched === albumTitles.length ? sides : undefined;
}

async function discogsFetch<T>(url: string, token: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Discogs token=${token}`, "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return undefined;
    return await response.json() as T;
  } catch {
    return undefined;
  }
}

function pickReleaseCandidates(results: DiscogsSearchResult[], album: string) {
  const wanted = normalizeTitle(album);
  return results
    .filter((result) => result.id && result.type === "release" && titlesMatch(result.title?.split(" - ").slice(1).join(" - ") ?? result.title, wanted))
    .sort((a, b) => (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MAX_RELEASE_CANDIDATES);
}

/**
 * Resolve vinyl sides for an album's ordered track titles.
 * Undefined when no token, no vinyl release, or no confident alignment.
 */
export async function fetchVinylSides(
  artist: string,
  album: string,
  albumTitles: string[],
  token: string | undefined,
): Promise<VinylSideAssignment | undefined> {
  if (!token || !albumTitles.length) return undefined;
  const cacheKey = `${normalizeTitle(artist)}|${normalizeTitle(album)}|${albumTitles.length}`;
  const cached = sidesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sides;

  const searchUrl = `${DISCOGS_API}/database/search?artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}&format=Vinyl&type=release&per_page=10`;
  const search = await discogsFetch<{ results?: DiscogsSearchResult[] }>(searchUrl, token);
  const candidates = pickReleaseCandidates(search?.results ?? [], album);

  let sides: VinylSideAssignment | undefined;
  for (const candidate of candidates) {
    const release = await discogsFetch<{ tracklist?: DiscogsTrackEntry[] }>(`${DISCOGS_API}/releases/${candidate.id}`, token);
    if (!release?.tracklist) continue;
    sides = alignVinylSides(release.tracklist, albumTitles);
    if (sides) break;
  }

  sidesCache.set(cacheKey, { at: Date.now(), sides });
  return sides;
}
