// Run state machine for the hand-off dialog: configure → running (ticking the
// checklist off `handoff-progress` events) → done/error. Closable mid-run —
// the move keeps going. Failures toast; routine success is silent when a repo
// is still open (destination load updates the UI), and toasts on the welcome
// screen so the outcome isn't lost (GL-105).

import { useState } from "react";
import { HANDOFF_PROGRESS, handoffProgressEventSchema, listenTyped } from "@/lib/api";

import { friendlyGitError } from "@/lib/gitError";
import { useRepo } from "@/store/repo";
import { useStepRun } from "@/hooks/useStepRun";
import { useUi, type HandoffRequest } from "@/store/ui";
import { handoffStepIndex } from "./steps";

export type HandoffPhase = "configure" | "running" | "done" | "error";

export interface HandoffRun {
  phase: HandoffPhase;
  /** Furthest checklist row reached (only meaningful while running). */
  reached: number;
  /** Backend result (done) or readable failure (error). */
  message: string;
  /** Kick off the move to `destPath`. No-op while already running. */
  start: (destPath: string) => void;
}

export function useHandoffRun(req: HandoffRequest): HandoffRun {
  const moveBranchToWorktree = useRepo((s) => s.moveBranchToWorktree);
  const [phase, setPhase] = useState<HandoffPhase>("configure");
  const [reached, setReached] = useState(0);
  const [message, setMessage] = useState("");

  // The dialog body unmounts when the user closes it mid-run; the move keeps
  // running. Failures toast; success toasts only when no repo is open
  // (welcome screen — GL-105), otherwise the destination load is enough.
  // The `mounted` guard, its StrictMode re-arm, the in-flight latch, and the
  // progress-event subscribe/unlisten wiring live in the shared run scaffold.
  const { mounted, start: startRun } = useStepRun();

  const start = (destPath: string) => {
    // No-op while already running: `phase` is stale render state, so a fast
    // double-click could otherwise start two runs (the second bouncing off the
    // store's loading guard into a spurious error screen).
    const started = startRun(
      async () => {
        try {
          const msg = await moveBranchToWorktree(req.branch, req.sourcePath, destPath, true);
          if (!mounted.current) {
            // Welcome screen (no open tabs): toast so the outcome isn't lost.
            // Otherwise success is silent — the destination worktree opens / refreshes.
            if (useRepo.getState().openPaths.length === 0) {
              useUi.getState().showToast(msg);
            }
            return;
          }
          setMessage(msg);
          setPhase("done");
        } catch (e) {
          if (!mounted.current) {
            // showToast rewrites error-tone messages via friendlyGitError itself,
            // so the background path reads the same as the in-dialog one.
            useUi.getState().showToast(e, "error");
            return;
          }
          setMessage(friendlyGitError(e));
          setPhase("error");
        } finally {
          useUi.getState().setHandoffRunning(false);
        }
      },
      // Subscribe before invoking so the earliest steps can't be missed.
      () =>
        listenTyped(HANDOFF_PROGRESS, handoffProgressEventSchema, (payload) => {
          const i = handoffStepIndex(payload.step);
          // Monotonic: a stale/duplicate event never moves the checklist backwards.
          if (i >= 0) setReached((r) => Math.max(r, i));
        }),
    );
    if (!started) return;
    setPhase("running");
    setReached(0);
    // Marks the move in flight store-wide, so loadRepo's repo-switch overlay
    // cleanup spares the dialog when the hand-off itself lands on the destination.
    useUi.getState().setHandoffRunning(true);
  };

  return { phase, reached, message, start };
}
