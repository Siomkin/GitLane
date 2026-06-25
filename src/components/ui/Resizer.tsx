// A vertical drag target between panels. Reports incremental horizontal movement
// to `onResize`, which the caller maps to a panel width.

import { useRef, useState } from "react";

import { cn } from "../../lib/cn";

export const Resizer = ({ onResize }: { onResize: (dx: number) => void }) => {
  const lastX = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    lastX.current = e.clientX;
    setDragging(true);
    const move = (ev: MouseEvent) => {
      onResize(ev.clientX - lastX.current);
      lastX.current = ev.clientX;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(-16);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(16);
    }
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      tabIndex={0}
      title="Drag to resize"
      className="group relative z-20 -mx-2 flex cursor-col-resize select-none items-center justify-center outline-none"
    >
      <span
        className={cn(
          "h-16 max-h-[28%] w-1 rounded-full bg-neutral-400/40 opacity-0 shadow-sm transition-[background-color,opacity,transform] duration-150 dark:bg-neutral-500/45",
          "group-hover:opacity-100 group-focus-visible:opacity-100",
          dragging && "scale-y-110 bg-[color:var(--accent)]/70 opacity-100 dark:bg-[color:var(--accent)]/75",
        )}
      />
    </div>
  );
};
