// Open-state + viewport-fixed position for menus inside scrollable change
// surfaces. Fixed positioning escapes overflow clipping; the placement is
// chosen by the caller so controls near the top open down and composer
// controls near the bottom open up.

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { useDismiss } from "@/hooks/useDismiss";

export function useFixedPopover({
  align = "right",
  placement = "up",
}: {
  align?: "left" | "right";
  placement?: "up" | "down";
} = {}) {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const open = position !== null;
  useDismiss(open, () => setPosition(null), ref);

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
    setPosition((previous) => {
      if (previous) return null;
      const vertical = placement === "up"
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 };
      const horizontal = align === "right"
        ? { right: window.innerWidth - rect.right }
        : { left: rect.left };
      return { ...vertical, ...horizontal };
    });
  };

  return {
    ref,
    open,
    menuStyle: position ?? undefined,
    toggle,
    close: () => setPosition(null),
  };
}
