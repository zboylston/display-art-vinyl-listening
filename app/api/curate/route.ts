import OpenAI from "openai";
import { NextResponse } from "next/server";
import { balanceBySource, MIN_LANDSCAPE_RATIO, orientationPoolForCurator } from "../../lib/art-orientation";
import { excludeRecentCandidates, parseRecentArtworkIds } from "../../lib/recent-artwork";
import {
  cleanTrackPayload,
  normalizeBrief,
  normalizeDossier,
  sanitizeMuseumSearchTerms,
  strings,
  type CleanTrack,
  type SongDossier,
  type VisualBrief,
} from "../../lib/visual-brief";

const metApi = "https://collectionapi.metmuseum.org/public/collection/v1";
const clevelandApi = "https://openaccess-api.clevelandart.org/api/artworks/";
const chicagoApi = "https://api.artic.edu/api/v1/artworks/search";
const smithsonianApi = "https://api.si.edu/openaccess/api/v1.0/search";
const model = "gpt-5.6-terra";
const reasoning = { effort: "high" as const };
type ArtSource = "met" | "cleveland" | "artic" | "smithsonian";

type Track = { artist?: string; title?: string; album?: string; year?: string; genre?: string };
type Candidate = {
  id: string;
  source: ArtSource;
  sourceId: string;
  sourceUrl: string;
  rights: "CC0" | "Public Domain";
  title: string;
  artist: string;
  date: string;
  museum: string;
  image: string;
  medium: string;
  objectName: string;
  probeImage: string;
  aspectRatio?: number;
};
type CuratorCandidate = Candidate & { curatorImage: string };

const SEARCH_RESULTS_PER_TERM = 36;
const MAX_OBJECTS_TO_RESOLVE = 60;
const MAX_FINE_ART_TO_PROBE = 60;
const MAX_CURATOR_IMAGE_FETCH = 24;
const MAX_VISUAL_CANDIDATES = 18;
const SEMIFINAL_BATCH_SIZE = 6;
const SEMIFINALISTS_PER_BATCH = 2;
const EXTERNAL_RESULTS_PER_TERM = 12;
const MIN_SEARCH_TERMS = 8;
const MIN_DISPLAY_RATIO = 0.55;
const MAX_DISPLAY_RATIO = 2.8;
const FINE_ART_TERMS = /\b(painting|print|drawing|photograph|photography|photographic|watercolor|watercolour|pastel|lithograph|etching|engraving|woodcut|monotype|collage|gelatin)\b/i;
const OBJECT_TERMS = /\b(armor|armour|bowl|vessel|cup|cabinet|chair|table|mirror|sword|helmet|screen|tureen|plate|jar|beaker|sculpture|relief|mask|textile|garment|coin|instrument|lamp|furniture|weapon|box)\b/i;

