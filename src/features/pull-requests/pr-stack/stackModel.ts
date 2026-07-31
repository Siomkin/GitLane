// Pure view-model for the stack card. No React, no IPC — the mapping from
// GitHub's bottom-to-top `PrStack` to the rows the card paints top-to-bottom.

import type { PrStack, PrStackEntry } from "@/lib/api";

/** Per-layer readiness, in the card's own vocabulary. `blocked` is GitHub's
 * "Not ready": the layer has no conflicts but something else — a required check
 * or review, or a base it's behind — stops it merging right now. */
export type StackRowStatus = "merged" | "closed" | "draft" | "conflicts" | "blocked" | "ready";

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
  /** True when any layer a stack merge from here would land — the viewed PR
   * *and* everything below it — cannot currently merge. The operation is
   * all-or-nothing, so one such layer sinks it; offering the button anyway
   * would only produce a server-side failure. Layers *above* are irrelevant:
   * they are not part of this merge. */
  mergeBlocked: boolean;
  /** True when `size` exceeds the layers we actually received. */
  partial: boolean;
}

const STATUS_LABEL: Record<StackRowStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  conflicts: "Conflicts",
  blocked: "Not ready",
  ready: "Ready",
};

export const statusLabel = (status: StackRowStatus): string => STATUS_LABEL[status];

function rowStatus(entry: PrStackEntry): StackRowStatus {
  if (entry.state === "MERGED") return "merged";
  if (entry.state === "CLOSED") return "closed";
  if (entry.isDraft || entry.mergeState === "DRAFT") return "draft";
  // Conflicts first, from either signal — `mergeable` is the dedicated verdict
  // and DIRTY is the same fact in `mergeStateStatus`.
  if (entry.mergeable === "CONFLICTING" || entry.mergeState === "DIRTY") return "conflicts";
  // `mergeable` covers conflicts ONLY. A layer held by a required check or
  // review still reports MERGEABLE, so readiness has to come from
  // `mergeStateStatus` — this is what GitHub's own card shows as "Not ready".
  if (entry.mergeState === "BLOCKED" || entry.mergeState === "BEHIND") return "blocked";
  // CLEAN and HAS_HOOKS merge outright. UNSTABLE means only non-required checks
  // are failing, which GitHub still allows. UNKNOWN/"" are indefinite — GitHub
  // hasn't computed it yet, and guessing "blocked" there would be as wrong as
  // guessing "conflicts" before mergeability resolves.
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
  // The merge set: the current row plus everything below it in this top-first
  // list. These are exactly the layers a stack merge from here would land.
  const mergeSet = currentIndex < 0 ? [] : rows.slice(currentIndex);
  return {
    rows,
    baseRef: stack.baseRef,
    belowCount,
    mergeCount: currentIndex < 0 ? 0 : belowCount + 1,
    // An already-merged or closed layer is fine — the stack merge only lands the
    // *unmerged* ones. Draft, conflicts, and blocked are the real stoppers.
    mergeBlocked: mergeSet.some(
      (row) => row.status === "draft" || row.status === "conflicts" || row.status === "blocked",
    ),
    partial: stack.size > stack.entries.length,
  };
}
