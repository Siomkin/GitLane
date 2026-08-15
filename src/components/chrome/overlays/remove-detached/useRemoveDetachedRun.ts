// Run state machine for the bulk remove-detached sweep: configure → running
// (ticking one row per worktree as the frontend-driven loop removes them) →
// done. Closable mid-run — the sweep keeps going. Failures toast; all-ok is
// silent (the worktree list already refreshed). Follows the GL-105 hand-off /
// GL-107 delete-worktree shell.

import { useState } from "react";

import { friendlyGitError } from "@/lib/gitError";
import { useRepo } from "@/store/repo";
import { openIntent, publishedRepoSession } from "@/store/repoRequests";
import type { WorktreeInfo } from "@/lib/api";
import { useStepRun } from "@/hooks/useStepRun";
import { useUi } from "@/store/ui";
import { removeDetachedSummary, type RemoveOutcome } from "./steps";

export type RemoveDetachedPhase = "configure" | "running" | "done";

export interface RemoveDetachedRun {
  phase: RemoveDetachedPhase;
  /** Per-target outcomes recorded so far (drives the checklist rows). */
  outcomes: RemoveOutcome[];
  /** Summary shown on the done screen (failures also toast on a mid-run close). */
  message: string;
  /** True when at least one removal failed (drives the done badge tone). */
  hadFailure: boolean;
  /** Kick off the sweep. No-op while already running. */
  start: () => void;
}

/** `targets` is the *planned* set (GL-297), not `req.targets`: the dialog probes
 * every candidate first and withholds the ones it cannot vouch for. The sweep
 * itself stays deliberately unforced — see the loop below. */
export function useRemoveDetachedRun(targets: WorktreeInfo[]): RemoveDetachedRun {
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const [phase, setPhase] = useState<RemoveDetachedPhase>("configure");
  const [outcomes, setOutcomes] = useState<RemoveOutcome[]>([]);
  const [message, setMessage] = useState("");
  const [hadFailure, setHadFailure] = useState(false);

  // The dialog body unmounts when the user closes it mid-run; the sweep keeps
  // going. Failures toast; all-ok is silent (the worktree list already refreshed).
  // The `mounted` guard, its StrictMode re-arm, and the in-flight latch live in
  // the shared run scaffold (this run reports no progress events, so there is
  // no event wiring to share).
  const { mounted, start: startRun } = useStepRun();

  const start = () => {
    // The store latch stops a *reopened* dialog from starting a second sweep
    // while the first still runs in the background; the scaffold's latch stops
    // a fast double-click on this instance (`phase` is stale render state
    // until the re-render lands).
    if (useUi.getState().removeDetachedRunning) return;
    // Pin the repo the sweep acts on. `removeWorktree` reads the *current*
    // summary path on every call, so a repo switch mid-sweep (the dialog can be
    // closed and outlive its repo) would aim later removals at the wrong
    // repository. If the active repo diverges we stop and leave the rest in
    // place, mirroring useDeleteWorktreeRun's repoAtStart guard. Kept as the raw
    // (possibly undefined) path so the divergence check compares like-for-like.
    const repoAtStart = useRepo.getState().summary?.path;
    const openIntentAtStart = openIntent.current();
    const repoSessionAtStart = publishedRepoSession.current();
    const startingRepoIsCurrent = () =>
      useRepo.getState().summary?.path === repoAtStart &&
      openIntent.isCurrent(openIntentAtStart) &&
      publishedRepoSession.isCurrent(repoSessionAtStart);
    const started = startRun(async () => {
      try {
        const acc: RemoveOutcome[] = [];
        let firstError: string | null = null;
        // A failure doesn't abort the sweep — record it and keep going so one
        // stuck worktree (e.g. git's dirty-worktree check) can't strand the rest.
        // Never force. The plan has already withheld anything dirty, unverified,
        // or agent-managed (GL-297), and locked worktrees never became candidates —
        // so git's own refusal is a backstop here, not the primary guard. Forcing
        // would turn that backstop into silent data loss; the per-row menu is where
        // a forced removal belongs, because it names what is being discarded.
        for (let i = 0; i < targets.length; i++) {
          if (!startingRepoIsCurrent()) {
            // Repo switched under us — record the untouched remainder as failures
            // so the checklist completes instead of stranding rows as "pending".
            for (; i < targets.length; i++) acc.push("fail");
            if (firstError === null) firstError = "Repository changed — remaining worktrees were left in place.";
            break;
          }
          try {
            const preview = await useRepo.getState().previewRemoveWorktree(targets[i].path);
            if (preview.requiresForce) {
              throw new Error(
                "Worktree has uncommitted work or is locked — skipped by the unforced sweep.",
              );
            }
            await removeWorktree(targets[i].path, preview.expectedState);
            acc.push("ok");
          } catch (e) {
            acc.push("fail");
            if (firstError === null) firstError = friendlyGitError(String(e instanceof Error ? e.message : e));
          }
          if (mounted.current) setOutcomes([...acc]);
        }
        if (mounted.current) setOutcomes([...acc]);
        const summary = removeDetachedSummary(acc, targets.length, firstError);
        if (!mounted.current) {
          // Dialog closed mid-run: only surface failures. All-ok is silent —
          // the worktree list already refreshed.
          if (firstError) useUi.getState().showToast(summary, "error");
          return;
        }
        setHadFailure(firstError !== null);
        setMessage(summary);
        setPhase("done");
      } finally {
        useUi.getState().setRemoveDetachedRunning(false);
      }
    });
    if (!started) return;
    useUi.getState().setRemoveDetachedRunning(true);
    setPhase("running");
    setOutcomes([]);
  };

  return { phase, outcomes, message, hadFailure, start };
}
