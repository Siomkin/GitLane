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
