import { api, BranchKind, type FileChange, type RepoSummary } from "@/lib/api";
import {
  discardAllGuardMessage,
  fileWriteGuard,
  findGuardedFile,
  guardedAdvancedWriteMessage,
} from "@/lib/advancedRepoState";
import { splitCommitMessage } from "@/lib/commitMessage";
import { friendlyGitError } from "@/lib/gitError";
import { findOtherBranchWorktree, type WorktreeRef } from "@/lib/graphActions";
import { mergeWasAlreadyUpToDate } from "@/lib/mergeOutcome";
import { pushRemoteForBranch, remoteNameForUpstream } from "@/lib/remoteAccounts";
import { isActiveWorktreePath, trimTrailingSlash, worktreeName } from "@/lib/worktrees";
import {
  handoffDestinationHere,
  handoffSourceValid,
  startWorktreeHandoff,
} from "@/lib/worktreeHandoff";
import { branchWebUrl } from "@/lib/forgeUrls";
import { openExternalUrl } from "@/lib/openExternal";
import { useAccounts } from "./accounts";
import { useNotifications } from "./notifications";
import { flushPendingRefresh } from "./repoGuards";
import {
  currentOpenIntent,
  currentPublishedRepoSession,
  openIntentIsCurrent,
  publishedRepoSessionIsCurrent,
} from "./repoRequests";
import { validateSquashRange } from "./selection";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

// The old-side path of a rename ("R") entry for `path` in `bucket`, or null when
// it isn't a rename. Only renames need both sides staged/unstaged together
// (GL-127): a rename deletes the old path, so acting on the new path alone leaves
// that deletion in the opposite state. A copy ("C") is deliberately excluded —
// it leaves the old path intact, so it must NOT be touched. An "R" with no
// `previousPath` is a backend-invariant breach (post-GL-127 the status pass
// always fills it); warn rather than silently fall back to single-path staging,
// which would resurrect the half-staged-rename bug instead of failing loudly.
function renameOldPath(entry: FileChange | undefined): string | null {
  if (entry?.status !== "R") return null;
  if (!entry.previousPath) {
    console.warn(
      `GL-127: rename entry "${entry.path}" is missing previousPath; staging its new side only`,
    );
    return null;
  }
  return entry.previousPath;
}

// The two paths a rename spans, or null for an ordinary single-path change — so
// the caller can keep using the single-path git command for non-renames.
function renamePaths(bucket: FileChange[], path: string): string[] | null {
  const old = renameOldPath(bucket.find((f) => f.path === path));
  return old ? [old, path] : null;
}

// Expand a path list so any rename in `bucket` also contributes its old side.
// Folder roll-ups (stagePaths/unstagePaths) pass new-side paths only; without
// this a rename under a rolled-up directory would leave the old path's deletion
// in the opposite state (the same GL-127 bug in the bulk flows).
// De-duplicated (a rename and its source both selected won't double up); order
// preserved for stable git invocations.
function withRenameCounterparts(bucket: FileChange[], paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byPath = new Map(bucket.map((entry) => [entry.path, entry]));
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const path of paths) {
    push(path);
    const old = renameOldPath(byPath.get(path));
    if (old) push(old);
  }
  return out;
}

// Shared body for the branch/history write ops: require an open repo, run the
// op, refresh the graph, and return its toast message. Rejects (for the caller
// to toast) when there's no repo or the git op throws.
type RepoWriteOwner = Readonly<{ path: string; openIntent: number; publishedSession: number }>;

function captureOwner(summary: RepoSummary): RepoWriteOwner {
  return {
    path: summary.path,
    openIntent: currentOpenIntent(),
    publishedSession: currentPublishedRepoSession(),
  };
}

function ownerIsCurrent(get: RepoGet, owner: RepoWriteOwner): boolean {
  return get().summary?.path === owner.path &&
    publishedRepoSessionIsCurrent(owner.publishedSession);
}

// Store publication belongs to the displayed session above. Automatic
// navigation is stricter: a newer user open wins as soon as it is claimed,
// even while its phase-1 probe is still pending (and even if it later fails).
function ownerMayNavigate(get: RepoGet, owner: RepoWriteOwner): boolean {
  return ownerIsCurrent(get, owner) && openIntentIsCurrent(owner.openIntent);
}

async function refreshIfCurrent(
  get: RepoGet,
  owner: RepoWriteOwner,
  opts?: Parameters<RepoState["refresh"]>[0],
): Promise<boolean> {
  if (!ownerIsCurrent(get, owner)) return false;
  const refreshed = await get().refresh(opts);
  return refreshed && ownerIsCurrent(get, owner);
}

function releaseLoadingIfCurrent(
  set: RepoSet,
  get: RepoGet,
  owner: RepoWriteOwner,
  flush = false,
): boolean {
  if (!ownerIsCurrent(get, owner)) return false;
  set({ loading: false });
  if (flush) flushPendingRefresh(get);
  return true;
}

type FileSelectionOwner = Readonly<{
  requestId: number;
  fileView: RepoState["fileView"];
}>;

function captureFileSelection(get: RepoGet): FileSelectionOwner {
  return { requestId: get().fileSelectionRequestId, fileView: get().fileView };
}

function fileSelectionIsCurrent(get: RepoGet, owner: FileSelectionOwner): boolean {
  return get().fileSelectionRequestId === owner.requestId && get().fileView === owner.fileView;
}

function commitSetIsCurrent(get: RepoGet, commits: string[]): boolean {
  return get().selectedCommits === commits;
}

async function runOp(
  get: RepoGet,
  body: (summary: RepoSummary, owner: RepoWriteOwner) => Promise<string>,
  opts?: { refreshOnError?: boolean },
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const owner = captureOwner(summary);
  let message: string;
  try {
    message = await body(summary, owner);
  } catch (error) {
    if (opts?.refreshOnError) {
      // Some guarded writes can fail after a partial mutation. Refresh the
      // originating repo, but always rethrow the backend's actionable error —
      // a secondary refresh failure must not replace the operation outcome.
      try {
        await refreshIfCurrent(get, owner);
      } catch {
        // `refresh` currently reports failure as `false`, but keep this boundary
        // fail-safe if that contract ever regresses or a test double rejects.
      }
    }
    throw error;
  }
  await refreshIfCurrent(get, owner);
  return message;
}

// Like `runOp`, but for operations that can legitimately stop on conflicts
// (merge/rebase/cherry-pick/revert). Git exits non-zero when it stops on a
// conflict, but that is not a failure — it's an invitation to resolve. So after
// any error we refresh and check whether an operation is now active: if so, the
// conflict is the outcome (the App surfaces the ConflictWorkspace off
// `operation`), and we return an informational message instead of throwing.
// A genuine failure (no operation in progress) still rejects for the caller to
// toast as an error.
async function runMaybeConflict(
  get: RepoGet,
  body: (summary: RepoSummary) => Promise<string>,
  inProgressLabel: string,
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const owner = captureOwner(summary);
  // Capture whether an operation was ALREADY active before we start: only a
  // *newly* entered operation means this op stopped on conflicts. If one was
  // already in progress (e.g. a terminal-started merge, or a second attempt
  // while the workspace is open), git's failure is genuine and must surface —
  // otherwise every error would be masked as a benign "resolve conflicts".
  const hadOperation = !!get().operation;
  try {
    const message = await body(summary);
    // Don't refresh/publish onto a different repo if the user switched mid-op.
    await refreshIfCurrent(get, owner);
    return message;
  } catch (e) {
    // Switched repos mid-op: surface the raw error; never interpret it (or the
    // global operation) against the now-current, unrelated repo.
    if (!ownerIsCurrent(get, owner)) throw e;
    await refreshIfCurrent(get, owner);
    if (ownerIsCurrent(get, owner) && !hadOperation && get().operation) {
      return `${inProgressLabel} — resolve conflicts to continue`;
    }
    throw e;
  }
}

