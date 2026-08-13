// One conflict's Output editor: a numbered, syntax-highlighted backdrop with a
// transparent textarea on top (the same overlay the file editor uses). Native
// <textarea> glyphs can't be coloured per token, and WKWebView ignores Tailwind
// line-height on textareas — the overlay gives both colour and stable metrics.

import { useMemo, useRef } from "react";
import { cn } from "@/lib/cn";
import { MONO_FONT } from "@/lib/ui";
import { tokenize } from "./conflictModel";
import { splitOutputLines } from "./outputBlocks";

const LINE_H = 20;
const PAD_Y = 4;
const PAD_X = 8;
const BOX = { fontFamily: MONO_FONT, fontSize: "12px", lineHeight: `${LINE_H}px`, tabSize: 2 } as const;

export function OutputHunk({
  conflictNo,
  regionIdx,
  open,
  startNo,
  text,
  onTakeBlock,
  onUndo,
  onEdit,
}: {
  /** The hunk's 1-based conflict number. Omitted for a whole-file rewrite,
   * which has no hunk identity — and so no A/B ticks to offer. */
  conflictNo?: number;
  /** Scroll anchor for the conflict nav; absent for a whole-file rewrite. */
  regionIdx?: number;
  open: boolean;
  /** Merged-file line number of the first row in this hunk. */
  startNo: number;
  text: string;
  onTakeBlock?: (which: "a" | "b" | "both") => void;
  onUndo: () => void;
  onEdit: (lines: string[]) => void;
}) {
  const file = conflictNo == null;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => (text === "" ? [""] : text.split("\n")), [text]);
  const displayCount = Math.max(lines.length, open ? 3 : 1);
  const displayLines = useMemo(() => {
    const out = lines.slice();
    while (out.length < displayCount) out.push("");
    return out;
  }, [lines, displayCount]);

  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (backdropRef.current) {
      backdropRef.current.scrollTop = ta.scrollTop;
      backdropRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  const highlighted = text !== "";
  const height = displayCount * LINE_H + PAD_Y * 2;
  const lastNo = startNo + displayCount - 1;
  const gutterWidth = `${Math.max(2, String(lastNo).length)}ch`;

  return (
    <div
      data-region={regionIdx}
      data-start-no={startNo}
      className={cn(
        "mx-1.5 my-1 rounded-lg border px-2 py-1.5",
        open
          ? "border-dashed border-amber-400/60 bg-amber-50/60 dark:bg-amber-400/[0.06]"
          : "border-black/5 bg-emerald-500/[0.06] dark:border-white/10",
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">
          {file
            ? "Merged file — edit if this isn't right"
            : `Conflict ${conflictNo}${open ? " — pick lines above or type a resolution" : " — edit if this isn't right"}`}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {onTakeBlock && (
            <>
          <button
            type="button"
            onClick={() => onTakeBlock("a")}
            className="h-5 rounded bg-[var(--accent-soft)] px-2 text-[10px] font-semibold text-[color:var(--accent)] hover:brightness-95"
          >
            All A
          </button>
          <button
            type="button"
            onClick={() => onTakeBlock("b")}
            className="h-5 rounded bg-[#3b7ff5]/12 px-2 text-[10px] font-semibold text-[#3b7ff5] hover:brightness-95"
          >
            All B
          </button>
          <button
            type="button"
            onClick={() => onTakeBlock("both")}
            className="h-5 rounded border border-black/10 px-2 text-[10px] font-semibold text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Both
          </button>
            </>
          )}
          {(!open || file) && (
            <button
              type="button"
              onClick={onUndo}
              className="h-5 rounded border border-black/10 px-2 text-[10px] font-semibold text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              Undo
            </button>
          )}
        </div>
      </div>
      <div
        className="flex overflow-hidden rounded-md border border-black/5 dark:border-white/10"
        style={{ height }}
      >
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-r border-black/5 bg-black/[0.02] text-right tabular-nums text-neutral-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-600"
          style={{ ...BOX, width: `calc(${gutterWidth} + 14px)`, padding: `${PAD_Y}px 6px` }}
        >
          {displayLines.map((_, i) => (
            <div key={i} style={{ height: LINE_H }}>
              {i < lines.length ? startNo + i : ""}
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {highlighted && (
            <pre
              ref={backdropRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden"
              style={{ ...BOX, padding: `${PAD_Y}px ${PAD_X}px` }}
            >
              {displayLines.map((line, i) => (
                <div
                  key={i}
                  className="whitespace-pre"
                  style={{ height: LINE_H, width: "max-content", minWidth: "100%" }}
                >
                  {tokenize(line).map((t, j) => (
                    <span key={j} className={t.cls}>
                      {t.v}
                    </span>
                  ))}
                </div>
              ))}
            </pre>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onEdit(splitOutputLines(e.target.value))}
            onScroll={syncScroll}
            spellCheck={false}
            wrap="off"
            placeholder={open ? "Type a merged result…" : undefined}
            aria-label={file ? "Merged file resolution" : `Conflict ${conflictNo} resolution`}
            className={cn(
              "absolute inset-0 resize-none overflow-auto border-0 caret-neutral-800 outline-none dark:caret-neutral-100",
              highlighted
                ? "bg-transparent text-transparent"
                : "bg-white text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200",
            )}
            style={{ ...BOX, padding: `${PAD_Y}px ${PAD_X}px`, whiteSpace: "pre" }}
          />
        </div>
      </div>
    </div>
  );
}
