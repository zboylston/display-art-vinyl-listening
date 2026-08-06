import OpenAI from "openai";
import { NextResponse } from "next/server";
import { balanceBySource, landscapeFirstPool, MIN_LANDSCAPE_RATIO } from "../../lib/art-orientation";

const metApi = "https://collectionapi.metmuseum.org/public/collection/v1";
const clevelandApi = "https://openaccess-api.clevelandart.org/api/artworks/";
const chicagoApi = "https://api.artic.edu/api/v1/artworks/search";
const model = "gpt-5.6-sol";
type ArtSource = "met" | "cleveland" | "artic";

type Track = { artist?: string; title?: string; album?: string; year?: string };
type VisualBrief = {
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
};
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
const MIN_DISPLAY_RATIO = 0.55;
const MAX_DISPLAY_RATIO = 2.8;
const FINE_ART_TERMS = /\b(painting|print|drawing|photograph|photography|watercolor|watercolour|pastel|lithograph|etching|engraving|woodcut|monotype|collage)\b/i;
const OBJECT_TERMS = /\b(armor|armour|bowl|vessel|cup|cabinet|chair|table|mirror|sword|helmet|screen|tureen|plate|jar|beaker|sculpture|relief|mask|textile|garment|coin|instrument|lamp|furniture|weapon|box)\b/i;

