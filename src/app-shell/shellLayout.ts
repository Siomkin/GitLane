// The main grid's shape and the top-level screen ladder — the single encoding
// of decisions `App` used to restate inline. `deriveShellLayout` collapses the
// center-view key to the grid arm; `shellLayoutColumns` is the ONE place each
// arm's `grid-template-columns` lives, so the template and the JSX dispatch in
// `App.tsx` are both driven off the same key and cannot drift apart.
// `deriveShellScreen` owns the summary → missing-repo → restoring → onboarding
// ladder (plus which of those screens the raised onboarding overlay may cover).

import type { CenterViewKey } from "./centerView";

export type ShellLayout = "conflict" | "pulls" | "inspect";

export interface ShellLayoutInput {
  /** The derived center-view key (see [`deriveCenterView`]). */
  view: CenterViewKey;
}

/** Conflict resolution takes over the whole center; the PR view is two-pane
 * (docked list + detail); everything else is center workspace + right
 * inspector. */
export function deriveShellLayout(input: ShellLayoutInput): ShellLayout {
  if (input.view === "conflict") return "conflict";
  if (input.view === "pulls") return "pulls";
  return "inspect";
}

export interface ShellLayoutColumnsInput {
  /** Docked PR-list width (ui store `leftWidth`, user-resizable). */
  leftWidth: number;
  /** Right inspector width (ui store `rightWidth`, user-resizable). */
  rightWidth: number;
}

/** The grid columns for a layout arm. The inspector honors the user's manual
 * width on roomy windows, then clamps with the viewport so narrow review
 * layouts stay usable without reserving a hidden blank column. */
export function shellLayoutColumns(
  layout: ShellLayout,
  { leftWidth, rightWidth }: ShellLayoutColumnsInput,
): string {
  switch (layout) {
    case "conflict":
      return "minmax(0,1fr)";
    case "pulls":
      return `${leftWidth}px 6px minmax(0,1fr)`;
    case "inspect":
      return `minmax(0,1fr) 6px clamp(280px, 34vw, ${rightWidth}px)`;
  }
}

export type ShellScreen = "workspace" | "missing-repo" | "restoring" | "onboarding";

export interface ShellScreenInput {
  /** A repo summary is loaded (repo store `summary`). */
  hasSummary: boolean;
  /** The open tab's path no longer resolves (repo store `missingRepo`). */
  missingRepo: boolean;
  /** The previous session's tabs are still being restored. */
  restoringSession: boolean;
}

export function deriveShellScreen(input: ShellScreenInput): ShellScreen {
  if (input.hasSummary) return "workspace";
  if (input.missingRepo) return "missing-repo";
  if (input.restoringSession) return "restoring";
  return "onboarding";
}

/** The screens over which onboarding raised from the tab strip can appear as
 * an overlay — a repo (or the missing-repo recovery state) is showing. The
 * no-repo start state renders it inline instead (`App.tsx`). */
export const screenShowsRepoState = (screen: ShellScreen) =>
  screen === "workspace" || screen === "missing-repo";
