// GL-297: which of the sweep's candidate worktrees are actually safe to delete.
//
// `removableDetachedWorktrees` decides candidacy from the worktree list alone —
// it cannot see uncommitted work, and "detached" is a poor proxy for
// "disposable" (an agent's isolation worktree is detached *by construction*).
// This module applies what the probe learned, so the sweep removes only what it
// can vouch for and says plainly what it is leaving behind.

import type { WorktreeDirtyState, WorktreeInfo } from "@/lib/api";
import { isAgentManagedWorktree } from "@/lib/worktrees";

/** Why a candidate was withheld from the sweep. */
export type SkipReason = "uncommittedWork" | "agentManaged" | "unverified";

export interface SkippedWorktree {
  worktree: WorktreeInfo;
  reason: SkipReason;
  /** Probe result when there was one; null when the probe failed. */
  dirty: WorktreeDirtyState | null;
}

/** A candidate the sweep will remove, with what goes with it. */
export interface RemovableWorktree {
  worktree: WorktreeInfo;
  /** Ignored entries git deletes along with the directory, collapsed by
   * directory. Zero for a worktree with none. */
  ignored: number;
}

export interface RemoveDetachedPlan {
  /** Candidates the sweep will remove. */
  remove: RemovableWorktree[];
  /** Candidates deliberately left in place, each with its reason. */
  skip: SkippedWorktree[];
}

/** The probe outcome per candidate path; a missing or null entry means the
 * probe did not answer. */
export type DirtyProbeResults = Map<string, WorktreeDirtyState | null>;

/** Split the sweep's candidates into what it may remove and what it must not.
 *
 * Three things are withheld, and none of them is a judgement call the sweep
 * should be making silently on the user's behalf:
 *
 * - **Uncommitted work.** Git refuses an unforced removal here, so before this
 *   the row simply failed mid-sweep with a raw error. Withholding it up front
 *   turns that into a stated decision. (The per-row menu can still force it —
 *   GL-296 — which is the right place for that, since it names the loss.)
 * - **Agent-managed.** Detached is how agents isolate, so these are the *most*
 *   live worktrees in the repo, not the most disposable.
 * - **Unverified.** A probe that failed cannot tell us the worktree is clean.
 *   For a bulk destructive action, not knowing is a reason to leave it alone;
 *   the per-row removal remains available and states the uncertainty.
 */
export function buildRemoveDetachedPlan(
  candidates: WorktreeInfo[],
  probes: DirtyProbeResults,
): RemoveDetachedPlan {
  const remove: RemovableWorktree[] = [];
  const skip: SkippedWorktree[] = [];
  for (const worktree of candidates) {
    const dirty = probes.get(worktree.path) ?? null;
    // Agent ownership is checked first: it is the more informative reason to
    // show, and it holds whether or not the worktree happens to be dirty.
    if (isAgentManagedWorktree(worktree)) {
      skip.push({ worktree, reason: "agentManaged", dirty });
    } else if (!probes.has(worktree.path) || dirty === null) {
      skip.push({ worktree, reason: "unverified", dirty: null });
    } else if (dirty.modified + dirty.untracked > 0) {
      skip.push({ worktree, reason: "uncommittedWork", dirty });
    } else {
      // Ignored files never block the sweep: git deletes them on an unforced
      // remove because its model says they are regenerable, and withholding on
      // them would make every JS worktree (`node_modules/`) unremovable. The
      // count rides along so the row can say they are going.
      remove.push({ worktree, ignored: dirty.ignored });
    }
  }
  return { remove, skip };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One short phrase for a skipped row, naming the concrete reason. */
export function describeSkip(skipped: SkippedWorktree): string {
  switch (skipped.reason) {
    case "agentManaged":
      return "In use by a coding agent";
    case "unverified":
      return "Couldn’t check for uncommitted changes";
    case "uncommittedWork": {
      const { modified = 0, untracked = 0 } = skipped.dirty ?? {};
      const parts: string[] = [];
      if (modified > 0) parts.push(plural(modified, "modified file"));
      if (untracked > 0) parts.push(plural(untracked, "untracked file"));
      return `Has ${parts.join(" and ")}`;
    }
  }
}

/** What a removable row loses beyond the directory itself, or null when the
 * removal takes nothing else with it. */
export function describeCollateral(removable: RemovableWorktree): string | null {
  if (removable.ignored <= 0) return null;
  const n = removable.ignored;
  return `also deletes ${n} ignored ${n === 1 ? "entry" : "entries"}`;
}