function jsonFromModel(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The visual-brief response was not valid JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

async function createDossier(client: OpenAI, track: CleanTrack): Promise<SongDossier> {
  const response = await client.responses.create({
    model,
    reasoning,
    input: [
      {
        role: "developer",
        content: "You are preparing a song dossier for visual curation. Ground the reading in this specific recording first: performing artist, album, genre, and arrangement when known. If the title is a famous standard associated with another artist, contrast this recording with that original and do not inherit the original's visual mythology unless the performing artist is that original artist. Prefer positive sonic and cultural facts over long lists of clichés. Never quote or invent lyrics. Never name specific artworks or museum artists. Return JSON only.",
      },
      {
        role: "user",
        content: `Track identity: ${JSON.stringify(track)}\n\nReturn exactly these JSON keys:\n- confidence: high|medium|low — high only if you know this specific recording (this artist/album take) beyond the title words\n- known_facts: up to 6 short facts about THIS recording or its performers you are reasonably sure about\n- uncertain: up to 6 gaps (arrangement, personnel, whether it is a remake, etc.)\n- sonic_and_thematic_reading: 2-4 sentences on rhythm feel, instrumentation/timbre, energy, setting, and themes for THIS take. If it may be a remake or cover, say how this version likely differs from the famous original. If confidence is low, lean on album/artist/genre priors and say so — still describe probable groove and energy, not only era labels.\n- literal_traps_to_avoid: exactly 2-3 hard bans only (e.g. musician portraits, album-cover restaging). Do not write a long anti-cliché essay. Literal title imagery is allowed when it also matches the recording's energy and setting — only ban it when it would be a shallow one-note gag. This includes social scenes: a crowded dinner-party, feast, or gathering painting is a strong literal match for a song about bringing people together.\n- artist_or_album_priors: up to 6 concrete place, era, light, crowd, or cultural priors useful for museum search, matched to this recording's energy (e.g. dense night interiors and syncopated urban geometry for groove-heavy remakes; open landscape for sparse folk)`,
      },
    ],
  });
  return normalizeDossier(jsonFromModel(response.output_text));
}

async function createVisualPlan(client: OpenAI, track: CleanTrack, dossier: SongDossier): Promise<VisualBrief> {
  const lowConfidenceNote = dossier.confidence === "low" || dossier.confidence === "medium"
    ? "Knowledge is limited. Weight the dossier's sonic_and_thematic_reading and artist_or_album_priors over title wordplay. Build a positive visual world from probable groove, energy, and setting — do not compensate with a long avoid list."
    : "Use track-specific knowledge from the dossier. Keep the visual world faithful to this recording's energy and arrangement.";

  const response = await client.responses.create({
    model,
    reasoning,
    input: [
      {
        role: "developer",
        content: "Create nuanced visual-art direction for a music-listening experience on a large television. Lead with positive grounding from the song dossier: energy, rhythm feel, timbre, and cultural setting. Map sound to visible qualities (e.g. pocket groove → dense overlapping forms and artificial night light; cool classic remade as funk → layered flat color planes and syncopated geometry). Anti-cliché is secondary and short. Never quote lyrics. Do not name specific artworks or museum artists. Return JSON only.",
      },
      {
        role: "user",
        content: `Track identity: ${JSON.stringify(track)}\nSong dossier: ${JSON.stringify(dossier)}\n\n${lowConfidenceNote}\n\nReturn exactly these JSON keys:\n- semantic_anchors: 3-6 concepts grounded in the dossier's reading of THIS recording\n- sonic_character: 3-6 descriptors of space, rhythm, texture, or motion that match the stated energy\n- emotional_tone: 3-6 emotional qualities\n- formal_qualities: 3-6 visible compositional qualities that echo the music (density, syncopation, layering, openness, etc.)\n- cultural_context: up to 4 cautious associations\n- visual_direction: 3-6 requirements for room-scale television display\n- avoid: exactly 3-4 hard bans only — portraits, music notation/instruments as subject, weak decorative fillers. Do not expand the dossier's trap list. Do not ban literal title imagery; a night sky for "Stargazing" is welcome when it also fits the groove, and a lively dinner-party or gathering scene is welcome for a song about coming together.\n- mood: 3-6 adjectives\n- energy: low|medium|high — must match the dossier reading (groove-heavy, punchy, or danceable takes should be high or medium-high, never soft-default medium)\n- palette: 3-5 colors\n- visual_motifs: 4-8 concrete visible motifs museums can catalog, honest to energy (high energy: crowded night interiors, neon doorway, overlapping figures, bold geometric planes, urban signage color; low energy: open landscape, quiet interior, soft horizon)\n- art_movements: up to 3\n- museum_search_terms: exactly 10 retrieval-native museum-catalog queries of 1-4 common words each\n- curatorial_rationale: exactly 2 sentences grounded in the recording's feel\n\nSearch-term mix: 3 tight thematic subjects, 3 settings/atmospheres, 2 formal/light queries, 2 broader wildcards. Prefer concrete nouns museums index. Match energy — for high-energy urban/funk/soul-jazz prefer terms like night cafe, dance hall, neon interior, crowded street, geometric collage, bold color planes; for sparse music prefer open landscape terms. Procession, parade, courtyard, and similar communal public scenes remain valid when they fit the reading. Up to two queries may echo the track title or its literal imagery when that imagery also fits the recording's mood (e.g. "night sky", "starry night" for a dreamy R&B track called Stargazing; "dinner party", "banquet", "supper gathering" for a communal song about bringing people together). Do not use artist names, instruments, or music/audio words.`,
      },
    ],
  });
  return normalizeBrief(jsonFromModel(response.output_text), dossier, track);
}

async function refillSearchTerms(client: OpenAI, track: CleanTrack, dossier: SongDossier, brief: VisualBrief): Promise<string[]> {
  const needed = 10 - brief.museum_search_terms.length;
  if (needed <= 0) return brief.museum_search_terms;
  const response = await client.responses.create({
    model,
    reasoning,
    input: [
      {
        role: "developer",
        content: "Generate replacement museum catalog search queries. Return JSON only.",
      },
      {
        role: "user",
        content: `Track: ${JSON.stringify(track)}\nDossier reading energy cues: ${dossier.sonic_and_thematic_reading}\nDossier priors: ${JSON.stringify(dossier.artist_or_album_priors)}\nMotifs: ${JSON.stringify(brief.visual_motifs)}\nEnergy: ${brief.energy}\nAlready kept: ${JSON.stringify(brief.museum_search_terms)}\n\nReturn {"museum_search_terms":[...]} with ${needed + 4} new 1-4 word concrete catalog queries that are not duplicates of the kept list and match the brief energy. No artist names, instruments, or music/audio words.`,
      },
    ],
  });
  const parsed = jsonFromModel(response.output_text) as { museum_search_terms?: unknown };
  return sanitizeMuseumSearchTerms(
    [...brief.museum_search_terms, ...strings(parsed.museum_search_terms, 16)],
    track,
    10,
  );
}

async function createBrief(client: OpenAI, track: CleanTrack): Promise<VisualBrief> {
  const dossier = await createDossier(client, track);
  let brief = await createVisualPlan(client, track, dossier);
  if (brief.museum_search_terms.length < MIN_SEARCH_TERMS) {
    const terms = await refillSearchTerms(client, track, dossier, brief);
    brief = { ...brief, museum_search_terms: terms };
  }
  if (!brief.museum_search_terms.length) {
    throw new Error("The visual brief did not provide usable museum search terms.");
  }
  return brief;
}

async function searchMet(term: string) {
  const response = await fetch(`${metApi}/search?hasImages=true&q=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return [];
  const data = await response.json() as { objectIDs?: number[] };
  return data.objectIDs?.slice(0, SEARCH_RESULTS_PER_TERM) ?? [];
}

type ClevelandArtwork = {
  id?: number;
  accession_number?: string;
  share_license_status?: string;
  title?: string;
  creation_date?: string;
  creators?: Array<{ description?: string }>;
  culture?: string[];
  technique?: string;
  type?: string;
  url?: string;
  images?: {
    web?: { url?: string; width?: string; height?: string };
    print?: { url?: string; width?: string; height?: string };
  };
};

async function searchCleveland(term: string): Promise<Candidate[]> {
  const url = new URL(clevelandApi);
  url.searchParams.set("q", term);
  url.searchParams.set("cc0", "");
  url.searchParams.set("has_image", "1");
  url.searchParams.set("limit", String(EXTERNAL_RESULTS_PER_TERM));
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return [];
  const data = await response.json() as { data?: ClevelandArtwork[] };
  return (data.data ?? []).flatMap((work) => {
    const web = work.images?.web;
    if (work.share_license_status !== "CC0" || !work.id || !web?.url) return [];
    const width = Number(web.width);
    const height = Number(web.height);
    const artist = work.creators?.map((creator) => creator.description).filter(Boolean).join("; ")
      || work.culture?.join("; ") || "Unknown artist";
    return [{
      id: `cleveland:${work.id}`,
      source: "cleveland" as const,
      sourceId: String(work.accession_number ?? work.id),
      sourceUrl: work.url ?? `https://www.clevelandart.org/art/${work.accession_number ?? work.id}`,
      rights: "CC0" as const,
      title: work.title || "Untitled",
      artist,
      date: work.creation_date || "Date unknown",
      museum: "Cleveland Museum of Art",
      // The web derivative is a dependable, sub-megabyte JPEG suitable for display.
      image: web.url,
      medium: work.technique || "",
      objectName: work.type || "",
      probeImage: web.url,
      aspectRatio: width > 0 && height > 0 ? width / height : undefined,
    }];
  });
}

