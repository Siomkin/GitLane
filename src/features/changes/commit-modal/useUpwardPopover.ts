// Open-state + viewport-fixed position for the composer's upward-opening
// popovers (Draft agents, commit variants, identity choices). The composer
// lives inside the inspector's `overflow-auto` region, so an
// `absolute bottom-full` menu is clipped the moment it extends past that
// scroll container — `position: fixed` against the trigger's rect escapes it.

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { useDismiss } from "@/hooks/useDismiss";

export function useUpwardPopover(align: "left" | "right" = "right") {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const open = position !== null;
  useDismiss(open, () => setPosition(null), ref);

  // The position is captured once at open, so scrolling the inspector (or
  // resizing the window) would leave the menu floating at a stale offset —
  // close instead. Scrolls inside the popover itself (its own overflow list)
  // must not dismiss it.
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      setPosition(null);
    };
    const onResize = () => setPosition(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggle = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition((prev) =>
      prev
        ? null
        : {
            bottom: window.innerHeight - rect.top + 6,
            ...(align === "right"
              ? { right: window.innerWidth - rect.right }
              : { left: rect.left }),
          },
    );
  };

  return {
    /** Ref for the wrapper containing both trigger and menu (outside-dismiss). */
    ref,
    open: position !== null,
    /** Inline style for the `position: fixed` menu element. */
    menuStyle: position ?? undefined,
    toggle,
    close: () => setPosition(null),
  };
}
