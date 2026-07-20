import { NavCategory, RowKind } from "./refs";
import type { NavRefItem, NavigatorSections, StashItem, WorktreeItem } from "./useNavigatorSections";

/* The list pane is virtualized, which needs one flat, indexable sequence rather
 * than nested sections. Everything the pane can render becomes an item here —
 * including the section headers and the pinned/unpinned separator, so their
 * heights are part of the same coordinate space as the rows. Pure: no React, no
 * stores, so the ordering and the height math are testable on their own. */

export const NavItemKind = {
  Header: "header",
  /** The Worktrees category's "Remove detached (N)" action, which stands alone
   * when there's no section header to hang it on. */
  Sweep: "sweep",
  Separator: "separator",
  Ref: "ref",
  Worktree: "worktree",
  Stash: "stash",
} as const;
export type NavItemKind = (typeof NavItemKind)[keyof typeof NavItemKind];

export type NavListItem =
  | { kind: typeof NavItemKind.Header; label: string; count: number; sweep: boolean }
  | { kind: typeof NavItemKind.Sweep }
  | { kind: typeof NavItemKind.Separator; section: string }
  | { kind: typeof NavItemKind.Ref; rowKind: RowKind; item: NavRefItem }
  | { kind: typeof NavItemKind.Worktree; item: WorktreeItem }
  | { kind: typeof NavItemKind.Stash; item: StashItem };

/** Rendered heights in px, matching the row classes exactly — the virtualizer
 * places items from these, so a value that disagrees with the CSS shows up as
 * scroll drift. Rows sit flush (no margins); only the separator carries any. */
const HEIGHTS: Record<NavItemKind, number> = {
  [NavItemKind.Header]: 28, // h-7
  [NavItemKind.Sweep]: 28, // h-7
  [NavItemKind.Separator]: 9, // h-px + my-1
  [NavItemKind.Ref]: 32, // h-8
  [NavItemKind.Worktree]: 44, // min-h-[2.75rem], single-line label + path
  [NavItemKind.Stash]: 32, // h-8
};

export function navItemHeight(item: NavListItem): number {
  return HEIGHTS[item.kind];
}

/** Stable per-item key — the virtualizer reuses DOM by key, so these must not
 * collide across sections (a branch and a tag can share a name). */
export function navItemKey(item: NavListItem, index: number): string {
  switch (item.kind) {
    case NavItemKind.Ref:
      return `${item.kind}:${item.rowKind}:${item.item.name}`;
    case NavItemKind.Worktree:
      return `${item.kind}:${item.item.wt.path}`;
    case NavItemKind.Stash:
      return `${item.kind}:${item.item.stash.index}`;
    case NavItemKind.Header:
      return `${item.kind}:${item.label}`;
    // Separators repeat per section; the section name disambiguates them.
    case NavItemKind.Separator:
      return `${item.kind}:${item.section}`;
    default:
      return `${item.kind}:${index}`;
  }
}

const refItems = (
  section: NavigatorSections["locals"],
  rowKind: RowKind,
  sectionName: string,
): NavListItem[] =>
  section.items.flatMap((item, index) =>
    index === section.separatorAt
      ? [
          { kind: NavItemKind.Separator, section: sectionName } as NavListItem,
          { kind: NavItemKind.Ref, rowKind, item },
        ]
      : [{ kind: NavItemKind.Ref, rowKind, item }],
  );

const worktreeItems = (section: NavigatorSections["worktrees"]): NavListItem[] =>
  section.items.map((item) => ({ kind: NavItemKind.Worktree, item }));

const stashItems = (section: NavigatorSections["stashes"]): NavListItem[] =>
  section.items.map((item) => ({ kind: NavItemKind.Stash, item }));

/** Flatten the active category into the sequence the list pane renders. "All"
 * interleaves section headers (only for non-empty sections); a single category
 * is a flat list, with the worktree sweep promoted to its own row since there's
 * no header to carry it. */
export function buildNavItems(
  category: NavCategory,
  sections: NavigatorSections,
  { showSweep }: { showSweep: boolean },
): NavListItem[] {
  const { locals, remotes, tags, worktrees, stashes } = sections;
  if (category === NavCategory.All) {
    const groups: { label: string; rows: NavListItem[]; sweep?: boolean }[] = [
      { label: "Branches", rows: refItems(locals, RowKind.Local, "Branches") },
      { label: "Remotes", rows: refItems(remotes, RowKind.Remote, "Remotes") },
      { label: "Worktrees", rows: worktreeItems(worktrees), sweep: showSweep },
      { label: "Tags", rows: refItems(tags, RowKind.Tag, "Tags") },
      { label: "Stashes", rows: stashItems(stashes) },
    ];
    return groups.flatMap((group) =>
      group.rows.length === 0
        ? []
        : [
            {
              kind: NavItemKind.Header,
              label: group.label,
              // Counts the rows shown, so a separator doesn't inflate it.
              count: group.rows.filter((r) => r.kind !== NavItemKind.Separator).length,
              sweep: !!group.sweep,
            } as NavListItem,
            ...group.rows,
          ],
    );
  }
  switch (category) {
    case NavCategory.Branches:
      return refItems(locals, RowKind.Local, "Branches");
    case NavCategory.Remotes:
      return refItems(remotes, RowKind.Remote, "Remotes");
    case NavCategory.Worktrees:
      return showSweep
        ? [{ kind: NavItemKind.Sweep }, ...worktreeItems(worktrees)]
        : worktreeItems(worktrees);
    case NavCategory.Tags:
      return refItems(tags, RowKind.Tag, "Tags");
    case NavCategory.Stashes:
      return stashItems(stashes);
    default:
      return [];
  }
}
