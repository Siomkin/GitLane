// The single open-menu slot and the drag payload a menu can carry (GL-363).
//
// Coupled by design: half the store's actions close the menu when they open
// something else, so `menu` is the one field other slices write. They declare
// that in their own `set` type (`Pick<MenuSlice, "menu">`) rather than reaching
// through the store — the coupling stays visible at each end.

import type { BranchDragRef, GraphDropTarget } from "@/lib/graphActions";
import type { SliceSet } from "./slice";

/** Which menu the single open-menu slot holds. Compare against these consts,
 * never the raw strings. */
export const MenuKind = {
  Action: "action",
  Context: "context",
  Commit: "commit",
  Stash: "stash",
  File: "file",
  Wip: "wip",
  Tag: "tag",
  Worktree: "worktree",
  RepoTab: "repoTab",
  RepoGroup: "repoGroup",
} as const;
export type MenuKind = (typeof MenuKind)[keyof typeof MenuKind];

/** Drag-and-drop action menu raised when a ref is dropped on a writable graph target. */
export interface ActionMenu {
  x: number;
  y: number;
  from: BranchDragRef;
  to: GraphDropTarget;
}

export interface ContextMenu {
  x: number;
  y: number;
  branch: string;
  isCurrent: boolean;
}

export interface CommitMenu {
  x: number;
  y: number;
  sha: string;
  shortSha: string;
  /** The full multi-selection snapshot when the menu opened, so the menu can
   * switch to batch labels (cherry-pick N, compare range…). Omitted/empty for a
   * single right-click. */
  selection?: string[];
}

export interface StashMenu {
  x: number;
  y: number;
  /** The stash commit oid — stable across list churn, unlike `stash@{n}`
   * indices, which shift whenever any stash is created or dropped (GL-117). */
  oid: string;
  message: string;
}

/** Right-click menu on the synthetic "uncommitted changes" (WIP) row. Carries
 * no payload — it acts on the whole working tree, read from the repo store. */
export interface WipMenu {
  x: number;
  y: number;
}

/** Right-click menu on a tag ref (a pill in the graph or a navigator row).
 * `sha` is the peeled commit for checkout / branch / worktree; `refOid` is the
 * exact lightweight/annotated tag object captured for compare-and-swap delete. */
export interface TagMenu {
  x: number;
  y: number;
  name: string;
  sha: string;
  refOid: string;
}

/** Right-click menu on a worktree row in the navigator. */
export interface WorktreeMenu {
  x: number;
  y: number;
  /** Absolute path of the linked worktree. */
  path: string;
  /** Display label (its branch, falling back to the worktree name). */
  name: string;
  /** The primary worktree can't be removed — hide that action for it. */
  isMain: boolean;
}

/** Right-click menu on a repository tab in the title-bar strip: renaming the
 * repository and its group membership. Carries the tab's own path; the menu
 * resolves it to the repository identity itself (a worktree tab edits its
 * parent repository, which is what the name and group belong to). */
export interface RepoTabMenu {
  x: number;
  y: number;
  path: string;
}

/** Right-click menu on a repository *group* in the title-bar strip — its name
 * in the well, or its collapsed pill. Separate from [`RepoTabMenu`] because
 * the two subjects are different: a tab menu acts on one repository, this one
 * acts on the group as a whole. */
export interface RepoGroupMenu {
  x: number;
  y: number;
  groupId: string;
}

/** Which file-menu variant a [`FileMenu`] carries. Compare against these
 * consts, never the raw strings. */
export const FileMenuKind = {
  Directory: "directory",
  Working: "working",
  Committed: "committed",
} as const;
export type FileMenuKind = (typeof FileMenuKind)[keyof typeof FileMenuKind];

/** Right-click menu on a file row — working-changes rows, a committed
 * commit's changed-file list, and Tree-view directory headers. The `kind`
 * discriminant picks the variant (`FileContextMenu` switches on it); each
 * variant carries exactly the fields its menu reads, so a malformed menu is a
 * compile error rather than a silently wrong variant. */
