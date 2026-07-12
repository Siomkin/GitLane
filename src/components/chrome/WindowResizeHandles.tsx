import { useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Mirror of @tauri-apps/api's ResizeDirection (declared internally, not exported).
// startResizeDragging accepts these string values.
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

// getCurrentWindow() reads window.__TAURI_INTERNALS__ and throws synchronously
// when it's absent (browser dev / jsdom). Guard so a stray mount is a no-op.
function win() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

// On Windows/Linux we drop the native window frame (see the mount effect) to
// avoid a doubled title bar over our custom header. A frameless window also
// loses the OS edge-resize grips, so we re-create them: thin invisible strips
// pinned to each edge/corner that hand the gesture back to the OS via
// startResizeDragging. macOS keeps its native Overlay frame, so the caller only
// mounts this off-mac.
const EDGE = 5; // px — edge strip thickness
const CORNER = 12; // px — corner square (takes priority over edges)

type Handle = { dir: ResizeDirection; cursor: string; style: React.CSSProperties };

const HANDLES: Handle[] = [
  { dir: "North", cursor: "cursor-ns-resize", style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "South", cursor: "cursor-ns-resize", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "West", cursor: "cursor-ew-resize", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "East", cursor: "cursor-ew-resize", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "NorthWest", cursor: "cursor-nwse-resize", style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: "NorthEast", cursor: "cursor-nesw-resize", style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { dir: "SouthWest", cursor: "cursor-nesw-resize", style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: "SouthEast", cursor: "cursor-nwse-resize", style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];

/** Hand the edge/corner drag back to the OS via startResizeDragging — state-free. */
const onDown = (dir: ResizeDirection) => (e: PointerEvent<HTMLDivElement>) => {
  if (e.button !== 0) return;
  e.preventDefault();
  win()
    ?.startResizeDragging(dir)
    .catch(() => {});
};

export function WindowResizeHandles() {
  const [maximized, setMaximized] = useState(false);

  // Strip the native frame once on mount, then track the maximized state. If the
  // permission/IPC is unavailable the window simply keeps its native decorations
  // — a safe visual fallback.
  useEffect(() => {
    const w = win();
    if (!w) return;
    w.setDecorations(false).catch(() => {});
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

  // A maximized window can't be edge-resized, and the grips would otherwise sit
  // over the screen corners — intercepting the click users aim at the close
  // button. Drop them entirely until the window is restored.
  if (maximized) return null;

  return (
    <>
      {HANDLES.map((h) => (
        <div key={h.dir} className={`fixed z-[100] ${h.cursor}`} style={h.style} onPointerDown={onDown(h.dir)} />
      ))}
    </>
  );
}
