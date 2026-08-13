/**
 * Measure the tone of a museum artwork by title, to seed curation eval fixtures
 * with real numbers instead of estimates.
 *
 *   node scripts/measure-artwork.mjs "Two Shepherdesses"
 */
import sharp from "sharp";

const metApi = "https://collectionapi.metmuseum.org/public/collection/v1";
const query = process.argv[2];
if (!query) throw new Error("Pass an artwork title.");

const search = await fetch(`${metApi}/search?hasImages=true&q=${encodeURIComponent(query)}`);
const { objectIDs = [] } = await search.json();

for (const id of objectIDs.slice(0, 40)) {
  const work = await (await fetch(`${metApi}/objects/${id}`)).json();
  if (!work.isPublicDomain || !work.primaryImage) continue;
  if (!work.title?.toLowerCase().includes(query.toLowerCase())) continue;

  const bytes = Buffer.from(await (await fetch(work.primaryImageSmall || work.primaryImage)).arrayBuffer());
  const { data, info } = await sharp(bytes).resize(48, 48, { fit: "inside" }).removeAlpha().toColourspace("srgb").raw()
    .toBuffer({ resolveWithObject: true });

  let luminance = 0, saturation = 0, warmth = 0, count = 0;
  for (let index = 0; index + info.channels <= data.length; index += info.channels) {
    const [red, green, blue] = [data[index] / 255, data[index + 1] / 255, data[index + 2] / 255];
    luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    saturation += Math.max(red, green, blue) - Math.min(red, green, blue);
    warmth += red - blue;
    count += 1;
  }

  console.log(JSON.stringify({
    id: `met:${id}`,
    title: work.title,
    artist: work.artistDisplayName,
    date: work.objectDate,
    medium: work.medium,
    objectName: work.objectName,
    image: work.primaryImageSmall || work.primaryImage,
    tone: {
      luminance: Number((luminance / count).toFixed(3)),
      saturation: Number((saturation / count).toFixed(3)),
      warmth: Number((warmth / count).toFixed(3)),
    },
  }, null, 2));
}
