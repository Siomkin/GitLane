import { handoffDestinationOptions, startWorktreeHandoff } from "@/lib/worktreeHandoff";
import { isActiveWorktreePath, trimTrailingSlash } from "@/lib/worktrees";
import { CopyIcon, FolderIcon, PlusIcon, TrashIcon, TreeIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "../shared";

/** Right-click menu on a navigator worktree row. The row's left-click is the
 * primary "switch to this worktree" action now (GL-22); this menu carries the
 * secondary actions — "Open worktree" (same switch, for discoverability), copy
 * path, and remove. The active worktree only offers "Copy path" (it's already
 * open; nothing to open/remove). */
export function WorktreeContextMenu() {
  const menu = useUi((s) => s.worktreeMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const openHandoff = useUi((s) => s.openHandoff);
  const showToast = useUi((s) => s.showToast);
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const changes = useRepo((s) => s.changes);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const run = useBranchOp();
  if (!menu) return null;

  const { path, name, isMain } = menu;
  // The live worktree entry — its branch is the handoff subject, and `locked`
  // decides whether removal needs a lock-override (`--force --force`). Normalize
  // the path compare (trailing slash) to match the handoff helpers.
  const wtEntry = worktrees.find((w) => trimTrailingSlash(w.path) === trimTrailingSlash(path));
  const wtBranch = wtEntry?.branch ?? null;
  const wtLocked = wtEntry?.locked ?? false;
  // Removing the worktree backing the open tab would delete its directory out
  // from under the app, leaving the refresh pointing at a gone path. `isMain`
  // only flags the *primary* worktree, so when the app is opened on a linked
  // worktree it isn't enough — also match the open repo's own path/workdir
  // (the shared helper does both).
  const isActiveWorktree = isActiveWorktreePath(summary, path);
  const items: MenuItem[] = [];
  // The active worktree is already open, so opening it again is a no-op; only
  // offer the switch for the others. "Open worktree" switches the current tab
  // in place (one repository, one tab); "Open in new tab" is the deliberate
  // side-by-side action (GL-110).
  if (!isActiveWorktree) {
    items.push({
      label: "Open worktree",
      icon: <FolderIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void openWorktree(path).catch((e) => showToast(String(e), "error"));
      },
    });
    items.push({
      label: "Open in new tab",
      icon: <PlusIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void openWorktree(path, { newTab: true }).catch((e) => showToast(String(e), "error"));
      },
    });
  }
  // Hand the worktree's branch (and its uncommitted work) off to another
  // workspace (GL-74). Only when it has a branch and a *valid* destination exists
  // (bare / prunable worktrees are filtered out) — never a dead click.
  if (wtBranch && handoffDestinationOptions(worktrees, path).length > 0) {
    const sourceChanges = isActiveWorktree
      ? changes.staged.length + changes.unstaged.length + changes.conflicted.length
      : null;
    items.push({
      label: "Hand off branch to…",
      icon: <TreeIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () =>
        startWorktreeHandoff({
          branch: wtBranch,
          sourcePath: path,
          worktrees,
          sourceChanges,
          openHandoff,
          onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
        }),
    });
  }
  items.push({
    label: "Copy path",
    icon: <CopyIcon className="h-4 w-4" />,
    sep: items.length > 0,
    onClick: () => {
      close();
      void navigator.clipboard?.writeText(path);
      showToast("Copied path");
    },
  });
  // Don't offer removal of the primary worktree (git refuses) or the one
  // currently open in the app (it'd delete the active tab's directory).
  if (!isMain && !isActiveWorktree) {
    items.push({
      label: "Remove worktree",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Remove worktree ${name}?`,
          message: `The linked worktree at ${path} will be removed. Its branch and commits are kept.${
            wtLocked ? " This worktree is locked; removing it will override the lock." : ""
          }`,
          confirmLabel: "Remove worktree",
          danger: true,
          // A locked worktree needs a forced removal (`--force --force` on the
          // backend); an ordinary one stays unforced so git's dirty check applies.
          onConfirm: () => void run(() => removeWorktree(path, wtLocked)),
        }),
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={200} />;
}
