import { type MouseEvent as ReactMouseEvent } from "react";
import { useUi } from "@/store/ui";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";

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

export function Toast() {
  const toast = useUi((s) => s.toast);
  const dismissToast = useUi((s) => s.dismissToast);
  if (!toast) return null;
  const isError = toast.tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className="fixed bottom-[26px] left-1/2 z-[70] flex max-w-[min(560px,calc(100vw-48px))] -translate-x-1/2 items-start gap-2.5 rounded-xl border border-black/10 bg-white px-[18px] py-[11px] shadow-[0_18px_44px_-8px_rgba(0,0,0,0.4)] dark:border-white/10 dark:bg-neutral-800"
      style={{ animation: "gp-toast .18s ease-out" }}
    >
      {isError ? (
        <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
          !
        </span>
      ) : (
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-white">
          <CheckIcon className="h-2.5 w-2.5" />
        </span>
      )}
      {/* pre-wrap + scroll so multi-line hook errors stay readable and copyable */}
      <span className="max-h-[42vh] select-text overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-800 dark:text-neutral-100">
        {toast.message}
      </span>
      {isError && (
        <button
          type="button"
          onClick={dismissToast}
          aria-label="Dismiss"
          className="-mr-1.5 -mt-0.5 ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
