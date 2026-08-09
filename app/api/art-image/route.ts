import { NextRequest, NextResponse } from "next/server";
import { artworkImageRequest } from "../../lib/art-image-source";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  if (!source) return NextResponse.json({ error: "Missing artwork image source." }, { status: 400 });
  try {
    const imageRequest = artworkImageRequest(source);
    if (!imageRequest) {
      return NextResponse.json({ error: "Artwork source is not allowed." }, { status: 400 });
    }
    const { url, headers } = imageRequest;
    // Large museum originals exceed Next's data-cache item limit. Let the browser/CDN
    // honor the response cache header instead of trying to store the body in Next.
    // Follow redirects: museum CDNs (Met, Cleveland, Art Institute, Smithsonian)
    // commonly redirect to CDN edges, and the source URL is already validated
    // against the provider allowlist in artworkImageRequest.
    const upstream = await fetch(url, { headers, cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(12000) });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !upstream.body || !contentType.startsWith("image/")) {
      console.error("[art-image] upstream failure", url.hostname, upstream.status, contentType);
      return NextResponse.json({ error: "Artwork image is unavailable." }, { status: 502 });
    }
    return new NextResponse(upstream.body, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" } });
  } catch {
    return NextResponse.json({ error: "Artwork image could not be loaded." }, { status: 400 });
  }
}