type ChicagoArtwork = {
  id?: number;
  title?: string;
  artist_title?: string;
  artist_display?: string;
  date_display?: string;
  medium_display?: string;
  artwork_type_title?: string;
  image_id?: string;
  thumbnail?: { width?: number; height?: number };
  is_public_domain?: boolean;
};

async function searchChicago(term: string): Promise<Candidate[]> {
  const url = new URL(chicagoApi);
  url.searchParams.set("q", term);
  url.searchParams.set("query[term][is_public_domain]", "true");
  url.searchParams.set("limit", String(EXTERNAL_RESULTS_PER_TERM));
  url.searchParams.set("fields", "id,title,artist_title,artist_display,date_display,medium_display,artwork_type_title,image_id,thumbnail,is_public_domain");
  const response = await fetch(url, {
    headers: { "AIC-User-Agent": "music-art local listening display" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];
  const data = await response.json() as { data?: ChicagoArtwork[]; config?: { iiif_url?: string; website_url?: string } };
  const iiif = data.config?.iiif_url ?? "https://www.artic.edu/iiif/2";
  const website = (data.config?.website_url ?? "https://www.artic.edu").replace("http://", "https://");
  return (data.data ?? []).flatMap((work) => {
    if (!work.is_public_domain || !work.id || !work.image_id) return [];
    const width = Number(work.thumbnail?.width);
    const height = Number(work.thumbnail?.height);
    return [{
      id: `artic:${work.id}`,
      source: "artic" as const,
      sourceId: String(work.id),
      sourceUrl: `${website}/artworks/${work.id}`,
      rights: "Public Domain" as const,
      title: work.title || "Untitled",
      artist: work.artist_title || work.artist_display?.split("\n")[0] || "Unknown artist",
      date: work.date_display || "Date unknown",
      museum: "Art Institute of Chicago",
      image: `${iiif}/${work.image_id}/full/1686,/0/default.jpg`,
      medium: work.medium_display || "",
      objectName: work.artwork_type_title || "",
      probeImage: `${iiif}/${work.image_id}/full/400,/0/default.jpg`,
      aspectRatio: width > 0 && height > 0 ? width / height : undefined,
    }];
  });
}

type SmithsonianRow = {
  id?: string;
  title?: string;
  content?: {
    descriptiveNonRepeating?: {
      record_ID?: string;
      title?: { content?: string };
      data_source?: string;
      online_media?: { media?: Array<{ content?: string; type?: string; width?: number; height?: number }> };
    };
    freetext?: {
      name?: Array<{ label?: string; content?: string }>;
      date?: Array<{ label?: string; content?: string }>;
      physicalDescription?: Array<{ label?: string; content?: string }>;
      type?: Array<{ label?: string; content?: string }>;
    };
  };
};

function smithsonianText(values: Array<{ label?: string; content?: string }> | undefined) {
  return values?.map((value) => value.content).filter(Boolean).join("; ") ?? "";
}

function smithsonianMedium(values: Array<{ label?: string; content?: string }> | undefined) {
  return values?.filter((value) => value.label === "Medium").map((value) => value.content).filter(Boolean).join("; ") ?? "";
}

/** Smithsonian Open Access — strong photography/documentary archive. Requires SMITHSONIAN_API_KEY. */
async function searchSmithsonian(term: string): Promise<Candidate[]> {
  const apiKey = process.env.SMITHSONIAN_API_KEY;
  if (!apiKey) return [];
  // Smithsonian catalogs photography by medium, not mood — bare terms return rights-restricted
  // or image-less records. Query the raw term plus photography/portrait variants that surface
  // the National Portrait Gallery and other open image collections, then merge + dedupe.
  const queries = [
    `${term} AND online_media_type:"Images"`,
    `${term} photograph AND online_media_type:"Images"`,
    `${term} portrait AND online_media_type:"Images"`,
  ];
  const rowSets = await Promise.all(queries.map(async (q) => {
    const url = new URL(smithsonianApi);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("q", q);
    url.searchParams.set("rows", String(EXTERNAL_RESULTS_PER_TERM));
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const data = await response.json() as { response?: { rows?: SmithsonianRow[] } };
    return data.response?.rows ?? [];
  }));
  const seen = new Set<string>();
  return rowSets.flat().flatMap((row) => {
    const recordId = row.content?.descriptiveNonRepeating?.record_ID ?? row.id;
    const media = row.content?.descriptiveNonRepeating?.online_media?.media?.find((item) => item.type === "Images" && item.content);
    if (!recordId || !media?.content) return [];
    const key = String(recordId);
    if (seen.has(key)) return [];
    seen.add(key);
    const title = (row.content?.descriptiveNonRepeating?.title?.content ?? row.title ?? "Untitled").replace(/<\/?I>/gi, "");
    // First name entry is the creator/photographer; later entries are often the subject.
    const artist = row.content?.freetext?.name?.[0]?.content ?? "Unknown artist";
    const date = smithsonianText(row.content?.freetext?.date) || "Date unknown";
    // Medium ("Gelatin silver print") carries the fine-art keyword; type is usually empty.
    const medium = smithsonianMedium(row.content?.freetext?.physicalDescription);
    const objectName = medium || smithsonianText(row.content?.freetext?.type) || "photograph";
    const museum = row.content?.descriptiveNonRepeating?.data_source ?? "Smithsonian";
    const width = Number(media.width);
    const height = Number(media.height);
    return [{
      id: `smithsonian:${recordId}`,
      source: "smithsonian" as const,
      sourceId: String(recordId),
      sourceUrl: `https://www.si.edu/object/${encodeURIComponent(String(recordId))}`,
      rights: "CC0" as const,
      title,
      artist,
      date,
      museum,
      image: media.content,
      medium,
      objectName,
      probeImage: media.content,
      aspectRatio: width > 0 && height > 0 ? width / height : undefined,
    }];
  });
}

function interleaveCandidates(resultSets: Candidate[][], limit: number) {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...resultSets.map((results) => results.length));
  for (let index = 0; index < longest && candidates.length < limit; index += 1) {
    for (const results of resultSets) {
      const candidate = results[index];
      if (!candidate || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
      if (candidates.length === limit) break;
    }
  }
  return candidates;
}

function interleaveUniqueIds(resultSets: number[][], limit: number) {
  const ids: number[] = [];
  const seen = new Set<number>();
  const longest = Math.max(0, ...resultSets.map((results) => results.length));
  for (let index = 0; index < longest && ids.length < limit; index += 1) {
    for (const results of resultSets) {
      const id = results[index];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length === limit) break;
    }
  }
  return ids;
}

async function resolveCandidates(ids: number[]) {
  const candidates: Array<Candidate | null> = [];
  for (let index = 0; index < ids.length; index += 12) {
    candidates.push(...await Promise.all(ids.slice(index, index + 12).map((id) => getCandidate(id).catch(() => null))));
  }
  return candidates;
}

async function getCandidate(id: number): Promise<Candidate | null> {
  const response = await fetch(`${metApi}/objects/${id}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const work = await response.json() as {
    isPublicDomain?: boolean; primaryImage?: string; title?: string; artistDisplayName?: string;
    objectDate?: string; repository?: string; medium?: string; objectName?: string; primaryImageSmall?: string;
  };
  if (!work.isPublicDomain || !work.primaryImage) return null;
  return {
    id: `met:${id}`,
    source: "met",
    sourceId: String(id),
    sourceUrl: `https://www.metmuseum.org/art/collection/search/${id}`,
    rights: "Public Domain",
    title: work.title || "Untitled",
    artist: work.artistDisplayName || "Unknown artist",
    date: work.objectDate || "Date unknown",
    museum: work.repository || "The Metropolitan Museum of Art",
    image: work.primaryImage,
    medium: work.medium || "",
    objectName: work.objectName || "",
    probeImage: work.primaryImageSmall || work.primaryImage,
  };
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG stores its dimensions in the fixed IHDR header.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: new DataView(bytes.buffer, bytes.byteOffset + 16, 4).getUint32(0), height: new DataView(bytes.buffer, bytes.byteOffset + 20, 4).getUint32(0) };
  }
  // Met delivery is normally JPEG. Find its start-of-frame marker without downloading the full image.
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset]; offset += 1;
      if (marker === 0xd8 || marker === 0xd9) continue;
      const length = (bytes[offset] << 8) + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[offset + 3] << 8) + bytes[offset + 4], width: (bytes[offset + 5] << 8) + bytes[offset + 6] };
      }
      offset += length;
    }
  }
  return null;
}

