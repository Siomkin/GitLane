// Run state machine for the delete-branch-and-worktree dialog (GL-107):
// configure → running (ticking the checklist off `delete-worktree-progress`
// events) → done/error. The dialog stays closable mid-run — the delete keeps
// going and its result lands as a toast instead of the success screen.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { friendlyGitError } from "@/lib/gitError";
import { useRepo } from "@/store/repo";
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
  start: () => void;
}

export function useDeleteWorktreeRun(req: DeleteWorktreeRequest): DeleteWorktreeRun {
  const [phase, setPhase] = useState<DeleteWorktreePhase>("configure");
  const [reached, setReached] = useState(0);
  const [message, setMessage] = useState("");

  // The dialog body unmounts when the user closes it mid-run; the delete keeps
  // running, so its outcome must fall back to a toast instead of setState on an
  // unmounted component. The effect body must re-arm the flag: under StrictMode's
  // dev double-mount the cleanup runs once on the simulated unmount, and a
  // cleanup-only effect would leave `mounted` permanently false on the real,
  // visible instance (success would always divert to the toast).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Synchronous in-flight latch: `phase` is stale render state, so a fast
  // double-click could start two runs before the re-render lands.
  const inFlight = useRef(false);

  const start = () => {
    // Two guards: `inFlight` stops a double-click on this instance; the store
    // latch stops a *reopened* dialog (a fresh hook with inFlight=false) from
    // starting a second delete while the first still runs in the background.
    if (inFlight.current || useUi.getState().deleteWorktreeRunning) return;
    inFlight.current = true;
    useUi.getState().setDeleteWorktreeRunning(true);
    setPhase("running");
    setReached(0);
    void (async () => {
      // Subscribe before invoking so the earliest steps can't be missed.
      const unlisten = await listen<{ step: string }>(
        "delete-worktree-progress",
        ({ payload }) => {
          const i = deleteWorktreeStepIndex(payload.step);
          // Ignore events after the body unmounted (mid-run close) — the run
          // finishes in the background and reports via toast; touching state then
          // is a no-op at best and a stray warning at worst.
          if (!mounted.current) return;
          // Monotonic: a stale/duplicate event never moves the checklist backwards.
          if (i >= 0) setReached((r) => Math.max(r, i));
        },
      );
      try {
        const msg = await useRepo
          .getState()
          .deleteBranchWithWorktree(req.branch, req.worktreePath);
        // The backend emits no event for the graph refresh — advance to the
        // terminal "Refreshing" row ourselves so it spins while the store reloads.
        // (The store action deliberately skips runOp's refresh so we own it here.)
        setReached(DELETE_WORKTREE_REFRESH_ROW);
        await useRepo.getState().refresh();
        if (!mounted.current) {
          useUi.getState().showToast(msg);
          return;
        }
        setMessage(msg);
        setPhase("done");
      } catch (e) {
        const raw = String(e instanceof Error ? e.message : e);
        if (!mounted.current) {
          // showToast rewrites error-tone messages via friendlyGitError itself,
          // so the background path reads the same as the in-dialog one.
          useUi.getState().showToast(raw, "error");
          return;
        }
        setMessage(friendlyGitError(raw));
        setPhase("error");
      } finally {
        inFlight.current = false;
        useUi.getState().setDeleteWorktreeRunning(false);
        unlisten();
      }
    })();
  };

  return { phase, reached, message, start };
}
