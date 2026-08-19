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

export function tabDisplay(
  path: string,
  info: TabInfo | undefined,
  /** The repository's custom display name (`store/ui`'s `repoNameOf`), when the
   * user has set one. It replaces the folder-derived name — including the
   * parent-repo half of a worktree tab, since it names the *repository*. */
  customName?: string | null,
): TabDisplay {
  if (info?.isWorktree && info.mainPath) {
    return {
      kind: "worktree",
      repoName: customName || repoLabel(info.mainPath),
      // The branch is what distinguishes a worktree; a detached one falls back
      // to its leaf directory so the tab never shows a bare repo name twice.
      detail: info.branch ?? repoLabel(path),
    };
  }
  return { kind: "repo", name: customName || repoLabel(path) };
}

/** Human label for a tab (tooltips / aria): the display parts joined. */
export function tabLabel(
  path: string,
  info: TabInfo | undefined,
  customName?: string | null,
): string {
  const display = tabDisplay(path, info, customName);
  return display.kind === "worktree" ? `${display.repoName} · ${display.detail}` : display.name;
}

/** One stretch of the tab strip drawn together: a group's tabs behind its
 * name, or a single ungrouped tab (`groupId: null`). A run is also the unit a
 * drag moves — a whole group travels with its tabs. */
export interface TabRun {
  groupId: string | null;
  /** Everything the run holds: what a drag moves and what the collapsed pill
   * counts, whether or not it is all drawn. */
  paths: string[];
  /** True when the group is folded to its pill. Always false for an ungrouped
   * run — collapsing is a property of a group. */
  collapsed: boolean;
  /** The subset of `paths` the strip actually draws. Same as `paths` unless
   * the run is collapsed, in which case it is the active tab alone (a
   * collapsed group never hides where the user is) or nothing at all. */
  drawn: string[];
}

/** Stable identity of a run for keys and drag ids: the group, or the lone
 * ungrouped tab's own path. */
export function runKey(run: TabRun): string {
  return run.groupId ?? `ungrouped:${run.paths[0]}`;
}

/**
 * Partition the tab order into the runs the strip draws (GL — repo groups).
 *
 * Group membership is *derived* from the stored order rather than stored as a
 * second order: a group's run is emitted at the position of its first member
 * and pulls that group's later members forward, while ungrouped tabs stay put.
 * So a drag can never leave a group visually split, and assigning a group never
 * has to rewrite `openPaths` behind the user's back.
 *
 * Idempotent: feeding back the flattened result reproduces it exactly, which is
 * what lets a drag persist the rendered order as the new stored order.
 */
export function groupRuns(
  paths: string[],
  groupIdOf: (path: string) => string | null,
  /** What the strip folds and where the user is. Omitted (the default) means
   * nothing is collapsed, which is what the pure ordering helpers want. */
  options: {
    collapsed?: (groupId: string) => boolean;
    activePath?: string | null;
  } = {},
): TabRun[] {
  const runs: TabRun[] = [];
  const byGroup = new Map<string, TabRun>();
  for (const path of paths) {
    const groupId = groupIdOf(path);
    if (groupId === null) {
      runs.push({ groupId: null, paths: [path], collapsed: false, drawn: [path] });
      continue;
    }
    const existing = byGroup.get(groupId);
    if (existing) {
      existing.paths.push(path);
      continue;
    }
    const run: TabRun = {
      groupId,
      paths: [path],
      collapsed: options.collapsed?.(groupId) ?? false,
      drawn: [],
    };
    byGroup.set(groupId, run);
    runs.push(run);
  }
  // `drawn` is settled once every member is known: a collapsed group draws the
  // active tab if it holds it, and nothing otherwise.
  for (const run of runs) {
    if (run.groupId === null) continue;
    run.drawn = run.collapsed
      ? run.paths.filter((path) => path === options.activePath)
      : run.paths;
  }
  return runs;
}

/** The tab order as the strip actually draws it — `groupRuns` flattened. Tab
 * shortcuts (⌘1…9, ⌘⇧[/]) and the close-neighbour pick index this, not the
 * stored `openPaths`: grouping pulls a group's later members forward, so the
 * two differ and indexing the raw order would activate the wrong tab. */
export function drawnTabOrder(
  paths: string[],
  groupIdOf: (path: string) => string | null,
  options?: { collapsed?: (groupId: string) => boolean; activePath?: string | null },
): string[] {
  return groupRuns(paths, groupIdOf, options).flatMap((run) => run.drawn);
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

/** Move a whole run (a group and its tabs, or a lone ungrouped tab) to another
 * position, as the flat tab order it produces. Groups drag as one piece — a
 * tab can never be dropped into a group, which is what keeps the drawn order
 * and the stored membership from disagreeing. */
export function moveRun(runs: TabRun[], fromIndex: number, toIndex: number): string[] {
  // Full `paths`, not `drawn`: a collapsed group moves with every member,
  // including the ones it is folding away.
  const next = runs.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return runs.flatMap((run) => run.paths);
  next.splice(toIndex, 0, moved);
  return next.flatMap((run) => run.paths);
}

/** Reorder one tab inside its own run, as the flat tab order it produces.
 * Reordering is confined to the run: dragging a grouped tab rearranges that
 * group, never its membership. */
export function moveWithinRun(
  runs: TabRun[],
  runIndex: number,
  fromIndex: number,
  toIndex: number,
): string[] {
  return runs.flatMap((run, index) => {
    if (index !== runIndex) return run.paths;
    const paths = run.paths.slice();
    const [moved] = paths.splice(fromIndex, 1);
    if (!moved) return run.paths;
    paths.splice(toIndex, 0, moved);
    return paths;
  });
}
