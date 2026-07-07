// Native provider OAuth sign-in checklist mapping (GL-139): the backend's
// `provider-oauth-progress` step ids → the display rows, per flow. GitLab uses a
// device flow (a one-time code); Bitbucket uses a PKCE loopback (no code). Status
// derivation lives in the shared `../progress` primitive; this file owns only the
// event map and labels.

import { stepIndexIn, stepStatus, type StepStatus } from "../progress";

/** GitLab = device flow; Bitbucket = PKCE loopback. */
export type OauthMode = "device" | "pkce";

export type OauthStepStatus = StepStatus;

// Rows per flow, in order. `reached` starts at -1 (every row pending).
const EVENTS: Record<OauthMode, readonly (readonly string[])[]> = {
  device: [
    [], // row 0 — "Code copied", done once the code arrives (reached ≥ 1)
    ["device_code"], // row 1 — open the verification page
    ["polling"], // row 2 — waiting for authorization
    ["authorized", "storing"], // row 3 — account added
  ],
  pkce: [
    ["browser"], // row 0 — open the authorize page
    ["waiting"], // row 1 — waiting for authorization
    ["authorized", "storing"], // row 2 — account added
  ],
};

/** Number of checklist rows for `mode`. */
export function oauthStepCount(mode: OauthMode): number {
  return EVENTS[mode].length;
}

/** Row index a backend step id belongs to for `mode`, or -1 if unknown. */
export function oauthStepIndex(mode: OauthMode, step: string): number {
  return stepIndexIn(EVENTS[mode], step);
}

/** Status of row `index` given the furthest row reached so far. */
export const oauthStepStatus = stepStatus;

/** Label for row `index`, phrased for its state (a spinning row reads as
 * in-progress, a checked row as completed). `host` names the target. */
export function oauthStepLabel(
  mode: OauthMode,
  index: number,
  host: string,
  done: boolean,
): string {
  if (mode === "device") {
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
  switch (index) {
    case 0:
      return done ? `Opened ${host}` : `Opening ${host} in your browser`;
    case 1:
      return done ? "Authorized" : "Waiting for authorization…";
    default:
      return "Account added";
  }
}

/** GitLab signs in via the device flow; every other supported provider (today
 * just Bitbucket) uses the PKCE loopback. */
export function oauthModeFor(provider: string): OauthMode {
  return provider === "gitlab" ? "device" : "pkce";
}