async function withDisplayableImage(candidate: Candidate): Promise<Candidate | null> {
  try {
    if (candidate.aspectRatio !== undefined) {
      return candidate.aspectRatio >= MIN_DISPLAY_RATIO && candidate.aspectRatio <= MAX_DISPLAY_RATIO ? candidate : null;
    }
    const response = await fetch(candidate.probeImage, { headers: { Accept: "image/*", Range: "bytes=0-65535" }, signal: AbortSignal.timeout(8000) });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.startsWith("image/")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 256) return null;
    const dimensions = imageDimensions(bytes);
    if (!dimensions) return candidate;
    const aspectRatio = dimensions.width / dimensions.height;
    if (aspectRatio < MIN_DISPLAY_RATIO || aspectRatio > MAX_DISPLAY_RATIO) return null;
    return { ...candidate, aspectRatio };
  } catch {
    return null;
  }
}

function isTwoDimensionalFineArt(candidate: Candidate) {
  const description = `${candidate.objectName} ${candidate.medium}`;
  return FINE_ART_TERMS.test(description) && !OBJECT_TERMS.test(description);
}

function normalizedArtworkKey(candidate: Candidate) {
  const normalize = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const artist = normalize(candidate.artist);
  const title = normalize(candidate.title);
  return artist === "unknown artist" || title === "untitled" ? candidate.id : `${artist}|${title}`;
}

