import { useState, type ReactNode } from "react";
import { useUi } from "@/store/ui";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";
import { NavCategory, RowKind } from "./refs";
import {
  useNavigatorSections,
  type NavRefItem,
  type NavSection,
  type NavigatorSections,
} from "./useNavigatorSections";
import { useRemoveDetachedWorktrees } from "./useRowActions";
import { BranchRow, Section, StashRow, WorktreeRow } from "./rows";
import { CategorySidebar } from "./CategorySidebar";
import { NavEmptyState } from "./NavEmptyState";

/** Singular / plural nouns per category — the search placeholder, match count,
 * and empty-state copy all speak in these. */
const KIND_NOUNS: Record<NavCategory, { one: string; many: string }> = {
  [NavCategory.All]: { one: "ref", many: "refs" },
  [NavCategory.Branches]: { one: "branch", many: "branches" },
  [NavCategory.Remotes]: { one: "remote", many: "remotes" },
  [NavCategory.Worktrees]: { one: "worktree", many: "worktrees" },
  [NavCategory.Tags]: { one: "tag", many: "tags" },
  [NavCategory.Stashes]: { one: "stash", many: "stashes" },
};

/** Hairline between a section's pinned run and the rest of its rows. */
function PinSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px bg-black/5 dark:bg-white/5" />;
}

/** The branch / worktree / stash navigator: a two-pane ref palette (per the
 * design) raised by the "Checked out" trigger — a category sidebar on the left
 * (All / Branches / Remotes / Worktrees / Tags / Stashes with counts) and the
 * matching list on the right, grouped under headers in "All". Picking a branch,
 * remote, tag or worktree jumps the graph to its tip (see `revealCommit`);
 * stashes jump to their graph row. This component is composition + the search
 * box and category state — the section data lives in `useNavigatorSections`,
 * pin ordering in `pinning`, row behaviour in `useRowActions`, and the ref→oid
 * resolution in `refs`. */
