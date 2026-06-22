import { memo, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { CommitNode, RefLabel } from "../../lib/api";
import { buildClusterItems } from "./refCluster";
import { cn } from "../../lib/cn";
import { focusRing } from "@/lib/ui";
import { useRepo } from "../../store/repo";
import { selectionForContextMenu } from "../../store/selection";
import { useUi } from "../../store/ui";
import { useBranchRefDrag } from "../../hooks/useBranchRefDrag";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { formatDate } from "./historyRowShared";

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
        <RefCluster refs={commit.refs} currentBranch={currentBranch} />
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

/** A commit's refs rendered inline as pills before the message. A local branch
 * and the remote-tracking ref(s) of the same name collapse into one pill (saved
 * width for the common in-sync case); clicking it splits them back into the
 * individual RefPills so a specific ref can be dragged / right-clicked. */
function RefCluster({ refs, currentBranch }: { refs: RefLabel[]; currentBranch: string | null }) {
  const [expandedBase, setExpandedBase] = useState<string | null>(null);
  const items = useMemo(() => buildClusterItems(refs, currentBranch), [refs, currentBranch]);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((it) =>
        it.type === "group" ? (
          <CombinedRefPill
            key={`group:${it.base}`}
            base={it.base}
            local={it.local}
            remotes={it.remotes}
            current={it.base === currentBranch}
            expanded={expandedBase === it.base}
            onToggle={() => setExpandedBase((cur) => (cur === it.base ? null : it.base))}
          />
        ) : (
          <RefPill
            key={`${it.ref.kind}:${it.ref.name}`}
            refLabel={it.ref}
            current={it.ref.name === currentBranch}
          />
        ),
      )}
    </>
  );
}

function RefPill({ refLabel, current }: { refLabel: RefLabel; current: boolean }) {
  const openContextMenu = useUi((state) => state.openContextMenu);
  const checkoutBranch = useRepo((state) => state.checkoutBranch);
  const draggable = refLabel.kind === "branch" || refLabel.kind === "remote";
  const name = refLabel.name;
  // The pill is nested in a droppable commit row, so stop drag events bubbling.
  const { isDropTarget, dndProps } = useBranchRefDrag(
    name,
    draggable
      ? {
          draggable: true,
          kind: refLabel.kind === "branch" ? "local" : "remote",
          // Local branches and remote-tracking refs are both drop targets:
          // dropping onto a remote ref moves the dragged local branch onto it
          // (e.g. fast-forward develop → origin/develop).
          droppable: true,
          stopPropagation: true,
        }
      : { draggable: false, stopPropagation: true },
  );

  const base =
    "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px]";
  const style = current
    ? "pl-1 pr-2 bg-[var(--accent)] text-white shadow-sm cursor-grab active:cursor-grabbing"
    : refLabel.kind === "tag"
      ? "pl-1.5 pr-2 bg-amber-50 dark:bg-amber-400/10 border border-amber-300/70 dark:border-amber-400/25 text-amber-700 dark:text-amber-300"
      : refLabel.kind === "remote"
        ? "pl-1.5 pr-2 bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.06] dark:border-white/[0.06] text-neutral-500 dark:text-neutral-400 cursor-grab active:cursor-grabbing"
        : "pl-1.5 pr-2 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm cursor-grab active:cursor-grabbing";

  const icon = current ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : refLabel.kind === "tag" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  ) : refLabel.kind === "remote" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0 text-neutral-400">
      <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  );

  return (
    <span
      {...dndProps}
      className={cn(base, style)}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (!draggable) return;
        e.stopPropagation();
        void checkoutBranch(name).catch((err) =>
          useUi.getState().showToast(String(err), "error"),
        );
      }}
      onContextMenu={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent: current });
      }}
    >
      {icon}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A local branch + its in-sync remote ref(s) shown as one pill. Collapsed it
 * acts as the local branch (drag source, right-click menu); a single click
 * splits it into the individual RefPills — each of which already owns the full
 * drag / checkout / context-menu behaviour. A leading chevron recombines them. */
function CombinedRefPill({
  base,
  local,
  remotes,
  current,
  expanded,
  onToggle,
}: {
  base: string;
  local: RefLabel;
  remotes: RefLabel[];
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const openContextMenu = useUi((state) => state.openContextMenu);
  // Collapsed, the pill stands in for the local branch (the usual drag/menu
  // target); the remote ref is reachable by splitting.
  const { isDropTarget, dndProps } = useBranchRefDrag(local.name, {
    draggable: true,
    kind: "local",
    droppable: true,
    stopPropagation: true,
  });

  if (expanded) {
    return (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title="Combine local + remote"
          className="grid h-[22px] w-[18px] shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <RefPill refLabel={local} current={current} />
        {remotes.map((r) => (
          <RefPill key={r.name} refLabel={r} current={false} />
        ))}
      </>
    );
  }

  const cls =
    "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[240px] cursor-grab active:cursor-grabbing";
  const style = current
    ? "pl-1 pr-1 bg-[var(--accent)] text-white shadow-sm"
    : "pl-1.5 pr-1 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm";
  const remoteLabel = `${remotes.length} remote${remotes.length > 1 ? "s" : ""}`;

  return (
    <span
      {...dndProps}
      className={cn(cls, style)}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      title={`${local.name} — local + ${remoteLabel} in sync (click to split)`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, branch: local.name, isCurrent: current });
      }}
    >
      {current ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0 text-neutral-400">
          <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
        </svg>
      )}
      <span className="truncate">{base}</span>
      <span
        aria-label={remoteLabel}
        className={cn(
          "ml-0.5 flex items-center gap-0.5 rounded px-1 py-0.5",
          current ? "bg-white/20 text-white" : "bg-black/[0.05] text-neutral-400 dark:bg-white/10",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-2.5 w-2.5 shrink-0">
          <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
        </svg>
        {remotes.length > 1 && (
          <span className="text-[9px] font-semibold leading-none">{remotes.length}</span>
        )}
      </span>
    </span>
  );
}
