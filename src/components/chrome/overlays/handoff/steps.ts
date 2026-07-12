// Hand-off dialog's step-checklist mapping: the backend's `handoff-progress` step
// ids → the fixed display rows. The pending/active/done derivation now lives in
// the shared `../progress` primitive (extracted in GL-106); this file keeps only
// the hand-off-specific event map and labels.

import { stepIndexIn, stepStatus, type StepStatus } from "@/components/chrome/overlays/progress";

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

export type HandoffStepStatus = StepStatus;

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

/** Row index a backend step id belongs to, or -1 for an unknown id. */
export function handoffStepIndex(step: string): number {
  return stepIndexIn(STEP_EVENTS, step);
}

/** Status of row `index` given the furthest row reached so far. */
export const handoffStepStatus = stepStatus;
