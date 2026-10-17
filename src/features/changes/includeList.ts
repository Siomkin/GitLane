// The combined working-changes list of the Changes tab's Include view: one row
// per path, its three-state include checkbox read from the two index buckets,
// and which paths a check or uncheck acts on. Pure — the inspector dispatches.

import type { FileChange, WorkingChanges } from "@/lib/api";
import { deriveReviewRows, type ReviewRow } from "./changes-workspace/changesReviewModel";

/** Included (only staged), partly included (staged and unstaged), or excluded. */
export type IncludeState = boolean | "mixed";

export interface IncludeRow extends ReviewRow {
  checked: IncludeState;
}

/** One row per changed path in path order, showing the working-tree entry while
 * anything is unstaged — the same rows the stacked review lists. */
export function includeRows(changes: WorkingChanges): IncludeRow[] {
  const staged = new Set(changes.staged.map((f) => f.path));
  const unstaged = new Set(changes.unstaged.map((f) => f.path));
  return deriveReviewRows(changes).map((row) => ({
    ...row,
    checked: !unstaged.has(row.path) ? true : staged.has(row.path) ? "mixed" : false,
  }));
}

/** A folder roll-up's state: checked only when every file under it is. */
export function rollupState(rows: IncludeRow[], paths: string[]): IncludeState {
  const set = new Set(paths);
  const states = rows.filter((r) => set.has(r.path)).map((r) => r.checked);
  if (states.length > 0 && states.every((s) => s === true)) return true;
  if (states.every((s) => s === false)) return false;
  return "mixed";
}

/** What checking a row or roll-up does: unstage everything when it is fully
 * included, otherwise stage the paths that still have unstaged changes. */
export function includeTarget(
  rows: IncludeRow[],
  paths: string[],
): { action: "stage" | "unstage"; paths: string[] } {
  const set = new Set(paths);
  const picked = rows.filter((r) => set.has(r.path));
  if (picked.length > 0 && picked.every((r) => r.checked === true)) {
    return { action: "unstage", paths: picked.map((r) => r.path) };
  }
  return { action: "stage", paths: picked.filter((r) => r.checked !== true).map((r) => r.path) };
}

/** The display entries for the list component, in row order. */
export const rowFiles = (rows: IncludeRow[]): FileChange[] => rows.map((r) => r.file);
