import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, WindowMaximizeIcon, WindowMinimizeIcon, WindowRestoreIcon } from "../ui/icons";

// Caption buttons for the frameless Windows/Linux window (macOS keeps its native
// traffic lights via titleBarStyle: Overlay, so this is gated on !isMac by the
// caller). Mirrors the native order — minimize, maximize/restore, close — and
// reflects the live maximized state so the middle glyph swaps to "restore".
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const win = () => getCurrentWindow();
  const btn =
    "grid h-full w-[44px] place-items-center text-neutral-500 transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10";

  return (
    <div className="-mr-4 flex self-stretch">
      <button className={btn} onClick={() => void win().minimize().catch(() => {})} title="Minimize" aria-label="Minimize">
        <WindowMinimizeIcon />
      </button>
      <button
        className={btn}
        onClick={() => void win().toggleMaximize().catch(() => {})}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <WindowRestoreIcon /> : <WindowMaximizeIcon />}
      </button>
      <button
        className="grid h-full w-[44px] place-items-center text-neutral-500 transition-colors hover:bg-red-600 hover:text-white dark:text-neutral-300"
        onClick={() => void win().close().catch(() => {})}
        title="Close"
        aria-label="Close"
      >
        <CloseIcon width={11} height={11} strokeWidth={1.6} />
      </button>
    </div>
  );
}
