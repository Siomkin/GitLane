// A thin vertical drag handle between panels. Reports incremental horizontal
// movement to `onResize`, which the caller maps to a panel width.

import { useRef } from "react";

export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  const lastX = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    lastX.current = e.clientX;
    const move = (ev: MouseEvent) => {
      onResize(ev.clientX - lastX.current);
      lastX.current = ev.clientX;
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
      title="Drag to resize"
      className="group relative z-20 -mx-2 flex cursor-col-resize select-none justify-center"
    >
      <span className="h-full w-px bg-black/10 transition-colors group-hover:bg-[color:var(--accent)]/40 group-active:bg-[color:var(--accent)] dark:bg-white/10" />
    </div>
  );
}