export function BranchNavigator() {
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const [category, setCategory] = useState<NavCategory>(NavCategory.All);
  const sections = useNavigatorSections(filter);
  const { locals, remotes, tags, worktrees, stashes, detachedRemovable, filtering, isEmpty } = sections;
  const removeDetached = useRemoveDetachedWorktrees(detachedRemovable);

  const counts: Record<NavCategory, number> = {
    [NavCategory.All]:
      locals.total + remotes.total + tags.total + worktrees.total + stashes.total,
    [NavCategory.Branches]: locals.total,
    [NavCategory.Remotes]: remotes.total,
    [NavCategory.Worktrees]: worktrees.total,
    [NavCategory.Tags]: tags.total,
    [NavCategory.Stashes]: stashes.total,
  };
  const visibleByCategory: Record<NavCategory, number> = {
    [NavCategory.All]:
      locals.items.length + remotes.items.length + tags.items.length + worktrees.items.length + stashes.items.length,
    [NavCategory.Branches]: locals.items.length,
    [NavCategory.Remotes]: remotes.items.length,
    [NavCategory.Worktrees]: worktrees.items.length,
    [NavCategory.Tags]: tags.items.length,
    [NavCategory.Stashes]: stashes.items.length,
  };
  const visibleCount = visibleByCategory[category];
  const nouns = KIND_NOUNS[category];
  const countLabel = !filtering
    ? ""
    : category === NavCategory.All
      ? `${visibleCount} ${visibleCount === 1 ? "match" : "matches"}`
      : `${visibleCount} of ${counts[category]}`;

  // Switching category clears the search (per the design) so each tab opens on
  // its full list.
  const selectCategory = (next: NavCategory) => {
    setCategory(next);
    if (filter !== "") setFilter("");
  };

  const refRows = (section: NavSection<NavRefItem>, kind: RowKind): ReactNode =>
    section.items.map((item, index) => (
      <div key={item.name} className="contents">
        {section.separatorAt === index && <PinSeparator />}
        <BranchRow
          name={item.name}
          kind={kind}
          oid={item.oid}
          isCurrent={!!item.current}
          pinned={item.pinned}
          query={filter}
          sync={item.sync}
          worktree={item.worktree}
        />
      </div>
    ));
  const worktreeRows = (section: NavigatorSections["worktrees"]): ReactNode =>
    section.items.map((w) => (
      <WorktreeRow key={w.wt.path} wt={w.wt} oid={w.oid} isActive={w.isActive} label={w.label} query={filter} />
    ));
  const stashRows = (section: NavigatorSections["stashes"]): ReactNode =>
    section.items.map((s) => <StashRow key={s.stash.index} stash={s.stash} query={filter} />);

  // Hidden while searching: `detachedRemovable` counts the whole worktree
  // list, so a filter that hides some rows would make the "(N)" read higher
  // than what's visible and sweep unshown rows.
  const sweepAction =
    !filtering && detachedRemovable.length > 0 ? (
      // Sweep every removable detached worktree at once (confirmed with the
      // target list) — one-by-one removal via each row's menu gets tedious once
      // agent tools pile them up.
      <button
        type="button"
        title={`Remove ${detachedRemovable.length} detached worktree${detachedRemovable.length === 1 ? "" : "s"}`}
        aria-label="Remove all detached worktrees"
        className="shrink-0 text-[10px] font-medium text-neutral-400 transition-colors hover:text-red-600 dark:hover:text-red-400"
        onClick={removeDetached}
      >
        Remove detached ({detachedRemovable.length})
      </button>
    ) : undefined;

  const list = (() => {
    if (visibleCount === 0) {
      if (isEmpty && !filtering) {
        return <div className="px-2 py-6 text-center text-[12px] text-neutral-400">Nothing here yet</div>;
      }
      return (
        <NavEmptyState
          nouns={nouns}
          query={filter.trim()}
          canCreate={category === NavCategory.All || category === NavCategory.Branches}
        />
      );
    }
    if (category === NavCategory.All) {
      const groups: { label: string; rows: ReactNode; count: number; action?: ReactNode }[] = [
        { label: "Branches", rows: refRows(locals, RowKind.Local), count: locals.items.length },
        { label: "Remotes", rows: refRows(remotes, RowKind.Remote), count: remotes.items.length },
        { label: "Worktrees", rows: worktreeRows(worktrees), count: worktrees.items.length, action: sweepAction },
        { label: "Tags", rows: refRows(tags, RowKind.Tag), count: tags.items.length },
        { label: "Stashes", rows: stashRows(stashes), count: stashes.items.length },
      ];
      return groups
        .filter((g) => g.count > 0)
        .map((g) => (
          <Section key={g.label} label={g.label} count={g.count} action={g.action}>
            {g.rows}
          </Section>
        ));
    }
    switch (category) {
      case NavCategory.Branches:
        return refRows(locals, RowKind.Local);
      case NavCategory.Remotes:
        return refRows(remotes, RowKind.Remote);
      case NavCategory.Worktrees:
        return (
          <>
            {sweepAction && <div className="flex h-7 items-center justify-end px-2">{sweepAction}</div>}
            {worktreeRows(worktrees)}
          </>
        );
      case NavCategory.Tags:
        return refRows(tags, RowKind.Tag);
      case NavCategory.Stashes:
        return stashRows(stashes);
    }
  })();

  return (
    <div className="flex flex-col">
      <div className="border-b border-black/5 p-2.5 dark:border-white/5">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-black/[0.03] px-2.5 text-[13px] focus-within:border-[color:var(--accent)] dark:border-white/10 dark:bg-white/[0.04]">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={category === NavCategory.All ? "Search all refs" : `Filter ${nouns.many}`}
            className="min-w-0 flex-1 border-none bg-transparent text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          />
          {countLabel !== "" && (
            <span className="shrink-0 whitespace-nowrap text-[11px] text-neutral-400">{countLabel}</span>
          )}
          {filter !== "" && (
            <button
              type="button"
              title="Clear branch search"
              aria-label="Clear branch search"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFilter("")}
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex h-[392px]">
        <CategorySidebar active={category} counts={counts} onSelect={selectCategory} />
        <div className="min-w-0 flex-1 overflow-auto p-1.5">{list}</div>
      </div>
    </div>
  );
}
