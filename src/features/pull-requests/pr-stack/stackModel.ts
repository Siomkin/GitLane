// Pure view-model for the stack card. No React, no IPC — the mapping from
// GitHub's bottom-to-top `PrStack` to the rows the card paints top-to-bottom.

import type { PrStack, PrStackEntry } from "@/lib/api";

/** Per-layer readiness, in the card's own vocabulary. `blocked` is GitHub's
 * "Not ready": the layer has no conflicts but something else — a required check
 * or review, or a base it's behind — stops it merging right now. */
export type StackRowStatus =
  | "merged"
  | "closed"
  | "draft"
  | "conflicts"
  | "blocked"
  | "blockedDownstack"
  | "merging"
  | "ready";

export interface StackRow {
  entry: PrStackEntry;
  status: StackRowStatus;
  /** For `blockedDownstack`: the lowest unmergeable PR between this layer and
   * the trunk — the one that must be fixed first. "Blocked" without a target
   * isn't actionable, so the badge names it. */
  blockedBy?: number;
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
  /** False when the viewed PR isn't among the layers we received — its own row
   * was filtered out, so this is somebody else's stack and nothing here can
   * describe a merge from it. */
  currentFound: boolean;
  /** Why a stack merge can't be offered, or `null` when it can.
   *
   * - `"layer"` — a layer in the merge set is draft, conflicting, or blocked.
   * - `"partial"` — the stack has more layers than we received, so an unseen
   *   one could be blocked and we cannot honestly claim the merge would work.
   * Distinct reasons because they need different copy: "some PRs cannot be
   * merged" is wrong when the truth is "we can't see all of them".
   *
   * Base-branch rules (a required approval, say) are deliberately NOT a reason:
   * GitHub's own stack UI offers the merge and lets the server refuse, and
   * `merge_stack` surfaces that refusal verbatim. Blocking here would disable
   * the button on every unapproved stack, which is not what GitHub does. */
  blockReason: "layer" | "partial" | null;
  /** True when `size` exceeds the layers we actually received. */
  partial: boolean;
}

export const STATUS_LABEL: Record<StackRowStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  conflicts: "Conflicts",
  blocked: "Not ready",
  blockedDownstack: "Blocked downstack",
  merging: "Merging",
  ready: "Ready",
};

function rowStatus(entry: PrStackEntry): StackRowStatus {
  if (entry.state === "MERGED") return "merged";
  if (entry.state === "CLOSED") return "closed";
  if (entry.isDraft) return "draft";
  if (entry.mergeable === "CONFLICTING") return "conflicts";
  // Readiness is the head commit's check rollup — what GitHub's own stack card
  // shows. Anything not yet green is "Not ready"; `""` means the repo runs no
  // checks at all, which is nothing failing rather than nothing known.
  if (entry.checks !== "SUCCESS" && entry.checks !== "") return "blocked";
  return "ready";
}

/**
 * Build the card's rows for the PR numbered `currentNumber`.
 *
 * The backend hands entries bottom-to-top (position 1 targets the base branch);
 * the card renders top-first, so this reverses once, here, rather than in JSX.
 *
 * `merging` is true while this PR's stack merge is in flight. GitHub animates
 * its own card bottom-up because its server tells it which layer is landing;
 * our poll reports one status for the whole operation, so every layer that will
 * actually land is marked at once — the honest rendering of what we know.
 */
export function stackView(stack: PrStack, currentNumber: number, merging = false): StackView {
  // Walk bottom-to-top (the backend's order) so each layer knows whether an
  // ancestor between it and the trunk is unmergeable. GitHub's per-PR
  // `mergeable`/checks don't carry this — a green layer above a red one merges
  // cleanly into its own base — so blocked-downstack is derived here, from the
  // chain. The lowest blocker is the one named: it's what must be fixed first,
  // and every layer above it is blocked by that same fix.
  let blockingNum: number | null = null;
  const rows: StackRow[] = stack.entries
    .map((entry): StackRow => {
      const own = rowStatus(entry);
      const isCurrent = entry.number === currentNumber;
      if (own === "ready" && blockingNum !== null) {
        return { entry, status: "blockedDownstack", blockedBy: blockingNum, isCurrent };
      }
      // Merged/closed layers below don't block — they're not landed again.
      if (blockingNum === null && (own === "draft" || own === "conflicts" || own === "blocked")) {
        blockingNum = entry.number;
      }
      return { entry, status: own, isCurrent };
    })
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
  const currentFound = currentIndex >= 0;
  // Only the layers the merge actually lands turn "Merging" — an already-merged
  // or closed layer below is not landed again, so pretending it is in flight
  // would be a lie on screen. Copied rather than mutated in place: every field
  // above is derived from `rows`, and rewriting them afterwards is the kind of
  // ordering dependency that breaks silently when someone moves a line.
  const shown =
    merging && currentFound
      ? rows.map((row, i) =>
          i >= currentIndex && isUnmerged(row) ? { ...row, status: "merging" as const } : row,
        )
      : rows;
  return {
    rows: shown,
    baseRef: stack.baseRef,
    belowCount,
    mergeCount: currentFound ? belowCount + 1 : 0,
    currentFound,
    // Ordered by how actionable the reason is: a genuinely blocked layer tells
    // the user what to fix; the others only explain why we won't promise.
    // A partial stack hides layers we never inspected, and the merge is
    // all-or-nothing — an unseen blocked layer would sink it.
    blockReason: layerBlocked ? "layer" : partial ? "partial" : null,
    partial,
  };
}

/** A layer a stack merge would actually land (merged/closed ones are not). */
const isUnmerged = (row: StackRow): boolean =>
  row.status !== "merged" && row.status !== "closed";
