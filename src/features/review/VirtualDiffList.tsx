// Windowed scroller for a flat diff-row list. Owns its own scroll container (the
// single-file review gives each diff mode a dedicated scroll area), so the DOM
// holds only the visible rows plus overscan regardless of how many lines the
// file changed. Rows are dynamically measured because a pinned review note grows
// its row past the default line height.

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Default unified/split line height (matches DiffBody's 19px rows). Hunk
 * headers and note-bearing rows are taller and get measured up from here. */
const ESTIMATED_ROW = 19;
/** Generous overscan: diff scrolling is fast and rows are cheap, so keep a
 * comfortable buffer above/below the viewport to avoid blank flashes. */
const DIFF_OVERSCAN = 24;

export function VirtualDiffList<T>({
  rows,
  getKey,
  renderRow,
  testId,
}: {
  rows: T[];
  getKey: (row: T, index: number) => string;
  renderRow: (row: T, index: number) => ReactNode;
  testId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    overscan: DIFF_OVERSCAN,
    getItemKey: (index) => getKey(rows[index], index),
  });
  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      data-testid={testId}
      className="absolute inset-0 overflow-auto bg-white dark:bg-neutral-800"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {items.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(rows[item.index], item.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
