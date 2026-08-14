import type { useRepo } from "@/store/repo";
import type { useUi } from "@/store/ui";
import type { useBranchOp } from "@/components/chrome/overlays/shared";
import type { BranchContextMenuPolicy } from "@/components/chrome/overlays/menus/branchContextMenuPolicy";
import type { menuAction } from "@/components/chrome/overlays/menus/menuAction";
import type { useRemoveWorktree } from "@/components/chrome/overlays/menus/useRemoveWorktree";

type RepoState = ReturnType<typeof useRepo.getState>;
type UiState = ReturnType<typeof useUi.getState>;

/** Everything the branch menu's row builders read, resolved once by the
 * container: the pure policy, the menu payload, and the store actions the rows
 * dispatch to. The builders stay dumb painters over this. */
export type BranchMenuContext = BranchContextMenuPolicy & {
  /** The branch the menu was opened on. */
  b: string;
  /** The checked-out branch, if any. */
  cur: string | null;
  isCurrent: boolean;
  headOid: string | null;
  repoPath: string | null;
  workdir: string;
  branches: RepoState["branches"];
  worktrees: RepoState["worktrees"];
  /** Can the current branch fast-forward to this one? */
  canFf: boolean;
  /** A forge that has no pull requests at all. */
  prsUnsupported: boolean;
  act: ReturnType<typeof menuAction>;
  run: ReturnType<typeof useBranchOp>;
  requestRemoveWorktree: ReturnType<typeof useRemoveWorktree>;
  close: UiState["closeOverlays"];
  requestConfirm: UiState["requestConfirm"];
  requestPrompt: UiState["requestPrompt"];
  openHandoff: UiState["openHandoff"];
  openDeleteWorktree: UiState["openDeleteWorktree"];
  showToast: UiState["showToast"];
  openCreateBranchFrom: UiState["openCreateBranchFrom"];
  openCreatePr: UiState["openCreatePr"];
  openCompare: RepoState["openCompare"];
  createPatchAt: RepoState["createPatchAt"];
  checkoutBranch: RepoState["checkoutBranch"];
  checkoutRemoteBranch: RepoState["checkoutRemoteBranch"];
  removeBranch: RepoState["removeBranch"];
  renameBranchTo: RepoState["renameBranchTo"];
  setUpstreamFor: RepoState["setUpstreamFor"];
  pushBranch: RepoState["pushBranch"];
  publishBranch: RepoState["publishBranch"];
  pull: RepoState["pull"];
  push: RepoState["push"];
  forcePush: RepoState["forcePush"];
  deleteRemoteBranch: RepoState["deleteRemoteBranch"];
  mergeInto: RepoState["mergeInto"];
  rebaseOnto: RepoState["rebaseOnto"];
  fastForwardTo: RepoState["fastForwardTo"];
  resetBranchTo: RepoState["resetBranchTo"];
  cherryPickCommit: RepoState["cherryPickCommit"];
  revertCommit: RepoState["revertCommit"];
  createTagAt: RepoState["createTagAt"];
  createAnnotatedTagAt: RepoState["createAnnotatedTagAt"];
  createWorktreeAt: RepoState["createWorktreeAt"];
  openWorktree: RepoState["openWorktree"];
};
