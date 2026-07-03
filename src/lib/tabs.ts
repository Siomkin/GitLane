// Pure helpers for the repo tab strip (GL-110): what the strip knows about
// each open path, how a tab presents itself (plain repo vs linked-worktree
// tab), and where a newly opened path is inserted so worktrees group next to
// their parent repository's tab. No React, no IPC — selection.ts-style module.

import type { RecentStatus, RepoSummary } from "@/lib/api";
import { repoLabel } from "./paths";
import { trimTrailingSlash } from "./worktrees";

/** What the tab strip knows about one open path. Populated from the opened
 * repo's summary (active tab) or the session-restore probe (inactive tabs);
 * absent entries degrade to a plain repo tab labeled by the leaf directory. */
export interface TabInfo {
  /** True when the path is a linked worktree of some repository. */
  isWorktree: boolean;
  /** The main checkout's path (the repository identity) when a worktree. */
  mainPath: string | null;
  /** Checked-out branch, or null when detached / unknown. */
  branch: string | null;
}

export function tabInfoFromSummary(summary: RepoSummary): TabInfo {
  return {
    isWorktree: summary.isWorktree ?? false,
    mainPath: summary.mainPath ?? null,
    branch: summary.headBranch,
  };
}

export function tabInfoFromStatus(status: RecentStatus): TabInfo {
  return {
    isWorktree: status.isWorktree ?? false,
    mainPath: status.mainPath ?? null,
    branch: status.branch,
  };
}

/** The repository identity a tab belongs to: its main checkout's path for a
 * linked worktree, else the tab's own path (see `repoIdentityKey`). */
export function tabIdentity(path: string, info: TabInfo | undefined): string {
  return trimTrailingSlash(info?.mainPath || path);
}

/** How one tab renders: a plain repo tab (leaf directory name), or a worktree
 * tab showing `parent repo · branch` with the accent tree icon — the same
 * visual language as the toolbar worktree indicator (GL-22). */
export type TabDisplay =
  | { kind: "repo"; name: string }
  | { kind: "worktree"; repoName: string; detail: string };

export function tabDisplay(path: string, info: TabInfo | undefined): TabDisplay {
  if (info?.isWorktree && info.mainPath) {
    return {
      kind: "worktree",
      repoName: repoLabel(info.mainPath),
      // The branch is what distinguishes a worktree; a detached one falls back
      // to its leaf directory so the tab never shows a bare repo name twice.
      detail: info.branch ?? repoLabel(path),
    };
  }
  return { kind: "repo", name: repoLabel(path) };
}

/** Human label for a tab (tooltips / aria): the display parts joined. */
export function tabLabel(path: string, info: TabInfo | undefined): string {
  const display = tabDisplay(path, info);
  return display.kind === "worktree" ? `${display.repoName} · ${display.detail}` : display.name;
}

/** Where a newly opened `identity`'s tab is inserted: right after the last tab
 * of the same repository (main checkout or sibling worktree) so worktrees
 * group next to their parent repo's tab; unrelated repositories append. */
export function groupedInsertIndex(
  openPaths: string[],
  infoByPath: Record<string, TabInfo>,
  identity: string,
): number {
  let last = -1;
  openPaths.forEach((path, index) => {
    if (tabIdentity(path, infoByPath[path]) === identity) last = index;
  });
  return last === -1 ? openPaths.length : last + 1;
}

/** Drop info entries whose tab is no longer open (closed / replaced). */
export function pruneTabInfo(
  infoByPath: Record<string, TabInfo>,
  openPaths: string[],
): Record<string, TabInfo> {
  const open = new Set(openPaths);
  return Object.fromEntries(Object.entries(infoByPath).filter(([path]) => open.has(path)));
}
