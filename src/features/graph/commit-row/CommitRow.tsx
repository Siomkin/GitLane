import { memo, type MouseEvent as ReactMouseEvent } from "react";
import type { CommitNode } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { focusRing } from "@/lib/ui";
import { useRepo } from "../../../store/repo";
import { selectionForContextMenu } from "../../../store/selection";
import { useUi } from "../../../store/ui";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { formatDate } from "../historyRowShared";
import { RefCluster } from "./RefCluster";

export const CommitRow = memo(function CommitRow({
  commit,
  currentBranch,
  selected,
  focused,
  flash,
  dimmed,
  query,
  top,
  rowHeight,
  graphColW,
  onSelect,
}: {
  commit: CommitNode;
  currentBranch: string | null;
  selected: boolean;
  focused: boolean;
  flash: boolean;
  /** Search/kind filter is active and this commit is not a match — fade it so
   * the matches stand out (the row stays in place, never removed). */
  dimmed: boolean;
  /** The active search query, used to mark the matched substring in the summary
   * (no-op under 3 chars). */
  query: string;
  top: number;
  rowHeight: number;
  graphColW: number;
  onSelect: (id: string, mods: { shift?: boolean; additive?: boolean }) => void;
}) {
  const openCommitMenu = useUi((state) => state.openCommitMenu);
  const draggingFrom = useUi((state) => state.draggingFrom);
  const clearDrag = useUi((state) => state.clearDrag);

  const select = (e: ReactMouseEvent<HTMLDivElement>) =>
    onSelect(commit.id, { shift: e.shiftKey, additive: e.metaKey || e.ctrlKey });

  // A commit is a target only for a local branch: remote-tracking refs are
  // useful sources for local-branch operations, but are never writable.
  const isDropTarget = draggingFrom?.kind === "local";

  // Not a <button>: the expanded ref cluster nests its own buttons (split/combine
  // chevron), and a button-in-button is invalid HTML that breaks keyboard/click
  // dispatch. A role="button" div keeps the row selectable by mouse and keyboard
  // while letting interactive children render legally.
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "absolute left-0 flex w-full cursor-pointer items-stretch bg-transparent text-left text-neutral-700 transition-opacity duration-150 hover:bg-black/[0.025] dark:text-neutral-200 dark:hover:bg-white/[0.025]",
        focusRing,
        selected && "bg-[var(--accent-soft)]",
        focused && "bg-[var(--accent-soft)]",
        flash && "gp-reveal-flash",
        // A selected/focused row stays at full strength even when it doesn't
        // match, so the active selection never disappears into the dimmed list;
        // hover and keyboard focus also restore a dimmed row for inspection.
        dimmed && !selected && !focused && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(commit.id, { shift: e.shiftKey, additive: e.metaKey || e.ctrlKey });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const currentSelection = useRepo.getState().selectedCommits;
        const selection = selectionForContextMenu(currentSelection, commit.id);
        if (!currentSelection.includes(commit.id)) {
          onSelect(commit.id, {});
        }
        openCommitMenu({
          x: e.clientX,
          y: e.clientY,
          sha: commit.id,
          shortSha: commit.shortId,
          selection,
        });
      }}
      onDragOver={(e) => isDropTarget && e.preventDefault()}
      onDrop={(e) => {
        if (draggingFrom?.kind !== "local") return;
        e.preventDefault();
        useUi.getState().openActionMenu({
          x: e.clientX,
          y: e.clientY,
          from: draggingFrom,
          to: { kind: "commit", sha: commit.id, shortSha: commit.shortId },
        });
        clearDrag();
      }}
    >
      <div
        className={cn(
          "absolute bottom-0 left-0 top-0 w-[3px]",
          focused ? "bg-[var(--accent)]" : selected && "bg-[color:var(--accent)]/50",
        )}
      />
      <div className="shrink-0" style={{ width: graphColW }} />
      <div className="z-10 flex min-w-0 flex-1 items-center gap-1.5 px-3.5">
        <RefCluster refs={commit.refs} currentBranch={currentBranch} commitId={commit.id} />
        <span className="min-w-0 truncate text-[13px] text-neutral-700 dark:text-neutral-200">
          <HighlightMatch text={commit.summary} query={query} />
        </span>
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end whitespace-nowrap pl-3 pr-4 font-mono text-xs text-neutral-400">
        {formatDate(commit.timestamp)}
      </div>
    </div>
  );
});
