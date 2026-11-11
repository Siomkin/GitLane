import { useEffect, useRef, useState, type CSSProperties } from "react";

/** Width of the arrow button over a clipped edge (h-6 w-6 in TitleBar). */
const ARROW = 24;
/** Arrow plus the fade beside it: how much of a clipped edge hides tabs. */
const EDGE = ARROW + 16;

/** Overflow for the title-bar tab strip without a scrollbar: the scroller keeps
 * native trackpad scrolling, a mouse wheel's vertical turn scrolls it sideways,
 * a clipped edge fades out, and the active tab is brought into view whenever it
 * changes. `scrollerRef` goes on the overflow box, `contentRef` on the row of
 * tabs inside it (watched so a tab opening or a group collapsing re-checks the
 * edges). */
export const useTabStripScroll = (activePath: string | null) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const onWheel = (e: WheelEvent) => {
      // The strip never scrolls vertically, so a vertical wheel is free to use.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    const tab = el?.querySelector<HTMLElement>('[data-active="true"]');
    if (!el || !tab) return;
    // Measured by hand rather than scrollIntoView: that would also scroll
    // ancestors, and it can't leave room for the arrow and fade.
    const s = el.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < s.left + EDGE) el.scrollLeft -= s.left + EDGE - t.left;
    else if (t.right > s.right - EDGE) el.scrollLeft += t.right - (s.right - EDGE);
  }, [activePath]);

  // A clipped edge is blank under its arrow button, then fades in, so the
  // arrow never sits on top of tab text.
  const startStops = edges.start ? `transparent ${ARROW}px, #000 ${EDGE}px` : "#000 0px";
  const endStops = edges.end ? `#000 calc(100% - ${EDGE}px), transparent calc(100% - ${ARROW}px)` : "#000 100%";
  const mask =
    edges.start || edges.end ? `linear-gradient(to right, ${startStops}, ${endStops})` : undefined;
  const style: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };

  /** Page the strip one view-width (less a little overlap) toward `dir`. */
  const page = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    el?.scrollBy?.({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return { scrollerRef, contentRef, style, edges, page };
};
