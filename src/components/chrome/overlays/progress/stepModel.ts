// Shared, pure step-checklist model (no React, no IPC) for live progress dialogs
// — the reusable core behind the GL-105 hand-off dialog, the GL-106 GitHub
// sign-in, and the GL-107 delete-branch-and-worktree flow. Each consumer owns its
// own event→row mapping (`STEP_EVENTS`) and labels; this module only derives a
// row's status from how far the backend has progressed.

export type StepStatus = "pending" | "active" | "done";

/** Row index a backend step id belongs to, or -1 for an unknown id (a newer
 * backend emitting a step this build doesn't know must not break the list). */
export function stepIndexIn(events: readonly (readonly string[])[], step: string): number {
  return events.findIndex((ids) => ids.includes(step));
}

/** Status of row `index` given the furthest row reached so far. Rows before the
 * reached one are done (this folds skipped steps in); the reached row is active;
 * `finished` (the IPC promise resolved) completes everything. */
export function stepStatus(index: number, reached: number, finished: boolean): StepStatus {
  if (finished || index < reached) return "done";
  return index === reached ? "active" : "pending";
}
