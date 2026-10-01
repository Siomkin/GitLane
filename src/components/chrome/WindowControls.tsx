import { CloseIcon, WindowMaximizeIcon, WindowMinimizeIcon, WindowRestoreIcon } from "@/components/ui/icons";
import { currentWindow as win, useWindowMaximized } from "./useWindowMaximized";

// Caption buttons for the frameless Windows/Linux window (macOS keeps its native
// traffic lights via titleBarStyle: Overlay, so this is gated on !isMac by the
// caller). Mirrors the native order — minimize, maximize/restore, close — and
// reflects the live maximized state so the middle glyph swaps to "restore".
export function WindowControls() {
  const maximized = useWindowMaximized();

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
