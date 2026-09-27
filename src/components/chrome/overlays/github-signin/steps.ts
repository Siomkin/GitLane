// GitHub sign-in checklist mapping: the backend's `github-signin-progress` step
// ids → the fixed display rows. Status derivation lives in the shared `../progress`
// primitive; this file owns only the sign-in event map and labels.

import { stepIndexIn, stepStatus, type StepStatus } from "@/components/chrome/overlays/progress";

/** Display rows, in order. `reached` starts at -1 (every row pending — the code
 * box shows its own "requesting…" spinner); each backend step advances to the
 * next row. Row 0 ("Code copied") only lights up once the code actually arrives.
 * Row 3 ("Account added") has no event — it completes when the IPC resolves. */
const STEP_EVENTS: readonly (readonly string[])[] = [
  [], // row 0 — pending until the code arrives (reached 1), then done
  ["code"], // row 1
  ["browser"], // row 2
  ["authorized"], // row 3
];

export type SigninStepStatus = StepStatus;

/** Number of checklist rows. */
export const SIGNIN_STEP_COUNT = STEP_EVENTS.length;

/** Row index a backend step id belongs to, or -1 for an unknown id. */
export function signinStepIndex(step: string): number {
  return stepIndexIn(STEP_EVENTS, step);
}

/** Status of row `index` given the furthest row reached so far. */
export const signinStepStatus = stepStatus;
