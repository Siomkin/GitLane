import { useRef, useState, type ReactNode } from "react";
import { useVirtualizer, type Rect, type Virtualizer } from "@tanstack/react-virtual";
import { useUi } from "@/store/ui";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";
import { NavCategory } from "./refs";
import { useNavigatorSections } from "./useNavigatorSections";
import { buildNavItems, navItemHeight, navItemKey, NavItemKind, type NavListItem } from "./navItems";
import { useRemoveDetachedWorktrees } from "./useRowActions";
import { BranchRow, SectionHeader, StashRow, WorktreeRow } from "./rows";
import { CategorySidebar } from "./CategorySidebar";
import { NavEmptyState } from "./NavEmptyState";

/** Fixed height of the list body (design spec) — and therefore the virtualizer's
 * viewport whenever the platform hasn't measured one. */
const LIST_HEIGHT = 392;
/** Rows rendered beyond the viewport on each side, so a fast scroll or a
 * keyboard focus move lands on a mounted row. */
const NAV_OVERSCAN_ROWS = 8;

/** Track the scroll element's size, but treat a reported height of 0 as "not
 * measured yet" and fall back to the pane's fixed height. Zero is never a real
 * viewport here: it means the pre-layout frame in a browser, or an environment
 * that doesn't lay out at all (happy-dom in the tests), and taking it at face
 * value collapses the window to nothing so no rows mount. */
function observeListRect(
  instance: Virtualizer<HTMLDivElement, Element>,
  cb: (rect: Rect) => void,
): (() => void) | void {
  const element = instance.scrollElement;
  if (!element) return;
  const report = () => {
    const rect = element.getBoundingClientRect();
    cb({ width: rect.width, height: rect.height || LIST_HEIGHT });
  };
  report();
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(report);
  observer.observe(element);
  return () => observer.disconnect();
}

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

  // Hidden while searching: `detachedRemovable` counts the whole worktree
  // list, so a filter that hides some rows would make the "(N)" read higher
  // than what's visible and sweep unshown rows.
  const showSweep = !filtering && detachedRemovable.length > 0;
  const sweepAction = showSweep ? (
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

  const items = buildNavItems(category, sections, { showSweep });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => navItemHeight(items[index]),
    overscan: NAV_OVERSCAN_ROWS,
    getItemKey: (index) => navItemKey(items[index], index),
    // The body is a fixed 392px, so the very first window is exact rather than
    // a guess; `observeListRect` keeps it that way until a real measurement.
    initialRect: { width: 0, height: LIST_HEIGHT },
    observeElementRect: observeListRect,
  });
  const virtualItems = virtualizer.getVirtualItems();

  const renderItem = (item: NavListItem): ReactNode => {
    switch (item.kind) {
      case NavItemKind.Header:
        return (
          <SectionHeader label={item.label} count={item.count} action={item.sweep ? sweepAction : undefined} />
        );
      case NavItemKind.Sweep:
        return <div className="flex h-7 items-center justify-end px-2">{sweepAction}</div>;
      case NavItemKind.Separator:
        return <PinSeparator />;
      case NavItemKind.Ref:
        return (
          <BranchRow
            name={item.item.name}
            kind={item.rowKind}
            oid={item.item.oid}
            isCurrent={!!item.item.current}
            pinned={item.item.pinned}
            query={filter}
            sync={item.item.sync}
            worktree={item.item.worktree}
          />
        );
      case NavItemKind.Worktree:
        return (
          <WorktreeRow
            wt={item.item.wt}
            oid={item.item.oid}
            isActive={item.item.isActive}
            label={item.item.label}
            query={filter}
          />
        );
      case NavItemKind.Stash:
        return <StashRow stash={item.item.stash} query={filter} />;
    }
  };

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
    // Spacer padding rather than absolutely positioned items: rows keep their
    // natural height, so a row that outgrows its estimate (a wrapped worktree
    // path, a longer sync badge) pushes its neighbours down instead of being
    // overlapped by them. Only the scroll extent depends on the estimates.
    const first = virtualItems[0];
    const last = virtualItems[virtualItems.length - 1];
    return (
      <>
        <div style={{ height: first ? first.start : 0 }} />
        {virtualItems.map((virtualItem) => (
          <div key={virtualItem.key} data-index={virtualItem.index}>
            {renderItem(items[virtualItem.index])}
          </div>
        ))}
        <div style={{ height: last ? virtualizer.getTotalSize() - last.end : 0 }} />
      </>
    );
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

      <div className="flex" style={{ height: LIST_HEIGHT }}>
        <CategorySidebar active={category} counts={counts} onSelect={selectCategory} />
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto p-1.5">
          {list}
        </div>
      </div>
    </div>
  );
}
