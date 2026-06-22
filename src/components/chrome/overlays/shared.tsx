import { useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from "react";
import { useUi } from "@/store/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { focusRing } from "@/lib/ui";

/**
 * Keep a menu anchored at (x, y) fully on-screen. Measures the panel's *real*
 * rendered size in a layout effect (before paint, so there's no flicker), then:
 *   - slides it left when it would overflow the right edge,
 *   - slides it up when it would overflow the bottom edge,
 *   - and, only when it's taller than the viewport, pins it to the top and caps
 *     its height so it scrolls internally instead of running off-screen.
 *
 * This replaces the old per-menu `window.innerHeight - <hardcoded guess>` clamps,
 * which cut tall menus (e.g. the branch context menu) off at the bottom.
 */
export function useFittedMenuPosition(
  x: number,
  y: number,
  ref: RefObject<HTMLElement | null>,
  deps: DependencyList = [],
) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: x,
    top: y,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.scrollHeight; // natural content height, ignoring any max-height cap
    const maxHeight = vh - margin * 2;
    const left = Math.max(margin, Math.min(x, vw - margin - w));
    const top = h <= maxHeight ? Math.max(margin, Math.min(y, vh - margin - h)) : margin;
    setPos({ left, top, maxHeight });
    // ref is stable; x/y + caller-supplied deps drive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...deps]);
  return pos;
}

/** Run a branch operation, surfacing its result (or git error) as a toast. */
export function useBranchOp() {
  const showToast = useUi((s) => s.showToast);
  return async (op: () => Promise<string>) => {
    try {
      const message = await op();
      showToast(message);
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e), "error");
    }
  };
}
export interface MenuItem {
  label: string;
  /** Required unless `header` is set (headers are non-clickable labels). */
  onClick?: () => void;
  danger?: boolean;
  sep?: boolean;
  /** Non-clickable group header (e.g. a label above a cluster of related
   * actions like the reset-mode choices). Renders muted, no hover state. */
  header?: boolean;
  /** Indented child of a header group (used for the reset soft/mixed/hard
   * choices). Adds left padding so they read as nested. */
  indent?: boolean;
}

export function MenuPanel({
  left,
  top,
  items,
  onClose,
  width = 220,
}: {
  /** Anchor x (e.g. the click's clientX) — clamped on-screen internally. */
  left: number;
  /** Anchor y (e.g. the click's clientY) — clamped on-screen internally. */
  top: number;
  items: MenuItem[];
  onClose: () => void;
  width?: number;
}) {
  // Close on Escape (and outside mousedown); the backdrop shields underlying
  // content from the dismissing click. Mirrors ConfirmDialog/the navigator.
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, panelRef);
  const pos = useFittedMenuPosition(left, top, panelRef, [items.length]);
  return (
    <>
      <Backdrop onClick={onClose} z={49} />
      <div
        ref={panelRef}
        role="menu"
        className="fixed z-50 overflow-y-auto rounded-xl border border-black/10 bg-white py-1.5 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        style={{
          left: pos.left,
          top: pos.top,
          minWidth: width,
          maxHeight: pos.maxHeight,
          animation: "gp-pop .12s ease-out",
        }}
      >
        {items.map((it, i) =>
          it.header ? (
            <div key={`${it.label}-${i}`}>
              {it.sep && <div className="my-1 mx-2 h-px bg-black/5 dark:bg-white/5" />}
              <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                {it.label}
              </div>
            </div>
          ) : (
            <div key={`${it.label}-${i}`}>
              {it.sep && <div className="my-1 mx-2 h-px bg-black/5 dark:bg-white/5" />}
              <button
                role="menuitem"
                onClick={it.onClick}
                className={`flex h-8 w-full items-center whitespace-nowrap text-left text-[13px] ${focusRing} ${
                  it.indent ? "pl-6 pr-3" : "px-3"
                } ${
                  it.danger
                    ? "text-rose-500 hover:bg-rose-500/10 dark:text-rose-400"
                    : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
                }`}
              >
                {it.label}
              </button>
            </div>
          ),
        )}
      </div>
    </>
  );
}
export function Backdrop({ onClick, z }: { onClick: () => void; z: number }) {
  return <div className="fixed inset-0" style={{ zIndex: z }} onClick={onClick} />;
}