function uniqueArtworks(candidates: Candidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizedArtworkKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceCounts(candidates: Candidate[]) {
  return Object.fromEntries(["met", "cleveland", "artic", "smithsonian"].map((source) => [source, candidates.filter((candidate) => candidate.source === source).length]));
}

async function withCuratorImage(candidate: Candidate): Promise<CuratorCandidate | null> {
  try {
    const response = await fetch(candidate.probeImage, {
      headers: {
        Accept: "image/*",
        ...(candidate.source === "artic" ? { "AIC-User-Agent": "music-art local listening display" } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!response.ok || !contentType.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 256 || bytes.length > 2_000_000) return null;
    return { ...candidate, curatorImage: `data:${contentType};base64,${bytes.toString("base64")}` };
  } catch {
    return null;
  }
}

function candidateContent(candidate: CuratorCandidate, detail: "low" | "high") {
  return [
    { type: "input_text" as const, text: `Candidate ${candidate.id}: ${candidate.title} — ${candidate.artist}, ${candidate.date}. Medium: ${candidate.medium || "unknown"}. Object type: ${candidate.objectName || "unknown"}. Aspect ratio: ${candidate.aspectRatio?.toFixed(2) ?? "unknown"}.` },
    { type: "input_image" as const, image_url: candidate.curatorImage, detail },
  ];
}

function validCandidateIds(value: unknown, candidates: CuratorCandidate[], limit: number) {
  const available = new Set(candidates.map((candidate) => candidate.id));
  const ids = strings(value, limit).filter((id) => available.has(id));
  return [...new Set(ids)];
}

async function chooseSemifinalists(client: OpenAI, track: CleanTrack, brief: VisualBrief, candidates: CuratorCandidate[]) {
  if (candidates.length <= SEMIFINALISTS_PER_BATCH) return candidates;
  const response = await client.responses.create({
    model,
    reasoning,
    input: [
      { role: "developer", content: "You are a museum curator conducting a comparative semifinal for a widescreen television display. Prefer works that match the brief's positive energy, sonic character, and motifs. Reject merely decorative or off-energy matches. Return JSON only. Never invent facts." },
      {
        role: "user",
        content: [
          { type: "input_text", text: `Track: ${JSON.stringify(track)}\nSong dossier confidence: ${brief.confidence}\nDossier reading: ${brief.dossier.sonic_and_thematic_reading}\nVisual brief: ${JSON.stringify({ semantic_anchors: brief.semantic_anchors, sonic_character: brief.sonic_character, emotional_tone: brief.emotional_tone, visual_motifs: brief.visual_motifs, mood: brief.mood, energy: brief.energy, avoid: brief.avoid })}\n\nChoose the strongest ${SEMIFINALISTS_PER_BATCH} distinct candidates that fit this recording's energy and reading. A successful pairing needs at least one semantic_anchors connection, one emotional or sonic connection, and one compelling visual reason. Judge the actual images, not title coincidence — but do not reject a work only because it literally matches the title; literal imagery is a valid connection when it also carries the right energy and setting. Prefer strong room-scale compositions when they also fit the brief. Return exactly {"candidateIds":["source:id","source:id"]}, ranked best first.` },
          ...candidates.flatMap((candidate) => candidateContent(candidate, "low")),
        ],
      },
    ],
  });
  const choice = jsonFromModel(response.output_text) as { candidateIds?: unknown };
  const chosenIds = validCandidateIds(choice.candidateIds, candidates, SEMIFINALISTS_PER_BATCH);
  const chosen = chosenIds.map((id) => candidates.find((candidate) => candidate.id === id)!);
  for (const candidate of candidates) {
    if (chosen.length === SEMIFINALISTS_PER_BATCH) break;
    if (!chosen.some((item) => item.id === candidate.id)) chosen.push(candidate);
  }
  return chosen;
}

async function chooseCandidate(client: OpenAI, track: CleanTrack, brief: VisualBrief, candidates: CuratorCandidate[]) {
  const response = await client.responses.create({
    model,
    reasoning,
    input: [
      { role: "developer", content: "You are the final critic for a museum-quality music and art pairing on a widescreen television. Compare the finalists directly, apply the stated rubric and penalties, and choose the exceptional pairing rather than the first defensible one. Weight fidelity to this recording's stated energy and sonic character above generic elegance. Candidates are verified two-dimensional fine art. Do not invent works, artists, lyrics, history, or other facts. Return JSON only." },
      {
        role: "user",
        content: [
          { type: "input_text", text: `Track: ${JSON.stringify(track)}\nSong dossier: ${JSON.stringify(brief.dossier)}\nVisual brief: ${JSON.stringify(brief)}\n\nScore comparatively using: brief fidelity and thematic resonance 35%, sonic and emotional resonance (including energy match) 30%, visual strength on television 15%, interpretive originality 10%, historical or cultural connection 5%, and provenance confidence 5%. Apply explicit penalties: energy mismatch (e.g. serene/historical decoration for a groove-heavy or high-energy reading) -30; gorgeous but off-brief -30; generic or decorative -20; shallow title illustration that ignores the recording's energy or setting -20; artist or musician portrait -25; weak television composition -15; rationale requiring invented facts -30. A successful winner must name which semantic_anchors or motifs it supports, plus an emotional or sonic connection and a visual reason. Literal title imagery is not a penalty when it also matches the mood and energy.\n\nReturn exactly {"candidateId":"source:id","alternativeIds":["source:id","source:id"],"matchedAnchors":["anchor","anchor"],"rationale":"two concise sentences explaining visible and interpretive connections without invented facts"}.` },
          ...candidates.flatMap((candidate) => candidateContent(candidate, "high")),
        ],
      },
    ],
  });
  const choice = jsonFromModel(response.output_text) as { candidateId?: unknown; alternativeIds?: unknown; rationale?: unknown };
  const selected = candidates.find((candidate) => candidate.id === choice.candidateId);
  if (!selected) throw new Error("The artwork-selection response did not choose a verified candidate.");
  const alternatives = validCandidateIds(choice.alternativeIds, candidates.filter((candidate) => candidate.id !== selected.id), 2)
    .map((id) => candidates.find((candidate) => candidate.id === id)!);
  for (const candidate of candidates) {
    if (alternatives.length === 2) break;
    if (candidate.id !== selected.id && !alternatives.some((item) => item.id === candidate.id)) alternatives.push(candidate);
  }
  return { selected, alternatives, rationale: typeof choice.rationale === "string" ? choice.rationale.trim() : brief.curatorial_rationale };
}

export async function POST(request: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OpenAI is not configured." }, { status: 503 });
    const payload = await request.json().catch(() => ({})) as { track?: Track; excludeArtworkIds?: unknown };
    const track = cleanTrackPayload(payload.track ?? {});
    if (!track) return NextResponse.json({ error: "A recognized artist and title are required for curation." }, { status: 400 });
    const excludeArtworkIds = parseRecentArtworkIds(payload.excludeArtworkIds);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const brief = await createBrief(client, track);
    console.info("[curate] visual brief", JSON.stringify({
      track: `${track.artist} — ${track.title}`,
      confidence: brief.confidence,
      genre: track.genre ?? null,
      exclude: excludeArtworkIds.length,
      terms: brief.museum_search_terms,
    }));
    const safeTerms = <T,>(search: (term: string) => Promise<T[]>) => Promise.all(
      brief.museum_search_terms.map((term) => search(term).catch((error) => {
        console.warn(`[curate] provider search failed term=${term}`, error instanceof Error ? error.message : error);
        return [];
      })),
    );
    const [metResultSets, clevelandResultSets, chicagoResultSets, smithsonianResultSets] = await Promise.all([
      safeTerms(searchMet),
      safeTerms(searchCleveland),
      safeTerms(searchChicago),
      safeTerms(searchSmithsonian),
    ]);
    const ids = interleaveUniqueIds(metResultSets, MAX_OBJECTS_TO_RESOLVE);
    const resolved = await resolveCandidates(ids);
    const metCandidates = resolved.filter((candidate): candidate is Candidate => candidate !== null);
    const clevelandCandidates = interleaveCandidates(clevelandResultSets, MAX_OBJECTS_TO_RESOLVE);
    const chicagoCandidates = interleaveCandidates(chicagoResultSets, MAX_OBJECTS_TO_RESOLVE);
    const smithsonianCandidates = interleaveCandidates(smithsonianResultSets, MAX_OBJECTS_TO_RESOLVE);
    const fineArt = uniqueArtworks([...metCandidates, ...clevelandCandidates, ...chicagoCandidates, ...smithsonianCandidates].filter(isTwoDimensionalFineArt));
    const probePool = balanceBySource(fineArt, MAX_FINE_ART_TO_PROBE);
    const withImages = (await Promise.all(probePool.map(withDisplayableImage)))
      .filter((candidate): candidate is Candidate => candidate !== null);
    const orientationPool = orientationPoolForCurator(withImages);
    const withoutRecent = excludeRecentCandidates(orientationPool, excludeArtworkIds);
    const selectionPool = balanceBySource(withoutRecent, MAX_CURATOR_IMAGE_FETCH);
    const curatorReady = (await Promise.all(selectionPool.map(withCuratorImage)))
      .filter((candidate): candidate is CuratorCandidate => candidate !== null);
    const curatorPool = balanceBySource(curatorReady, MAX_VISUAL_CANDIDATES);
    console.info("[curate] candidate funnel", JSON.stringify({
      searched: {
        met: metResultSets.map((result) => result.length),
        cleveland: clevelandResultSets.map((result) => result.length),
        artic: chicagoResultSets.map((result) => result.length),
        smithsonian: smithsonianResultSets.map((result) => result.length),
      },
      resolved: sourceCounts([...metCandidates, ...clevelandCandidates, ...chicagoCandidates, ...smithsonianCandidates]),
      fineArt: sourceCounts(fineArt),
      probed: sourceCounts(probePool),
      displayable: sourceCounts(withImages),
      landscape: sourceCounts(withImages.filter((candidate) => (candidate.aspectRatio ?? 0) >= MIN_LANDSCAPE_RATIO)),
      afterExclude: sourceCounts(withoutRecent),
      selectionPool: sourceCounts(selectionPool),
      curatorReady: sourceCounts(curatorReady),
      visualPool: sourceCounts(curatorPool),
      excluded: excludeArtworkIds.length,
    }));
    if (!curatorPool.length) return NextResponse.json({ error: "No verified paintings, drawings, prints, or photographs matched this visual brief." }, { status: 502 });

    const batches: CuratorCandidate[][] = [];
    for (let index = 0; index < curatorPool.length; index += SEMIFINAL_BATCH_SIZE) {
      batches.push(curatorPool.slice(index, index + SEMIFINAL_BATCH_SIZE));
    }
    const finalists = (await Promise.all(batches.map((batch) => chooseSemifinalists(client, track, brief, batch)))).flat();
    console.info("[curate] visual judging", JSON.stringify({ batches: batches.map((batch) => batch.length), finalists: finalists.map((candidate) => candidate.id) }));
    const { selected, alternatives, rationale } = await chooseCandidate(client, track, brief, finalists);
    const publicArtwork = (candidate: Candidate) => ({
      id: candidate.id,
      source: candidate.source,
      sourceId: candidate.sourceId,
      sourceUrl: candidate.sourceUrl,
      rights: candidate.rights,
      title: candidate.title,
      artist: candidate.artist,
      date: candidate.date,
      museum: candidate.museum,
      image: candidate.image,
      aspectRatio: candidate.aspectRatio,
    });
    return NextResponse.json({
      ...publicArtwork(selected),
      rationale,
      alternatives: alternatives.map(publicArtwork),
      brief,
    });
  } catch (error) {
    console.error("[curate]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Artwork curation failed." }, { status: 500 });
  }
}
