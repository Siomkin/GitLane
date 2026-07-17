import type { KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import {
  resizeTerminalFromBottom,
  resizeTerminalInsets,
  type TerminalHorizontalInsets,
  type TerminalResizeSide,
} from "./terminalPanelGeometry";

export function TerminalResizeHandles({
  panelRef,
  adjustHeight,
  setVertical,
  setInsets,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  adjustHeight: (delta: number) => void;
  setVertical: (bottomInset: number, height: number) => void;
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

  // Bottom edge: drag the floor of the panel while its top edge stays put.
  const beginBottomDrag = (event: ReactMouseEvent) => {
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const startY = event.clientY;
    beginDrag("ns-resize", (moveEvent) => {
      const next = resizeTerminalFromBottom({
        start: geometry.vertical,
        deltaY: moveEvent.clientY - startY,
      });
      setVertical(next.bottom, next.height);
    });
  };

  // Top corners: one drag drives both axes — height (incremental, like the top
  // edge) and the matching side's inset (absolute from the drag start).
  const beginCornerDrag = (side: TerminalResizeSide, event: ReactMouseEvent) => {
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const startX = event.clientX;
    let lastY = event.clientY;
    beginDrag(side === "left" ? "nwse-resize" : "nesw-resize", (moveEvent) => {
      adjustHeight(lastY - moveEvent.clientY);
      lastY = moveEvent.clientY;
      const next = resizeTerminalInsets({
        side,
        start: geometry.insets,
        deltaX: moveEvent.clientX - startX,
        containerWidth: geometry.containerWidth,
      });
      setInsets(next.left, next.right);
    });
  };

  // Bottom corners: the matching side's inset (absolute) + the bottom edge
  // (top-fixed), both from the drag start.
  const beginBottomCornerDrag = (side: TerminalResizeSide, event: ReactMouseEvent) => {
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const startX = event.clientX;
    const startY = event.clientY;
    beginDrag(side === "left" ? "nesw-resize" : "nwse-resize", (moveEvent) => {
      const vertical = resizeTerminalFromBottom({
        start: geometry.vertical,
        deltaY: moveEvent.clientY - startY,
      });
      setVertical(vertical.bottom, vertical.height);
      const horizontal = resizeTerminalInsets({
        side,
        start: geometry.insets,
        deltaX: moveEvent.clientX - startX,
        containerWidth: geometry.containerWidth,
      });
      setInsets(horizontal.left, horizontal.right);
    });
  };

  // ArrowUp lifts the floor (shrink), ArrowDown lowers it (grow) — the bottom
  // handle's vertical counterpart to the top edge's keyboard resize.
  const resizeBottomWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const geometry = panelGeometry(panelRef.current);
    if (!geometry) return;
    const step = event.shiftKey ? 48 : 16;
    const next = resizeTerminalFromBottom({
      start: geometry.vertical,
      deltaY: event.key === "ArrowDown" ? step : -step,
    });
    setVertical(next.bottom, next.height);
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
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal from bottom"
        tabIndex={0}
        onKeyDown={resizeBottomWithKeyboard}
        onMouseDown={beginBottomDrag}
        title="Drag to resize height"
        className="absolute inset-x-0 bottom-0 z-10 h-2 cursor-ns-resize outline-none focus-visible:bg-[color:var(--accent)]/40"
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
      {/* Corner handles sit above the edge strips (z-20) so the overlap wins.
          Not `role="separator"` — that implies a single axis (and defaults to
          horizontal); a corner is a 2D grip, so it's a plain button whose label
          names both axes. Arrow keys move one axis per press. */}
      {(["left", "right"] as const).map((side) => (
        <div
          key={`corner-top-${side}`}
          role="button"
          aria-label={`Resize terminal height and width from top ${side}`}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              adjustHeight((event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 48 : 16));
              return;
            }
            resizeWidthWithKeyboard(side, event);
          }}
          onMouseDown={(event) => beginCornerDrag(side, event)}
          title="Drag to resize"
          className={`absolute top-0 z-20 h-4 w-4 outline-none focus-visible:bg-[color:var(--accent)]/40 ${
            side === "left" ? "left-0 cursor-nwse-resize" : "right-0 cursor-nesw-resize"
          }`}
        />
      ))}
      {(["left", "right"] as const).map((side) => (
        <div
          key={`corner-bottom-${side}`}
          role="button"
          aria-label={`Resize terminal height and width from bottom ${side}`}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              resizeBottomWithKeyboard(event);
              return;
            }
            resizeWidthWithKeyboard(side, event);
          }}
          onMouseDown={(event) => beginBottomCornerDrag(side, event)}
          title="Drag to resize"
          className={`absolute bottom-0 z-20 h-4 w-4 outline-none focus-visible:bg-[color:var(--accent)]/40 ${
            side === "left" ? "left-0 cursor-nesw-resize" : "right-0 cursor-nwse-resize"
          }`}
        />
      ))}
    </>
  );
}

function panelGeometry(panel: HTMLDivElement | null): {
  insets: TerminalHorizontalInsets;
  vertical: { bottom: number; height: number };
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
    vertical: {
      bottom: containerRect.bottom - panelRect.bottom,
      height: panelRect.height,
    },
    containerWidth: containerRect.width,
  };
}

function beginDrag(
  cursor: "ns-resize" | "ew-resize" | "nwse-resize" | "nesw-resize",
  onMove: (event: MouseEvent) => void,
) {
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
