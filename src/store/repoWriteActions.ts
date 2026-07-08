import { api, type FileChange, type RepoSummary } from "../lib/api";
import { fileWriteGuard, findGuardedFile, guardedAdvancedWriteMessage } from "../lib/advancedRepoState";
import { splitCommitMessage } from "../lib/commitMessage";
import { findOtherBranchWorktree, type WorktreeRef } from "../lib/graphActions";
import { mergeWasAlreadyUpToDate } from "../lib/mergeOutcome";
import { pushRemoteForBranch, remoteNameForUpstream } from "../lib/remoteAccounts";
import { branchWebUrl } from "../lib/forgeUrls";
import { openExternalUrl } from "../lib/openExternal";
import { useAccounts } from "./accounts";
import { useNotifications } from "./notifications";
import { takePendingRefresh } from "./repoRequests";
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
// Folder roll-ups (stagePaths/unstagePaths) and the commit modal's partial
// exclude pass new-side paths only; without this a rename under a rolled-up
// directory — or an unchecked staged rename — would leave the old path's
// deletion in the opposite state (the same GL-127 bug in the bulk flows).
// De-duplicated (a rename and its source both selected won't double up); order
// preserved for stable git invocations.
function withRenameCounterparts(bucket: FileChange[], paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const path of paths) {
    push(path);
    const old = renameOldPath(bucket.find((f) => f.path === path));
    if (old) push(old);
  }
  return out;
}

// Shared body for the branch/history write ops: require an open repo, run the
// op, refresh the graph, and return its toast message. Rejects (for the caller
// to toast) when there's no repo or the git op throws.
async function runOp(
  get: RepoGet,
  body: (summary: RepoSummary) => Promise<string>,
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const message = await body(summary);
  await get().refresh();
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
  const opPath = summary.path;
  // Capture whether an operation was ALREADY active before we start: only a
  // *newly* entered operation means this op stopped on conflicts. If one was
  // already in progress (e.g. a terminal-started merge, or a second attempt
  // while the workspace is open), git's failure is genuine and must surface —
  // otherwise every error would be masked as a benign "resolve conflicts".
  const hadOperation = !!get().operation;
  try {
    const message = await body(summary);
    // Don't refresh/publish onto a different repo if the user switched mid-op.
    if (get().summary?.path === opPath) await get().refresh();
    return message;
  } catch (e) {
    // Switched repos mid-op: surface the raw error; never interpret it (or the
    // global operation) against the now-current, unrelated repo.
    if (get().summary?.path !== opPath) throw e;
    await get().refresh();
    if (get().summary?.path === opPath && !hadOperation && get().operation) {
      return `${inProgressLabel} — resolve conflicts to continue`;
    }
    throw e;
  }
}

// Replay a watcher/focus re-sync that `refresh` deferred while a `loading`-holding
// write op (checkout/fetch) was in flight. `refresh` already flushes on its own
// success/failure, but a write op's failure path clears `loading` without going
// through `refresh`, so the queued re-sync would otherwise be stranded until the
// next external event (GL-20 review). Mirrors the lifecycle slice's flush.
function flushPendingRefresh(get: RepoGet) {
  const scope = takePendingRefresh();
  if (scope) void get().refresh({ prs: false, quiet: true, scope });
}

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

