import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  resolvedRows,
  tokenize,
  type LineSelection,
  type Region,
  type RegionDecision,
} from "./conflictModel";
import { Tokens } from "./ConflictLine";

const ROW = "grid grid-cols-[46px_1fr] font-mono text-[12.5px] leading-[21px]";
const NUM = "select-none pr-2 text-right text-neutral-300 dark:text-neutral-600";

const resolvedLabel = (dec: RegionDecision | undefined) =>
  dec === "ours"
    ? "Resolved — kept current"
    : dec === "theirs"
      ? "Resolved — kept incoming"
      : dec === "both"
        ? "Resolved — kept both"
        : "Resolved — edited by line";

const SidePreview = ({
  title,
  sub,
  tone,
  lines,
  onUse,
}: {
  title: string;
  sub: string;
  tone: "ours" | "theirs";
  lines: string[];
  onUse: () => void;
}) => (
  <button type="button"
    onClick={onUse}
    className={cn(
      "group block w-full bg-white text-left transition-colors dark:bg-neutral-800",
      tone === "ours" ? "hover:bg-[var(--accent-soft)]" : "hover:bg-[#3b7ff5]/[0.10]",
    )}
  >
    <div className="flex h-8 items-center gap-2 px-3">
      <span
        className={cn(
          "shrink-0 text-[11px] font-semibold",
          tone === "ours" ? "text-[color:var(--accent)]" : "text-[#3b7ff5]",
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[11px]",
          tone === "ours" ? "text-[color:var(--accent)]/70" : "text-[#3b7ff5]/70",
        )}
      >
        {sub}
      </span>
      <span
        className={cn(
          "ml-auto flex shrink-0 items-center gap-1 text-[11px] font-semibold opacity-0 transition-opacity group-hover:opacity-100",
          tone === "ours" ? "text-[color:var(--accent)]" : "text-[#3b7ff5]",
        )}
      >
        Use this
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </div>
    {/* Conflict lines are an immutable positional snapshot; duplicate text is valid. */}
    {lines.map((line, i) => (
      <div
        key={i}
        className={cn(ROW, tone === "ours" ? "bg-[var(--accent-body)]" : "bg-[#3b7ff5]/[0.10]")}
      >
        <span className={NUM} />
        <Tokens tokens={tokenize(line)} />
      </div>
    ))}
  </button>
);

export const InlineConflict = ({
  regions,
  oursSub,
  theirsSub,
  decisionFor,
  lineSelFor,
  onDecide,
  onUndo,
}: {
  regions: Region[];
  oursSub: string;
  theirsSub: string;
  decisionFor: (idx: number) => RegionDecision | undefined;
  lineSelFor: (idx: number) => LineSelection;
  onDecide: (idx: number, decision: RegionDecision) => void;
  onUndo: (idx: number) => void;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // On open, land on the first still-undecided conflict instead of the file top.
  // The target is captured once per mounted file (the workspace remounts this
  // editor per file via key=path) — an external content refresh while the same
  // file stays mounted must NOT re-target (see InlineConflict.test.tsx).
  // jsdom has no layout engine and throws on scrollIntoView, so it's guarded.
  const [initialTarget] = useState(() =>
    regions.findIndex((r, i) => r.kind === "cf" && !decisionFor(i)),
  );
  useEffect(() => {
    if (initialTarget < 0) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-region="${initialTarget}"]`);
      if (!el || typeof el.scrollIntoView !== "function") return;
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* unimplemented under jsdom */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [initialTarget]);

  let lineNo = 0;
  return (
    <div ref={scrollRef} className="flex-1 overflow-auto py-1.5">
      {/* Regions retain positional identity for this file; decisions only change their rendering. */}
      {regions.map((region, idx) => {
        if (region.kind === "ctx") {
          return region.lines.map((line, k) => {
            lineNo += 1;
            return (
              <div key={`${idx}-${k}`} className={cn(ROW, "text-neutral-600 dark:text-neutral-300")}>
                <span className={NUM}>{lineNo}</span>
                <Tokens tokens={tokenize(line)} />
              </div>
            );
          });
        }
        const dec = decisionFor(idx);
        lineNo += Math.max(region.ours.length, region.theirs.length);
        if (!dec) {
          return (
            <div
              key={idx}
              data-region={idx}
              className="mx-1.5 my-1 overflow-hidden rounded-md border border-amber-300/60 dark:border-amber-400/30"
            >
              <SidePreview
                title="Current (ours)"
                sub={oursSub}
                tone="ours"
                lines={region.ours}
                onUse={() => onDecide(idx, "ours")}
              />
              <SidePreview
                title="Incoming (theirs)"
                sub={theirsSub}
                tone="theirs"
                lines={region.theirs}
                onUse={() => onDecide(idx, "theirs")}
              />
              <div className="flex border-t border-black/5 dark:border-white/5">
                <button type="button"
                  onClick={() => onDecide(idx, "both")}
                  className="h-7 w-full text-[11px] font-medium text-neutral-500 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                >
                  Keep both
                </button>
              </div>
            </div>
          );
        }
        const rows = resolvedRows(region, dec, lineSelFor(idx));
        return (
          <div key={idx} data-region={idx} className="group relative">
            {/* Resolved rows are an immutable positional projection and may contain duplicate lines. */}
            {rows.map((row, k) => (
              <div
                key={k}
                className={cn(
                  ROW,
                  row.side === "a" ? "bg-[var(--accent-body)]" : "bg-[#3b7ff5]/[0.10]",
                )}
              >
                <span className={NUM} />
                <Tokens tokens={tokenize(row.line)} />
              </div>
            ))}
            <div className="absolute right-1.5 top-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button type="button"
                onClick={() => onUndo(idx)}
                title={resolvedLabel(dec)}
                className="flex h-6 items-center gap-1 rounded-md border border-black/10 bg-white/90 px-2 text-[11px] font-medium text-neutral-600 shadow-sm backdrop-blur-sm hover:bg-white dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                  <path d="M9 14 4 9l5-5" />
                  <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
                </svg>
                Undo
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
