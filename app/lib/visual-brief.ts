/** Clean identity sent to the brief/dossier models — no ISRCs, covers, or timings. */
export type CleanTrack = {
  artist: string;
  title: string;
  album?: string;
  year?: string;
  genre?: string;
};

export type SongDossier = {
  confidence: "high" | "medium" | "low";
  known_facts: string[];
  uncertain: string[];
  sonic_and_thematic_reading: string;
  literal_traps_to_avoid: string[];
  artist_or_album_priors: string[];
};

export type VisualBrief = {
  confidence: SongDossier["confidence"];
  semantic_anchors: string[];
  sonic_character: string[];
  emotional_tone: string[];
  formal_qualities: string[];
  cultural_context: string[];
  visual_direction: string[];
  avoid: string[];
  mood: string[];
  energy: "low" | "medium" | "high";
  palette: string[];
  visual_motifs: string[];
  art_movements: string[];
  museum_search_terms: string[];
  curatorial_rationale: string;
  dossier: SongDossier;
};

const MUSIC_SEARCH_WORDS = /\b(song|songs|music|musical|melody|lyric|lyrics|album|track|tracks|band|singer|guitar|piano|drums|bass|violin|orchestra|tempo|rhythm|beat|chorus|verse|ballad|concert|vinyl|record|audio|soundtrack|musician|playlist)\b/i;

function normalize(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** Strip recognition noise so the model only sees curatorial identity. */
export function cleanTrackPayload(track: {
  artist?: string;
  title?: string;
  album?: string;
  year?: string;
  genre?: string;
}): CleanTrack | null {
  const artist = track.artist?.trim();
  const title = track.title?.trim();
  if (!artist || !title) return null;
  const album = track.album?.trim();
  const year = track.year?.trim();
  const genre = track.genre?.trim();
  return {
    artist,
    title,
    ...(album && album !== "Album unknown" ? { album } : {}),
    ...(year ? { year } : {}),
    ...(genre ? { genre } : {}),
  };
}

export function strings(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, limit)
    : [];
}

export function normalizeDossier(value: unknown): SongDossier {
  if (!value || typeof value !== "object") throw new Error("The song dossier response was incomplete.");
  const dossier = value as Record<string, unknown>;
  const confidence = dossier.confidence === "high" || dossier.confidence === "medium" || dossier.confidence === "low"
    ? dossier.confidence
    : "low";
  return {
    confidence,
    known_facts: strings(dossier.known_facts, 6),
    uncertain: strings(dossier.uncertain, 6),
    sonic_and_thematic_reading: typeof dossier.sonic_and_thematic_reading === "string"
      ? dossier.sonic_and_thematic_reading.trim()
      : "",
    literal_traps_to_avoid: strings(dossier.literal_traps_to_avoid, 6),
    artist_or_album_priors: strings(dossier.artist_or_album_priors, 6),
  };
}

/** True when a museum query is likely to retrieve music noise or artist-name hits. */
export function isBlockedSearchTerm(term: string, track: CleanTrack) {
  const cleaned = term.trim();
  if (!cleaned) return true;
  if (wordCount(cleaned) < 1 || wordCount(cleaned) > 4) return true;
  if (MUSIC_SEARCH_WORDS.test(cleaned)) return true;

  const normalizedTerm = normalize(cleaned);
  const artist = normalize(track.artist);
  if (artist && normalizedTerm.includes(artist)) return true;
  const artistTokens = artist.split(" ").filter((token) => token.length >= 4);
  if (artistTokens.some((token) => normalizedTerm === token)) return true;
  return false;
}

/**
 * Keep retrieval-native museum queries: 1–4 words, no music jargon, no artist names,
 * and at most one soft title echo. Dedupes near-duplicates.
 */
export function sanitizeMuseumSearchTerms(terms: string[], track: CleanTrack, limit = 10) {
  const kept: string[] = [];
  const seen = new Set<string>();
  let titleEchoes = 0;
  const title = normalize(track.title);

  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, " ");
    if (isBlockedSearchTerm(term, track)) continue;
    const key = normalize(term);
    if (!key || seen.has(key)) continue;

    const isTitleEcho = Boolean(title && (key === title || title.includes(key) || key.includes(title)));
    if (isTitleEcho) {
      if (titleEchoes >= 1) continue;
      titleEchoes += 1;
    }

    seen.add(key);
    kept.push(term);
    if (kept.length === limit) break;
  }
  return kept;
}

export function normalizeBrief(value: unknown, dossier: SongDossier, track: CleanTrack): VisualBrief {
  if (!value || typeof value !== "object") throw new Error("The visual-brief response was incomplete.");
  const brief = value as Record<string, unknown>;
  const terms = sanitizeMuseumSearchTerms(strings(brief.museum_search_terms, 16), track, 10);
  if (!terms.length) throw new Error("The visual brief did not provide usable museum search terms.");
  const energy = brief.energy === "low" || brief.energy === "medium" || brief.energy === "high" ? brief.energy : "medium";
  return {
    confidence: dossier.confidence,
    semantic_anchors: strings(brief.semantic_anchors, 6),
    sonic_character: strings(brief.sonic_character, 6),
    emotional_tone: strings(brief.emotional_tone, 6),
    formal_qualities: strings(brief.formal_qualities, 6),
    cultural_context: strings(brief.cultural_context, 4),
    visual_direction: strings(brief.visual_direction, 6),
    avoid: strings(brief.avoid, 8),
    mood: strings(brief.mood, 6),
    energy,
    palette: strings(brief.palette, 5),
    visual_motifs: strings(brief.visual_motifs, 8),
    art_movements: strings(brief.art_movements, 3),
    museum_search_terms: terms,
    curatorial_rationale: typeof brief.curatorial_rationale === "string" ? brief.curatorial_rationale.trim() : "",
    dossier,
  };
}

/** Prefer a concrete Apple/iTunes genre; ignore the generic "Music" label. */
export function pickGenreLabel(...candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && !/^music$/i.test(value)) return value;
  }
  return undefined;
}
