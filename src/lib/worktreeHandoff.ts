// Worktree branch-handoff (GL-74): pick a destination workspace and confirm the
// detach before moving a branch (and its uncommitted work) between worktrees.
// Pure/orchestration helpers — no React — so the branch menu, the worktree menu,
// and the toolbar indicator all drive the same flow. The picker reuses the
// existing searchable prompt (`PromptRequest.options`); the confirm names the
// destination, the detach, and what (if anything) is carried.

import type { WorktreeInfo } from "./api";
import { trimTrailingSlash, worktreeLabel } from "./worktrees";
import type { ConfirmRequest, PromptOption, PromptRequest } from "@/store/ui";

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
    .filter((wt) => trimTrailingSlash(wt.path) !== source)
    .map((wt) => ({
      value: wt.path,
      label: worktreeLabel(wt, worktrees),
      // The main checkout is marked in the hint; the path is always shown so
      // sibling worktrees stay distinguishable (AC: "with full paths").
      hint: wt.isMain ? `main · ${wt.path}` : wt.path,
    }));
}

/** Leaf directory name of a path, for naming the source worktree in the confirm. */
function leaf(path: string): string {
  return trimTrailingSlash(path).split("/").filter(Boolean).pop() ?? path;
}

/** The "N uncommitted change(s) will be carried" line for the confirm. `null`
 * means the source's dirtiness is unknown (the flow was started from a menu whose
 * worktree isn't the open repo), so we phrase it conditionally. */
function carriedLine(sourceChanges: number | null): string {
  if (sourceChanges === null) {
    return "Any uncommitted changes in the source worktree travel with the branch.";
  }
  if (sourceChanges === 0) {
    return "The source worktree has no uncommitted changes to carry.";
  }
  return `${sourceChanges} uncommitted change${sourceChanges === 1 ? "" : "s"} in the source worktree will be carried along.`;
}

export interface HandoffPromptArgs {
  branch: string;
  /** Absolute path of the worktree the branch is moving out of. */
  sourcePath: string;
  worktrees: WorktreeInfo[];
  /** Count of the source's uncommitted files, or null when unknown. */
  sourceChanges: number | null;
  requestPrompt: (req: PromptRequest) => void;
  requestConfirm: (req: ConfirmRequest) => void;
  /** Toasting runner (e.g. `useBranchOp()`). */
  run: (op: () => Promise<string>) => void;
  moveBranchToWorktree: (
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) => Promise<string>;
  /** Surfaced when there's nowhere to hand the branch off to. */
  onNoDestinations?: () => void;
}

/** Open the destination picker for handing `branch` off, then a confirm that
 * names the destination, the detach of the source, and what gets carried, before
 * running the move. Always carries (the backend no-ops the stash when the source
 * is clean). */
export function promptWorktreeHandoff({
  branch,
  sourcePath,
  worktrees,
  sourceChanges,
  requestPrompt,
  requestConfirm,
  run,
  moveBranchToWorktree,
  onNoDestinations,
}: HandoffPromptArgs): void {
  const options = handoffDestinationOptions(worktrees, sourcePath);
  if (options.length === 0) {
    onNoDestinations?.();
    return;
  }
  const sourceName = leaf(sourcePath);
  requestPrompt({
    title: `Hand off ${branch} to…`,
    message: "Check this branch out in another workspace, carrying its uncommitted work.",
    placeholder: "Search worktrees",
    options,
    confirmLabel: "Choose destination",
    onSubmit: (destPath) => {
      const dest = worktrees.find((w) => trimTrailingSlash(w.path) === trimTrailingSlash(destPath));
      const destLabel = dest ? worktreeLabel(dest, worktrees) : leaf(destPath);
      requestConfirm({
        title: `Hand off ${branch} to ${destLabel}?`,
        message: `${branch} will be checked out in ${destPath}.`,
        details: [carriedLine(sourceChanges)],
        warnings: [
          `The source worktree (${sourceName}) will be left with a detached HEAD — no branch checked out — so ${branch} can move.`,
        ],
        confirmLabel: "Hand off branch",
        onConfirm: () => run(() => moveBranchToWorktree(branch, sourcePath, destPath, true)),
      });
    },
  });
}
