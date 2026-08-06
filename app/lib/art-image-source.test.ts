import { describe, expect, it } from "vitest";
import { artworkImageRequest } from "./art-image-source";

describe("artworkImageRequest", () => {
  it.each([
    "https://images.metmuseum.org/CRDImages/ep/original/DP-19486-001.jpg",
    "https://openaccess-cdn.clevelandart.org/1972.47/1972.47_web.jpg",
    "https://www.artic.edu/iiif/2/50034c7f-ce51-00f1-430e-a6f7efc233fc/full/1686,/0/default.jpg",
  ])("allows a known museum display image: %s", (source) => {
    expect(artworkImageRequest(source)?.url.toString()).toBe(source);
  });

  it("adds the Chicago image-service identification header", () => {
    const request = artworkImageRequest("https://www.artic.edu/iiif/2/image-id/full/400,/0/default.jpg");
    expect(request?.headers["AIC-User-Agent"]).toBe("music-art local listening display");
  });

  it.each([
    "http://www.artic.edu/iiif/2/image-id/full/400,/0/default.jpg",
    "https://www.artic.edu/artworks/56905",
    "https://openaccess-cdn.clevelandart.org/1972.47/1972.47_full.tif",
    "https://example.com/image.jpg",
  ])("rejects an unapproved image source: %s", (source) => {
    expect(artworkImageRequest(source)).toBeNull();
  });
});
