import type { MouseEvent as ReactMouseEvent } from "react";

/** Full-height drag handle for resizing the graph column. */
export function ColumnHandle({ left, onResize }: { left: number; onResize: (width: number) => void }) {
  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = left;
    const move = (ev: MouseEvent) => {
      // Use the drag's initial position rather than an incremental delta.
      // The window listener keeps the callback from the mouse-down render, so
      // accumulating against the rendered `left` would repeatedly reset near
      // the starting width after React re-renders.
      onResize(startWidth + ev.clientX - startX);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div
      onMouseDown={onMouseDown}
      title="Drag to resize the graph column"
      className="group absolute inset-y-0 z-20 w-2.5 cursor-col-resize"
      style={{ left, transform: "translateX(-50%)" }}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-[color:var(--accent)]/40" />
    </div>
  );
}
