// Run state machine for the delete-branch-and-worktree dialog (GL-107):
// configure → running (ticking the checklist off `delete-worktree-progress`
// events) → done/error. Closable mid-run — the delete keeps going. Failures
// toast; routine success is silent (the graph/navigator already update).

import { useState } from "react";
import {
  DELETE_WORKTREE_PROGRESS,
  deleteWorktreeProgressEventSchema,
  listenTyped,
} from "@/lib/api";

import { friendlyGitError } from "@/lib/gitError";
import { useRepo } from "@/store/repo";
import { publishedRepoSession } from "@/store/repoRequests";
import { useStepRun } from "@/hooks/useStepRun";
import { useUi, type DeleteWorktreeRequest } from "@/store/ui";
import { deleteWorktreeStepIndex, DELETE_WORKTREE_REFRESH_ROW } from "./steps";

export type DeleteWorktreePhase = "configure" | "running" | "done" | "error";

export interface DeleteWorktreeRun {
  phase: DeleteWorktreePhase;
  /** Furthest checklist row reached (only meaningful while running). */
  reached: number;
  /** Backend result (done) or readable failure (error). */
  message: string;
  /** Kick off the delete. No-op while already running. */
  start: (expectedOid: string, expectedState: string) => void;
}

export function useDeleteWorktreeRun(req: DeleteWorktreeRequest): DeleteWorktreeRun {
  const [phase, setPhase] = useState<DeleteWorktreePhase>("configure");
  const [reached, setReached] = useState(0);
  const [message, setMessage] = useState("");

  // The dialog body unmounts when the user closes it mid-run; the delete keeps
  // running. Failures toast; routine success is silent (graph/navigator update).
  // The `mounted` guard, its StrictMode re-arm, the in-flight latch, and the
  // progress-event subscribe/unlisten wiring live in the shared run scaffold.
  const { mounted, start: startRun } = useStepRun();

  const start = (expectedOid: string, expectedState: string) => {
    // The store latch stops a *reopened* dialog (a fresh hook, inFlight=false)
    // from starting a second delete while the first still runs in the
    // background; the scaffold's latch stops a fast double-click on this
    // instance (`phase` is stale render state until the re-render lands).
    if (useUi.getState().deleteWorktreeRunning) return;
    // The repo this delete acts on, captured now and passed explicitly into both
    // the delete and the refresh guard. The op runs after the scaffold's
    // `await listenTyped(...)` below, and a repo switch landing in that window closes
    // the dialog but leaves this background body running — pinning the path
    // keeps the delete (and the post-op refresh) targeted at the repo the user
    // acted on, never the newly-active one. GL-107 review.
    const repoAtStart = useRepo.getState().summary?.path ?? null;
    const repoSessionAtStart = publishedRepoSession.current();
    const startingRepoIsCurrent = () =>
      repoAtStart !== null &&
      useRepo.getState().summary?.path === repoAtStart &&
      publishedRepoSession.isCurrent(repoSessionAtStart);
    const started = startRun(
      async () => {
        try {
          if (!repoAtStart) throw new Error("No repository");
          const msg = await useRepo
            .getState()
            .deleteBranchWithWorktree(
              req.branch,
              req.worktreePath,
              repoAtStart,
              expectedOid,
              expectedState,
            );
          // The backend emits no event for the graph refresh — advance to the
          // terminal "Refreshing" row ourselves so it spins while the store reloads.
          // (The store action deliberately skips runOp's refresh so we own it here.)
          // Guard the checklist state like the listener does: a close after the IPC
          // resolved but before refresh finishes must not setState on the dead body.
          if (mounted.current) setReached(DELETE_WORKTREE_REFRESH_ROW);
          // Refresh regardless of mount (a closed-but-same-repo dialog still needs
          // the deleted branch gone from the graph) — but only if we're still on
          // the repo the delete acted on. A mid-run switch means the mutated repo
          // isn't active; refreshing the new one would reload the wrong graph (the
          // acted-on repo reconciles via its FS watcher / next load). GL-107 review.
          if (startingRepoIsCurrent()) {
            await useRepo.getState().refresh();
          }
          if (!mounted.current) {
            // Dialog closed mid-run: success is silent (the graph/navigator
            // already update). Failures still toast so the outcome isn't lost.
            return;
          }
          setMessage(msg);
          setPhase("done");
        } catch (e) {
          // The backend can report a truthful partial outcome (for example, the
          // worktree was removed but the prepared ref commit failed). Reconcile
          // the acted-on repo before rendering that error so the sidebar never
          // keeps showing a worktree that is already gone.
          if (startingRepoIsCurrent()) {
            try {
              await useRepo.getState().refresh();
            } catch {
              // Keep the destructive operation's actionable error primary; the
              // filesystem watcher can retry the refresh.
            }
          }
          if (!mounted.current) {
            // showToast rewrites error-tone messages via friendlyGitError itself,
            // so the background path reads the same as the in-dialog one.
            useUi.getState().showToast(e, "error");
            return;
          }
          setMessage(friendlyGitError(e));
          setPhase("error");
        } finally {
          useUi.getState().setDeleteWorktreeRunning(false);
        }
      },
      // Subscribe before invoking so the earliest steps can't be missed.
      () =>
        listenTyped(DELETE_WORKTREE_PROGRESS, deleteWorktreeProgressEventSchema, (payload) => {
          const i = deleteWorktreeStepIndex(payload.step);
          // Ignore events after the body unmounted (mid-run close) — the run
          // finishes in the background and reports via toast; touching state then
          // is a no-op at best and a stray warning at worst.
          if (!mounted.current) return;
          // Monotonic: a stale/duplicate event never moves the checklist backwards.
          if (i >= 0) setReached((r) => Math.max(r, i));
        }),
    );
    if (!started) return;
    useUi.getState().setDeleteWorktreeRunning(true);
    setPhase("running");
    setReached(0);
  };

  return { phase, reached, message, start };
}
