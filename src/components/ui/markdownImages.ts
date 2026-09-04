// Inline images are narrowed to a small raster allowlist with a length cap. SVG is
// excluded on purpose — `data:image/svg+xml` can carry script/foreignObject — and
// the cap is on the data-URI *string length* (a deliberately cheap proxy: we don't
// base64-decode untrusted markdown just to measure it), which keeps the rendered
// blob roughly bounded so a PR can't wedge the view with a multi-megabyte image.
// `markdownUrlTransform` and `isTrustedImageSrc` are the two gates; keep both
// pointed at `isSafeDataImage`.
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const MAX_DATA_IMAGE_URI_CHARS = 256 * 1024;

export function isSafeDataImage(url: string): boolean {
  return url.length <= MAX_DATA_IMAGE_URI_CHARS && SAFE_DATA_IMAGE.test(url);
}

// Untrusted PR/issue markdown can embed remote images that beacon the viewer's
// IP and client version to the author's server the moment they auto-load. Only
// data: URIs and GitHub's user-content CDN are trusted to load directly; any
// other source renders as a labelled placeholder rather than being fetched.
// Keep `img-src` in `src-tauri/tauri.conf.json` in lockstep — `markdownCsp.test.ts`
// parses that string and asserts the HTTPS hosts match this helper. Shields
// badges (`img.shields.io`) stay off both lists: `priorityBadge` renders them
// as a local chip and never emits `<img>`.
export function isTrustedImageHost(host: string): boolean {
  const normalised = host.toLowerCase();
  return normalised === "githubusercontent.com" || normalised.endsWith(".githubusercontent.com");
}

export function isTrustedImageSrc(src: string): boolean {
  if (isSafeDataImage(src)) return true;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:") return false;
    return isTrustedImageHost(url.hostname);
  } catch {
    return false;
  }
}
