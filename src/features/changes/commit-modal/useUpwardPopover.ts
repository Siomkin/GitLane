// Open-state + viewport-fixed position for the composer's upward-opening
// popovers (Draft agents, commit variants, identity choices). The composer
// lives inside the inspector's `overflow-auto` region, so an
// `absolute bottom-full` menu is clipped the moment it extends past that
// scroll container — `position: fixed` against the trigger's rect escapes it.

import { useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { useDismiss } from "@/hooks/useDismiss";

export function useUpwardPopover(align: "left" | "right" = "right") {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(position !== null, () => setPosition(null), ref);

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
