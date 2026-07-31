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
  /** Layers below the viewed PR a stack merge would land — **unmerged only**.
   * An already-merged or closed layer below is not landed again, so counting it
   * would overstate what the button does. */
  belowCount: number;
  /** Layers a "merge stack" would land: the viewed PR plus `belowCount`. */
  mergeCount: number;
  /** Why a stack merge can't be offered, or `null` when it can.
   *
   * - `"layer"` — a layer in the merge set is draft, conflicting, or blocked.
   * - `"partial"` — the stack has more layers than we received, so an unseen
   *   one could be blocked and we cannot honestly claim the merge would work.
   *
   * Distinct reasons because they need different copy: "some PRs cannot be
   * merged" is wrong when the truth is "we can't see all of them". */
  blockReason: "layer" | "partial" | null;
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
  // The merge set: the current row plus everything below it in this top-first
  // list. These are exactly the layers a stack merge from here would land.
  const mergeSet = currentIndex < 0 ? [] : rows.slice(currentIndex);
  // Only unmerged layers below are actually landed, so only those are counted —
  // an already-merged or closed one would inflate every "will also merge N"
  // string and the button's badge.
  const belowCount = mergeSet.slice(1).filter((row) => isUnmerged(row)).length;
  const partial = stack.size > stack.entries.length;
  // Draft, conflicts, and blocked stop the merge; an already-merged or closed
  // layer does not, because it is not landed again.
  const layerBlocked = mergeSet.some(
    (row) =>
      isUnmerged(row) &&
      (row.status === "draft" || row.status === "conflicts" || row.status === "blocked"),
  );
  return {
    rows,
    baseRef: stack.baseRef,
    belowCount,
    mergeCount: currentIndex < 0 ? 0 : belowCount + 1,
    // A partial stack hides layers we never inspected, and the merge is
    // all-or-nothing — an unseen blocked layer would sink it. Refuse rather
    // than promise an outcome we cannot see.
    blockReason: layerBlocked ? "layer" : partial ? "partial" : null,
    partial,
  };
}

/** A layer a stack merge would actually land (merged/closed ones are not). */
const isUnmerged = (row: StackRow): boolean =>
  row.status !== "merged" && row.status !== "closed";
