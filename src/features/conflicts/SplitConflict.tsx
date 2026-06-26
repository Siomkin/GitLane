import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { cn } from "../../lib/cn";
import type { LineEditor, PaneRow } from "./conflictModel";
import { Tokens } from "./ConflictLine";

type Side = "a" | "b";

const CheckIcon = ({ w = "w-2.5 h-2.5" }: { w?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={w}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const DashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
    <path d="M5 12h14" />
  </svg>
);
const ChevronIcon = ({ dir }: { dir: "up" | "down" }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
    <path d={dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
  </svg>
);

const ROW = "grid grid-cols-[26px_32px_18px_1fr] font-mono text-[12px] leading-[20px]";
const NUM = "select-none pr-1.5 text-right text-neutral-300 dark:text-neutral-600";
const tint = (side: Side) => (side === "a" ? "bg-[var(--accent-soft)]" : "bg-[#3b7ff5]/[0.10]");

// Smoothly bring a conflict block to the centre of every scroll pane. jsdom has
// no layout engine and throws on scrollIntoView, so the call is guarded for tests.
const revealRegion = (refs: RefObject<HTMLDivElement | null>[], regionIdx: number, smooth: boolean) => {
  refs.forEach((ref) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-region="${regionIdx}"]`);
    if (!el || typeof el.scrollIntoView !== "function") return;
    try {
      el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    } catch {
      /* scrollIntoView is unimplemented under jsdom */
    }
  });
};

// Small square toggle (per-line and per-block), tinted by side + state.
const box = (side: Side, on: boolean, partial = false) =>
  cn(
    "grid h-[14px] w-[14px] shrink-0 cursor-pointer place-items-center rounded border transition",
    side === "a"
      ? on
        ? "border-[color:var(--accent)] bg-[var(--accent)] text-white"
        : partial
          ? "border-[color:var(--accent)] bg-[var(--accent-soft)] text-[color:var(--accent)]"
          : "border-[color:var(--accent)]/40 text-transparent hover:border-[color:var(--accent)]"
      : on
        ? "border-[#3b7ff5] bg-[#3b7ff5] text-white"
        : partial
          ? "border-[#3b7ff5] bg-[#3b7ff5]/15 text-[#3b7ff5]"
          : "border-[#3b7ff5]/40 text-transparent hover:border-[#3b7ff5]",
  );

const Pane = ({
  side,
  title,
  sub,
  rows,
  all,
  scrollRef,
  onToggleLine,
  onSetBlock,
  onSelectAll,
}: {
  side: Side;
  title: string;
  sub: string;
  rows: PaneRow[];
  all: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onToggleLine: (regionIdx: number, side: Side, lineIdx: number) => void;
  onSetBlock: (regionIdx: number, side: Side, on: boolean) => void;
  onSelectAll: (side: Side, on: boolean) => void;
}) => {
  const accent = side === "a";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-black/5 dark:border-white/10">
      <div
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 border-b border-black/5 px-2.5 dark:border-white/5",
          accent ? "bg-[var(--accent-soft)]" : "bg-[#3b7ff5]/[0.10]",
        )}
      >
        <span
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] font-bold text-white",
            accent ? "bg-[var(--accent)]" : "bg-[#3b7ff5]",
          )}
        >
          {accent ? "A" : "B"}
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-[11px] font-semibold",
            accent ? "text-[color:var(--accent)]" : "text-[#3b7ff5]",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "hidden truncate font-mono text-[10.5px] lg:inline",
            accent ? "text-[color:var(--accent)]/70" : "text-[#3b7ff5]/70",
          )}
        >
          {sub}
        </span>
        <button
          onClick={() => onSelectAll(side, !all)}
          className={cn(
            "ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[10.5px] font-semibold",
            accent
              ? "text-[color:var(--accent)] hover:bg-[color:var(--accent)]/12"
              : "text-[#3b7ff5] hover:bg-[#3b7ff5]/12",
          )}
        >
          {all && <CheckIcon w="w-3 h-3" />}
          {all ? "All accepted" : "Accept all"}
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto py-1">
        {rows.map((ln, k) => (
          <div
            key={k}
            data-region={ln.conflict ? ln.regionIdx : undefined}
            className={cn(
              ROW,
              ln.conflict ? tint(side) : "text-neutral-600 dark:text-neutral-300",
              ln.blockFirst && "border-t border-black/5 dark:border-white/5",
            )}
          >
            <span className="relative">
              {ln.blockFirst && (
                <button
                  onClick={() => onSetBlock(ln.regionIdx, side, !ln.blockAll)}
                  title="Select whole conflict block"
                  className={cn(
                    "absolute left-1.5 top-1/2 -translate-y-1/2",
                    box(side, ln.blockAll, ln.blockSome),
                  )}
                >
                  {ln.blockAll ? <CheckIcon /> : ln.blockSome ? <DashIcon /> : null}
                </button>
              )}
            </span>
            <span className={NUM}>{ln.no}</span>
            <span className="grid place-items-center">
              {ln.conflict && (
                <button
                  onClick={() => onToggleLine(ln.regionIdx, side, ln.lineIdx)}
                  className={box(side, ln.picked)}
                >
                  {ln.picked ? <CheckIcon /> : null}
                </button>
              )}
            </span>
            <span className="whitespace-pre pl-1 pr-2">
              <Tokens tokens={ln.tokens} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const OUT_ROW = "grid grid-cols-[40px_20px_1fr] items-center font-mono text-[12px] leading-[20px]";

export const SplitConflict = ({
  editor,
  oursSub,
  theirsSub,
  onToggleLine,
  onSetBlock,
  onTakeBlock,
  onSelectAll,
}: {
  editor: LineEditor;
  oursSub: string;
  theirsSub: string;
  onToggleLine: (regionIdx: number, side: Side, lineIdx: number) => void;
  onSetBlock: (regionIdx: number, side: Side, on: boolean) => void;
  onTakeBlock: (regionIdx: number, which: "a" | "b" | "both") => void;
  onSelectAll: (side: Side, on: boolean) => void;
}) => {
  const aRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  // The ordered conflict hunks (by region index) and which remain unresolved.
  // Every hunk shows in the output as a placeholder (when it contributes no
  // picked line) or as removable picked lines, so a single pass over outRows
  // yields the document order and the open set.
  const { order, unresolved } = useMemo(() => {
    const order: number[] = [];
    const unresolved = new Set<number>();
    for (const r of editor.outRows) {
      if (r.kind === "placeholder") {
        if (!order.includes(r.regionIdx)) order.push(r.regionIdx);
        unresolved.add(r.regionIdx);
      } else if (r.removable && !order.includes(r.regionIdx)) {
        order.push(r.regionIdx);
      }
    }
    return { order, unresolved };
  }, [editor.outRows]);
  const total = order.length;

  const reveal = useCallback(
    (i: number, smooth: boolean) => {
      const regionIdx = order[i];
      if (regionIdx == null) return;
      revealRegion([aRef, bRef, outRef], regionIdx, smooth);
    },
    [order],
  );

  // On open (a fresh file mounts this editor) jump to the first still-unresolved
  // conflict so the user lands on work to do rather than the top of the file.
  useEffect(() => {
    if (total === 0) return;
    const firstOpen = order.findIndex((idx) => unresolved.has(idx));
    const start = firstOpen >= 0 ? firstOpen : 0;
    setActive(start);
    const raf = requestAnimationFrame(() => reveal(start, false));
    return () => cancelAnimationFrame(raf);
    // Run once per mounted file; reveal/order are stable for that mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (delta: number) => {
    const next = Math.min(Math.max(active + delta, 0), Math.max(total - 1, 0));
    setActive(next);
    reveal(next, true);
  };

  const navBtn = (enabled: boolean) =>
    cn(
      "grid h-5 w-5 place-items-center rounded border border-black/10 text-neutral-500 dark:border-white/10 dark:text-neutral-300",
      enabled
        ? "hover:bg-black/5 dark:hover:bg-white/5"
        : "cursor-not-allowed opacity-40",
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex min-h-0 flex-[1.1] gap-2">
        <Pane
          side="a"
          title="Current (ours)"
          sub={oursSub}
          rows={editor.aRows}
          all={editor.aAll}
          scrollRef={aRef}
          onToggleLine={onToggleLine}
          onSetBlock={onSetBlock}
          onSelectAll={onSelectAll}
        />
        <Pane
          side="b"
          title="Incoming (theirs)"
          sub={theirsSub}
          rows={editor.bRows}
          all={editor.bAll}
          scrollRef={bRef}
          onToggleLine={onToggleLine}
          onSetBlock={onSetBlock}
          onSelectAll={onSelectAll}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-black/5 dark:border-white/10">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-black/5 px-2.5 dark:border-white/5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 text-neutral-400">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          <span className="text-[11.5px] font-semibold text-neutral-700 dark:text-neutral-200">Output</span>
          <span className="hidden text-[10.5px] text-neutral-400 lg:inline">
            merged result — tick lines from A or B
          </span>
          {total > 0 && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="text-[10.5px] font-medium tabular-nums text-neutral-400">
                conflict {active + 1} of {total}
              </span>
              <button
                onClick={() => go(-1)}
                disabled={active === 0}
                aria-label="Previous conflict"
                className={navBtn(active > 0)}
              >
                <ChevronIcon dir="up" />
              </button>
              <button
                onClick={() => go(1)}
                disabled={active >= total - 1}
                aria-label="Next conflict"
                className={navBtn(active < total - 1)}
              >
                <ChevronIcon dir="down" />
              </button>
            </div>
          )}
        </div>
        <div ref={outRef} className="flex-1 overflow-auto py-1">
          {editor.outRows.map((ln, k) =>
            ln.kind === "placeholder" ? (
              <div
                key={k}
                data-region={ln.regionIdx}
                className="mx-1.5 my-1 flex h-7 items-center justify-between gap-2 rounded-lg border border-dashed border-amber-400/60 bg-amber-50/60 px-2.5 dark:bg-amber-400/[0.06]"
              >
                <span className="truncate whitespace-nowrap text-[11px] text-neutral-400 dark:text-neutral-500">
                  Conflict {ln.conflictNo} — pick lines above
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => onTakeBlock(ln.regionIdx, "a")}
                    className="h-5 rounded bg-[var(--accent-soft)] px-2 text-[10px] font-semibold text-[color:var(--accent)] hover:brightness-95"
                  >
                    All A
                  </button>
                  <button
                    onClick={() => onTakeBlock(ln.regionIdx, "b")}
                    className="h-5 rounded bg-[#3b7ff5]/12 px-2 text-[10px] font-semibold text-[#3b7ff5] hover:brightness-95"
                  >
                    All B
                  </button>
                  <button
                    onClick={() => onTakeBlock(ln.regionIdx, "both")}
                    className="h-5 rounded border border-black/10 px-2 text-[10px] font-semibold text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
                  >
                    Both
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={k}
                data-region={ln.removable ? ln.regionIdx : undefined}
                className={cn(OUT_ROW, ln.removable && tint(ln.side))}
              >
                <span className={NUM}>{ln.no}</span>
                <span className="grid place-items-center">
                  {ln.removable && (
                    <button
                      onClick={() => onToggleLine(ln.regionIdx, ln.side, ln.lineIdx)}
                      title="Remove from output"
                      className={box(ln.side, true)}
                    >
                      <CheckIcon />
                    </button>
                  )}
                </span>
                <span className="whitespace-pre pl-1 pr-2">
                  <Tokens tokens={ln.tokens} />
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
};
