// Pointer drag-to-reorder for a vertical list of cards, with a FLIP animation
// so rows glide to their new slots instead of snapping.
//
// Lifted verbatim out of the Terminal Agents editor when AI Agents needed the
// same gesture. The subtleties here are all bought with bug reports — pointer
// capture so a drag survives leaving the grip, ending on every terminal signal
// so a row can't stick lifted, and cancelling in-flight FLIP frames so a rapid
// second reorder doesn't baseline off a mid-animation rect — and none of them
// are worth discovering twice.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ListReorder {
  /** Id of the row currently being dragged, for the lifted styling. */
  draggingId: string | null;
  /** Ref callback that registers a row's element for measurement. */
  registerEl: (id: string) => (el: HTMLElement | null) => void;
  /** `onPointerDown` for a row's drag grip. */
  startDrag: (id: string) => (e: React.PointerEvent) => void;
}

export function useListReorder(
  /** Row ids in their current order. */
  ids: string[],
  /** Commit a move; called live as the pointer crosses a row's midpoint. */
  move: (from: number, to: number) => void,
  /** Extra key that changes when row *heights* change (e.g. a row expands), so
   *  the FLIP baseline is refreshed without animating. */
  layoutKey = "",
): ListReorder {
  // While dragging we reorder *live* — as the pointer crosses a row's midpoint
  // the dragged row moves into that slot and the FLIP effect glides every row
  // to its new position, so it's always obvious where it will land.
  const [dragId, setDragId] = useState<string | null>(null);

  // Refs read by the window-level pointer handlers, which are registered once
  // per drag and must see the latest ids / move fn without re-subscribing.
  const rowEls = useRef<Map<string, HTMLElement>>(new Map());
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const moveRef = useRef(move);
  moveRef.current = move;
  const dragIdRef = useRef<string | null>(null);
  // Everything needed to tear a drag down from any exit path: the window
  // listeners we attached plus the element/pointer we captured.
  const dragRef = useRef<{ detach: () => void; el: Element; pointerId: number } | null>(null);

  const endDrag = () => {
    const d = dragRef.current;
    if (d) {
      // Null out first so releasing capture (which re-fires `lostpointercapture`)
      // can't re-enter this teardown.
      dragRef.current = null;
      d.detach();
      if (d.el.hasPointerCapture?.(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    }
    dragIdRef.current = null;
    setDragId(null);
  };

  const onDragMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    const id = dragIdRef.current;
    // Only the captured pointer drives the reorder — a second finger's move must
    // not hijack the drag.
    if (id === null || !drag || e.pointerId !== drag.pointerId) return;
    const order = idsRef.current;
    const from = order.indexOf(id);
    if (from < 0) return;
    // Target slot = number of rows whose midpoint the pointer has passed.
    let to = 0;
    for (let i = 0; i < order.length; i++) {
      const el = rowEls.current.get(order[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) to = i + 1;
    }
    if (to > from) to--;
    to = Math.max(0, Math.min(order.length - 1, to));
    if (to !== from) moveRef.current(from, to);
  };

  const startDrag = (id: string) => (e: React.PointerEvent) => {
    // Only a primary-button / primary-pointer press starts a reorder — ignore
    // right/middle clicks and secondary (multi-touch) pointers, which would
    // otherwise enter drag state and attach global listeners for no gesture.
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    // Defensively end any drag still in flight (e.g. a pointerup we missed)
    // before starting a new one, so the previous drag's window listeners and
    // pointer capture can't leak.
    if (dragRef.current) endDrag();
    const el = e.currentTarget;
    const { pointerId } = e;
    dragIdRef.current = id;
    setDragId(id);
    // Capture the pointer so moves/ups keep flowing even if it leaves the grip
    // or the window, and end the drag on every terminal signal — normal release,
    // `pointercancel`, or a `lostpointercapture` from an OS gesture / alt-tab —
    // so a row can never stick in its lifted state. Capture is best-effort.
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore: drag still works via the window listeners below
    }
    const moveHandler = (ev: PointerEvent) => onDragMove(ev);
    // End only on the captured pointer's release/cancel/lost-capture — a stray
    // release from another pointer must not end this drag.
    const end = (ev: PointerEvent) => {
      if (dragRef.current && ev.pointerId !== dragRef.current.pointerId) return;
      endDrag();
    };
    window.addEventListener("pointermove", moveHandler);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("lostpointercapture", end);
    dragRef.current = {
      el,
      pointerId,
      detach: () => {
        window.removeEventListener("pointermove", moveHandler);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("lostpointercapture", end);
      },
    };
  };

  // Detach any live drag listeners if the list unmounts mid-drag.
  useEffect(() => endDrag, []);

  // FLIP: glide rows to their new positions on reorder instead of snapping.
  // `order` detects an actual reorder — the only thing we animate; editing a
  // field mutates the list without moving any row, so it must not re-measure.
  const order = ids.join(" ");
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const prevOrder = useRef(order);
  const flipRafs = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const els = rowEls.current;
    const rafs = flipRafs.current; // stable Map ref; capture for the cleanup closure
    // Clear any transform still applied from an animation that the cleanup below
    // just cancelled, so the measurement reads TRUE layout positions — a rapid
    // consecutive reorder must not baseline off a mid-animation (transformed) rect.
    els.forEach((el) => {
      if (el.style.transform) {
        el.style.transition = "none";
        el.style.transform = "";
      }
    });
    const nextRects = new Map<string, DOMRect>();
    els.forEach((el, id) => nextRects.set(id, el.getBoundingClientRect()));
    // Only animate on a real reorder; a height change just refreshes the baseline.
    if (order !== prevOrder.current) {
      els.forEach((el, id) => {
        const prev = prevRects.current.get(id);
        const next = nextRects.get(id);
        const dy = prev && next ? prev.top - next.top : 0;
        if (dy) {
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
          void el.offsetHeight; // force reflow so the start position sticks
          const raf = requestAnimationFrame(() => {
            el.style.transition = "transform 220ms cubic-bezier(0.2,0,0,1)";
            el.style.transform = "";
            rafs.delete(id);
          });
          rafs.set(id, raf);
        }
      });
    }
    prevRects.current = nextRects;
    prevOrder.current = order;
    return () => {
      // Cancel pending FLIP frames on re-run / unmount so a stale frame can't
      // reset a transform mid-flight (which would make a rapid reorder jump).
      rafs.forEach((raf) => cancelAnimationFrame(raf));
      rafs.clear();
    };
  }, [order, layoutKey]);

  const registerEl = (id: string) => (el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };

  return { draggingId: dragId, registerEl, startDrag };
}
