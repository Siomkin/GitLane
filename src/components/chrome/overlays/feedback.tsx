import { type MouseEvent as ReactMouseEvent } from "react";
import { useUi } from "@/store/ui";

export function Tooltip() {
  const tip = useUi((s) => s.tooltip);
  if (!tip) return null;
  const left = Math.max(8, Math.min(tip.x, window.innerWidth - 8));
  return (
    <div
      className="pointer-events-none fixed z-[90] -translate-x-1/2 -translate-y-full rounded-md border border-black/10 bg-white px-2 py-1 text-[12px] font-medium text-neutral-800 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.35)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100"
      style={{ left, top: tip.y - 6 }}
    >
      {tip.text}
    </div>
  );
}
/** Hover handlers that show the floating tooltip only when the hovered
 * element's text is actually truncated. */
export function useTruncatedTooltip(text: string) {
  const showTooltip = useUi((s) => s.showTooltip);
  const hideTooltip = useUi((s) => s.hideTooltip);
  return {
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
      const el = e.currentTarget.querySelector<HTMLElement>("[data-truncate]") ?? e.currentTarget;
      if (el.scrollWidth > el.clientWidth + 1) {
        const r = e.currentTarget.getBoundingClientRect();
        showTooltip(text, r.left + r.width / 2, r.top);
      }
    },
    onMouseLeave: () => hideTooltip(),
  };
}
