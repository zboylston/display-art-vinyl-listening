export type ArtworkImageRequest = {
  url: URL;
  headers: Record<string, string>;
};

const providers: Record<string, { path: RegExp; headers?: Record<string, string> }> = {
  "images.metmuseum.org": { path: /^\/CRDImages\// },
  "openaccess-cdn.clevelandart.org": { path: /^\/[^/]+\/[^/]+_web\.(?:jpg|jpeg|png)$/i },
  "www.artic.edu": {
    path: /^\/iiif\/2\/[^/]+\/full\/\d+,?\/0\/default\.(?:jpg|jpeg|png)$/i,
    headers: { "AIC-User-Agent": "music-art local listening display" },
  },
  "ids.si.edu": { path: /^\/ids\/deliveryService$/ },
};

export function artworkImageRequest(source: string): ArtworkImageRequest | null {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const provider = providers[url.hostname];
    if (!provider || !provider.path.test(url.pathname)) return null;
    return { url, headers: { Accept: "image/*", ...provider.headers } };
  } catch {
    return null;
  }
}
