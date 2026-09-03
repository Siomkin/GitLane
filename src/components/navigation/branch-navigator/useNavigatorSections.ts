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

/** Stable identity for "this repo has no pins" — returning a fresh `{}` from the
 * store selector would hand `useSyncExternalStore` a new snapshot every render. */
const NO_PINS: Record<string, true> = {};

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
 * is in the loaded graph — worktrees carry no explicit target). */
export interface WorktreeItem {
  wt: WorktreeInfo;
  oid?: string;
  /** This worktree backs the currently open repo tab (the "you are here" row). */
  isActive: boolean;
  /** Row label: the branch, or a distinguishing directory name when detached
   * (disambiguated against sibling worktrees — see {@link worktreeLabel}). */
  label: string;
}

/** A stash row. */
export interface StashItem {
  stash: StashEntry;
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
 * the checked-out branch, whether a search is active, and whether the repo has
 * no refs at all.
 * All the store reads and ref→oid resolution live here so the rows stay purely
 * presentational. */
export interface NavigatorSections {
  locals: NavSection<NavRefItem>;
  remotes: NavSection<NavRefItem>;
  tags: NavSection<NavRefItem>;
  worktrees: NavSection<WorktreeItem>;
  stashes: NavSection<StashItem>;
  /** The error message of a worktree / stash section whose last read failed
   * (its rows are the last good ones), or null when the read is healthy. The
   * list renders it as an "unavailable" row instead of an empty section. */
  unavailable: { worktrees: string | null; stashes: string | null };
  /** Detached worktrees the bulk "Remove detached" header action may delete
   * (never main, never the one backing the open tab). */
  detachedRemovable: WorktreeInfo[];
  head: string | null;
  /** A search term is present (so non-matches are removed). */
  filtering: boolean;
  /** No refs/worktrees/stashes at all (an empty repo), regardless of search. */
  isEmpty: boolean;
}

/* Deliberately NOT memoized beyond the graph-derived maps below, despite the
 * obvious "this re-sorts every ref on every keystroke" reading. Measured with
 * synthetic repos (median per keystroke, happy-dom, which understates real
 * render cost since it does no layout or paint), before and after the list
 * pane was virtualized:
 *
 *     refs    section building    render/keystroke      initial mount
 *                                  before   after      before    after
 *      600           0.44 ms       8.6 ms   5.3 ms     190 ms    19 ms
 *     2500           1.45 ms      27.3 ms   6.1 ms     513 ms    13 ms
 *     6000           3.01 ms      65.5 ms   7.6 ms    1422 ms    11 ms
 *
 * Mount is now flat in the ref count — the window is ~20 rows whatever the
 * repo holds — so the 1.4s that used to precede the navigator appearing is
 * gone. Virtualizing was the fix; memoizing this hook never was.
 *
 * That does shift the balance: with rendering bounded, section building is now
 * ~40% of a keystroke at 6000 refs rather than ~5%. It still leaves a keystroke
 * at 7.6 ms, inside a 16 ms frame, so it stays unmemoized — but if this ever
 * needs optimizing, the split to make is the filter-INDEPENDENT half (mapping
 * and the recency sort) into a memo, leaving only match/filter/pin-order per
 * keystroke. Memoizing the whole thing on a key that includes the query buys
 * nothing: every keystroke is a fresh key. Re-measure first. */
export function useNavigatorSections(filter: string): NavigatorSections {
  const branches = useRepo((s) => s.branches);
  const worktrees = useRepo((s) => s.worktrees);
  const stashes = useRepo((s) => s.stashes);
  const unavailableSections = useRepo((s) => s.unavailableSections);
  const graph = useRepo((s) => s.graph);
  const summary = useRepo((s) => s.summary);
  const repoPath = summary?.path ?? null;
  const pinnedNavRefs = useUi((s) =>
    repoPath ? (s.pinnedNavRefsByRepo[repoPath] ?? NO_PINS) : NO_PINS,
  );

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
      pinned: !!pinnedNavRefs[pinKey(RowKind.Remote, b.name)],
      tipTime: b.tipTime ?? null,
    }))
    .sort(byRecency);
  // Tags read newest-first: descending, with numeric collation so v1.10.0 sorts
  // above v1.9.0 (plain lexicographic order would invert them).
  const tags = allTags
    .map((t) => ({ ...t, pinned: !!pinnedNavRefs[pinKey(RowKind.Tag, t.name)] }))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  // Branch name → authoritative tip, built once rather than scanning the branch
  // list per worktree below.
  const branchTarget = new Map<string, string>();
  for (const b of branches) {
    if (b.target) branchTarget.set(b.name, b.target);
  }
  // Resolve a worktree's tip like a branch row does — prefer the branch's
  // authoritative `target`, fall back to the graph — so a worktree whose branch
  // tip is outside the loaded window still navigates. A detached worktree has
  // no branch, but its HEAD oid still locates it in the graph.
  const worktreeItems = worktrees.map((wt) => ({
    wt,
    oid:
      (wt.branch ? (branchTarget.get(wt.branch) ?? oidByName.get(wt.branch)) : undefined) ??
      wt.head ??
      undefined,
    isActive: isActiveWorktreePath(summary, wt.path),
    label: worktreeLabel(wt, worktrees),
  }));
  const stashItems = stashes.map((s) => ({ stash: s }));
  const detachedRemovable = removableDetachedWorktrees(worktrees, summary);

  const visible = <T>(items: T[], keep: (item: T) => boolean) =>
    filtering ? items.filter(keep) : items;
  // Pin-ordering runs on the visible rows so the pinned/unpinned hairline
  // always lands between rows that are actually shown.
  const pinSection = <T extends NavRefItem>(items: T[]): NavSection<T> => {
    const { rows, separatorAt } = orderWithPins(visible(items, (item) => matches(item.name)));
    return { items: rows, separatorAt, total: items.length };
  };
  const plainSection = <T>(items: T[], keep: (item: T) => boolean): NavSection<T> => ({
    items: visible(items, keep),
    separatorAt: null,
    total: items.length,
  });

  const localSection = pinSection(locals);
  const remoteSection = pinSection(remotes);
  const tagSection = pinSection(tags);
  const worktreeSection = plainSection(
    worktreeItems,
    (item) => matches(item.wt.branch ?? item.wt.name) || matches(item.wt.path),
  );
  const stashSection = plainSection(stashItems, (item) => matches(item.stash.message));

  const sections = [localSection, remoteSection, tagSection, worktreeSection, stashSection];
  const isEmpty = sections.every((section) => section.total === 0);

  return {
    locals: localSection,
    remotes: remoteSection,
    tags: tagSection,
    worktrees: worktreeSection,
    stashes: stashSection,
    unavailable: {
      worktrees: unavailableSections.worktrees ?? null,
      stashes: unavailableSections.stashes ?? null,
    },
    detachedRemovable,
    head,
    filtering,
    isEmpty,
  };
}
