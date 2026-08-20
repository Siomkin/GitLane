// Single gate for opening a URL in the user's real browser (never the Tauri
// webview). PR/commit/provider links come from `gh`, forge metadata, and
// untrusted PR markdown, so every opener call validates the scheme here instead
// of re-deriving it per call site — a crafted `javascript:`/`file:`/`data:` URL
// is refused before it ever reaches the OS. New "open in browser" call sites
// should import this rather than calling the opener plugin directly.

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./platform";

/** Schemes we will ever hand to the OS browser. */
const OPENABLE_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/** True when `href` parses as a URL with an allowed external scheme. */
export function isOpenableUrl(href: string): boolean {
  try {
    return OPENABLE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** Open `href` in the system browser if its scheme is allowed; returns whether
 * it was accepted. Inside Tauri, `onError` reports an asynchronous opener
 * failure; in a plain browser (`bun run dev` / tests) this falls back to
 * `window.open` with `noopener`. */
export function openExternalUrl(href: string, onError?: (error: unknown) => void): boolean {
  if (!isOpenableUrl(href)) return false;
  // Only swallow the rejection when someone is there to report it — without a
  // handler it must stay an unhandled rejection, visible in the console.
  if (isTauri) void (onError ? openUrl(href).catch(onError) : openUrl(href));
  else window.open(href, "_blank", "noopener");
  return true;
}
