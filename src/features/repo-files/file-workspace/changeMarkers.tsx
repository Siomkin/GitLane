// Shared uncommitted-change decoration components for the file views (GL-212):
// the per-line gutter bar + deletion caret, and the far-right overview ruler.
// Both the read-only Source view and the editable editor render these against
// the committed (HEAD) baseline. Pure logic + colour tokens live in
// `./changeMarks` so this file exports only components.

import { memo } from "react";
import { barFill, DELETE_CARET, type RulerMark, RULER_OPACITY } from "./changeMarks";
import { LineChange } from "./lineChanges";

const DeleteCaret = () => (
  <span
    className="pointer-events-none absolute right-0 top-0 h-0 w-0 -translate-y-1/2"
    style={{
      borderLeft: "4px solid transparent",
      borderRight: "4px solid transparent",
      borderTop: `4px solid ${DELETE_CARET}`,
    }}
  />
);

/** The per-line change decoration: a bar in the lane at the row's right edge
 * (added/modified) plus a caret when baseline lines were deleted just above.
 * Rendered inside a `position: relative` row/number cell. */
export function ChangeBar({ tag, deletedAbove }: { tag: LineChange; deletedAbove: boolean }) {
  const fill = barFill(tag);
  return (
    <>
      {fill && (
        <span className="pointer-events-none absolute inset-y-0 right-0 w-[3px]" style={{ background: fill }} />
      )}
      {deletedAbove && <DeleteCaret />}
    </>
  );
}

/** Far-right overview ruler: the whole file mapped to the view height with a
 * tick per change, so every uncommitted change is visible at once and one click
 * jumps to it. Styled to match the review view's ChangeMinimap. */
export const OverviewRuler = memo(function OverviewRuler({
  marks,
  onJump,
}: {
  marks: RulerMark[];
  onJump: (fraction: number) => void;
}) {
  return (
    <div
      aria-hidden
      title="Uncommitted changes — click to jump"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.height <= 0) return; // not laid out yet — avoid NaN
        onJump(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
      }}
      className="relative w-2.5 shrink-0 cursor-pointer border-l border-black/5 bg-black/[0.03] dark:border-white/5 dark:bg-white/[0.04]"
    >
      {marks.map((m, i) => (
        <div
          key={i}
          className="pointer-events-none absolute inset-x-[1px] rounded-[1px]"
          style={{
            top: `${m.top * 100}%`,
            height: m.deletion ? 2 : `max(2px, ${m.height * 100}%)`,
            background: m.fill,
            opacity: RULER_OPACITY,
            transform: m.deletion ? "translateY(-1px)" : undefined,
          }}
        />
      ))}
    </div>
  );
});
