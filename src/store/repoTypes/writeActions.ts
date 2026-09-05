// The repo store's git write actions — one member per operation the write
// layer exposes, grouped the way `repoWriteActions/` is.

import type {
  DeleteBranchPreview,
  DiscardAllPreview,
  DiscardFilePreview,
  ForcePushPreview,
  ResetPreview,
  DiffLine,
  RemoveWorktreePreview,
} from "@/lib/api";

export interface RepoWriteActions {
  /** Ask an ACP-capable agent one question about `repoPath` and resolve with its
   * answer. Every in-app agent action goes through here. `runId` tags progress
   * events so concurrent Draft/Describe banners stay isolated. */
  acpPrompt: (
    agentCommand: string,
    repoPath: string,
    model: string,
    config: Record<string, string>,
    prompt: string,
    runId: string,
  ) => Promise<string>;
  /** Stop the ACP turn `runId` started, ending the adapter process. Resolves
   * `false` when it had already finished. */
  acpCancel: (runId: string) => Promise<boolean>;
  /** Checkout `name`; resolves with a toast message, throws the git error so
   * callers can surface it (the global error bar is reserved for open/refresh). */
  checkoutBranch: (name: string) => Promise<string>;
  /** Checkout local `branch` for `remote/branch`, creating it with tracking or
   * safely fast-forwarding it when it already exists. */
  checkoutRemoteBranch: (remote: string, branch: string) => Promise<string>;
  createBranchAt: (name: string, startPoint?: string) => Promise<string>;
  /** Create `name` at the captured detached HEAD and check it out in that
   * exact worktree. */
  createBranchInWorktree: (
    worktreePath: string,
    name: string,
    expectedOid: string,
  ) => Promise<string>;
  /** Delete the exact branch tip from a preview pinned to `repoPath`. */
  removeBranch: (
    name: string,
    expectedOid: string,
    repoPath: string,
    force?: boolean,
  ) => Promise<string>;
  renameBranchTo: (oldName: string, newName: string) => Promise<string>;
  /** Set `branch`'s upstream to the remote-tracking ref `upstream`. */
  setUpstreamFor: (branch: string, upstream: string) => Promise<string>;
  /** Push a branch that isn't necessarily checked out, to its configured
   * remote (origin fallback). */
  pushBranch: (branch: string) => Promise<string>;
  /** Push a branch to `remote/branch` and set that as its upstream. */
  publishBranch: (branch: string, upstream: string) => Promise<string>;
  mergeInto: (from: string, to: string) => Promise<string>;
  fastForwardTo: (from: string, to: string) => Promise<string>;
  /** Rebase the explicit source branch/revision onto the target. */
  rebaseOnto: (source: string, onto: string) => Promise<string>;
  /** Reset the explicit source branch, or detached HEAD when source is null.
   * Pass the leased `preview` from `previewReset` so hard resets cannot discard
   * a different repository state than the confirmation showed (GL-302). */
  resetBranchTo: (
    source: string | null,
    target: string,
    mode: "soft" | "mixed" | "hard",
    preview: ResetPreview,
  ) => Promise<string>;
  /** Stash actions address the stash by commit oid — `stash@{n}` indices go
   * stale whenever any stash is created/dropped, even in another worktree. */
  applyStash: (oid: string, pop: boolean, withIndex?: boolean) => Promise<string>;
  /** Check out `branch` at the stash's parent and apply the stash there. */
  branchFromStash: (oid: string, branch: string) => Promise<string>;
  dropStash: (oid: string) => Promise<string>;
  cherryPickCommit: (sha: string) => Promise<string>;
  revertCommit: (sha: string) => Promise<string>;
  /** Cherry-pick several commits atomically (single git invocation). */
  cherryPickMany: (shas: string[]) => Promise<string>;
  /** Revert several commits atomically (single git invocation). */
  revertMany: (shas: string[]) => Promise<string>;
  /** Squash on HEAD, or on the explicitly captured other-branch target.
   * Both paths preserve uncommitted work and refresh even after partial errors. */
  squashSelection: (shas: string[], message: string, target?: import("@/store/squashTargets").SquashTarget) => Promise<string>;
  /** Create a lightweight tag at `sha` (defaults to HEAD). */
  createTagAt: (name: string, sha?: string) => Promise<string>;
  /** Create an annotated tag (with `message`) at `sha` (defaults to HEAD). */
  createAnnotatedTagAt: (name: string, message: string, sha?: string) => Promise<string>;
  /** Delete a local tag at the exact target the caller saw. A remote copy is
   * re-imported by fetch — pass `alsoRemote` to delete it there too. */
  deleteTag: (name: string, expectedOid: string, alsoRemote?: boolean) => Promise<string>;
  /** Push a tag to `remote` (the default push remote when omitted). */
  pushTag: (name: string, remote?: string) => Promise<string>;
  /** Remove a linked worktree using its Worktree Removal Lease (GL-303). */
  removeWorktree: (worktreePath: string, expectedState: string) => Promise<string>;
  /** Hand a branch off from one worktree to another (GL-74): detach the source,
   * check the branch out in `toWorktreePath`, and — when `carry` — bring the
   * source's uncommitted work along. Lands the app on the destination; a
   * conflicting carry opens the conflict workspace there. */
  moveBranchToWorktree: (
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) => Promise<string>;
  /** Preview deleting `branch` (unmerged-commit warning + recovery note) for the
   * delete-branch-and-worktree dialog's configure screen. A read-shaped preview,
   * so it does not refresh. */
  previewDeleteBranch: (branch: string) => Promise<DeleteBranchPreview>;
  /** Preview Linked Worktree Removal and capture the Worktree Removal Lease. */
  previewRemoveWorktree: (worktreePath: string) => Promise<RemoveWorktreePreview>;
  /** Remove the linked worktree holding `branch`, then delete the branch — the
   * one-step path when a branch's Delete is locked by its worktree. `repoPath` is
   * explicit (not read from the live summary) so the op stays pinned to the repo
   * the dialog started on across a mid-run switch. Requires both the branch tip
   * lease and the worktree lease (GL-303). Does NOT refresh: the GL-107 dialog
   * drives the graph refresh itself so it can surface it as the checklist's
   * "Refreshing" row (see useDeleteWorktreeRun). */
  deleteBranchWithWorktree: (
    branch: string,
    fromWorktreePath: string,
    repoPath: string,
    expectedOid: string,
    expectedState: string,
  ) => Promise<string>;
  /** Delete a branch on its remote. `remote`/`branch` are split from the
   * remote-tracking ref name (e.g. `origin/feature` → `origin`, `feature`). */
  deleteRemoteBranch: (remote: string, branch: string, expectedOid: string) => Promise<string>;
  /** Force-push `branch` using the exact source, route, and destination lease
   * returned by its confirmation preview. */
  forcePush: (branch: string, preview: ForcePushPreview) => Promise<string>;
  /** Discard exactly the whole-worktree state approved by the destructive
   * preview. The backend rejects if HEAD/index/worktree drifted meanwhile. */
  discardAll: (preview: DiscardAllPreview) => Promise<string>;
  /** Write a `.patch` file for one commit into the worktree. */
  createPatchAt: (sha: string) => Promise<string>;
  /** Write one mailbox `.patch` covering the contiguous `base..head` range. */
  createPatchRangeAt: (base: string, head: string) => Promise<string>;
  /** Create a worktree at `worktreePath`, then open it as a repo tab. With
   * `newBranch`, a fresh branch of that name is created at `reference` (its
   * start point) and checked out in the worktree; otherwise the worktree is
   * checked out to `reference` directly. */
  createWorktreeAt: (
    worktreePath: string,
    reference: string,
    newBranch?: string,
  ) => Promise<string>;
  /** Switch the app to an existing worktree. By default the current tab's
   * path switches in place — one repository, one tab (GL-110); `newTab` is the
   * explicit side-by-side action, opening a separate worktree-styled tab
   * grouped next to this repository's tabs. */
  openWorktree: (worktreePath: string, opts?: { newTab?: boolean }) => Promise<void>;
  checkoutDetached: (sha: string) => Promise<string>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  /** Stage every file under a directory at once (Tree-view folder roll-up). */
  stagePaths: (paths: string[]) => Promise<void>;
  /** Unstage every file under a directory at once (Tree-view folder roll-up). */
  unstagePaths: (paths: string[]) => Promise<void>;
  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff. */
  applyHunk: (
    path: string,
    staged: boolean,
    hunkIndex: number,
    expectedHeader: string,
    expectedBody: string,
  ) => Promise<void>;
  /** Stage one changed line from an unstaged diff, or unstage one changed line from a staged diff. */
  applyLine: (path: string, staged: boolean, hunkIndex: number, lineIndex: number, line: DiffLine) => Promise<void>;
  /** Preview one exact path-local discard and capture its backend state lease. */
  previewDiscardFile: (
    repoPath: string,
    path: string,
    previousPath: string | null,
    staged: boolean,
  ) => Promise<DiscardFilePreview>;
  /** Execute the exact file discard approved by `previewDiscardFile`. */
  discardFile: (
    repoPath: string,
    path: string,
    previousPath: string | null,
    staged: boolean,
    expectedState: string,
  ) => Promise<void>;
  /** Append one ignore pattern (root `.gitignore` or local exclude). */
  appendIgnorePattern: (pattern: string, local?: boolean) => Promise<void>;
  /** Reveal a repo-relative path in the OS file manager. */
  revealInFileManager: (path: string) => Promise<void>;
  /** Open a worktree leaf with the OS default application. */
  openPathDefault: (path: string) => Promise<void>;
  /** Open a tracked path in the configured `git difftool`. */
  openPathDifftool: (path: string) => Promise<void>;
  /** Stop tracking a path (`git rm --cached`) while keeping it on disk. */
  stopTracking: (path: string) => Promise<void>;
  /** Write a `.patch` for one path's working-tree change. */
  createWorkingTreePatch: (path: string) => Promise<string>;
  /** Pathspec stash for one working-tree file. */
  stashFile: (path: string) => Promise<void>;
  /** ADR 0003: true when restoring would change on-disk bytes. */
  worktreeDiffersFromCommit: (commitOid: string, path: string) => Promise<boolean>;
  /** ADR 0003: true when `path` has a restorable (non-gitlink) blob at `commitOid`.
   * The merged-selection surface probes the selection tip before offering Restore. */
  commitPathIsRestorable: (commitOid: string, path: string) => Promise<boolean>;
  /** ADR 0003: restore one path into the worktree from a commit (does not stage). */
  restorePathFromCommit: (commitOid: string, path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (summary: string, description: string, amend: boolean) => Promise<void>;
  /** Reword the previous commit when it has not been pushed. */
  amendHeadMessage: (summary: string, description: string) => Promise<string>;
  /** Commit the currently staged changes with `message`. Returns whether the
   * commit completed, so the inline composer only clears after success. */
  commitSelected: (message: string, amend?: boolean) => Promise<boolean>;
  stash: () => Promise<void>;
  /** Fetch all remotes. Quiet mode suppresses progress/success notifications
   * for scheduled background runs while preserving the same auth routing.
   * Resolves true when the fetch itself succeeded (even if the follow-up
   * refresh failed), so the auto-fetch scheduler can back off on failures. */
  fetch: (opts?: { quiet?: boolean }) => Promise<boolean>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
}
