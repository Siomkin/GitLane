import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The current Tauri window, or null outside Tauri. getCurrentWindow() reads
 * window.__TAURI_INTERNALS__ and throws synchronously when it's absent (browser
 * dev / jsdom); callers only mount inside Tauri, but a stray mount degrades to a
 * no-op instead of crashing. */
export function currentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/** The window's live maximized state, tracked through `onResized`. Shared by the
 * caption buttons and the resize grips. */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = currentWindow();
    if (!w) return;
    let unlisten: (() => void) | undefined;
    const sync = () => void w.isMaximized().then(setMaximized).catch(() => {});
    sync();
    w.onResized(sync)
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  return maximized;
}
