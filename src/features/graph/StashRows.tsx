import type { MouseEvent as ReactMouseEvent } from "react";
import type { StashContextCommit, StashEntry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi } from "@/store/ui";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { StashIcon } from "@/components/ui/icons";
import { formatDate } from "./historyRowShared";

/** A stash anchored next to its base commit. Click selects it (the inspector
 * shows its file list); right-click opens apply/pop/drop. */
export function StashRow({
  stash,
  top,
  rowHeight,
  graphColW,
  nodeX,
  selected,
  focused,
  flash,
  dimmed,
  onSelect,
}: {
  stash: StashEntry;
  top: number;
  rowHeight: number;
  graphColW: number;
  nodeX: number;
  selected: boolean;
  focused: boolean;
  flash: boolean;
  /** A commit search is active — a stash is never a commit match, so fade it
   * with the rest of the non-matching list. */
  dimmed: boolean;
  onSelect: (id: string, mods: { shift?: boolean; additive?: boolean }) => void;
}) {
  const openStashMenu = useUi((state) => state.openStashMenu);
  const select = (e: ReactMouseEvent<HTMLButtonElement>) =>
    onSelect(stash.oid, { shift: e.shiftKey, additive: e.metaKey || e.ctrlKey });

  return (
    <button type="button"
      className={cn(
        "group absolute left-0 flex w-full cursor-pointer select-none items-stretch text-left transition-opacity hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
        focusRing,
        selected && "bg-[var(--accent-soft)]",
        focused && "bg-[var(--accent-soft)]",
        flash && "gp-reveal-flash",
        dimmed && !selected && !focused && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Same as the commit rows: only ⌘/Ctrl+Enter goes to the Review
        // shortcut; ⌘/Ctrl+Space still additive-selects.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        onSelect(stash.oid, { shift: e.shiftKey, additive: e.metaKey || e.ctrlKey });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openStashMenu({ x: e.clientX, y: e.clientY, oid: stash.oid, message: stash.message });
      }}
    >
      <div
        className={cn(
          "absolute bottom-0 left-0 top-0 w-[3px]",
          focused ? "bg-[var(--accent)]" : selected && "bg-[color:var(--accent)]/50",
        )}
      />
      <div className="relative z-10 shrink-0" style={{ width: graphColW }}>
        <StashGraphMarker tone="active" left={nodeX} />
      </div>
      <div className="z-10 flex min-w-0 flex-1 items-center gap-2.5 px-3.5">
        <span className="flex h-[22px] items-center whitespace-nowrap rounded-md bg-amber-100 px-1.5 font-mono text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
          stash@&#123;{stash.index}&#125;
        </span>
        <span className="min-w-0 truncate text-[13px] text-neutral-500 dark:text-neutral-400">{stash.message}</span>
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end pl-3 pr-4 text-xs text-neutral-400">stash</div>
    </button>
  );
}

/** A collapsed pointer to stashes whose base is outside the loaded history;
 * clicking opens the navigator where they're listed in full. */
export function StashFallbackRow({
  count,
  top,
  rowHeight,
  graphColW,
  nodeX,
  dimmed,
}: {
  count: number;
  top: number;
  rowHeight: number;
  graphColW: number;
  nodeX: number;
  dimmed: boolean;
}) {
  const openNav = useUi((state) => state.openNav);

  return (
    <button type="button"
      className={cn(
        "group absolute left-0 flex w-full cursor-pointer select-none items-stretch text-left transition-opacity hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
        focusRing,
        dimmed && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={openNav}
    >
      <div className="relative z-10 shrink-0" style={{ width: graphColW }}>
        <StashGraphMarker tone="muted" left={nodeX} />
      </div>
      <div className="z-10 flex min-w-0 flex-1 items-center gap-2.5 px-3.5">
        <span className="flex h-[22px] items-center whitespace-nowrap rounded-md bg-neutral-100 px-1.5 font-mono text-[11px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
          {count}
        </span>
        <span className="min-w-0 truncate text-[13px] text-neutral-500 dark:text-neutral-400">
          {count === 1 ? "stash outside loaded history" : "stashes outside loaded history"}
        </span>
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end pl-3 pr-4 text-xs text-neutral-400">
        stashes
      </div>
    </button>
  );
}

function StashGraphMarker({ tone, left }: { tone: "active" | "muted"; left: number }) {
  return (
    <span
      data-testid="stash-graph-marker"
      className={cn(
        "absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-dashed bg-white shadow-sm dark:bg-neutral-800",
        tone === "active"
          ? "border-amber-500 text-amber-500 dark:border-amber-300 dark:text-amber-300"
          : "border-neutral-400 text-neutral-400 dark:border-neutral-500 dark:text-neutral-500",
      )}
      style={{ left }}
      aria-hidden="true"
    >
      <StashIcon className="h-3.5 w-3.5" />
    </span>
  );
}

/** One commit of a dangling stash's bounded first-parent context chain, shown
 * between the stash and the commit where it rejoins the visible graph. */
export function StashContextRow({
  commit,
  top,
  rowHeight,
  graphColW,
  nodeX,
  dimmed,
}: {
  commit: StashContextCommit;
  top: number;
  rowHeight: number;
  graphColW: number;
  nodeX: number;
  dimmed: boolean;
}) {
  const openStackedReview = useUi((state) => state.openStackedReview);

  return (
    <button type="button"
      className={cn(
        "group absolute left-0 flex w-full cursor-pointer select-none items-stretch text-left transition-opacity hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
        focusRing,
        dimmed && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={() => openStackedReview(commit.id, commit.summary)}
    >
      <div className="relative z-10 shrink-0" style={{ width: graphColW }}>
        <span
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-amber-500 shadow-sm dark:border-neutral-800 dark:bg-amber-300"
          style={{ left: nodeX }}
          aria-hidden="true"
        />
      </div>
      <div className="z-10 flex min-w-0 flex-1 items-center gap-1.5 px-3.5">
        <span className="min-w-0 truncate text-[13px] text-neutral-600 dark:text-neutral-300">
          <HighlightMatch text={commit.summary} query="" />
        </span>
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end whitespace-nowrap pl-3 pr-4 font-mono text-xs text-neutral-400">
        {formatDate(commit.timestamp)}
      </div>
    </button>
  );
}