async function findCheckoutWorktree(
  set: RepoSet,
  get: RepoGet,
  summary: RepoSummary,
  branch: string,
): Promise<WorktreeRef | null> {
  const currentWorkdir = summary.workdir ?? summary.path;
  const cached = findOtherBranchWorktree(get().worktrees, branch, currentWorkdir);
  if (cached) return cached;

  // On checkout, a cached miss is not enough: the branch may be held by a
  // worktree that is still loading, so probe once before falling through to git.
  const worktrees = await api.listWorktrees(summary.path).catch(() => null);
  if (!worktrees) return null;
  if (get().summary?.path !== summary.path) {
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
  | "removeBranch"
  | "renameBranchTo"
  | "setUpstreamFor"
  | "pushBranch"
  | "publishBranch"
  | "mergeInto"
  | "fastForwardTo"
  | "rebaseOnto"
  | "resetCurrentTo"
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
  | "discardFile"
  | "stageAll"
  | "unstageAll"
  | "commit"
  | "amendHeadMessage"
  | "commitSelected"
  | "stash"
  | "fetch"
  | "pull"
  | "push"
> {
  // Per-remote account resolution (GL-129): every push-family call sends the
  // account bound to the remote it actually targets, not one repo-wide pick.
  const authFor = (remote: string | null) =>
    remote ? useAccounts.getState().transportAuthForRemote(remote) : null;
  // The remote a push of `branch` targets — its configured remote from the
  // branch list, with the backend's "origin" fallback.
  const pushRemoteOf = (branch: string) =>
    pushRemoteForBranch(get().branches.find((b) => b.kind === "local" && b.name === branch));
  // The default push remote (tags land there when no remote is picked).
  const defaultRemote = () => get().remotes.find((r) => r.isDefault)?.name ?? "origin";

  return {
    checkoutBranch: async (name) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const existingWorktree = await findCheckoutWorktree(set, get, summary, name);
      if (existingWorktree) {
        await get().openWorktree(existingWorktree.path);
        return `Opened ${name} worktree`;
      }
      set({ loading: true, error: null });
      try {
        await api.checkout(summary.path, name);
        set({ loading: false });
        await get().refresh();
        return `Checked out ${name}`;
      } catch (e) {
        // Reset the spinner but let the caller present the failure (toast), so a
        // failed checkout never leaves a stale success message behind. Replay any
        // re-sync deferred while this op held `loading` (GL-20 review).
        set({ loading: false });
        flushPendingRefresh(get);
        throw e;
      }
    },

    checkoutRemoteBranch: async (remote, branch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const existingWorktree = await findCheckoutWorktree(set, get, summary, branch);
      if (existingWorktree) {
        await get().openWorktree(existingWorktree.path);
        return `Opened ${branch} worktree`;
      }
      set({ loading: true, error: null });
      try {
        await api.checkoutRemoteBranch(summary.path, remote, branch);
        set({ loading: false });
        await get().refresh();
        return `Checked out ${branch}`;
      } catch (e) {
        set({ loading: false });
        flushPendingRefresh(get);
        throw e;
      }
    },

    // Branch operations. Each refreshes the graph and returns a human-readable
    // message for the caller to surface as a toast; failures reject with the
    // git error so the caller can toast that instead.
    createBranchAt: (name, startPoint) =>
      runOp(get, async (summary) => {
        await api.createBranch(summary.path, name, startPoint);
        await api.checkout(summary.path, name);
        return `Created ${name}`;
      }),

    removeBranch: (name, force = false) =>
      runOp(get, async (summary) => {
        await api.deleteBranch(summary.path, name, force);
        return `Deleted ${name}`;
      }),

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
        await api.pushBranch(summary.path, branch, authFor(pushRemoteOf(branch)));
        return `Pushed ${branch}`;
      }),

    publishBranch: (branch, upstream) =>
      runOp(get, async (summary) => {
        const remote = remoteNameForUpstream(
          upstream,
          get().remotes.map((r) => r.name),
        );
        await api.publishBranch(summary.path, branch, upstream, authFor(remote));
        return `Published ${branch} to ${upstream}`;
      }),

    mergeInto: (from, to) =>
      runMaybeConflict(
        get,
        async (summary) => {
          if (summary.headBranch !== to) {
            try {
              await api.checkout(summary.path, to);
            } catch (e) {
              throw new Error(`Couldn't check out ${to} to merge into it: ${e}`);
            }
          }
          const output = await api.mergeBranch(summary.path, from);
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
        if (summary.headBranch === to) await api.fastForward(summary.path, from);
        else await api.fastForwardBranch(summary.path, to, from);
        return `Fast-forwarded ${to} to ${from}`;
      }),

    rebaseOnto: (onto) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.rebaseOnto(summary.path, onto);
          return `Rebased onto ${onto}`;
        },
        `Rebasing onto ${onto}`,
      ),

    resetCurrentTo: (target, mode) =>
      runOp(get, async (summary) => {
        await api.resetTo(summary.path, target, mode);
        return `Reset to ${target}`;
      }),

    applyStash: (oid, pop, withIndex) =>
      runOp(get, async (summary) => {
        if (pop) await api.stashPop(summary.path, oid);
        else if (withIndex) await api.stashApplyIndex(summary.path, oid);
        else await api.stashApply(summary.path, oid);
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
          await api.cherryPick(summary.path, sha);
          return `Cherry-picked ${sha.slice(0, 7)}`;
        },
        `Cherry-picking ${sha.slice(0, 7)}`,
      ),

    revertCommit: (sha) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.revertCommit(summary.path, sha);
          return `Reverted ${sha.slice(0, 7)}`;
        },
        `Reverting ${sha.slice(0, 7)}`,
      ),

    checkoutDetached: (sha) =>
      runOp(get, async (summary) => {
        await api.checkout(summary.path, sha);
        return `Checked out ${sha.slice(0, 7)} (detached)`;
      }),

    cherryPickMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.cherryPickMany(summary.path, shas);
          return `Cherry-picked ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Cherry-picking ${n} commit${n === 1 ? "" : "s"}`,
      );
      get().clearSelection();
      return msg;
    },

    revertMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.revertMany(summary.path, shas);
          return `Reverted ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Reverting ${n} commit${n === 1 ? "" : "s"}`,
      );
      get().clearSelection();
      return msg;
    },

    squashSelection: async (shas, message) => {
      const msg = await runOp(get, async (summary) => {
        // Soft-reset to the parent of the oldest selected commit, then commit the
        // staged tree as one. `reset --soft` keeps the working tree + index at the
        // newest commit, so the new commit's content equals the squashed range's.
        const parent = validateSquashRange(get().graph, shas);
        // The newest selected commit is validated to be HEAD, so this is the tip we
        // restore to if the replacement commit is rejected below.
        const originalHead = get().graph?.head ?? null;
        await api.resetTo(summary.path, parent, "soft");
        const identity = useAccounts.getState().repoIdentity;
        const { summary: subject, description } = splitCommitMessage(message);
        try {
          await api.commit(summary.path, subject, description, false, identity?.name, identity?.email);
        } catch (e) {
          // The commit was rejected (commit-msg hook, signing failure, …). Undo the
          // soft reset so the branch keeps its original commits instead of being left
          // with them gone from HEAD and everything staged. `--soft` leaves the index
          // and working tree untouched, so this restores the exact pre-squash state.
          if (originalHead) await api.resetTo(summary.path, originalHead, "soft").catch(() => {});
          throw e;
        }
        return `Squashed ${shas.length} commits`;
      });
      get().clearSelection();
      return msg;
    },

    createTagAt: (name, sha) =>
      runOp(get, async (summary) => {
        await api.createTag(summary.path, name, sha);
        return `Created tag ${name}`;
      }),

    createAnnotatedTagAt: (name, message, sha) =>
      runOp(get, async (summary) => {
        await api.createAnnotatedTag(summary.path, name, message, sha);
        return `Created tag ${name}`;
      }),

    createPatchAt: (sha) =>
      runOp(get, async (summary) => {
        const file = await api.createPatch(summary.path, sha);
        return `Created patch ${file}`;
      }),

    deleteTag: (name, alsoRemote = false) =>
      runOp(get, async (summary) => {
        // Remote first: if the remote rejects (auth, protected tag) the local
        // ref survives, so the user retries from an unchanged state instead of
        // a half-deleted one that fetch would resurrect anyway. A never-pushed
        // tag is fine — the backend treats "remote ref does not exist" as the
        // desired end state.
        if (alsoRemote) {
          const remote = defaultRemote();
          await api.deleteRemoteTag(summary.path, name, remote, authFor(remote));
          try {
            await api.deleteTag(summary.path, name);
          } catch (e) {
            // The remote has already changed but runOp only refreshes on
            // success — re-sync quietly so the UI reflects whatever state the
            // failed local half left, then name the half-applied state and the
            // remaining step instead of a bare local-delete error.
            await get()
              .refresh({ prs: false, quiet: true })
              .catch(() => undefined);
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(
              `Deleted ${name} on ${remote}, but the local delete failed: ${reason}. Use “Delete local tag” to finish.`,
            );
          }
          return `Deleted tag ${name} (local and ${remote})`;
        }
        await api.deleteTag(summary.path, name);
        return `Deleted tag ${name}`;
      }),

    pushTag: (name, remote) =>
      runOp(get, async (summary) => {
        const target = remote ?? defaultRemote();
        await api.pushTag(summary.path, name, target, authFor(target));
        return `Pushed tag ${name} to ${target}`;
      }),

    removeWorktree: (worktreePath, force = false) =>
      runOp(get, async (summary) => api.removeWorktree(summary.path, worktreePath, force)),

    moveBranchToWorktree: async (branch, fromWorktreePath, toWorktreePath, carry) => {
      const { summary, loading } = get();
      if (!summary) throw new Error("No repository");
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
        if (get().openPaths.length === 0) return message;
        // Land on the destination — the branch (and any carried work, or a
        // conflict to resolve) lives there now. loadRepo owns the loading lifecycle
        // + open intent, republishes the graph, and reads operation_status, so a
        // carry conflict opens the conflict workspace for the destination. The
        // landing switches the current tab in place — same repository, same
        // tab (GL-110) — rather than opening the destination as a sibling.
        await get().loadRepo(toWorktreePath, { replaceTab: summary.path });
        return message;
      } catch (e) {
        flushPendingRefresh(get);
        throw e;
      } finally {
        // Safety net: on success loadRepo already cleared `loading`; if it didn't
        // (IPC threw, or loadRepo failed to open the destination) don't strand the
        // spinner.
        if (get().loading) set({ loading: false });
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

    // `repoPath` is passed explicitly (not read from `get().summary`) so the delete
    // is pinned to the repo the dialog started on. The op runs after an `await` in
    // the dialog's run hook, and a repo switch landing in that window would
    // otherwise retarget the delete at the newly-active repo with the old
    // branch/worktree subject. GL-107 review.
    deleteBranchWithWorktree: (branch, fromWorktreePath, repoPath) => {
      if (!repoPath) return Promise.reject(new Error("No repository"));
      return api.deleteBranchWithWorktree(repoPath, branch, fromWorktreePath);
    },

    deleteRemoteBranch: (remote, branch) =>
      runOp(get, async (summary) => {
        await api.deleteRemoteBranch(summary.path, remote, branch, authFor(remote));
        return `Deleted ${remote}/${branch}`;
      }),

    forcePush: (branch) =>
      runOp(get, async (summary) => {
        await api.forcePush(summary.path, branch, authFor(pushRemoteOf(branch)));
        return `Force-pushed ${branch} (with lease)`;
      }),

    discardAll: () => {
      const guard = guardedAdvancedWriteMessage(get().changes);
      if (guard) return Promise.reject(new Error(guard));
      return runOp(get, async (summary) => api.discardAll(summary.path));
    },

    createWorktreeAt: async (worktreePath, reference, newBranch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      // Create the worktree against the current repo, then open the new path as
      // its own repo tab (loadRepo discovers + watches it). With `newBranch`,
      // `reference` is the new branch's start point.
      await api.addWorktree(summary.path, worktreePath, reference, newBranch);
      await get().loadRepo(worktreePath);
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
      await get().loadRepo(
        worktreePath,
        opts?.newTab || !currentPath ? undefined : { replaceTab: currentPath },
      );
      // Switching into a worktree is usually about its in-progress work, but
      // loadRepo parks the selection on the tip commit. If the freshly loaded
      // worktree is dirty, surface its working tree (the WIP node) so the
      // uncommitted files are visible immediately instead of hidden behind a
      // commit diff. Best-effort and guarded against a repo switch landing
      // between the load and the select.
      const summary = get().summary;
      if (!summary) return;
      try {
        const changes = await api.workingChanges(summary.path);
        const dirty =
          changes.staged.length > 0 ||
          changes.unstaged.length > 0 ||
          changes.conflicted.length > 0;
        if (dirty && get().summary?.path === summary.path) {
          set({ changes });
          get().selectWip();
        }
      } catch {
        // A failed status read just leaves loadRepo's default tip selection.
      }
    },


    stageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
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
        await get().refresh();
        await get().selectFile(path, "staged");
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
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
        await get().refresh();
        await get().selectFile(path, "unstaged");
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
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Pull each rolled-up rename's old side in too, so a rename under this
        // folder stages as one rename instead of a half-staged pair (GL-127).
        await api.stageFiles(summary.path, withRenameCounterparts(get().changes.unstaged, paths));
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstagePaths: async (paths) => {
      const { summary } = get();
      if (!summary || paths.length === 0) return;
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Symmetric to stagePaths: unstage each rolled-up rename's old side too.
        await api.unstageFiles(summary.path, withRenameCounterparts(get().changes.staged, paths));
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    applyHunk: async (path, staged, hunkIndex, expectedHeader, expectedBody) => {
      const { summary } = get();
      if (!summary) return;
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
        await get().refresh();
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else {
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
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        const message = await api.applyLine(summary.path, path, staged, hunkIndex, lineIndex, line);
        await get().refresh();
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else {
          set({ selectedFile: null, fileDiff: null });
        }
        useUi.getState().showToast(message);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    discardFile: async (path, staged) => {
      const { summary } = get();
      if (!summary) return;
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        const message = await api.discardFile(summary.path, path, staged);
        await get().refresh();
        // The discarded view is now empty. `refresh` drops the selection when the
        // path leaves both buckets; but a partially-staged file can survive in the
        // other bucket with a now-stale `source` — re-point the diff at it so the
        // pane never shows an empty diff for a file that still has changes.
        const { selectedFile, changes } = get();
        if (selectedFile && selectedFile.source !== "commit" && selectedFile.path === path) {
          if (changes.unstaged.some((f) => f.path === path)) await get().selectFile(path, "unstaged");
          else if (changes.staged.some((f) => f.path === path)) await get().selectFile(path, "staged");
        }
        useUi.getState().showToast(message);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    stageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes))) return;
      try {
        await api.stageAll(summary.path);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.staged, changes), changes))) return;
      try {
        await api.unstageAll(summary.path);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    commit: async (summaryText, description, amend) => {
      const { summary } = get();
      if (!summary) return;
      // Pin the repo's bound identity (author + committer) so global-config
      // changes by other tools can never leak into a GitLane commit.
      const identity = useAccounts.getState().repoIdentity;
      try {
        await api.commit(summary.path, summaryText, description, amend, identity?.name, identity?.email);
        await get().refresh();
        set({ selectedFile: null, fileDiff: null });
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    amendHeadMessage: (summaryText, description) =>
      runOp(get, async (summary) => {
        const identity = useAccounts.getState().repoIdentity;
        await api.commit(summary.path, summaryText, description, true, identity?.name, identity?.email);
        return "Updated commit message";
      }),

    commitSelected: async (message, excludePaths, amend = false) => {
      const { summary } = get();
      if (!summary) return;
      const { changes } = get();
      const included = changes.staged.filter((file) => !excludePaths.includes(file.path));
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(included, changes), changes))) return;
      const identity = useAccounts.getState().repoIdentity;
      try {
        // Files unchecked in the modal are dropped from this commit by unstaging
        // them first; they stay in the working tree. Expand renames so unchecking
        // a staged rename also unstages its old-path deletion, instead of leaving
        // that "D" staged and committing half the rename (GL-127).
        // Unstage the excluded set atomically so a partial failure can't leave
        // some of them staged.
        const excluded = withRenameCounterparts(changes.staged, excludePaths);
        if (excluded.length > 0) await api.unstageFiles(summary.path, excluded);
        const { summary: subject, description } = splitCommitMessage(message);
        await api.commit(summary.path, subject, description, amend, identity?.name, identity?.email);
        await get().refresh();
        set({ selectedFile: null, fileDiff: null, wipSelected: false });
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    stash: async () => {
      const { summary } = get();
      if (!summary) return;
      if (toastAdvancedGuard(guardedAdvancedWriteMessage(get().changes))) return;
      try {
        await api.stash(summary.path);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    fetch: async () => {
      const { summary, forge } = get();
      if (!summary) return;
      set({ loading: true, error: null });
      // Capture how far behind the tracked branch is *before* fetching so the
      // success toast can report how many commits the remote ref gained.
      const head = get().branches.find((b) => b.kind === "local" && b.isHead);
      const behindBefore = head?.sync?.behind ?? 0;
      const only = get().remotes.length === 1 ? get().remotes[0].name : null;
      const notes = useNotifications.getState();
      const toastId = notes.notify({
        kind: "progress",
        title: only ? `Fetching ${only}…` : "Fetching…",
        body: forge?.host ? `Contacting ${forge.host}` : undefined,
        progress: "indeterminate",
      });
      try {
        // One {remote, account} pair per bound remote (GL-129); remotes
        // without a binding are omitted and fetch through the system
        // credential helpers / SSH.
        const remoteAccounts = get()
          .remotes.map((r) => ({ remote: r.name, auth: authFor(r.name) }))
          .filter((pair): pair is { remote: string; auth: NonNullable<typeof pair.auth> } =>
            pair.auth !== null,
          );
        await api.fetch(summary.path, remoteAccounts);
      } catch (e) {
        // Replay any re-sync deferred while this fetch held `loading` (GL-20 review).
        set({ loading: false });
        flushPendingRefresh(get);
        notes.dismiss(toastId);
        useUi.getState().showToast(String(e), "error");
        return;
      }
      set({ loading: false });
      // Fetch succeeded — refresh (best-effort) so the count reflects new refs,
      // then report. A refresh failure can't relabel a successful fetch.
      let refreshed = true;
      try {
        await get().refresh();
      } catch (err) {
        refreshed = false;
        console.warn("fetch: post-fetch refresh failed", err);
      }
      const headAfter = get().branches.find((b) => b.kind === "local" && b.isHead);
      const gained = Math.max(0, (headAfter?.sync?.behind ?? 0) - behindBefore);
      const on = headAfter?.name ?? head?.name;
      notes.update(toastId, {
        kind: "success",
        title: only ? `Fetched ${only}` : "Fetched",
        // The count comes from post-fetch branch state, so it's only trustworthy
        // when the refresh landed. If refresh failed, drop the detail rather than
        // claim "No new commits" (which could be wrong). "No new commits" (vs "up
        // to date") because a fetch that gained nothing doesn't mean the branch is
        // synced — it may still be behind; only pull can claim sync.
        body: !refreshed
          ? undefined
          : gained > 0 && on
            ? `↓${gained} new commit${gained === 1 ? "" : "s"} on ${on}`
            : "No new commits",
        progress: undefined,
        duration: 5000,
      });
    },

    pull: async () => {
      const { summary } = get();
      if (!summary) return;
      const head = get().branches.find((b) => b.kind === "local" && b.isHead);
      const remote = head?.upstreamRemote ?? "origin";
      const branch = head?.name ?? "HEAD";
      const upstream = head?.upstream ?? `${remote}/${branch}`;
      // Compare the branch tip across the pull to tell "fast-forwarded/merged"
      // from "already up to date".
      const tipBefore = head?.target ?? null;
      const notes = useNotifications.getState();
      const toastId = notes.notify({
        kind: "progress",
        title: `Pulling ${remote}…`,
        body: `from ${upstream}`,
        progress: "indeterminate",
      });
      try {
        await api.pull(summary.path, authFor(head?.upstreamRemote ?? null));
      } catch (e) {
        notes.dismiss(toastId);
        useUi.getState().showToast(String(e), "error");
        return;
      }
      // Pull succeeded — refresh (best-effort) to observe the new tip, then
      // report. A refresh failure can't relabel a successful pull.
      let refreshed = true;
      try {
        await get().refresh();
      } catch (err) {
        refreshed = false;
        console.warn("pull: post-pull refresh failed", err);
      }
      const tipAfter = get().branches.find((b) => b.kind === "local" && b.isHead)?.target ?? null;
      // The pulled-vs-up-to-date distinction relies on the tip observed after
      // refresh; if refresh failed the tip is stale, so report a neutral success
      // rather than risk claiming "Already up to date" on a pull that moved HEAD.
      const changed = refreshed && tipBefore !== null && tipAfter !== null && tipBefore !== tipAfter;
      notes.update(toastId, {
        kind: "success",
        title: !refreshed ? "Pulled" : changed ? "Pulled changes" : "Already up to date",
        body: !refreshed || changed ? `from ${upstream}` : `${branch} is up to date`,
        progress: undefined,
        duration: 5000,
      });
    },

    push: async () => {
      const { summary, forge } = get();
      if (!summary) return;
      // A bare push targets the checked-out branch's configured remote — send
      // that remote's account (GL-129). Capture the ahead count *before* the
      // push so the success toast can report how many commits went out.
      const head = get().branches.find((b) => b.kind === "local" && b.isHead);
      const remote = pushRemoteForBranch(head);
      // A bare push follows the configured upstream, whose branch name can differ
      // from the local branch — report the *upstream* branch (from `head.upstream`,
      // "remote/branch") for the copy + forge link, falling back to the local name.
      const remoteBranch =
        head?.upstream && head.upstream.startsWith(`${remote}/`)
          ? head.upstream.slice(remote.length + 1)
          : (head?.name ?? "HEAD");
      const aheadBefore = head?.sync?.ahead ?? 0;
      const target = `${remote}/${remoteBranch}`;
      const notes = useNotifications.getState();
      // git push doesn't stream progress through our transport, so the toast is
      // indeterminate ("working") until the invoke resolves, then it morphs into
      // the success card in place.
      const toastId = notes.notify({
        kind: "progress",
        title: `Pushing to ${remote}…`,
        body: `to ${target}`,
        progress: "indeterminate",
      });
      try {
        await api.push(summary.path, authFor(remote));
      } catch (e) {
        // Drop the in-flight progress toast; the error keeps its own persistent,
        // scrollable toast (via the legacy forwarder → friendlyGitError).
        notes.dismiss(toastId);
        useUi.getState().showToast(String(e), "error");
        return;
      }
      // The push landed — report it authoritatively *before* the refresh, so a
      // post-push refresh hiccup can't relabel a successful push as failed.
      const webUrl = branchWebUrl(forge, remoteBranch);
      notes.update(toastId, {
        kind: "success",
        title:
          aheadBefore > 0
            ? `Pushed ${aheadBefore} commit${aheadBefore === 1 ? "" : "s"}`
            : `Pushed to ${remote}`,
        body: `to ${target}`,
        progress: undefined,
        duration: 5000,
        actions: webUrl
          ? [{ label: `View on ${forge?.forge ?? "web"}`, onClick: () => openExternalUrl(webUrl) }]
          : undefined,
      });
      try {
        await get().refresh();
      } catch (err) {
        // The filesystem watcher will re-sync anyway; don't surface a refresh
        // failure as a push failure.
        console.warn("push: post-push refresh failed", err);
      }
    },
  };
}