// Write ops flush the deferred re-sync via the shared repoGuards helper:
// `refresh` already flushes on its own success/failure, but a write op's
// failure path clears `loading` without going through `refresh`, so the queued
// re-sync would otherwise be stranded until the next external event (GL-20).

function toastAdvancedGuard(message: string | null): boolean {
  if (!message) return false;
  useUi.getState().showToast(message, "error");
  return true;
}

function guardedPathMessage(get: RepoGet, path: string): string | null {
  const { changes } = get();
  return fileWriteGuard(
    [...changes.unstaged, ...changes.staged].find((file) => file.path === path),
    changes,
  );
}

function requireHeadOid(summary: RepoSummary, operation: string): string {
  if (!summary.headOid) {
    throw new Error(`Cannot ${operation}: HEAD has no commit.`);
  }
  return summary.headOid;
}

function revisionSnapshot(get: RepoGet, revision: string): { revision: string; oid: string } {
  if (revision === "HEAD") {
    const summary = get().summary;
    if (!summary?.headOid) throw new Error("HEAD has no commit. Refresh and try again.");
    return { revision, oid: summary.headOid };
  }
  const matches = get().branches.filter((candidate) => candidate.name === revision);
  if (matches.length > 1) {
    throw new Error(`Cannot resolve ambiguous ref ${revision}. Refresh and choose it again.`);
  }
  const [branch] = matches;
  if (branch?.target) {
    return {
      revision: branch.kind === BranchKind.Local
        ? `refs/heads/${branch.name}`
        : `refs/remotes/${branch.name}`,
      oid: branch.target,
    };
  }
  // Commit-menu and graph-row callers already carry an immutable oid.
  if (/^[0-9a-f]{7,64}$/i.test(revision)) return { revision, oid: revision };
  throw new Error(`Cannot resolve ${revision}. Refresh and try again.`);
}

function localBranchOid(get: RepoGet, branch: string): string {
  const oid = get().branches.find(
    (candidate) => candidate.kind === BranchKind.Local && candidate.name === branch,
  )?.target;
  if (!oid) throw new Error(`Cannot find branch ${branch}. Refresh and try again.`);
  return oid;
}

async function findCheckoutWorktree(
  set: RepoSet,
  get: RepoGet,
  summary: RepoSummary,
  owner: RepoWriteOwner,
  branch: string,
): Promise<WorktreeRef | null> {
  const currentWorkdir = summary.workdir ?? summary.path;
  const cached = findOtherBranchWorktree(get().worktrees, branch, currentWorkdir);
  if (cached) return cached;

  // On checkout, a cached miss is not enough: the branch may be held by a
  // worktree that is still loading, so probe once before falling through to git.
  const worktrees = await api.listWorktrees(summary.path).catch(() => null);
  if (!worktrees) return null;
  if (!ownerIsCurrent(get, owner)) {
    throw new Error("Repository changed while checking worktrees. Try again.");
  }
  set({ worktrees });
  return findOtherBranchWorktree(worktrees, branch, currentWorkdir);
}

export function createRepoWriteActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "checkoutBranch"
  | "checkoutRemoteBranch"
  | "createBranchAt"
  | "createBranchInWorktree"
  | "removeBranch"
  | "renameBranchTo"
  | "setUpstreamFor"
  | "pushBranch"
  | "publishBranch"
  | "mergeInto"
  | "fastForwardTo"
  | "rebaseOnto"
  | "resetBranchTo"
  | "applyStash"
  | "branchFromStash"
  | "dropStash"
  | "cherryPickCommit"
  | "revertCommit"
  | "cherryPickMany"
  | "revertMany"
  | "squashSelection"
  | "createTagAt"
  | "createAnnotatedTagAt"
  | "deleteTag"
  | "pushTag"
  | "removeWorktree"
  | "moveBranchToWorktree"
  | "previewDeleteBranch"
  | "previewRemoveWorktree"
  | "deleteBranchWithWorktree"
  | "deleteRemoteBranch"
  | "forcePush"
  | "discardAll"
  | "createPatchAt"
  | "createWorktreeAt"
  | "openWorktree"
  | "checkoutDetached"
  | "stageFile"
  | "unstageFile"
  | "stagePaths"
  | "unstagePaths"
  | "applyHunk"
  | "applyLine"
  | "previewDiscardFile"
  | "discardFile"
  | "appendIgnorePattern"
  | "revealInFileManager"
  | "worktreeDiffersFromCommit"
  | "restorePathFromCommit"
  | "stageAll"
  | "unstageAll"
  | "commit"
  | "amendHeadMessage"
  | "commitSelected"
  | "takeAgentCommitDraft"
  | "takeAgentChangeSummary"
  | "stash"
  | "fetch"
  | "pull"
  | "push"
