import { handoffDestinationOptions, handoffSourceValid, startWorktreeHandoff } from "@/lib/worktreeHandoff";
import { validateBranchName } from "@/lib/refName";
import { isActiveWorktreePath, trimTrailingSlash } from "@/lib/worktrees";
import { BranchIcon, CopyIcon, FolderIcon, PlusIcon, TrashIcon, TreeIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { useRemoveWorktree } from "./useRemoveWorktree";

/** Right-click menu on a navigator worktree row. The row's left-click reveals
 * the worktree's tip in the graph (consistent with the branch/tag rows); this
 * menu is where *switching* to the worktree lives — "Open worktree" / "Open in
 * new tab" — alongside branch attachment, hand-off, copy path, and remove. The
 * active worktree omits only the actions that would reopen or remove itself. */
export function WorktreeContextMenu() {
  const menu = useUi((s) => s.worktreeMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openHandoff = useUi((s) => s.openHandoff);
  const showToast = useUi((s) => s.showToast);
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const changes = useRepo((s) => s.changes);
  const openWorktree = useRepo((s) => s.openWorktree);
  const createBranchInWorktree = useRepo((s) => s.createBranchInWorktree);
  const requestRemoveWorktree = useRemoveWorktree();
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
  // A detached worktree is useful as an inspection workspace, but users can
  // promote it in place once they decide to keep working from that commit.
  // Capture its oid in the prompt callback; the backend revalidates the exact
  // registered worktree + detached HEAD before `git switch -c` mutates it.
  if (!wtBranch && wtEntry?.head && !wtEntry.bare && !wtEntry.prunable) {
    const detachedHead = wtEntry.head;
    items.push({
      label: "Create branch…",
      icon: <BranchIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () =>
        requestPrompt({
          title: `Create branch in ${name}`,
          message: `Create a branch at ${detachedHead.slice(0, 7)} and check it out in this worktree.`,
          placeholder: "feature/my-branch",
          confirmLabel: "Create branch",
          validate: validateBranchName,
          onSubmit: (branch) =>
            void run(() => createBranchInWorktree(path, branch, detachedHead)),
        }),
    });
  }
  // Hand the worktree's branch (and its uncommitted work) off to another
  // workspace (GL-74). Only when it has a branch, can still run the detach step
  // (not prunable), and a *valid* destination exists (bare / prunable worktrees
  // are filtered out) — never a dead click.
  if (
    wtBranch &&
    handoffSourceValid(worktrees, path) &&
    handoffDestinationOptions(worktrees, path).length > 0
  ) {
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
      // The confirm is built after probing the worktree for uncommitted work,
      // so a dirty worktree is warned about and force-removed on confirm rather
      // than dead-ending on git's refusal (GL-296).
      onClick: () =>
        void requestRemoveWorktree({
          name,
          path,
          branch: wtBranch,
          head: wtEntry?.head ?? null,
          locked: wtLocked,
        }),
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={200} />;
}
