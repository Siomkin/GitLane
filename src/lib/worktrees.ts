// Pure helpers for reasoning about linked worktrees — the single source of the
// "which worktree backs the open repo" derivation (previously duplicated in the
// branch navigator and the worktree context menu) plus the toolbar indicator's
// view-model. No React, no IPC: trivially testable, shared by both surfaces.

import type { RepoSummary, WorktreeInfo } from "@/lib/api";

/** Drop trailing slashes so two spellings of the same directory compare equal. */
export function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Does `path` point at the worktree backing the currently open repo? Matched on
 * both the workdir and the canonical repo path (they diverge for a bare repo),
 * mirroring git's own porcelain canonicalization at the UI boundary. */
export function isActiveWorktreePath(summary: RepoSummary | null, path: string): boolean {
  if (!summary) return false;
  const target = trimTrailingSlash(path);
  const workdir = summary.workdir ? trimTrailingSlash(summary.workdir) : null;
  const repoPath = summary.path ? trimTrailingSlash(summary.path) : null;
  return target === workdir || target === repoPath;
}

/** The worktree entry that backs the open repo tab (the "you are here" row), or
 * null when none matches (e.g. the list hasn't loaded yet). */
export function activeWorktree(
  worktrees: WorktreeInfo[],
  summary: RepoSummary | null,
): WorktreeInfo | null {
  if (!summary) return null;
  return worktrees.find((wt) => isActiveWorktreePath(summary, wt.path)) ?? null;
}

/** Linked (non-primary) worktrees — the ones whose existence the main UI should
 * advertise. The primary worktree is always present and isn't "extra". */
export function linkedWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return worktrees.filter((wt) => !wt.isMain);
}

/** Display label for a worktree row/chip: its checked-out branch, falling back
 * to the leaf directory name when detached. */
export function worktreeLabel(wt: WorktreeInfo): string {
  return wt.branch ?? wt.name;
}

/** What the toolbar's worktree indicator should show.
 * - `active`: the open repo is itself a linked worktree → name it + its path.
 * - `count`: linked worktrees exist but the open repo isn't one (e.g. the main
 *   worktree is open) → just advertise how many.
 * - `none`: no linked worktrees → render nothing. */
export type WorktreeIndicator =
  | { kind: "active"; name: string; path: string; linkedCount: number }
  | { kind: "count"; linkedCount: number }
  | { kind: "none" };

export function worktreeIndicatorView(
  worktrees: WorktreeInfo[],
  summary: RepoSummary | null,
): WorktreeIndicator {
  const linkedCount = linkedWorktrees(worktrees).length;
  const active = activeWorktree(worktrees, summary);
  if (active && !active.isMain) {
    return { kind: "active", name: active.name, path: active.path, linkedCount };
  }
  if (linkedCount > 0) return { kind: "count", linkedCount };
  return { kind: "none" };
}
