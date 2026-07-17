// The remove-detached dialog's per-worktree checklist model. Unlike the hand-off
// / delete-worktree flows (one op emitting backend step events), the sweep loop
// is frontend-driven — one removal per target — so each target is its own row
// and its status comes from the outcome the loop recorded for it, not a backend
// `*-progress` event. Pure (no React, no IPC): the run hook owns the loop.

import type { WorktreeInfo } from "@/lib/api";
import { worktreeName } from "@/lib/worktrees";
import type { StepStatus } from "@/components/chrome/overlays/progress";

/** Outcome the sweep recorded for one target, in order. */
export type RemoveOutcome = "ok" | "fail";

/** Checklist labels, one per target, in sweep order: each worktree's
 * distinguishing directory name (disambiguated within the sweep set so
 * codex-style siblings that share a leaf still read differently). */
export function removeDetachedStepLabels(targets: WorktreeInfo[]): string[] {
  return targets.map((wt) => worktreeName(wt, targets));
}

/** Status of row `index` given the outcomes recorded so far. A row with a
 * recorded outcome is done or failed; while the sweep runs the next unrecorded
 * row is active; the rest pend. */
export function removeDetachedStepStatus(
  index: number,
  outcomes: readonly RemoveOutcome[],
  running: boolean,
): StepStatus {
  if (index < outcomes.length) return outcomes[index] === "fail" ? "failed" : "done";
  if (running && index === outcomes.length) return "active";
  return "pending";
}

/** One-line summary of a finished sweep: how many were removed, and the first
 * failure (verbatim) when some couldn't be. */
export function removeDetachedSummary(
  outcomes: readonly RemoveOutcome[],
  total: number,
  firstError: string | null,
): string {
  const removed = outcomes.filter((o) => o === "ok").length;
  const noun = total === 1 ? "detached worktree" : "detached worktrees";
  if (!firstError) return `Removed ${removed} ${noun}`;
  return `Removed ${removed} of ${total} ${noun} — ${firstError}`;
}
