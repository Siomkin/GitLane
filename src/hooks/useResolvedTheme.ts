// Resolves the stored theme preference to the concrete `"dark" | "light"` mode,
// re-rendering when the user flips the preference OR (for `system`) when the OS
// colour scheme changes. Use this — not the raw `theme` store value — anywhere
// the actual paint mode matters.
//
// A SINGLE module-level `matchMedia` listener is shared by every caller: the diff
// view renders one `<Tokens>` per line, so a per-component listener/`matchMedia`
// call would mean hundreds of OS-scheme listeners on a large diff. Here `subscribe`
// is just a `Set` insert and `getSnapshot` returns a cached boolean.

import { useSyncExternalStore } from "react";

import { useUi } from "@/store/ui";
import { resolveTheme, PREFERS_DARK_QUERY } from "@/lib/theme";

const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PREFERS_DARK_QUERY)
    : null;

let systemDark = mql?.matches ?? false;
const listeners = new Set<() => void>();

if (mql) {
  const onChange = (e: MediaQueryListEvent) => {
    systemDark = e.matches;
    for (const notify of listeners) notify();
  };
  // Modern WebKit (Tauri's webview) has addEventListener; fall back to the
  // deprecated addListener for very old engines / some jsdom setups.
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
  else mql.addListener(onChange);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function getSnapshot() {
  return systemDark;
}

function getServerSnapshot() {
  return false;
}

export function useResolvedTheme(): "dark" | "light" {
  const theme = useUi((s) => s.theme);
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return resolveTheme(theme, dark);
}
