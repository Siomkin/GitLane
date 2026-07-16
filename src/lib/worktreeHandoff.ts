// Worktree branch-handoff (GL-74): validate that a destination workspace exists,
// then raise the dedicated HandoffDialog (destination picker → live step
// checklist → success message). Pure/orchestration helpers — no React — so the
// branch menu, the worktree menu, and the toolbar indicator all drive the same
// flow.

import type { WorktreeInfo } from "./api";
import { trimTrailingSlash, worktreeLabel } from "./worktrees";
import type { HandoffRequest } from "@/store/ui";
import type { PromptOption } from "@/store/ui";

/** Destination-picker options for handing a branch off from `sourcePath`: every
 * OTHER registered worktree, labelled by its checked-out branch (or directory
 * name), the main checkout marked, and the absolute path shown as the hint. The
 * option `value` is the destination worktree path — what the backend needs and
 * what the search box also filters on. */
export function handoffDestinationOptions(
  worktrees: WorktreeInfo[],
  sourcePath: string,
): PromptOption[] {
  const source = trimTrailingSlash(sourcePath);
  return worktrees
    .filter(
      (wt) =>
        trimTrailingSlash(wt.path) !== source &&
        // A bare repo or a prunable (missing) worktree has no working tree to
        // check the branch out into — git would reject the handoff checkout, so
        // don't offer them as destinations (common in bare + per-branch layouts).
        !wt.bare &&
        !wt.prunable,
    )
    .map((wt) => ({
      value: wt.path,
      label: worktreeLabel(wt, worktrees),
      // The main checkout is marked in the hint; the path is always shown so
      // sibling worktrees stay distinguishable (AC: "with full paths").
      hint: wt.isMain ? `main · ${wt.path}` : wt.path,
    }));
}

/** Can `sourcePath` run the hand-off's detach step? A prunable worktree's
 * directory is gone — git cannot detach inside it, so every hand-off entry
 * point (branch menu, worktree menu, "Check out here…") hides behind this one
 * predicate instead of each gating differently. */
export function handoffSourceValid(worktrees: WorktreeInfo[], sourcePath: string): boolean {
  const source = trimTrailingSlash(sourcePath);
  const wt = worktrees.find((candidate) => trimTrailingSlash(candidate.path) === source);
  return wt != null && !wt.prunable;
}

/** Leaf directory name of a path, for naming a worktree in the dialog. */
export function worktreeLeaf(path: string): string {
  return trimTrailingSlash(path).split("/").filter(Boolean).pop() ?? path;
}

/** The "N uncommitted change(s) will be carried" line for the dialog. `null`
 * means the source's dirtiness is unknown (the flow was started from a menu whose
 * worktree isn't the open repo), so we phrase it conditionally. */
export function carriedLine(sourceChanges: number | null): string {
  if (sourceChanges === null) {
    return "Any uncommitted changes in the source worktree travel with the branch.";
  }
  if (sourceChanges === 0) {
    return "The source worktree has no uncommitted changes to carry.";
  }
  return `${sourceChanges} uncommitted change${sourceChanges === 1 ? "" : "s"} in the source worktree will be carried along.`;
}

export interface HandoffStartArgs {
  branch: string;
  /** Absolute path of the worktree the branch is moving out of. */
  sourcePath: string;
  worktrees: WorktreeInfo[];
  /** Count of the source's uncommitted files, or null when unknown. */
  sourceChanges: number | null;
  /** Preselect this destination worktree in the dialog (see
   * {@link HandoffRequest.destPath}). */
  destPath?: string;
  /** Raises the HandoffDialog (`useUi().openHandoff`). */
  openHandoff: (req: HandoffRequest) => void;
  /** Surfaced when there's nowhere to hand the branch off to. */
  onNoDestinations?: () => void;
}

/** Open the hand-off dialog for `branch` — or report that no valid destination
 * exists. The dialog owns destination choice, the confirm, the live progress
 * checklist, and the success message. */
export function startWorktreeHandoff({
  branch,
  sourcePath,
  worktrees,
  sourceChanges,
  destPath,
  openHandoff,
  onNoDestinations,
}: HandoffStartArgs): void {
  if (handoffDestinationOptions(worktrees, sourcePath).length === 0) {
    onNoDestinations?.();
    return;
  }
  openHandoff({ branch, sourcePath, sourceChanges, destPath });
}
