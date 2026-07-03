// Pure step-checklist model for the hand-off dialog (no React, no IPC) — maps
// the backend's `handoff-progress` step ids onto the fixed display rows and
// derives each row's pending/active/done status. Kept separate so the mapping
// (including skipped steps) is unit-testable.

/** Display rows, in execution order. Each row owns one or more backend step ids
 * (`stashSource` + `stashDestination` both surface as "Stashing…"); a step that
 * never fires (clean source/destination) is folded into the next row reached. */
const STEP_EVENTS: readonly (readonly string[])[] = [
  ["stashSource", "stashDestination"],
  ["detach"],
  ["checkout"],
  ["applySource", "applyDestination"],
  ["finalize"],
];

/** Labels for the checklist rows, in `STEP_EVENTS` order. */
export function handoffStepLabels(branch: string, destLabel: string): string[] {
  return [
    "Stashing uncommitted changes",
    `Detaching ${branch} from the source worktree`,
    `Checking out ${branch} in ${destLabel}`,
    "Applying uncommitted changes",
    `Opening ${destLabel}`,
  ];
}

/** Row index a backend step id belongs to, or -1 for an unknown id (a newer
 * backend emitting a step this build doesn't know must not break the list). */
export function handoffStepIndex(step: string): number {
  return STEP_EVENTS.findIndex((events) => events.includes(step));
}

export type HandoffStepStatus = "pending" | "active" | "done";

/** Status of row `index` given the furthest row reached so far. Rows before the
 * reached one are done (this is what folds skipped steps in); the reached row
 * runs; `finished` (the IPC promise resolved) completes everything. */
export function handoffStepStatus(
  index: number,
  reached: number,
  finished: boolean,
): HandoffStepStatus {
  if (finished || index < reached) return "done";
  return index === reached ? "active" : "pending";
}
