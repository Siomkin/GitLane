import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, WindowMaximizeIcon, WindowMinimizeIcon, WindowRestoreIcon } from "@/components/ui/icons";

// getCurrentWindow() reads window.__TAURI_INTERNALS__ and throws synchronously
// when it's absent (browser dev / jsdom). The caller only mounts this inside
// Tauri, but guard anyway so a stray mount degrades to a no-op instead of crashing.
function win() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

// Caption buttons for the frameless Windows/Linux window (macOS keeps its native
// traffic lights via titleBarStyle: Overlay, so this is gated on !isMac by the
// caller). Mirrors the native order — minimize, maximize/restore, close — and
// reflects the live maximized state so the middle glyph swaps to "restore".
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = win();
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

  const btn =
    "grid h-full w-[44px] place-items-center text-neutral-500 transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10";

  // z-[101] keeps the buttons above the resize grips (z-[100]) so clicks near the
  // top-right corner hit the close button rather than starting a resize drag.
  return (
    <div className="relative z-[101] -mr-4 flex self-stretch">
      <button type="button" className={btn} onClick={() => void win()?.minimize().catch(() => {})} title="Minimize" aria-label="Minimize">
        <WindowMinimizeIcon />
      </button>
      <button type="button"
        className={btn}
        onClick={() => void win()?.toggleMaximize().catch(() => {})}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <WindowRestoreIcon /> : <WindowMaximizeIcon />}
      </button>
      <button type="button"
        className="grid h-full w-[44px] place-items-center text-neutral-500 transition-colors hover:bg-red-600 hover:text-white dark:text-neutral-300"
        onClick={() => void win()?.close().catch(() => {})}
        title="Close"
        aria-label="Close"
      >
        <CloseIcon width={11} height={11} strokeWidth={1.6} />
      </button>
    </div>
  );
}
