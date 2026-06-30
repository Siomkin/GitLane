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

/** A distinguishing directory label for a worktree. The leaf segment is normally
 * enough, but some tools (e.g. codex) nest every worktree under `<id>/<repo>`, so
 * every one has the repo name as its leaf (`.codex/worktrees/1e75/GitLane`). When
 * a linked worktree's leaf collides with another worktree's, fall back to
 * `<parent>/<leaf>` (e.g. "1e75/GitLane") so siblings stay distinguishable. The
 * main worktree always keeps its plain leaf. */
export function worktreeName(wt: WorktreeInfo, worktrees: WorktreeInfo[]): string {
  if (!wt.isMain && worktrees.some((w) => w.path !== wt.path && w.name === wt.name)) {
    const segments = trimTrailingSlash(wt.path).split("/").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
  }
  return wt.name;
}

/** Display label for a worktree row/chip: its checked-out branch, falling back
 * to the distinguishing directory name (see {@link worktreeName}) when detached. */
export function worktreeLabel(wt: WorktreeInfo, worktrees: WorktreeInfo[]): string {
  return wt.branch ?? worktreeName(wt, worktrees);
}

/** What the toolbar's worktree indicator should show.
 * - `active`: the open repo is itself a linked worktree → name it + its path.
 *   This is the only state worth a permanent toolbar chip — it's the "you are
 *   here" signal that you're not in the main checkout.
 * - `none`: render nothing. When the main worktree is open, linked worktrees
 *   still exist but don't earn an ever-present badge (it'd just sit there all
 *   the time) — they're listed in the branch/worktree navigator instead. */
export type WorktreeIndicator =
  | { kind: "active"; name: string; path: string }
  | { kind: "none" };

export function worktreeIndicatorView(
  worktrees: WorktreeInfo[],
  summary: RepoSummary | null,
): WorktreeIndicator {
  const active = activeWorktree(worktrees, summary);
  if (active && !active.isMain) {
    return { kind: "active", name: worktreeName(active, worktrees), path: active.path };
  }
  return { kind: "none" };
}