> {
  // Git rejects concurrent fetches when both processes prepare the same
  // remote-tracking ref update from the same old oid. Coalesce every in-app
  // fetch for the displayed repo onto one transport promise; the backend also
  // retries once for the equivalent race with an external git process.
  let fetchTransport: { path: string; promise: Promise<unknown> } | null = null;

  // Per-operation account resolution (GL-129): each network call selects from
  // the exact fetch or push URL it will contact, not one repo-wide pick.
  const authFor = (remote: string | null, direction: "fetch" | "push" = "push") =>
    remote && remote !== "."
      ? useAccounts.getState().transportAuthForRemote(remote, direction)
      : null;
  // The remote a push of `branch` targets — its configured remote from the
  // branch list, with the backend's "origin" fallback.
  const pushRemoteOf = (branch: string) =>
    pushRemoteForBranch(get().branches.find((b) => b.kind === BranchKind.Local && b.name === branch));
  // The default push remote (tags land there when no remote is picked).
  const defaultRemote = () => get().remotes.find((r) => r.isDefault)?.name ?? "origin";
  // Every network transport call (fetch/pull/push/publish/…) runs inside this
  // store-level mutex. Component guards are only UX — context menus, commit-and-
  // push, and other callers enter through the same actions, so the store must be
  // the authority that prevents concurrent remote-ref writers. Fetch is the one
  // joinable operation: its same-repo callers reuse `fetchTransport` below and
  // never try to acquire the mutex twice.
  const trackNet = <T>(work: () => Promise<T>): Promise<T> => {
    if (get().netOps > 0) {
      throw new Error("Another remote operation is already in progress. Try again when it finishes.");
    }
    set((s) => ({ netOps: s.netOps + 1 }));
    // Defer the actual IPC one microtask: fetch publishes `fetchTransport` and
    // `fetchingPath` synchronously after this returns, before git starts work.
    return Promise.resolve()
      .then(work)
      .finally(() => set((s) => ({ netOps: Math.max(0, s.netOps - 1) })));
  };

  return {
    takeAgentCommitDraft: async (repoPath, token) =>
      api.takeAgentCommitDraft(repoPath, token),
    takeAgentChangeSummary: async (repoPath, token) =>
      api.takeAgentChangeSummary(repoPath, token),
    checkoutBranch: async (name) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      const existingWorktree = await findCheckoutWorktree(set, get, summary, owner, name);
      // findCheckoutWorktree guards its own probe path, but the cached path
      // resolves without that check — re-verify ownership after the await so a
      // concurrent tab switch can't pair this repo's dialog with another's state.
      if (!ownerMayNavigate(get, owner)) {
        throw new Error("Repository changed while checking worktrees. Try again.");
      }
      if (existingWorktree) {
        // Git refuses to check a branch out in two worktrees, so this checkout
        // can't proceed as-is. Don't silently switch the tab into the holding
        // worktree (it may be a foreign agent scratch checkout the user never
        // wants to enter) — name that worktree and ask: reclaim the branch here
        // (the hand-off flow, destination preselected) or open it there. Falls
        // back to the plain open when the reclaim isn't possible (the holder is
        // prunable, or the open worktree isn't a valid destination).
        const worktrees = get().worktrees;
        const holder = worktrees.find(
          (wt) => trimTrailingSlash(wt.path) === trimTrailingSlash(existingWorktree.path),
        );
        const here = handoffDestinationHere(
          worktrees,
          existingWorktree.path,
          summary.workdir ?? summary.path,
        );
        if (holder && here && handoffSourceValid(worktrees, holder.path)) {
          const ui = useUi.getState();
          ui.requestConfirm({
            title: `${name} is in another worktree`,
            message: `Git allows a branch to be checked out in only one worktree at a time, and ${name} is currently checked out in "${worktreeName(holder, worktrees)}".`,
            details: [holder.path],
            confirmLabel: "Check out here",
            onConfirm: () => {
              // The confirm can sit open while a watcher refresh prunes the
              // holder, moves the branch, or invalidates the destination — the
              // snapshot above is only what the dialog was opened FROM. Re-gate
              // against the live list before starting the multi-step move (the
              // backend also fails closed, but this keeps the error immediate
              // and readable instead of a mid-handoff failure).
              const liveWorktrees = get().worktrees;
              const liveSummary = get().summary;
              const liveHolder = liveWorktrees.find(
                (wt) => trimTrailingSlash(wt.path) === trimTrailingSlash(holder.path),
              );
              const liveHere =
                liveSummary &&
                handoffDestinationHere(
                  liveWorktrees,
                  holder.path,
                  liveSummary.workdir ?? liveSummary.path,
                );
              if (
                !ownerMayNavigate(get, owner) ||
                liveSummary?.path !== summary.path ||
                liveHolder?.branch !== name ||
                !liveHere ||
                !handoffSourceValid(liveWorktrees, liveHolder.path)
              ) {
                useUi
                  .getState()
                  .showToast(`${name} moved while the dialog was open. Try again.`, "error");
                return;
              }
              startWorktreeHandoff({
                branch: name,
                sourcePath: liveHolder.path,
                worktrees: liveWorktrees,
                // The holder isn't the open repo, so its dirtiness is unknown
                // here — the dialog phrases the carry conditionally.
                sourceChanges: null,
                destPath: liveHere.value,
                openHandoff: useUi.getState().openHandoff,
                onNoDestinations: () =>
                  useUi.getState().showToast("No worktree to check out into.", "error"),
              });
            },
            secondary: {
              label: "Open that worktree",
              onClick: () => {
                if (!ownerMayNavigate(get, owner)) return;
                void get()
                  .openWorktree(holder.path)
                  .catch((e) => useUi.getState().showToast(String(e), "error"));
              },
            },
          });
          // The dialog owns what happens next — nothing to toast.
          return "";
        }
        if (ownerMayNavigate(get, owner)) await get().openWorktree(existingWorktree.path);
        return `Opened ${name} worktree`;
      }
      set({ loading: true, error: null });
      try {
        await api.checkout(summary.path, name, false);
        releaseLoadingIfCurrent(set, get, owner);
        await refreshIfCurrent(get, owner);
        return `Checked out ${name}`;
      } catch (e) {
        // Reset the spinner but let the caller present the failure (toast), so a
        // failed checkout never leaves a stale success message behind. Replay any
        // re-sync deferred while this op held `loading` (GL-20 review).
        releaseLoadingIfCurrent(set, get, owner, true);
        throw e;
      }
    },

    checkoutRemoteBranch: async (remote, branch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      const existingWorktree = await findCheckoutWorktree(set, get, summary, owner, branch);
      if (!ownerMayNavigate(get, owner)) {
        throw new Error("Repository changed while checking worktrees. Try again.");
      }
      set({ loading: true, error: null });
      try {
        // A branch already owned by another worktree must be advanced there:
        // opening it without running the remote checkout would leave the local
        // branch behind the remote ref the user explicitly selected.
        const checkoutPath = existingWorktree?.path ?? summary.path;
        await api.checkoutRemoteBranch(checkoutPath, remote, branch);
        releaseLoadingIfCurrent(set, get, owner);
        if (existingWorktree) {
          if (ownerMayNavigate(get, owner)) await get().openWorktree(existingWorktree.path);
          return `Updated ${branch} and opened its worktree`;
        }
        await refreshIfCurrent(get, owner);
        return `Checked out ${branch}`;
      } catch (e) {
        releaseLoadingIfCurrent(set, get, owner);
        // Checkout and `merge --ff-only` are separate git commands. The
        // backend reports when checkout succeeded but dirty changes blocked
        // the merge; refresh before surfacing that partial outcome so HEAD and
        // the working tree never wait on the watcher to become truthful.
        if (ownerIsCurrent(get, owner)) {
          try {
            await refreshIfCurrent(get, owner);
          } catch {
            // Preserve the operation's actionable error if the recovery read
            // also fails; the watcher can still retry the refresh later.
          }
        }
        if (ownerIsCurrent(get, owner)) flushPendingRefresh(get);
        throw e;
      }
    },

    // Branch operations. Each refreshes the graph and returns a human-readable
    // message for the caller to surface as a toast; failures reject with the
    // git error so the caller can toast that instead.
    createBranchAt: (name, startPoint) =>
      runOp(get, async (summary) => {
        // Send the picked ref (not its oid) as the start point so branching
        // from a remote-tracking ref keeps git's automatic upstream setup; the
        // captured oid pins it to the commit the user saw.
        const start = startPoint
          ? revisionSnapshot(get, startPoint)
          : { revision: "HEAD", oid: requireHeadOid(summary, "create a branch") };
        await api.createBranch(summary.path, name, start.revision, start.oid);
        await api.checkout(summary.path, name, false);
        return `Created ${name}`;
      }),

    createBranchInWorktree: (worktreePath, name, expectedOid) =>
      runOp(get, (summary) =>
        api.createBranchInWorktree(summary.path, worktreePath, name, expectedOid),
      ),

    // The confirmation owns both the exact ref oid and repository path it
    // previewed. Do not route this through runOp (which reads the live summary
    // after the user confirms): a repo switch must never retarget the old
    // dialog's destructive action to the newly-active repository.
    removeBranch: async (name, expectedOid, repoPath, force = false) => {
      if (!repoPath) throw new Error("No repository");
      const active = get().summary;
      if (active?.path !== repoPath) {
        throw new Error("Repository changed; preview the branch deletion again.");
      }
      const owner = captureOwner(active);
      const message = await api.deleteBranch(repoPath, name, expectedOid, force);
      await refreshIfCurrent(get, owner);
      return message || `Deleted ${name}`;
    },

    renameBranchTo: (oldName, newName) =>
      runOp(get, async (summary) => {
        await api.renameBranch(summary.path, oldName, newName);
        return `Renamed ${oldName} → ${newName}`;
      }),

    setUpstreamFor: (branch, upstream) =>
      runOp(get, async (summary) => {
        await api.setUpstream(summary.path, branch, upstream);
        return `Set upstream of ${branch} to ${upstream}`;
      }),

    pushBranch: (branch) =>
      runOp(get, async (summary) => {
        const expectedOid = localBranchOid(get, branch);
        const remote = pushRemoteOf(branch);
        const auth = authFor(remote);
        await trackNet(() => api.pushBranch(
          summary.path,
          branch,
          expectedOid,
          auth,
        ));
        return `Pushed ${branch}`;
      }),

    publishBranch: (branch, upstream) =>
      runOp(get, async (summary) => {
        const remote = remoteNameForUpstream(
          upstream,
          get().remotes.map((r) => r.name),
        );
        const expectedOid = localBranchOid(get, branch);
        const auth = authFor(remote);
        await trackNet(() => api.publishBranch(
          summary.path,
          branch,
          expectedOid,
          upstream,
          auth,
        ));
        return `Published ${branch} to ${upstream}`;
      }),

    mergeInto: (from, to) =>
      runMaybeConflict(
        get,
        async (summary) => {
          const source = revisionSnapshot(get, from);
          const detachedDestination = to === "HEAD" && summary.headBranch === null;
          const destination = detachedDestination ? null : to;
          const destinationOid = detachedDestination
            ? requireHeadOid(summary, "merge")
            : localBranchOid(get, to);
          const output = await api.mergeBranch(
            summary.path,
            source.revision,
            source.oid,
            destination,
            destinationOid,
          );
          // Even under `--no-ff`, git exits 0 and creates nothing when `from`
          // is already reachable from HEAD (equal tips included) — the toast
          // must not claim a merge happened.
          return mergeWasAlreadyUpToDate(output)
            ? `${to} is already up to date with ${from}`
            : `Merged ${from} into ${to}`;
        },
        `Merging ${from} into ${to}`,
      ),

    // `from` is the rev to advance to; `to` is the branch being moved forward.
    // When `to` is the checked-out branch, fast-forward it in the working tree
    // (`merge --ff-only`). Otherwise move its ref in place without a disruptive
    // checkout — so e.g. advancing develop to origin/develop never yanks you off
    // the branch you're working on.
    fastForwardTo: (from, to) =>
      runOp(get, async (summary) => {
        const target = revisionSnapshot(get, from);
        await api.fastForwardBranch(summary.path, to, localBranchOid(get, to), target.oid);
        return `Fast-forwarded ${to} to ${from}`;
      }),

    rebaseOnto: (source, onto) =>
      runMaybeConflict(
        get,
        async (summary) => {
          const sourceSnapshot = source === "HEAD"
            ? revisionSnapshot(get, source)
            : { revision: source, oid: localBranchOid(get, source) };
          const target = revisionSnapshot(get, onto);
          await api.rebaseOnto(
            summary.path,
            sourceSnapshot.revision,
            sourceSnapshot.oid,
            target.oid,
          );
          return `Rebased ${source} onto ${onto}`;
        },
        `Rebasing ${source} onto ${onto}`,
      ),

    resetBranchTo: (source, target, mode, preview) =>
      runOp(get, async (summary) => {
        // Always pass the previewed tips — never live store OIDs that can drift
        // after the confirmation dialog opened and weaken the backend lease.
        if (!preview.targetOid) {
          throw new Error("Reset requires the previewed target commit. Preview again.");
        }
        if (source !== null && !preview.expectedSourceOid) {
          throw new Error("The branch has no expected commit. Refresh and try again.");
        }
        if (mode === "hard" && !preview.expectedState) {
          throw new Error(
            "Hard reset requires the exact-state lease from its confirmation. Preview again.",
          );
        }
        await api.resetTo(
          summary.path,
          source,
          preview.expectedSourceOid,
          preview.targetOid,
          mode,
          preview.expectedState,
          preview.expectedHeadBranch,
          preview.expectedHeadOid,
        );
        return `Reset ${source ?? "HEAD"} to ${target}`;
      }),

    applyStash: (oid, pop, withIndex) =>
      runOp(get, async (summary) => {
        if (pop) await api.stashPop(summary.path, summary.headBranch, summary.headOid, oid);
        else if (withIndex) {
          await api.stashApplyIndex(summary.path, summary.headBranch, summary.headOid, oid);
        } else {
          await api.stashApply(summary.path, summary.headBranch, summary.headOid, oid);
        }
        return pop ? "Popped stash" : "Applied stash";
      }),

    branchFromStash: (oid, branch) =>
      runOp(get, async (summary) => {
        await api.stashBranch(summary.path, branch, oid);
        return `Applied stash to new branch ${branch}`;
      }),

    dropStash: (oid) =>
      runOp(get, async (summary) => {
        await api.stashDrop(summary.path, oid);
        return "Dropped stash";
      }),

    cherryPickCommit: (sha) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.cherryPick(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "cherry-pick"),
            sha,
          );
          return `Cherry-picked ${sha.slice(0, 7)}`;
        },
        `Cherry-picking ${sha.slice(0, 7)}`,
      ),

    revertCommit: (sha) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.revertCommit(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "revert"),
            sha,
          );
          return `Reverted ${sha.slice(0, 7)}`;
        },
        `Reverting ${sha.slice(0, 7)}`,
      ),

    checkoutDetached: (sha) =>
      runOp(get, async (summary) => {
        await api.checkout(summary.path, sha, true);
        return `Checked out ${sha.slice(0, 7)} (detached)`;
      }),

    cherryPickMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.cherryPickMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "cherry-pick"),
            shas,
          );
          return `Cherry-picked ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Cherry-picking ${n} commit${n === 1 ? "" : "s"}`,
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },

    revertMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.revertMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "revert"),
            shas,
          );
          return `Reverted ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Reverting ${n} commit${n === 1 ? "" : "s"}`,
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },

    squashSelection: async (shas, message) => {
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const msg = await runOp(
        get,
        async (summary) => {
          const parent = validateSquashRange(get().graph, shas);
          const expectedOid = requireHeadOid(summary, "squash commits");
          const identity = useAccounts.getState().repoIdentity;
          const { summary: subject, description } = splitCommitMessage(message);
          await api.squashCommits(
            summary.path,
            summary.headBranch,
            expectedOid,
            parent,
            subject,
            description,
            identity?.name,
            identity?.email,
            identity,
          );
          return `Squashed ${shas.length} commits`;
        },
        // Squash preserves pre-staged work by restoring an index snapshot after
        // the commit (GL-307), so it can reject *after* the replacement commit
        // already landed. Refresh on error like the guarded discard does, or the
        // graph keeps showing the pre-squash range until the watcher catches up.
        { refreshOnError: true },
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },

    createTagAt: (name, sha) =>
      runOp(get, async (summary) => {
        await api.createTag(summary.path, name, sha ?? requireHeadOid(summary, "create a tag"));
        return `Created tag ${name}`;
      }),

    createAnnotatedTagAt: (name, message, sha) =>
      runOp(get, async (summary) => {
        await api.createAnnotatedTag(
          summary.path,
          name,
          message,
          sha ?? requireHeadOid(summary, "create a tag"),
        );
        return `Created tag ${name}`;
      }),

    createPatchAt: (sha) =>
      runOp(get, async (summary) => {
        const file = await api.createPatch(summary.path, sha);
        return `Created patch ${file}`;
      }),

    deleteTag: (name, expectedOid, alsoRemote = false) =>
      runOp(get, async (summary, owner) => {
        // Remote first: if the remote rejects (auth, protected tag) the local
        // ref survives, so the user retries from an unchanged state instead of
        // a half-deleted one that fetch would resurrect anyway. A never-pushed
        // tag is fine — the backend treats "remote ref does not exist" as the
        // desired end state.
        if (alsoRemote) {
          const remote = defaultRemote();
          const auth = authFor(remote);
          await trackNet(() =>
            api.deleteRemoteTag(summary.path, name, expectedOid, remote, auth),
          );
          try {
            await api.deleteTag(summary.path, name, expectedOid);
          } catch (e) {
            // The remote has already changed but runOp only refreshes on
            // success — re-sync quietly so the UI reflects whatever state the
            // failed local half left, then name the half-applied state and the
            // remaining step instead of a bare local-delete error.
            await refreshIfCurrent(get, owner, { prs: false, quiet: true });
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(
              `Deleted ${name} on ${remote}, but the local delete failed: ${reason}. Use “Delete local tag” to finish.`,
            );
          }
          return `Deleted tag ${name} (local and ${remote})`;
        }
        await api.deleteTag(summary.path, name, expectedOid);
        return `Deleted tag ${name}`;
      }),

    pushTag: (name, remote) =>
      runOp(get, async (summary) => {
        const target = remote ?? defaultRemote();
        const auth = authFor(target);
        await trackNet(() => api.pushTag(summary.path, name, target, auth));
        return `Pushed tag ${name} to ${target}`;
      }),

    removeWorktree: (worktreePath, expectedState) =>
      runOp(get, async (summary) =>
        api.removeWorktree(summary.path, worktreePath, expectedState),
      ),

    moveBranchToWorktree: async (branch, fromWorktreePath, toWorktreePath, carry) => {
      const { summary, loading } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      // Guard against a double-submit: the handoff (stash → detach → checkout →
      // pop) is slow and the IPC runs before loadRepo raises `loading`, so a second
      // trigger could launch a concurrent move on the shared stash. Hold `loading`
      // across the IPC ourselves; loadRepo takes it over on success.
      if (loading) throw new Error("Another operation is in progress");
      set({ loading: true, error: null });
      try {
        const message = await api.moveBranchToWorktree(
          summary.path,
          branch,
          fromWorktreePath,
          toWorktreePath,
          carry,
        );
        // The dialog can be dismissed mid-move and the tab(s) closed while the
        // move finishes in the background — landing on the destination then
        // would yank the app off the welcome screen the user chose. The result
        // still reaches them as a toast.
        if (!ownerMayNavigate(get, owner) || get().openPaths.length === 0) return message;
        // Land on the destination — the branch (and any carried work, or a
        // conflict to resolve) lives there now. loadRepo owns the loading lifecycle
        // + open intent, republishes the graph, and reads operation_status, so a
        // carry conflict opens the conflict workspace for the destination. The
        // landing switches the current tab in place — same repository, same
        // tab (GL-110) — rather than opening the destination as a sibling.
        // Release this operation's spinner before `loadRepo` synchronously
        // claims the navigation intent and takes over its own loading lifecycle.
        releaseLoadingIfCurrent(set, get, owner);
        await get().loadRepo(toWorktreePath, { replaceTab: summary.path });
        return message;
      } catch (e) {
        releaseLoadingIfCurrent(set, get, owner, true);
        throw e;
      } finally {
        // Safety net: on success loadRepo already cleared `loading`; if it didn't
        // (IPC threw, or loadRepo failed to open the destination) don't strand the
        // spinner.
        if (get().loading) releaseLoadingIfCurrent(set, get, owner);
      }
    },

    // Thin pass-throughs for the GL-107 delete-branch-and-worktree dialog: it is
    // UI and must not reach `api` directly (architecture-rules-react.md §1), so
    // the boundary lives here. Unlike the other branch writes these skip `runOp`'s
    // refresh — the dialog owns the graph refresh so it can surface it as the
    // checklist's "Refreshing" row (see useDeleteWorktreeRun).
    previewDeleteBranch: (branch) => {
      const { summary } = get();
      if (!summary) return Promise.reject(new Error("No repository"));
      return api.previewDeleteBranch(summary.path, branch);
    },

    previewRemoveWorktree: (worktreePath) => {
      const { summary } = get();
      if (!summary) return Promise.reject(new Error("No repository"));
      return api.previewRemoveWorktree(summary.path, worktreePath);
    },

    // `repoPath` is passed explicitly (not read from `get().summary`) so the delete
    // is pinned to the repo the dialog started on. The op runs after an `await` in
    // the dialog's run hook, and a repo switch landing in that window would
    // otherwise retarget the delete at the newly-active repo with the old
    // branch/worktree subject. GL-107 review.
    deleteBranchWithWorktree: (
      branch,
      fromWorktreePath,
      repoPath,
      expectedOid,
      expectedState,
    ) => {
      if (!repoPath) return Promise.reject(new Error("No repository"));
      return api.deleteBranchWithWorktree(
        repoPath,
        branch,
        fromWorktreePath,
        expectedOid,
        expectedState,
      );
    },

    deleteRemoteBranch: (remote, branch, expectedOid) =>
      runOp(get, async (summary) => {
        const auth = authFor(remote);
        await trackNet(() => api.deleteRemoteBranch(summary.path, remote, branch, expectedOid, auth));
        return `Deleted ${remote}/${branch}`;
      }),

    forcePush: (branch, preview) =>
      runOp(get, async (summary) => {
        const auth = authFor(preview.remote);
        await trackNet(() => api.forcePush(
          summary.path,
          branch,
          preview.expectedOid,
          preview,
          auth,
        ));
        return `Force-pushed ${branch} (with lease)`;
      }),

    discardAll: (preview) => {
      const state = get();
      const guard = discardAllGuardMessage(state.changes, state.summary?.unborn === true);
      if (guard) return Promise.reject(new Error(guard));
      return runOp(
        get,
        async (summary) =>
          api.discardAll(
            summary.path,
            preview.expectedState,
            preview.expectedHeadBranch,
            preview.expectedHeadOid,
          ),
        // Untracked cleanup happens before the tracked reset. If that second
        // phase fails, the backend rejects after changing the worktree; refresh
        // on every guarded discard error so both partial failures and stale
        // preconditions leave the UI truthful while preserving the error text.
        // A stale lease is itself evidence that repository state drifted, so the
        // extra read is useful reconciliation rather than merely error cleanup.
        { refreshOnError: true },
      );
    },

    createWorktreeAt: async (worktreePath, reference, newBranch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      // Create the worktree against the current repo, then open the new path as
      // its own repo tab (loadRepo discovers + watches it). With `newBranch`,
      // `reference` is the new branch's start point.
      await api.addWorktree(summary.path, worktreePath, reference, newBranch);
      if (ownerMayNavigate(get, owner)) await get().loadRepo(worktreePath);
      return newBranch
        ? `Created ${newBranch} in a worktree at ${worktreePath}`
        : `Created worktree at ${worktreePath}`;
    },

    openWorktree: async (worktreePath, opts) => {
      // In-place by default (GL-110): git's model is one repository, many
      // working trees, so switching worktrees moves the *current tab* to the
      // new path — it keeps the repository identity — instead of opening a
      // sibling tab. `newTab` is the explicit side-by-side action; a worktree
      // already open in another tab is simply activated (loadRepo's
      // includes-check leaves the strip untouched either way).
      const currentPath = get().summary?.path;
      const previousPublishedSession = currentPublishedRepoSession();
      const load = get().loadRepo(
        worktreePath,
        opts?.newTab || !currentPath ? undefined : { replaceTab: currentPath },
      );
      // loadRepo claims its intent synchronously before its first await. Retain
      // that exact claim so a later A -> B -> A navigation cannot revive this
      // worktree switch's automatic WIP/HEAD selection on the reopened A.
      const loadIntent = currentOpenIntent();
      await load;
      // Ownership guard: loadRepo absorbs failures and can be superseded by a
      // newer open, so the post-load work below must only run when the
      // requested worktree actually became the active repo — never against
      // whichever repo is still (or newly) on screen.
      if (
        !openIntentIsCurrent(loadIntent) ||
        currentPublishedRepoSession() === previousPublishedSession ||
        !isActiveWorktreePath(get().summary, worktreePath)
      ) {
        return;
      }
      const summary = get().summary;
      if (!summary) return;
      const owner: RepoWriteOwner = {
        path: summary.path,
        openIntent: loadIntent,
        publishedSession: currentPublishedRepoSession(),
      };
      // A reveal already pending here is a during-load pick (GL-20): the user
      // navigated somewhere deliberate while the graph skeleton was up, and
      // loadRepo honored it — the HEAD reveal below must not clobber it. The
      // selection snapshot catches the same intent expressed as a plain graph
      // click during the status await (a click sets no revealTarget).
      const duringLoadPick = get().revealTarget !== null;
      const parkedSelection = get().selectedCommit;
      const parkedFileSelection = captureFileSelection(get);
      // Switching into a worktree is usually about its in-progress work. If the
      // freshly loaded worktree is dirty, surface its working tree (the WIP
      // node, always the top row) so the uncommitted files are visible
      // immediately instead of hidden behind a commit diff. Best-effort and
      // guarded against a repo switch landing between the load and the select.
      try {
        const changes = await api.workingChanges(summary.path);
        const dirty =
          changes.staged.length > 0 ||
          changes.unstaged.length > 0 ||
          changes.conflicted.length > 0;
        if (dirty && ownerIsCurrent(get, owner)) {
          set({ changes });
          // The same user-signal rule as the clean HEAD reveal below: a
          // during-load pick or a selection made while the status read was in
          // flight is deliberate navigation — don't yank it to the WIP node.
          if (
            !duringLoadPick &&
            ownerMayNavigate(get, owner) &&
            get().revealTarget === null &&
            get().selectedCommit === parkedSelection &&
            fileSelectionIsCurrent(get, parkedFileSelection)
          ) {
            get().selectWip();
          }
          return;
        }
      } catch {
        // The dirty state is unknown — revealing HEAD could yank a dirty
        // worktree away from its working tree, so keep loadRepo's default
        // selection instead.
        return;
      }
      // Clean worktree: land the graph on its HEAD row (the branch tip, or the
      // detached commit). loadRepo clears the selection and leaves the list at
      // the top, so without this the switch arrives "nowhere" — the commit the
      // worktree sits on is neither selected nor scrolled into view (it may not
      // even be inside the initially loaded window). The reveal stays pending
      // until the graph mounts and pages in more history when the row is deeper.
      // The graph is interactive during the status await, so every user signal
      // wins over the automatic reveal: a pending revealTarget (before or after
      // the await) and any selection change since the snapshot both bail.
      if (!ownerMayNavigate(get, owner) || duringLoadPick || get().revealTarget !== null) return;
      if (get().selectedCommit !== parkedSelection) return;
      if (!fileSelectionIsCurrent(get, parkedFileSelection)) return;
      // HEAD is re-read from the live summary: a same-path refresh during the
      // status read can move it, and the reveal should land on where HEAD is
      // now, not where it was before the await.
      const live = get().summary;
      if (!ownerMayNavigate(get, owner) || live?.path !== summary.path || !live.headOid) return;
      // Already parked on the HEAD row (a tip-aligned worktree): re-revealing
      // would only re-fetch its files and flash a row the user is looking at.
      if (get().selectedCommit === live.headOid) return;
      await get().revealCommit(live.headOid);
    },


    stageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        // A worktree rename shows as one "R" entry naming the new path, but its
        // old path is still deleted in the index. Stage both together so the
        // index records a single rename instead of leaving the deletion behind
        // as a separate unstaged "D" (GL-127).
        const paths = renamePaths(get().changes.unstaged, path);
        if (paths) {
          await api.stageFiles(summary.path, paths);
        } else {
          await api.stageFile(summary.path, path);
        }
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          await get().selectFile(path, "staged");
        }
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        // Mirror of stageFile: restore both sides of a staged rename at once so
        // unstaging the new path doesn't leave the old path's deletion staged.
        const paths = renamePaths(get().changes.staged, path);
        if (paths) {
          await api.unstageFiles(summary.path, paths);
        } else {
          await api.unstageFile(summary.path, path);
        }
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          await get().selectFile(path, "unstaged");
        }
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    // Folder roll-up: stage/unstage a whole directory's files at once (one git
    // invocation, one refresh). Unlike the single-file actions these don't move
    // the selection — a folder action shouldn't hijack which file is being viewed.
    stagePaths: async (paths) => {
      const { summary } = get();
      if (!summary || paths.length === 0) return;
      const owner = captureOwner(summary);
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Pull each rolled-up rename's old side in too, so a rename under this
        // folder stages as one rename instead of a half-staged pair (GL-127).
        await api.stageFiles(summary.path, withRenameCounterparts(get().changes.unstaged, paths));
        await refreshIfCurrent(get, owner);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstagePaths: async (paths) => {
      const { summary } = get();
      if (!summary || paths.length === 0) return;
      const owner = captureOwner(summary);
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Symmetric to stagePaths: unstage each rolled-up rename's old side too.
        await api.unstageFiles(summary.path, withRenameCounterparts(get().changes.staged, paths));
        await refreshIfCurrent(get, owner);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    applyHunk: async (path, staged, hunkIndex, expectedHeader, expectedBody) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        const message = await api.applyHunk(
          summary.path,
          path,
          staged,
          hunkIndex,
          expectedHeader,
          expectedBody,
        );
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !fileSelectionIsCurrent(get, fileSelection)) {
          useUi.getState().showToast(message);
          return;
        }
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else if (ownerIsCurrent(get, owner) && fileSelectionIsCurrent(get, fileSelection)) {
          set({ selectedFile: null, fileDiff: null });
        }
        useUi.getState().showToast(message);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    applyLine: async (path, staged, hunkIndex, lineIndex, line) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        await api.applyLine(summary.path, path, staged, hunkIndex, lineIndex, line);
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !fileSelectionIsCurrent(get, fileSelection)) return;
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else if (ownerIsCurrent(get, owner) && fileSelectionIsCurrent(get, fileSelection)) {
          set({ selectedFile: null, fileDiff: null });
        }
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    previewDiscardFile: (repoPath, path, previousPath, staged) => {
      if (get().summary?.path !== repoPath) {
        return Promise.reject(new Error("The active repository changed; preview the discard again."));
      }
      return api.previewDiscardFile(repoPath, path, previousPath, staged);
    },

    discardFile: async (repoPath, path, previousPath, staged, expectedState) => {
      const { summary } = get();
      if (!summary || summary.path !== repoPath) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        const message = await api.discardFile(
          repoPath,
          path,
          previousPath,
          staged,
          expectedState,
        );
        // The write belongs to the repo captured by the confirmation. If the
        // user switched tabs while it was in flight, its completion must not
        // refresh or reselect a same-named path in the newly active repo.
        if (!ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(message);
          return;
        }
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(message);
          return;
        }
        // The discarded view is now empty. `refresh` drops the selection when the
        // path leaves both buckets; but a partially-staged file can survive in the
        // other bucket with a now-stale `source` — re-point the diff at it so the
        // pane never shows an empty diff for a file that still has changes.
        const { selectedFile, changes } = get();
        if (
          fileSelectionIsCurrent(get, fileSelection) &&
          selectedFile &&
          selectedFile.source !== "commit" &&
          selectedFile.path === path
        ) {
          if (changes.unstaged.some((f) => f.path === path)) await get().selectFile(path, "unstaged");
          else if (changes.staged.some((f) => f.path === path)) await get().selectFile(path, "staged");
        }
        useUi.getState().showToast(message);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(String(e), "error");
        }
      }
    },

    appendIgnorePattern: async (pattern, local = false) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      try {
        const message = await api.appendIgnorePattern(summary.path, pattern, local);
        if (!ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(message);
          return;
        }
        await refreshIfCurrent(get, owner);
        useUi.getState().showToast(message);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(String(e), "error");
        }
      }
    },

    revealInFileManager: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.revealInFileManager(summary.path, path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    worktreeDiffersFromCommit: async (commitOid, path) => {
      const { summary } = get();
      if (!summary) return false;
      return api.worktreeDiffersFromCommit(summary.path, commitOid, path);
    },

    restorePathFromCommit: async (commitOid, path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      try {
        const message = await api.restorePathFromCommit(summary.path, commitOid, path);
        if (!ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(message);
          return;
        }
        await refreshIfCurrent(get, owner);
        useUi.getState().showToast(message);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(String(e), "error");
        }
      }
    },

    stageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes))) return;
      try {
        await api.stageAll(summary.path);
        await refreshIfCurrent(get, owner);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.staged, changes), changes))) return;
      try {
        await api.unstageAll(summary.path);
        await refreshIfCurrent(get, owner);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    commit: async (summaryText, description, amend) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      // Pin the repo's bound identity (author + committer) so global-config
      // changes by other tools can never leak into a GitLane commit.
      const identity = useAccounts.getState().repoIdentity;
      try {
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          summaryText,
          description,
          amend,
          identity?.name,
          identity?.email,
          identity,
        );
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          set({ selectedFile: null, fileDiff: null });
        }
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    amendHeadMessage: (summaryText, description) =>
      runOp(get, async (summary) => {
        const identity = useAccounts.getState().repoIdentity;
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          summaryText,
          description,
          true,
          identity?.name,
          identity?.email,
          identity,
        );
        return "Updated commit message";
      }),

    commitSelected: async (message, amend = false) => {
      const { summary } = get();
      if (!summary) return false;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.staged, changes), changes))) {
        return false;
      }
      const identity = useAccounts.getState().repoIdentity;
      try {
        const { summary: subject, description } = splitCommitMessage(message);
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          subject,
          description,
          amend,
          identity?.name,
          identity?.email,
          identity,
        );
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          set({ selectedFile: null, fileDiff: null, wipSelected: false });
        }
        return true;
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
        return false;
      }
    },

    stash: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      if (toastAdvancedGuard(guardedAdvancedWriteMessage(get().changes))) return;
      try {
        const message = await api.stash(summary.path, summary.headBranch, summary.headOid);
        await refreshIfCurrent(get, owner);
        // Report the outcome like the other working-tree writes do. A routine
        // stash normalises to one short line backend-side; a stash whose
        // untracked cleanup Git could not finish still succeeds, but carries
        // what GitLane completed and what it had to leave on disk — and that
        // must not land silently.
        useUi.getState().showToast(message);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    fetch: async (opts) => {
      const { summary, forge } = get();
      if (!summary) return false;
      const owner = captureOwner(summary);
      // The operation owner: every post-await store write below is guarded on
      // the displayed repo still being this one, so a fetch that outlives a
      // repo switch can't clear the new repo's loading lifecycle or refresh the
      // wrong checkout. Toast plumbing is global UI and stays unguarded.
      const opPath = summary.path;
      // A fetch can outlive a repo switch. Never start another app fetch while
      // it is still updating refs (linked worktrees may share those refs). The
      // ActionBar disables the new repo's network buttons for this short window.
      if (fetchTransport && fetchTransport.path !== opPath) return false;
      // A quiet (background) fetch doesn't hold global `loading` or raise
      // notifications; `fetchingPath` drives the Fetch-button spinner, while
      // `netOps` remains the scheduler's overlap signal. It also must not clear
      // an unrelated `error`.
      if (!opts?.quiet) set({ loading: true, error: null });
      // Capture how far behind the tracked branch is *before* fetching so the
      // success toast can report how many commits the remote ref gained.
      const head = get().branches.find((b) => b.kind === BranchKind.Local && b.isHead);
      const behindBefore = head?.sync?.behind ?? 0;
      const only = get().remotes.length === 1 ? get().remotes[0].name : null;
      const notes = useNotifications.getState();
      const toastId = opts?.quiet
        ? null
        : notes.notify({
            kind: "progress",
            title: only ? `Fetching ${only}…` : "Fetching…",
            body: forge?.host ? `Contacting ${forge.host}` : undefined,
            progress: "indeterminate",
          });
      try {
        // One {remote, account} pair per fetch URL with inline auth (GL-129);
        // remotes resolved to system helpers / SSH are omitted.
        const remoteAccounts = get()
          .remotes.map((r) => ({ remote: r.name, auth: authFor(r.name, "fetch") }))
          .filter((pair): pair is { remote: string; auth: NonNullable<typeof pair.auth> } =>
            pair.auth !== null,
          );
        let transport = fetchTransport?.promise;
        if (!transport) {
          transport = trackNet(() => api.fetch(summary.path, remoteAccounts));
          fetchTransport = { path: opPath, promise: transport };
          set({ fetchingPath: opPath });
          const clearTransport = () => {
            if (fetchTransport?.promise !== transport) return;
            fetchTransport = null;
            if (get().fetchingPath === opPath) set({ fetchingPath: null });
          };
          void transport.then(clearTransport, clearTransport);
        }
        await transport;
      } catch (e) {
        // Replay any re-sync deferred while this fetch held `loading` (GL-20
        // review). A quiet fetch held nothing, so it has no state to restore.
        if (!opts?.quiet) releaseLoadingIfCurrent(set, get, owner, true);
        if (toastId !== null) {
          notes.dismiss(toastId);
          useUi.getState().showToast(String(e), "error");
        } else {
          console.warn("auto-fetch failed", friendlyGitError(String(e)));
        }
        return false;
      }
      if (opts?.quiet) {
        // The fetch rewrote FETCH_HEAD (and any updated remote refs) under
        // .git, so the watcher fires its own quiet re-sync — skip the
        // foreground refresh (and its PR reload) entirely. No `loading` was
        // held, so there is nothing to clear or flush.
        return true;
      }
      if (!ownerIsCurrent(get, owner)) {
        // Switched repos mid-fetch: the new repo's load owns `loading` now.
        // The fetch itself succeeded, so resolve the toast — but without a
        // count, which would be read from the wrong repo's branches.
        if (toastId !== null) notes.update(toastId, {
          kind: "success",
          title: only ? `Fetched ${only}` : "Fetched",
          progress: undefined,
          duration: 5000,
        });
        return true;
      }
      releaseLoadingIfCurrent(set, get, owner);
      // Fetch succeeded — refresh (best-effort) so the count reflects new refs,
      // then report. `refresh` never rejects; it reports success as a boolean
      // (false = deferred/superseded/failed), and a refresh failure can't
      // relabel a successful fetch.
      const refreshed = await refreshIfCurrent(get, owner);
      const headAfter = refreshed
        ? get().branches.find((b) => b.kind === BranchKind.Local && b.isHead)
        : undefined;
      const gained = Math.max(0, (headAfter?.sync?.behind ?? 0) - behindBefore);
      const on = headAfter?.name ?? head?.name;
      if (toastId !== null) notes.update(toastId, {
        kind: "success",
        title: only ? `Fetched ${only}` : "Fetched",
        // The count comes from post-fetch branch state, so it's only trustworthy
        // when the refresh landed on this same repo. If it didn't, drop the
        // detail rather than claim "No new commits" (which could be wrong).
        // "No new commits" (vs "up to date") because a fetch that gained nothing
        // doesn't mean the branch is synced — it may still be behind; only pull
        // can claim sync.
        body: !refreshed || !ownerIsCurrent(get, owner)
          ? undefined
          : gained > 0 && on
            ? `↓${gained} new commit${gained === 1 ? "" : "s"} on ${on}`
            : "No new commits",
        progress: undefined,
        duration: 5000,
      });
      return true;
    },

    pull: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      // Same ownership rule as `fetch`: post-await reads/refresh are guarded on
      // the repo this pull started on.
      const head = get().branches.find((b) => b.kind === BranchKind.Local && b.isHead);
      const remote = head?.upstreamRemote ?? "origin";
      const branch = head?.name ?? "HEAD";
      const upstream = head?.upstream ?? `${remote}/${branch}`;
      const pullSource = remote === "." ? `local branch ${upstream}` : upstream;
      // Compare the branch tip across the pull to tell "fast-forwarded/merged"
      // from "already up to date".
      const tipBefore = head?.target ?? null;
      const notes = useNotifications.getState();
      // Claim the transport before painting progress. A context-menu pull can
      // bypass the ActionBar's disabled state; if fetch/push already owns the
      // mutex, surface only the actionable busy error — never flash a progress
      // card for work that did not start.
      let transport: Promise<string>;
      try {
        if (!head?.name || !head.target) {
          throw new Error("Cannot pull: HEAD is not an attached branch with a commit.");
        }
        const auth = authFor(remote, "fetch");
        transport = trackNet(() => api.pull(
          summary.path,
          head.name,
          head.target!,
          auth,
        ));
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
        return;
      }
      const toastId = notes.notify({
        kind: "progress",
        title: remote === "." ? "Pulling locally…" : `Pulling ${remote}…`,
        body: `from ${pullSource}`,
        progress: "indeterminate",
      });
      try {
        await transport;
      } catch (e) {
        notes.dismiss(toastId);
        useUi.getState().showToast(String(e), "error");
        return;
      }
      if (!ownerIsCurrent(get, owner)) {
        // Switched repos mid-pull: the pull itself succeeded, so resolve the
        // toast neutrally — the new repo's lifecycle owns refresh/loading, and
        // a tip read here would come from the wrong repo's branches.
        notes.update(toastId, {
          kind: "success",
          title: "Pulled",
          body: `from ${pullSource}`,
          progress: undefined,
          duration: 5000,
        });
        return;
      }
      // Pull succeeded — refresh (best-effort) to observe the new tip, then
      // report. `refresh` never rejects; it reports success as a boolean
      // (false = deferred/superseded/failed), and a refresh failure can't
      // relabel a successful pull.
      const refreshed = await refreshIfCurrent(get, owner);
      const tipAfter = refreshed
        ? get().branches.find((b) => b.kind === BranchKind.Local && b.isHead)?.target ?? null
        : null;
      // The pulled-vs-up-to-date distinction relies on the tip observed after
      // refresh; if refresh failed the tip is stale, so report a neutral success
      // rather than risk claiming "Already up to date" on a pull that moved HEAD.
      const changed = refreshed && tipBefore !== null && tipAfter !== null && tipBefore !== tipAfter;
      notes.update(toastId, {
        kind: "success",
        title: !refreshed ? "Pulled" : changed ? "Pulled changes" : "Already up to date",
        body: !refreshed || changed ? `from ${pullSource}` : `${branch} is up to date`,
        progress: undefined,
        duration: 5000,
      });
    },

    push: async () => {
      const { summary, forge } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      // Push the captured HEAD branch explicitly to its configured remote and
      // send that remote's account (GL-129). Capture the ahead count *before*
      // the push so the success toast can report how many commits went out.
      const head = get().branches.find((b) => b.kind === BranchKind.Local && b.isHead);
      const remote = pushRemoteForBranch(head);
      const localPush = remote === ".";
      // The explicit push follows the configured upstream, whose name can differ
      // from the local branch. Named remotes encode it as "remote/branch"; a local
      // `.` upstream is already the bare local branch name. A triangular local push
      // (`pushRemote=.` with a non-local upstream) instead targets the same-named
      // local branch, matching the backend's push-destination resolution.
      const remoteBranch =
        localPush
          ? (head?.upstreamRemote === "." ? head.upstream : null) ?? head?.name ?? "HEAD"
          : head?.upstream && head.upstream.startsWith(`${remote}/`)
            ? head.upstream.slice(remote.length + 1)
            : (head?.name ?? "HEAD");
      const aheadBefore = head?.sync?.ahead ?? 0;
      const target = localPush ? `local branch ${remoteBranch}` : `${remote}/${remoteBranch}`;
      const notes = useNotifications.getState();
      // As with pull, claim the store mutex before creating progress so direct
      // commit-and-push callers get one busy error and no misleading flash.
      let transport: Promise<string>;
      try {
        if (!head?.name || !head.target) {
          throw new Error("Cannot push: HEAD is not an attached branch with a commit.");
        }
        const headName = head.name;
        const headTarget = head.target;
        const auth = authFor(remote);
        transport = trackNet(() => api.pushBranch(
          summary.path,
          headName,
          headTarget,
          auth,
        ));
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
        return;
      }
      // git push doesn't stream progress through our transport, so the toast is
      // indeterminate ("working") until the invoke resolves, then it morphs into
      // the success card in place.
      const toastId = notes.notify({
        kind: "progress",
        title: localPush ? "Pushing locally…" : `Pushing to ${remote}…`,
        body: `to ${target}`,
        progress: "indeterminate",
      });
      try {
        await transport;
      } catch (e) {
        // Drop the in-flight progress toast; the error keeps its own persistent,
        // scrollable toast (via the legacy forwarder → friendlyGitError).
        notes.dismiss(toastId);
        useUi.getState().showToast(String(e), "error");
        return;
      }
      // The push landed — report it authoritatively *before* the refresh, so a
      // post-push refresh hiccup can't relabel a successful push as failed.
      const webUrl = localPush ? null : branchWebUrl(forge, remoteBranch);
      notes.update(toastId, {
        kind: "success",
        title:
          aheadBefore > 0
            ? `Pushed ${aheadBefore} commit${aheadBefore === 1 ? "" : "s"}`
            : localPush
              ? "Pushed locally"
              : `Pushed to ${remote}`,
        body: `to ${target}`,
        progress: undefined,
        duration: 5000,
        actions: webUrl
          ? [{ label: `View on ${forge?.forge ?? "web"}`, onClick: () => openExternalUrl(webUrl) }]
          : undefined,
      });
      // Best-effort: `refresh` never rejects (it reports success as a boolean),
      // and the filesystem watcher re-syncs anyway — the toast above doesn't
      // depend on it.
      await refreshIfCurrent(get, owner);
    },
  };
}
