import { api, type RepoSummary } from "../lib/api";
import { splitCommitMessage } from "../lib/commitMessage";
import { useAccounts } from "./accounts";
import { takePendingRefresh } from "./repoRequests";
import { validateSquashRange } from "./selection";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

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

export function createRepoWriteActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "checkoutBranch"
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
  | "deleteRemoteBranch"
  | "forcePush"
  | "discardAll"
  | "createPatchAt"
  | "createWorktreeAt"
  | "openWorktree"
  | "checkoutDetached"
  | "stageFile"
  | "unstageFile"
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
  return {
    checkoutBranch: async (name) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
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
        await api.pushBranch(summary.path, branch, useAccounts.getState().repoAccountRef);
        return `Pushed ${branch}`;
      }),

    publishBranch: (branch, upstream) =>
      runOp(get, async (summary) => {
        await api.publishBranch(summary.path, branch, upstream, useAccounts.getState().repoAccountRef);
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
          await api.mergeBranch(summary.path, from);
          return `Merged ${from} into ${to}`;
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

    applyStash: (index, pop, withIndex) =>
      runOp(get, async (summary) => {
        if (pop) await api.stashPop(summary.path, index);
        else if (withIndex) await api.stashApplyIndex(summary.path, index);
        else await api.stashApply(summary.path, index);
        return pop ? "Popped stash" : "Applied stash";
      }),

    branchFromStash: (index, branch) =>
      runOp(get, async (summary) => {
        await api.stashBranch(summary.path, branch, index);
        return `Applied stash to new branch ${branch}`;
      }),

    dropStash: (index) =>
      runOp(get, async (summary) => {
        await api.stashDrop(summary.path, index);
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
        await api.resetTo(summary.path, parent, "soft");
        const identity = useAccounts.getState().repoIdentity;
        await api.commit(summary.path, message, "", false, identity?.name, identity?.email);
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

    deleteTag: (name) =>
      runOp(get, async (summary) => api.deleteTag(summary.path, name)),

    pushTag: (name) =>
      runOp(get, async (summary) => {
        await api.pushTag(summary.path, name, useAccounts.getState().repoAccountRef);
        return `Pushed tag ${name}`;
      }),

    removeWorktree: (worktreePath, force = false) =>
      runOp(get, async (summary) => api.removeWorktree(summary.path, worktreePath, force)),

    deleteRemoteBranch: (remote, branch) =>
      runOp(get, async (summary) => {
        await api.deleteRemoteBranch(summary.path, remote, branch, useAccounts.getState().repoAccountRef);
        return `Deleted ${remote}/${branch}`;
      }),

    forcePush: (branch) =>
      runOp(get, async (summary) => {
        await api.forcePush(summary.path, branch, useAccounts.getState().repoAccountRef);
        return `Force-pushed ${branch} (with lease)`;
      }),

    discardAll: () => runOp(get, async (summary) => api.discardAll(summary.path)),

    createWorktreeAt: async (worktreePath, reference) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      // Create the worktree against the current repo, then open the new path as
      // its own repo tab (loadRepo discovers + watches it).
      await api.addWorktree(summary.path, worktreePath, reference);
      await get().loadRepo(worktreePath);
      return `Created worktree at ${worktreePath}`;
    },

    openWorktree: async (worktreePath) => {
      await get().loadRepo(worktreePath);
    },


    stageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.stageFile(summary.path, path);
        await get().refresh();
        await get().selectFile(path, "staged");
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    unstageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.unstageFile(summary.path, path);
        await get().refresh();
        await get().selectFile(path, "unstaged");
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    applyHunk: async (path, staged, hunkIndex, expectedHeader) => {
      const { summary } = get();
      if (!summary) return;
      try {
        const message = await api.applyHunk(summary.path, path, staged, hunkIndex, expectedHeader);
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
      const identity = useAccounts.getState().repoIdentity;
      try {
        // Files unchecked in the modal are dropped from this commit by unstaging
        // them first; they stay in the working tree.
        // Unstage the excluded set atomically so a partial failure can't leave
        // some of them staged.
        if (excludePaths.length > 0) await api.unstageFiles(summary.path, excludePaths);
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
      try {
        await api.stash(summary.path);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    fetch: async () => {
      const { summary } = get();
      if (!summary) return;
      set({ loading: true, error: null });
      try {
        await api.fetch(summary.path, useAccounts.getState().repoAccountRef);
        set({ loading: false });
        await get().refresh();
      } catch (e) {
        // Replay any re-sync deferred while this fetch held `loading` (GL-20 review).
        set({ loading: false });
        flushPendingRefresh(get);
        useUi.getState().showToast(String(e), "error");
      }
    },

    pull: async () => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.pull(summary.path);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    push: async () => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.push(summary.path, useAccounts.getState().repoAccountRef);
        await get().refresh();
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },
  };
}
