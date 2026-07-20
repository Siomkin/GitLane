import { useMemo } from "react";
import { BranchKind, type BranchSyncState, type StashEntry, type WorktreeInfo } from "@/lib/api";
import {
  isActiveWorktreePath,
  removableDetachedWorktrees,
  worktreeLabel,
  worktreeName,
} from "@/lib/worktrees";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { collectTags, makeRefOidResolver, pinKey, RowKind, type RefItem } from "./refs";
import { orderWithPins } from "./pinning";

/** A navigable ref row plus whether it matches the active search. While
 * filtering, non-matches are removed from the popup. */
/** Most recently updated first. Git records no branch creation time, so rows
 * order by their tip commit's committer time; a row whose tip can't be resolved
 * has no time to compare and sinks below the dated ones, alphabetical among its
 * peers (as are two branches sharing a tip). */
function byRecency(a: { name: string; tipTime: number | null }, b: { name: string; tipTime: number | null }) {
  if (a.tipTime !== b.tipTime) {
    if (a.tipTime === null) return 1;
    if (b.tipTime === null) return -1;
    return b.tipTime - a.tipTime;
  }
  return a.name.localeCompare(b.name);
}

export interface NavRefItem extends RefItem {
  match: boolean;
  /** Committer time of the tip (epoch seconds) — the sort key; see {@link byRecency}. */
  tipTime?: number | null;
  /** This row is pinned to the top of its section (persisted in the ui store). */
  pinned: boolean;
  /** The checked-out branch — always sorts first, ahead of pins. */
  current?: boolean;
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

/** One navigator section: its visible rows (match-filtered while searching,
 * pin-ordered where the section supports pins), the index of the row before
 * which the pinned/unpinned hairline is drawn, and the section's unfiltered
 * total (the sidebar count / "N of M" denominator). */
export interface NavSection<T> {
  items: T[];
  separatorAt: number | null;
  total: number;
}

/** The navigator's view-model: sections with their visible membership (filtered
 * down to matches when a query is active, pinned rows sorted to the top), plus
 * the checked-out branch, whether a search is active, whether anything matches
 * it, and whether the repo has no refs at all.
 * All the store reads and ref→oid resolution live here so the rows stay purely
 * presentational. */
export interface NavigatorSections {
  locals: NavSection<NavRefItem>;
  remotes: NavSection<NavRefItem>;
  tags: NavSection<NavRefItem>;
  worktrees: NavSection<WorktreeItem>;
  stashes: NavSection<StashItem>;
  /** Detached worktrees the bulk "Remove detached" header action may delete
   * (never main, never the one backing the open tab). */
  detachedRemovable: WorktreeInfo[];
  head: string | null;
  /** A search term is present (so non-matches are removed). */
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
  const pinnedNavRefs = useUi((s) => s.pinnedNavRefs);

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
  // name, so the Branches list can flag it: such a branch can't be checked out
  // or deleted here while another worktree holds it.
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
      pinned: !!pinnedNavRefs[pinKey(RowKind.Local, b.name)],
      current: b.name === head,
      tipTime: b.tipTime ?? null,
      sync: b.sync,
      worktree: branchWorktree.get(b.name) ?? null,
    }))
    .sort(byRecency);
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote)
    .map((b) => ({
      name: b.name,
      oid: b.target ?? oidByName.get(b.name),
      match: matches(b.name),
      pinned: !!pinnedNavRefs[pinKey(RowKind.Remote, b.name)],
      tipTime: b.tipTime ?? null,
    }))
    .sort(byRecency);
  // Tags read newest-first: descending, with numeric collation so v1.10.0 sorts
  // above v1.9.0 (plain lexicographic order would invert them).
  const tags = allTags
    .map((t) => ({ ...t, match: matches(t.name), pinned: !!pinnedNavRefs[pinKey(RowKind.Tag, t.name)] }))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
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
  const detachedRemovable = removableDetachedWorktrees(worktrees, summary);

  const visible = <T extends { match: boolean }>(items: T[]) =>
    filtering ? items.filter((item) => item.match) : items;
  // Pin-ordering runs on the visible rows so the pinned/unpinned hairline
  // always lands between rows that are actually shown.
  const pinSection = <T extends NavRefItem>(items: T[]): NavSection<T> => {
    const { rows, separatorAt } = orderWithPins(visible(items));
    return { items: rows, separatorAt, total: items.length };
  };
  const plainSection = <T extends { match: boolean }>(items: T[]): NavSection<T> => ({
    items: visible(items),
    separatorAt: null,
    total: items.length,
  });

  const localSection = pinSection(locals);
  const remoteSection = pinSection(remotes);
  const tagSection = pinSection(tags);
  const worktreeSection = plainSection(worktreeItems);
  const stashSection = plainSection(stashItems);

  const sections = [localSection, remoteSection, tagSection, worktreeSection, stashSection];
  const isEmpty = sections.every((section) => section.total === 0);
  // Only meaningful while filtering (every row matches when no search is active).
  const hasMatches = filtering && sections.some((section) => section.items.length > 0);

  return {
    locals: localSection,
    remotes: remoteSection,
    tags: tagSection,
    worktrees: worktreeSection,
    stashes: stashSection,
    detachedRemovable,
    head,
    filtering,
    isEmpty,
    hasMatches,
  };
}
