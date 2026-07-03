import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

/** Jump the graph to a ref's tip (scroll + history-tab flip via `revealCommit`)
 * and close the navigator. Shared by branch/remote/tag and worktree rows. */
export function useRevealNavigate() {
  const revealCommit = useRepo((s) => s.revealCommit);
  const closeNav = useUi((s) => s.closeNav);
  return (oid?: string) => {
    if (oid) void revealCommit(oid);
    closeNav();
  };
}

/** Switch the app to a linked worktree and close the navigator. This is a
 * worktree row's primary left-click action — distinct from "reveal tip", which
 * only scrolls the current graph. The switch moves the current tab in place
 * (one repository, one tab — GL-110); `newTab` (cmd/ctrl-click, or the menu's
 * explicit "Open in new tab") opens it side-by-side instead. Errors (e.g. a
 * removed directory) surface as a toast rather than throwing into the click
 * handler, matching the worktree context menu. */
export function useOpenWorktree() {
  const openWorktree = useRepo((s) => s.openWorktree);
  const closeNav = useUi((s) => s.closeNav);
  const showToast = useUi((s) => s.showToast);
  return (worktreePath: string, newTab = false) => {
    closeNav();
    void openWorktree(worktreePath, { newTab }).catch((e) => showToast(String(e), "error"));
  };
}

/** Jump the graph to a stash row without selecting its file list in the right
 * inspector. Right-click actions stay on the stash row itself. */
export function useRevealStashNavigate() {
  const revealStash = useRepo((s) => s.revealStash);
  const closeNav = useUi((s) => s.closeNav);
  return (oid: string) => {
    revealStash(oid);
    closeNav();
  };
}
