import { useLayoutEffect, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Rows mounted beyond each edge of the viewport, so a fast scroll never shows a gap. */
const OVERSCAN = 10;
/** Viewport assumed before the scroll container is measured (and in tests,
 * which have no layout): roughly one inspector's height of rows. */
const INITIAL_RECT = { width: 0, height: 1000 };

/** The nearest ancestor that scrolls vertically: the inspector's shared
 * `overflow-auto` body, which also holds the header and sibling sections. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Virtualizes a list that does not own its scroll container. The list keeps
 * scrolling with the rest of the inspector, and `scrollMargin` (its offset in
 * that container) is re-read whenever the container's children resize or are
 * added/removed, so content above the list never misaligns the window. */
export function useVirtualRows(
  listRef: RefObject<HTMLElement | null>,
  count: number,
  estimateSize: (index: number) => number,
  getItemKey: (index: number) => string,
) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const parent = scrollParent(list);
    setScrollEl(parent);
    if (!parent) return;
    const update = () =>
      setScrollMargin(
        list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    update();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(update);
    const observeAll = () => {
      resize.observe(parent);
      for (const child of parent.children) resize.observe(child);
    };
    observeAll();
    // A child inserted above the list (e.g. the filter field) moves it without
    // resizing anything already observed.
    const mutation = new MutationObserver(() => {
      observeAll();
      update();
    });
    mutation.observe(parent, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [listRef]);

  return useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    scrollMargin,
    initialRect: INITIAL_RECT,
    useFlushSync: false,
  });
}