function jsonFromModel(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The visual-brief response was not valid JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

function strings(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeBrief(value: unknown): VisualBrief {
  if (!value || typeof value !== "object") throw new Error("The visual-brief response was incomplete.");
  const brief = value as Record<string, unknown>;
  const terms = strings(brief.museum_search_terms, 10);
  if (!terms.length) throw new Error("The visual brief did not provide museum search terms.");
  const energy = brief.energy === "low" || brief.energy === "medium" || brief.energy === "high" ? brief.energy : "medium";
  return {
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
  };
}

async function createBrief(client: OpenAI, track: Track) {
  const response = await client.responses.create({
    model,
    input: [
      { role: "developer", content: "Create nuanced visual-art direction for a music-listening experience. Build connections through meaning, feeling, cultural context, and visible formal qualities; do not reduce the track to its title. Treat cultural knowledge as interpretive rather than verified fact. Never quote, summarize, or claim lyrics. Do not name specific artworks or artists. Return JSON only." },
      { role: "user", content: `Track identity: ${JSON.stringify(track)}\n\nReturn exactly these JSON keys:\n- semantic_anchors: 3-6 concepts suggested by the track identity or context\n- sonic_character: 3-6 interpretive descriptors of space, rhythm, texture, or motion\n- emotional_tone: 3-6 emotional qualities\n- formal_qualities: 3-6 visible compositional qualities that could echo the music\n- cultural_context: up to 4 cautious contextual associations\n- visual_direction: 3-6 requirements for an artwork that can hold a room on a large television\n- avoid: 4-8 clichés, overly literal treatments, portraits, or weak decorative approaches\n- mood: 3-6 adjectives\n- energy: low|medium|high\n- palette: 3-5 colors\n- visual_motifs: 4-8 concrete visible motifs\n- art_movements: up to 3\n- museum_search_terms: exactly 10 diverse museum-catalog queries of 1-4 common words each\n- curatorial_rationale: exactly 2 sentences\n\nDiversify the ten searches across thematic subjects, atmosphere or setting, composition or form, palette or light, and movement or cultural context. At most one query may directly echo the track title. Do not use artist names, instruments, or music/audio words as search queries.` },
    ],
  });
  return normalizeBrief(jsonFromModel(response.output_text));
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
  return Object.fromEntries(["met", "cleveland", "artic"].map((source) => [source, candidates.filter((candidate) => candidate.source === source).length]));
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

async function chooseSemifinalists(client: OpenAI, brief: VisualBrief, candidates: CuratorCandidate[]) {
  if (candidates.length <= SEMIFINALISTS_PER_BATCH) return candidates;
  const response = await client.responses.create({
    model,
    input: [
      { role: "developer", content: "You are a museum curator conducting a comparative semifinal for a widescreen television display. Examine every supplied image, compare candidates against each other, reject clichés and merely decorative matches, and return JSON only. Never invent facts." },
      {
        role: "user",
        content: [
          { type: "input_text", text: `Visual brief and anti-brief: ${JSON.stringify(brief)}\n\nChoose the strongest ${SEMIFINALISTS_PER_BATCH} distinct candidates. A successful pairing needs at least one semantic connection, one emotional or sonic connection, and one compelling visual reason. Judge the actual images, not title coincidence. Prefer original interpretations and strong room-scale landscape compositions. Return exactly {"candidateIds":["source:id","source:id"]}, ranked best first.` },
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

async function chooseCandidate(client: OpenAI, brief: VisualBrief, candidates: CuratorCandidate[]) {
  const response = await client.responses.create({
    model,
    input: [
      { role: "developer", content: "You are the final critic for a museum-quality music and art pairing on a widescreen television. Compare the finalists directly, apply the stated rubric and penalties, and choose the exceptional pairing rather than the first defensible one. Candidates are verified two-dimensional fine art. Do not invent works, artists, lyrics, history, or other facts. Return JSON only." },
      {
        role: "user",
        content: [
          { type: "input_text", text: `Visual brief and anti-brief: ${JSON.stringify(brief)}\n\nScore comparatively using: sonic and emotional resonance 30%, thematic resonance 20%, visual strength on television 20%, interpretive originality 15%, historical or cultural connection 10%, and provenance confidence 5%. Apply explicit penalties: generic or decorative -20; obvious title illustration without deeper connection -15; artist or musician portrait -25; weak television composition -20; rationale requiring invented facts -30. A successful winner must have a semantic connection, an emotional or sonic connection, and a compelling visual reason.\n\nReturn exactly {"candidateId":"source:id","alternativeIds":["source:id","source:id"],"rationale":"two concise sentences explaining visible and interpretive connections without invented facts"}.` },
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
    const payload = await request.json().catch(() => ({})) as { track?: Track };
    const track = payload.track ?? {};
    if (!track.artist || !track.title) return NextResponse.json({ error: "A recognized artist and title are required for curation." }, { status: 400 });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const brief = await createBrief(client, track);
    console.info("[curate] visual brief", JSON.stringify({ track: `${track.artist} — ${track.title}`, terms: brief.museum_search_terms }));
    const safeTerms = <T,>(search: (term: string) => Promise<T[]>) => Promise.all(
      brief.museum_search_terms.map((term) => search(term).catch((error) => {
        console.warn(`[curate] provider search failed term=${term}`, error instanceof Error ? error.message : error);
        return [];
      })),
    );
    const [metResultSets, clevelandResultSets, chicagoResultSets] = await Promise.all([
      safeTerms(searchMet),
      safeTerms(searchCleveland),
      safeTerms(searchChicago),
    ]);
    const ids = interleaveUniqueIds(metResultSets, MAX_OBJECTS_TO_RESOLVE);
    const resolved = await resolveCandidates(ids);
    const metCandidates = resolved.filter((candidate): candidate is Candidate => candidate !== null);
    const clevelandCandidates = interleaveCandidates(clevelandResultSets, MAX_OBJECTS_TO_RESOLVE);
    const chicagoCandidates = interleaveCandidates(chicagoResultSets, MAX_OBJECTS_TO_RESOLVE);
    const fineArt = uniqueArtworks([...metCandidates, ...clevelandCandidates, ...chicagoCandidates].filter(isTwoDimensionalFineArt));
    const probePool = balanceBySource(fineArt, MAX_FINE_ART_TO_PROBE);
    const withImages = (await Promise.all(probePool.map(withDisplayableImage)))
      .filter((candidate): candidate is Candidate => candidate !== null);
    const orientationPool = landscapeFirstPool(withImages);
    const selectionPool = balanceBySource(orientationPool, MAX_CURATOR_IMAGE_FETCH);
    const curatorReady = (await Promise.all(selectionPool.map(withCuratorImage)))
      .filter((candidate): candidate is CuratorCandidate => candidate !== null);
    const curatorPool = balanceBySource(curatorReady, MAX_VISUAL_CANDIDATES);
    console.info("[curate] candidate funnel", JSON.stringify({
      searched: {
        met: metResultSets.map((result) => result.length),
        cleveland: clevelandResultSets.map((result) => result.length),
        artic: chicagoResultSets.map((result) => result.length),
      },
      resolved: sourceCounts([...metCandidates, ...clevelandCandidates, ...chicagoCandidates]),
      fineArt: sourceCounts(fineArt),
      probed: sourceCounts(probePool),
      displayable: sourceCounts(withImages),
      landscape: sourceCounts(withImages.filter((candidate) => (candidate.aspectRatio ?? 0) >= MIN_LANDSCAPE_RATIO)),
      selectionPool: sourceCounts(selectionPool),
      curatorReady: sourceCounts(curatorReady),
      visualPool: sourceCounts(curatorPool),
    }));
    if (!curatorPool.length) return NextResponse.json({ error: "No verified paintings, drawings, prints, or photographs matched this visual brief." }, { status: 502 });

    const batches: CuratorCandidate[][] = [];
    for (let index = 0; index < curatorPool.length; index += SEMIFINAL_BATCH_SIZE) {
      batches.push(curatorPool.slice(index, index + SEMIFINAL_BATCH_SIZE));
    }
    const finalists = (await Promise.all(batches.map((batch) => chooseSemifinalists(client, brief, batch)))).flat();
    console.info("[curate] visual judging", JSON.stringify({ batches: batches.map((batch) => batch.length), finalists: finalists.map((candidate) => candidate.id) }));
    const { selected, alternatives, rationale } = await chooseCandidate(client, brief, finalists);
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
