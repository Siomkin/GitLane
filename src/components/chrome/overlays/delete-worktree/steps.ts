// Delete-branch-and-worktree checklist mapping (GL-107): the backend's
// `delete-worktree-progress` step ids → the fixed display rows. The
// pending/active/done derivation lives in the shared `../progress` primitive
// (extracted in GL-106); this file keeps only the delete-specific event map and
// labels.

import { stepIndexIn, stepStatus, type StepStatus } from "../progress";

/** Display rows, in execution order. The backend emits one id per phase it
 * begins; the final "Refreshing" row has no backend event — it's the frontend
 * graph refresh that runs once the delete IPC resolves, so the run hook advances
 * to it explicitly (like the sign-in dialog's terminal row). */
const STEP_EVENTS: readonly (readonly string[])[] = [
  ["removeWorktree"], // row 0
  ["deleteBranch"], // row 1
  [], // row 2 — Refreshing (frontend refresh; see useDeleteWorktreeRun)
];

export type DeleteWorktreeStepStatus = StepStatus;

/** Number of checklist rows. */
export const DELETE_WORKTREE_STEP_COUNT = STEP_EVENTS.length;

/** Index of the terminal "Refreshing" row — the run hook advances `reached` here
 * itself once the delete IPC resolves and the graph refresh begins. */
export const DELETE_WORKTREE_REFRESH_ROW = STEP_EVENTS.length - 1;

/** Labels for the checklist rows, in `STEP_EVENTS` order. */
export function deleteWorktreeStepLabels(): string[] {
  return ["Removing worktree", "Deleting branch", "Refreshing"];
}

/** Row index a backend step id belongs to, or -1 for an unknown id. */
export function deleteWorktreeStepIndex(step: string): number {
  return stepIndexIn(STEP_EVENTS, step);
}

/** Status of row `index` given the furthest row reached so far. */
export const deleteWorktreeStepStatus = stepStatus;
