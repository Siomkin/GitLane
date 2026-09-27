// Shared, pure step-checklist model (no React, no IPC) for live progress dialogs
// — the reusable core behind the GL-105 hand-off dialog, the GL-106 GitHub
// sign-in, and the GL-107 delete-branch-and-worktree flow. Each consumer owns its
// own event→row mapping (`STEP_EVENTS`) and labels; this module only derives a
// row's status from how far the backend has progressed.

export type StepStatus = "pending" | "active" | "done" | "failed";

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

/** Label for device-flow checklist row `index` (copy code → open browser →
 * authorize → account added), phrased for its state so a spinning row reads as
 * in-progress and a checked row as completed. `host` names the target.
 * Shared by the GitHub sign-in and the provider OAuth device flow. */
export function deviceFlowStepLabel(index: number, host: string, done: boolean): string {
  switch (index) {
    case 0:
      return "Code copied to clipboard";
    case 1:
      return done ? `Opened ${host}` : `Opening ${host} in your browser`;
    case 2:
      return done ? "Authorized" : "Waiting for authorization…";
    default:
      return "Account added";
  }
}

/** Trim the scheme so a verification URL reads compactly in a hint line. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
