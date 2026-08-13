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

/** Right-click menu on a file row — working-changes rows and a committed
 * commit's changed-file list. */
export interface FileMenu {
  x: number;
  y: number;
  /** Repo-relative path of the file, or — when `dir` is set — of the directory. */
  path: string;
  /** Set when the menu targets a Tree-view directory header rather than a file:
   * a copy-only menu (folder name / relative / full path), with none of the
   * file-specific actions (open, history, discard). Working-tree directories also
   * offer Ignore folder… (ADR 0002). */
  dir?: boolean;
  /** Working-tree discard target. Present for working-changes rows (drives the
   * Discard / Delete / Ignore items); omitted for committed files. */
  discard?: { staged: boolean };
  /** Committed-file restore target (ADR 0003). Present when the row has a blob
   * at that commit; drives Restore from this commit…. */
  restore?: { commitOid: string };
  /** Working-tree Tree-view directory header — enables Ignore folder…. */
  working?: boolean;
}

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
  | { kind: typeof MenuKind.Worktree; state: WorktreeMenu };

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

/** Menus and the drag payload they can carry. Every one is repo-bound: a switch
 * can land after a menu opened while `open_repo` was still pending, and keeping
 * that payload would render repo A's subject against repo B's store actions. */
export const resetMenus = () =>
  ({ menu: null, draggingFrom: null }) satisfies Pick<MenuSlice, "menu" | "draggingFrom">;

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
