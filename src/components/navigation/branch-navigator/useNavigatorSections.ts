import { useMemo } from "react";
import { BranchKind, type BranchSyncState, type StashEntry, type WorktreeInfo } from "@/lib/api";
import { isActiveWorktreePath, worktreeLabel, worktreeName } from "@/lib/worktrees";
import { useRepo } from "@/store/repo";
import { collectTags, makeRefOidResolver, type RefItem } from "./refs";

/** A navigable ref row plus whether it matches the active search. While
 * filtering, non-matches are removed from the popup. */
export interface NavRefItem extends RefItem {
  match: boolean;
  sync?: BranchSyncState | null;
  /** Name of the worktree this branch is checked out in, when that worktree is
   * not the one currently open (so the row can flag it as busy elsewhere). */
  worktree?: string | null;
}

/** A worktree paired with the oid to navigate to (its branch tip, when that tip
 * is in the loaded graph — worktrees carry no explicit target) and its match
 * flag. */
export interface WorktreeItem {
  wt: WorktreeInfo;
  oid?: string;
  match: boolean;
  /** This worktree backs the currently open repo tab (the "you are here" row). */
  isActive: boolean;
  /** Row label: the branch, or a distinguishing directory name when detached
   * (disambiguated against sibling worktrees — see {@link worktreeLabel}). */
  label: string;
}

/** A stash row paired with its match flag. */
export interface StashItem {
  stash: StashEntry;
  match: boolean;
}

/** The navigator's view-model: sections sorted with their visible membership
 * (filtered down to matches when a query is active), plus the checked-out
 * branch, whether a search is active, whether anything matches it, and whether
 * the repo has no refs at all.
 * All the store reads and ref→oid resolution live here so the rows stay purely
 * presentational. */
export interface NavigatorSections {
  locals: NavRefItem[];
  remotes: NavRefItem[];
  tags: NavRefItem[];
  worktrees: WorktreeItem[];
  stashes: StashItem[];
  head: string | null;
  /** A search term is present (so non-matches should be dimmed). */
  filtering: boolean;
  /** No refs/worktrees/stashes at all (an empty repo), regardless of search. */
  isEmpty: boolean;
  /** At least one row matches the active search (meaningful only while filtering). */
  hasMatches: boolean;
}

export function useNavigatorSections(filter: string): NavigatorSections {
  const branches = useRepo((s) => s.branches);
  const worktrees = useRepo((s) => s.worktrees);
  const stashes = useRepo((s) => s.stashes);
  const graph = useRepo((s) => s.graph);
  const summary = useRepo((s) => s.summary);

  const lower = filter.trim().toLowerCase();
  const filtering = lower !== "";
  const matches = (text: string) => !filtering || text.toLowerCase().includes(lower);

  // Derived once per graph (not per keystroke). Branches resolve via their own
  // `target` (the authoritative tip), falling back to the graph only when it's
  // null — so a tag sharing a branch's name can't hijack the branch's destination.
  const oidByName = useMemo(() => makeRefOidResolver(graph?.commits ?? []), [graph?.commits]);
  const allTags = useMemo(() => collectTags(graph?.commits ?? []), [graph?.commits]);
  const head = summary?.headBranch ?? null;

  // The worktree backing the open tab is resolved by the shared helper
  // (`isActiveWorktreePath`), the single source of that derivation across the
  // navigator, the worktree context menu, and the toolbar indicator.
  // Map each branch checked out in a *non-active* worktree to that worktree's
  // name, so the Local list can flag it: such a branch can't be checked out or
  // deleted here while another worktree holds it.
  const branchWorktree = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch && !isActiveWorktreePath(summary, wt.path)) {
      // Disambiguated name (parent/leaf on collisions) — agent tools nest every
      // worktree under `<id>/<repo>`, so the raw leaf names nothing.
      branchWorktree.set(wt.branch, worktreeName(wt, worktrees));
    }
  }

  const locals = branches
    .filter((b) => b.kind === BranchKind.Local)
    .map((b) => ({
      name: b.name,
      oid: b.target ?? oidByName.get(b.name),
      match: matches(b.name),
      sync: b.sync,
      worktree: branchWorktree.get(b.name) ?? null,
    }))
    .sort((a, b) => (a.name === head ? -1 : b.name === head ? 1 : a.name.localeCompare(b.name)));
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote)
    .map((b) => ({ name: b.name, oid: b.target ?? oidByName.get(b.name), match: matches(b.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tags = allTags
    .map((t) => ({ ...t, match: matches(t.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Resolve a worktree's tip like a branch row does — prefer the branch's
  // authoritative `target`, fall back to the graph — so a worktree whose branch
  // tip is outside the loaded window still navigates. A detached worktree has
  // no branch, but its HEAD oid still locates it in the graph.
  const worktreeItems = worktrees.map((wt) => ({
    wt,
    oid:
      (wt.branch
        ? (branches.find((b) => b.name === wt.branch)?.target ?? oidByName.get(wt.branch))
        : undefined) ??
      wt.head ??
      undefined,
    // Match the path too — it's shown as the row's secondary text now, so a
    // search for a path fragment should surface the worktree.
    match: matches(wt.branch ?? wt.name) || matches(wt.path),
    isActive: isActiveWorktreePath(summary, wt.path),
    label: worktreeLabel(wt, worktrees),
  }));
  const stashItems = stashes.map((s) => ({ stash: s, match: matches(s.message) }));

  const visible = <T extends { match: boolean }>(items: T[]) =>
    filtering ? items.filter((item) => item.match) : items;
  const visibleLocals = visible(locals);
  const visibleRemotes = visible(remotes);
  const visibleTags = visible(tags);
  const visibleWorktrees = visible(worktreeItems);
  const visibleStashes = visible(stashItems);

  const rawSections = [locals, remotes, tags, worktreeItems, stashItems];
  const visibleSections = [visibleLocals, visibleRemotes, visibleTags, visibleWorktrees, visibleStashes];
  const isEmpty = rawSections.every((section) => section.length === 0);
  // Only meaningful while filtering (every row matches when no search is active).
  const hasMatches = filtering && visibleSections.some((section) => section.length > 0);

  return {
    locals: visibleLocals,
    remotes: visibleRemotes,
    tags: visibleTags,
    worktrees: visibleWorktrees,
    stashes: visibleStashes,
    head,
    filtering,
    isEmpty,
    hasMatches,
  };
}
