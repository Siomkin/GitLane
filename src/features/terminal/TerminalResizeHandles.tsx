import type { KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import {
  resizeTerminalInsets,
  type TerminalHorizontalInsets,
  type TerminalResizeSide,
} from "./terminalPanelGeometry";

export function TerminalResizeHandles({
  panelRef,
  adjustHeight,
  setInsets,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  adjustHeight: (delta: number) => void;
  setInsets: (left: number, right: number) => void;
}) {
  const beginHeightDrag = (event: ReactMouseEvent) => {
    event.preventDefault();
    let lastY = event.clientY;
    beginDrag("ns-resize", (moveEvent) => {
      adjustHeight(lastY - moveEvent.clientY);
      lastY = moveEvent.clientY;
    });
  };

  const beginWidthDrag = (side: TerminalResizeSide, event: ReactMouseEvent) => {
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const startX = event.clientX;
    beginDrag("ew-resize", (moveEvent) => {
      const next = resizeTerminalInsets({
        side,
        start: geometry.insets,
        deltaX: moveEvent.clientX - startX,
        containerWidth: geometry.containerWidth,
      });
      setInsets(next.left, next.right);
    });
  };

  const resizeWidthWithKeyboard = (side: TerminalResizeSide, event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const next = resizeTerminalInsets({
      side,
      start: geometry.insets,
      deltaX: event.key === "ArrowRight" ? 32 : -32,
      containerWidth: geometry.containerWidth,
    });
    setInsets(next.left, next.right);
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal height"
        tabIndex={0}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 16;
          if (event.key === "ArrowUp") {
            event.preventDefault();
            adjustHeight(step);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            adjustHeight(-step);
          }
        }}
        onMouseDown={beginHeightDrag}
        title="Drag to resize height"
        className="absolute inset-x-0 top-0 z-10 h-2 cursor-ns-resize outline-none focus-visible:bg-[color:var(--accent)]/40"
      />
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize terminal width from ${side}`}
          tabIndex={0}
          onKeyDown={(event) => resizeWidthWithKeyboard(side, event)}
          onMouseDown={(event) => beginWidthDrag(side, event)}
          title="Drag to resize width"
          className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize outline-none focus-visible:bg-[color:var(--accent)]/40 ${side === "left" ? "left-0" : "right-0"}`}
        />
      ))}
    </>
  );
}

function panelGeometry(panel: HTMLDivElement | null): {
  insets: TerminalHorizontalInsets;
  containerWidth: number;
} | null {
  const container = panel?.parentElement;
  if (!panel || !container) return null;
  const panelRect = panel.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width === 0 || panelRect.width === 0) return null;
  return {
    insets: {
      left: panelRect.left - containerRect.left,
      right: containerRect.right - panelRect.right,
    },
    containerWidth: containerRect.width,
  };
}

function beginDrag(cursor: "ns-resize" | "ew-resize", onMove: (event: MouseEvent) => void) {
  const end = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", end);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", end);
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
}
