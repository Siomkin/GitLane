// Conflict-resolution write actions — the store-side glue for the in-app
// ConflictWorkspace (GL-36). Per-file actions resolve one unmerged path and do a
// cheap worktree re-sync (refreshing `changes` + `operation`); operation actions
// continue/abort/skip the active merge/sequencer and do a full refresh because
// the graph itself changes. All writes go through `lib/api` → real `git`.

import { api, toCommandError } from "@/lib/api";
import { useAccounts } from "./accounts";
import { operationLabel } from "./operation";
import { captureOwner, ownerIsCurrent, refreshSettled } from "./repoWriteActions/shared";
import { useUi } from "./ui";
import type { ActiveOperationKind, RepoGet, RepoSet, RepoState } from "./repoTypes";

// The identity preflight (the repo identity changed between the confirm and
// the write) rejects with the stale-lease kind before git runs.
function isOperationIdentityPreflightError(error: unknown): boolean {
  return toCommandError(error).kind === "staleLease";
}

export function createRepoConflictActions(
  _set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "acceptConflictSide"
  | "resolveConflictFile"
  | "markConflictResolved"
  | "reconflictFile"
  | "continueOperation"
  | "abortOperation"
  | "skipOperation"
> {
  // Shared body for the per-file resolutions: run the git write, then re-read
  // only the worktree (status + operation) so the file flips to resolved without
  // a graph rebuild. Returns whether the write succeeded — callers MUST gate any
  // local-state cleanup (clearing hunk choices) on a `true` result, so a failed
  // resolution never wipes the user's in-progress decisions. Errors surface as a
  // toast, like the staging actions.
  const perFile = async (run: (path: string) => Promise<string>): Promise<boolean> => {
    const { summary } = get();
    if (!summary) return false;
    const opPath = summary.path;
    try {
      await run(opPath);
      // Only re-sync if we're still on the repo the write targeted — a repo
      // switch mid-await must not publish this write's result into another repo.
      if (get().summary?.path === opPath) {
        await get().refresh({ prs: false, quiet: true, scope: "worktree" });
      }
      return true;
    } catch (e) {
      useUi.getState().showToast(e, "error");
      return false;
    }
  };

  // Run an operation-level action (continue/abort/skip), pinned to the repo it
  // started on. After the (slow) git await the user may have switched repos;
  // bailing on an owner mismatch keeps the result — the refresh and the
  // "still active?" read — from leaking onto the now-current, unrelated repo.
  const runOperation = async (
    call: (path: string, kind: ActiveOperationKind) => Promise<string>,
    message: (label: string, stillActive: boolean) => string,
  ): Promise<string> => {
    const { summary, operation } = get();
    if (!summary || !operation) throw new Error("No operation in progress");
    const owner = captureOwner(summary);
    const label = operationLabel(operation.kind);
    // The union is never cleared ahead of the refresh: a refresh deferred
    // behind `loading` would leave the conflict workspace blank until it
    // replays. The refresh folds the new status in (a file the step no longer
    // reports turns resolved), or clears it when the operation completed.
    try {
      await call(summary.path, operation.kind);
    } catch (e) {
      // These backend checks run before git. The current conflict necessarily
      // remains unchanged, so treating its presence as "next-step progress"
      // would turn a rejected skip/continue into a false success message.
      if (isOperationIdentityPreflightError(e)) throw e;
      // A continue/skip can advance to a *new* conflict step (e.g. the next
      // rebased commit) before git reports a non-zero exit. Re-read so the
      // workspace reflects the new conflict set immediately instead of showing
      // the stale "all resolved" union until the filesystem watcher fires.
      // If git simply stopped on the *next* conflict, that's forward progress,
      // not a failure — the workspace now shows it, so report progress rather
      // than surfacing a raw git error toast. A failure with no outstanding
      // conflicts (e.g. a rejected commit), or a refresh that never ran, still
      // propagates.
      if (
        (await refreshSettled(get, owner)) &&
        get().operation?.files.some((f) => !f.resolved)
      ) {
        return message(label, true);
      }
      throw e;
    }
    if (!ownerIsCurrent(get, owner)) return message(label, false);
    // Only a refresh that ran (for this repo) may read the (global) operation,
    // so neither a deferred refresh nor a switch during it is misread as this
    // op's outcome.
    const stillActive = (await refreshSettled(get, owner)) && !!get().operation;
    return message(label, stillActive);
  };

  return {
    acceptConflictSide: (file, side) =>
      perFile((path) => api.acceptConflictSide(path, file, side)),

    resolveConflictFile: (file, content) =>
      perFile((path) => api.resolveConflictFile(path, file, content)),

    markConflictResolved: (file) => perFile((path) => api.markConflictResolved(path, file)),

    reconflictFile: (file) => perFile((path) => api.reconflictFile(path, file)),

    continueOperation: () => {
      const identity = useAccounts.getState().repoIdentity;
      return runOperation(
        (path, kind) => api.continueOperation(path, kind, identity),
        (label, active) =>
          active ? `${label} continued — resolve the next conflicts` : `${label} complete`,
      );
    },

    abortOperation: () =>
      runOperation(
        (path, kind) => api.abortOperation(path, kind),
        (label) => `${label} aborted`,
      ),

    skipOperation: () => {
      const identity = useAccounts.getState().repoIdentity;
      return runOperation(
        (path, kind) => api.skipOperation(path, kind, identity),
        (label, active) => (active ? `Skipped — resolve the next conflicts` : `${label} complete`),
      );
    },
  };
}
