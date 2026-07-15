// Open-state + viewport-fixed position for menus inside scrollable change
// surfaces. Fixed positioning escapes overflow clipping; the placement is
// chosen by the caller so controls near the top open down and composer
// controls near the bottom open up.
//
// The menu is rendered through the `portal()` helper into the app root on
// purpose: a `position: fixed` element is only viewport-anchored when no
// ancestor establishes a containing block. Any ancestor `transform` — e.g. the
// `translateY(...)` on virtualized review rows (StackedReviewList) — retargets
// `fixed` to that ancestor's box, so the coordinates computed here from the
// trigger's `getBoundingClientRect()` (which are viewport-relative) land in the
// wrong place. WebView engines differ in how visibly this misfires (it showed
// up on Linux/WebKitGTK and Windows/WebView2 while looking fine on
// macOS/WebKit), so portaling out of the transformed subtree makes the
// placement correct on every platform.
//
// The portal host is the untransformed `.gp-root` element, NOT `document.body`:
// theming lives on `.gp-root` (the `.dark` class and the `--accent` custom
// properties both scope to it), so a body-level portal would render the menu
// un-accented and always in light mode. `.gp-root` has no containing-block
// transform, and `fixed` isn't clipped by its `overflow-hidden`, so anchoring
// stays viewport-correct while the theme context is preserved.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export function useFixedPopover({
  align = "right",
  placement = "up",
}: {
  align?: "left" | "right";
  placement?: "up" | "down";
} = {}) {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    // Treat the trigger wrapper and the portaled menu as one logical surface:
    // the menu lives outside `ref` in the DOM, so both must be consulted before
    // deciding a pointer/scroll event is "outside". Read `.current` at event
    // time (defined inside the effect) so the listeners always see live nodes.
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(ref.current?.contains(target) || menuRef.current?.contains(target));
    const onDown = (event: MouseEvent) => {
      if (!isInside(event.target)) setPosition(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPosition(null);
      }
    };
    const onScroll = (event: Event) => {
      if (isInside(event.target)) return;
      setPosition(null);
    };
    const onResize = () => setPosition(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggle = (event: ReactMouseEvent<HTMLElement>) => {
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

  // A render function, not a component: it invokes `createPortal` inside the
  // consumer's own render so the menu reconciles as part of that component and
  // isn't remounted whenever this hook re-runs (a fresh component identity per
  // render would unmount/remount the open menu). The argument is a callback so
  // the menu's children are only constructed while open — passing an element
  // directly would build the whole subtree every render even when closed.
  const hostRef = useRef<HTMLElement | null>(null);
  const portal = (render: () => ReactNode) => {
    if (!open) return null;
    hostRef.current ??= document.querySelector<HTMLElement>(".gp-root") ?? document.body;
    return createPortal(render(), hostRef.current);
  };

  return {
    ref,
    menuRef,
    open,
    menuStyle: position ?? undefined,
    toggle,
    close: () => setPosition(null),
    portal,
  };
}
