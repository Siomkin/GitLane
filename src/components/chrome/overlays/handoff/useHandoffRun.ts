// Run state machine for the hand-off dialog: configure → running (ticking the
// checklist off `handoff-progress` events) → done/error. The dialog stays
// closable mid-run — the move keeps going and its result lands as a toast
// instead of the success screen.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { friendlyGitError } from "@/lib/gitError";
import { useRepo } from "@/store/repo";
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
  // running, so its outcome must fall back to a toast instead of setState on an
  // unmounted component.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Synchronous in-flight latch: `phase` is stale render state, so a fast
  // double-click could start two runs (the second bouncing off the store's
  // loading guard into a spurious error screen) before the re-render lands.
  const inFlight = useRef(false);

  const start = (destPath: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("running");
    setReached(0);
    // Marks the move in flight store-wide, so loadRepo's repo-switch overlay
    // cleanup spares the dialog when the hand-off itself lands on the destination.
    useUi.getState().setHandoffRunning(true);
    void (async () => {
      // Subscribe before invoking so the earliest steps can't be missed.
      const unlisten = await listen<{ step: string }>("handoff-progress", ({ payload }) => {
        const i = handoffStepIndex(payload.step);
        // Monotonic: a stale/duplicate event never moves the checklist backwards.
        if (i >= 0) setReached((r) => Math.max(r, i));
      });
      try {
        const msg = await moveBranchToWorktree(req.branch, req.sourcePath, destPath, true);
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
        useUi.getState().setHandoffRunning(false);
        unlisten();
      }
    })();
  };

  return { phase, reached, message, start };
}
