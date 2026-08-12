// Keyboard navigation for the commit list (GL-346). Without this the arrow keys
// fall through to the browser, which scrolls the virtual list by a line and
// leaves the selection behind — the list appears to jump several rows while the
// selected commit never moves.
//
// Selection, not focus, is what moves: rows unmount as they scroll out of the
// virtual window, so DOM focus lives on the scroll container and the highlighted
// row is derived from the store.

import type { KeyboardEvent, RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useRepo } from "@/store/repo";
import { WIP_SELECTION_ID, workingRange } from "@/store/selection";
import { workingUnionCompare } from "@/features/changes/merged-selection/mergedSelection";
import { useUi } from "@/store/ui";
import type { HistoryRow } from "./historyRows";

/** The oid a row selects, or null for rows that are context only — stash
 *  context commits, the unanchored-stash cluster, and the load-more row. */
function rowOid(row: HistoryRow | undefined): string | null {
  if (row?.kind === "commit") return row.commit.id;
  if (row?.kind === "stash") return row.stash.oid;
  return null;
}

function isSelectable(row: HistoryRow | undefined): boolean {
  return row?.kind === "wip" || rowOid(row) !== null;
}

/** Builds the commit list's keydown handler. A plain factory, not a hook — it
 *  holds no state and reads the stores at event time. */
export function historyKeyDownHandler(
  rows: HistoryRow[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    // ⌘/Ctrl chords belong to the global shortcuts (⌘↵ reviews the selection);
    // Alt is left for the browser.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const { wipSelected, selectedCommit, selectionDiff, selectCommitMulti, selectWip, openCompare } =
      useRepo.getState();
    // Commits + WIP is its own mode: the pick is a range ending at the working
    // tree, so it opens that comparison and its cursor sits on the focus commit
    // rather than on the WIP row (which is only one end of the range).
    const workingBase = selectionDiff?.workingBase ?? null;

    if (event.key === "Enter") {
      // Enter opens what's selected. Only the WIP row (alone or as part of a
      // range) has an "open" — a commit's review is ⌘↵ — so anything else is
      // left to the focused row's own button.
      if (workingBase) {
        event.preventDefault();
        const spanned = workingRange(useRepo.getState().graph, selectionDiff?.commits ?? [])?.spanned ?? 0;
        void openCompare(workingUnionCompare(workingBase, spanned));
        return;
      }
      if (!wipSelected) return;
      event.preventDefault();
      useUi.getState().openChangesView(true);
      return;
    }
    if (step === 0) return;
    // The arrows belong to the list even where they can't move — at a boundary,
    // or when a shift-extension stops short. Letting the browser scroll instead
    // is exactly the behaviour this replaced.
    event.preventDefault();

    const current = rows.findIndex((row) =>
      wipSelected && !workingBase
        ? row.kind === "wip"
        : rowOid(row) !== null && rowOid(row) === selectedCommit,
    );
    let next = current;
    if (current < 0) {
      // Nothing selected yet: enter the list from the end the key points at.
      next = step > 0 ? -1 : rows.length;
    }
    do {
      next += step;
    } while (next >= 0 && next < rows.length && !isSelectable(rows[next]));
    if (next < 0 || next >= rows.length) return; // Stop at the ends; no wrapping.

    const row = rows[next];
    // Shift onto the WIP row extends the pick over it, exactly like shift-click:
    // the uncommitted changes join the merged diff. A plain arrow selects it
    // alone, matching a plain click.
    if (row.kind === "wip" && event.shiftKey) void selectCommitMulti(WIP_SELECTION_ID, { shift: true });
    else if (row.kind === "wip") selectWip();
    else {
      const oid = rowOid(row);
      if (!oid) return;
      // Shift extends the range, matching shift-click.
      selectCommitMulti(oid, { shift: event.shiftKey });
    }
    virtualizer.scrollToIndex(next, { align: "auto" });
    // The row that had focus may be virtualized away by the scroll; keep the
    // keyboard alive by parking focus on the container itself.
    scrollRef.current?.focus();
  };
}
