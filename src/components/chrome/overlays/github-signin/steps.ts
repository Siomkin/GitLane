// GitHub sign-in checklist mapping: the backend's `github-signin-progress` step
// ids → the fixed display rows. Status derivation lives in the shared `../progress`
// primitive; this file owns only the sign-in event map and labels.

import { stepIndexIn, stepStatus, type StepStatus } from "../progress";

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

/** Label for row `index`, phrased for its state so a spinning row reads as
 * in-progress and a checked row reads as completed — e.g. row 1 is "Opening…"
 * while active but "Opened …" once done, so a checkmark never sits next to a
 * present-progressive verb. `host` names the target (GHES-aware). */
export function signinStepLabel(index: number, host: string, done: boolean): string {
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

/** Row index a backend step id belongs to, or -1 for an unknown id. */
export function signinStepIndex(step: string): number {
  return stepIndexIn(STEP_EVENTS, step);
}

/** Status of row `index` given the furthest row reached so far. */
export const signinStepStatus = stepStatus;
