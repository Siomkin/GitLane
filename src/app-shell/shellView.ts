// Which chrome owns the area below the title bar — one encoding of the four
// mutually exclusive shell states App used to re-derive from `summary` /
// `missingRepo` / `restoringSession` / `onboardingOpen` in two separate
// expressions (GL-377). `onboardingOpen` only raises the overlay over an
// already-showing workspace or missing-repo view; the no-repo start state
// is always the inline onboarding screen, flag or not.

export const SHELL_VIEW = {
  Workspace: "workspace",
  Missing: "missing",
  Restoring: "restoring",
  Onboarding: "onboarding",
} as const;
export type ShellView = (typeof SHELL_VIEW)[keyof typeof SHELL_VIEW];

export interface ShellViewState {
  hasSummary: boolean;
  hasMissingRepo: boolean;
  restoringSession: boolean;
  onboardingOpen: boolean;
}

export interface ShellViewResult {
  view: ShellView;
  onboardingOverlay: boolean;
}

export function shellView(state: ShellViewState): ShellViewResult {
  const view = state.hasSummary
    ? SHELL_VIEW.Workspace
    : state.hasMissingRepo
      ? SHELL_VIEW.Missing
      : state.restoringSession
        ? SHELL_VIEW.Restoring
        : SHELL_VIEW.Onboarding;
  return {
    view,
    onboardingOverlay:
      state.onboardingOpen && (view === SHELL_VIEW.Workspace || view === SHELL_VIEW.Missing),
  };
}
