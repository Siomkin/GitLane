// Pure view-model for the stack card. No React, no IPC — the mapping from
// GitHub's bottom-to-top `PrStack` to the rows the card paints top-to-bottom.

import type { PrStack, PrStackEntry } from "@/lib/api";

/** Per-layer readiness, in the card's own vocabulary. */
export type StackRowStatus = "merged" | "closed" | "draft" | "conflicts" | "ready";

export interface StackRow {
  entry: PrStackEntry;
  status: StackRowStatus;
  /** True for the PR whose detail is on screen — the highlighted row. */
  isCurrent: boolean;
}

export interface StackView {
  /** Top of the stack first, matching how GitHub draws it. */
  rows: StackRow[];
  baseRef: string;
  /** Layers below the viewed PR that a stack merge would also land. */
  belowCount: number;
  /** Layers a "merge stack" would land: the viewed PR plus everything below. */
  mergeCount: number;
  /** True when a layer *below* the viewed PR can't merge (draft or conflicting).
   * A stack merge is all-or-nothing, so one blocked layer below sinks the whole
   * operation — offering the button anyway would only produce a server-side
   * failure. Layers *above* are irrelevant: they aren't part of this merge. */
  belowBlocked: boolean;
  /** True when `size` exceeds the layers we actually received. */
  partial: boolean;
}

const STATUS_LABEL: Record<StackRowStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  conflicts: "Conflicts",
  ready: "Ready",
};

export const statusLabel = (status: StackRowStatus): string => STATUS_LABEL[status];

function rowStatus(entry: PrStackEntry): StackRowStatus {
  if (entry.state === "MERGED") return "merged";
  if (entry.state === "CLOSED") return "closed";
  if (entry.isDraft) return "draft";
  // Only a definitive verdict demotes a layer — GitHub reports UNKNOWN (or "")
  // until it finishes computing mergeability, and flashing "Conflicts" during
  // that window would be a lie.
  if (entry.mergeable === "CONFLICTING") return "conflicts";
  return "ready";
}

/**
 * Build the card's rows for the PR numbered `currentNumber`.
 *
 * The backend hands entries bottom-to-top (position 1 targets the base branch);
 * the card renders top-first, so this reverses once, here, rather than in JSX.
 */
export function stackView(stack: PrStack, currentNumber: number): StackView {
  const rows: StackRow[] = stack.entries
    .map((entry) => ({
      entry,
      status: rowStatus(entry),
      isCurrent: entry.number === currentNumber,
    }))
    .reverse();
  // Count from the entries rather than `position`, so a stack whose layers were
  // partially filtered (an invisible PR) still describes what it actually shows.
  const currentIndex = rows.findIndex((row) => row.isCurrent);
  // Rows after the current one in this top-first list are the layers below it.
  const belowCount = currentIndex < 0 ? 0 : rows.length - currentIndex - 1;
  // Everything after the current row in this top-first list is below it.
  const below = currentIndex < 0 ? [] : rows.slice(currentIndex + 1);
  return {
    rows,
    baseRef: stack.baseRef,
    belowCount,
    mergeCount: currentIndex < 0 ? 0 : belowCount + 1,
    // An already-merged or closed layer below is fine — the stack merge only
    // lands the *unmerged* ones. Draft and conflicting are the real blockers.
    belowBlocked: below.some((row) => row.status === "draft" || row.status === "conflicts"),
    partial: stack.size > stack.entries.length,
  };
}
