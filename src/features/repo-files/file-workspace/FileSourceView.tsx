import { MONO_FONT } from "@/lib/ui";
import type { Language } from "@/lib/highlight";
import { Tokens, numCell } from "@/features/review/DiffBody";
import { ChangeBar } from "./changeMarkers";
import { LineChange, type LineChanges } from "./lineChanges";

/** Read-only, syntax-highlighted rendering of a file's text — numbered lines
 * coloured by the file's language (GL-211 view, now per-language via GL-212).
 * `shownLines` is the already-capped head; `totalLines` is the true count.
 * `changes` (working tree vs HEAD) paints the same uncommitted-change bars as
 * the editor, in a lane at the right edge of the number cell. */
export function FileSourceView({
  shownLines,
  totalLines,
  maxRenderLines,
  lang,
  changes,
}: {
  shownLines: string[];
  totalLines: number;
  maxRenderLines: number;
  lang: Language;
  changes: LineChanges | null;
}) {
  return (
    <div className="py-2 text-[12.5px] leading-[20px]" style={{ fontFamily: MONO_FONT }}>
      {shownLines.map((line, i) => (
        <div key={i} className="flex hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
          <span className={`relative ${numCell}`}>
            {i + 1}
            {changes && (
              <ChangeBar tag={changes.tags[i] ?? LineChange.None} deletedAbove={changes.deletedBefore.has(i)} />
            )}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre pl-3 pr-4 text-neutral-700 dark:text-neutral-300">
            <Tokens content={line} lang={lang} />
          </span>
        </div>
      ))}
      {changes?.deletedAtEnd && totalLines <= maxRenderLines && (
        // A caret at EOF when the last committed line(s) were deleted — mirrors
        // the editor's gutter. Only when the true end is actually on screen.
        <div className="flex">
          <span className={`relative ${numCell}`} style={{ height: 0 }}>
            <ChangeBar tag={LineChange.None} deletedAbove />
          </span>
          <span className="flex-1" />
        </div>
      )}
      {totalLines > maxRenderLines && (
        <div className="mx-3 mt-1 rounded-md bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          Showing the first {maxRenderLines.toLocaleString()} of {totalLines.toLocaleString()} lines.
        </div>
      )}
    </div>
  );
}