export type FileMenu = { x: number; y: number; path: string } &
  (
      | {
        kind: typeof FileMenuKind.Directory;
        /** Working-tree directory header — enables Ignore folder… (ADR 0002);
         * committed dirs are Reveal + Copy only (no recursive Restore). */
        working: boolean;
      }
    | {
        kind: typeof FileMenuKind.Working;
        /** Working-tree discard target — drives the Discard / Delete / Ignore
         * items and the staged/unstaged bucket labels. */
        discard: { staged: boolean };
      }
    | {
        kind: typeof FileMenuKind.Committed;
        /** Restore target (ADR 0003). Present when the row has a blob at that
         * commit; drives Restore from this commit…. */
        restore?: { commitOid: string };
      }
  );

/** The single open-menu slot (GL-363). At most one menu is open at a time —
 * by construction: opening any menu replaces whatever was open, so the old
 * "spread noMenus in every opener" convention has nothing left to forget. */
export type OpenMenu =
  | { kind: typeof MenuKind.Action; state: ActionMenu }
  | { kind: typeof MenuKind.Context; state: ContextMenu }
  | { kind: typeof MenuKind.Commit; state: CommitMenu }
  | { kind: typeof MenuKind.Stash; state: StashMenu }
  | { kind: typeof MenuKind.File; state: FileMenu }
  | { kind: typeof MenuKind.Wip; state: WipMenu }
  | { kind: typeof MenuKind.Tag; state: TagMenu }
  | { kind: typeof MenuKind.Worktree; state: WorktreeMenu }
  | { kind: typeof MenuKind.RepoTab; state: RepoTabMenu }
  | { kind: typeof MenuKind.RepoGroup; state: RepoGroupMenu };

export interface MenuSlice {
  /** The single open-menu slot — see [`OpenMenu`]. Read through the
   * per-kind selectors (`commitMenuOf`, …) rather than narrowing inline. */
  menu: OpenMenu | null;
  draggingFrom: BranchDragRef | null;

  /** Open a menu — replaces any menu already open (the slot is exclusive). */
  openMenu: (menu: OpenMenu) => void;
  startDrag: (branch: BranchDragRef) => void;
  clearDrag: () => void;
  closeOverlays: () => void;
}

// Per-kind selectors for the open-menu slot — the one place that narrows it.
// Components subscribe through these (`useUi(commitMenuOf)`), so they re-render
// exactly as they did when each menu was its own field.
export const actionMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.Action ? s.menu.state : null;
export const contextMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.Context ? s.menu.state : null;
export const commitMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.Commit ? s.menu.state : null;
export const stashMenuOf = (s: MenuSlice) => (s.menu?.kind === MenuKind.Stash ? s.menu.state : null);
export const fileMenuOf = (s: MenuSlice) => (s.menu?.kind === MenuKind.File ? s.menu.state : null);
export const wipMenuOf = (s: MenuSlice) => (s.menu?.kind === MenuKind.Wip ? s.menu.state : null);
export const tagMenuOf = (s: MenuSlice) => (s.menu?.kind === MenuKind.Tag ? s.menu.state : null);
export const worktreeMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.Worktree ? s.menu.state : null;
export const repoTabMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.RepoTab ? s.menu.state : null;
export const repoGroupMenuOf = (s: MenuSlice) =>
  s.menu?.kind === MenuKind.RepoGroup ? s.menu.state : null;

/** Menus and the drag payload they can carry. Every one is repo-bound: a switch
 * can land after a menu opened while `open_repo` was still pending, and keeping
 * that payload would render repo A's subject against repo B's store actions. */
export const resetMenus = () =>
  ({ menu: null, draggingFrom: null }) satisfies Pick<MenuSlice, "menu" | "draggingFrom">;

/** The open-menu slot owns the keyboard while it holds a menu. */
export const overlayOpenMenus = (s: MenuSlice) => s.menu !== null;

export function createMenuSlice(set: SliceSet<MenuSlice>): MenuSlice {
  return {
    ...resetMenus(),

    // Menus are mutually exclusive by construction: the slot holds one OpenMenu,
    // so opening any menu replaces whatever was open. Modals/overlays still clear
    // it explicitly (`menu: null`) in their own `set` patches.
    openMenu: (menu) => set(menu.kind === MenuKind.Action ? { menu, draggingFrom: null } : { menu }),
    startDrag: (branch) => set({ draggingFrom: branch }),
    clearDrag: () => set({ draggingFrom: null }),
    closeOverlays: () => set({ menu: null, draggingFrom: null }),
  };
}
