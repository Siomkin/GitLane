// Run state machine for the delete-branch dialog: configure → running (rows
// ticked by the store action's step callbacks) → done/error. Closable mid-run —
// the delete keeps going; a failure then toasts, routine success stays silent
// (the graph already updates). Same scaffold as useDeleteWorktreeRun.

import { useState } from "react";
import { notifyCaveat } from "@/components/chrome/overlays/progress";
import { useStepRun } from "@/hooks/useStepRun";
import { useRepo } from "@/store/repo";
import { friendlyRepoError, useUi, type DeleteBranchRequest } from "@/store/ui";

export type DeleteBranchPhase = "configure" | "running" | "done" | "error";

export interface DeleteBranchRun {
  phase: DeleteBranchPhase;
  /** Checklist rows for this run (two, or three with the remote). */
  rows: string[];
  /** Furthest row reached. */
  reached: number;
  /** Row that failed (error phase only). */
  failedAt: number | null;
  /** Routine success text (done) or readable failure (error). */
  message: string;
  /** Start the delete; `remote` (with its lease oid) also deletes it on the
   * remote first. No-op while one is already running. */
  start: (localOid: string, remote: RemoteTarget | null) => void;
}

type RemoteTarget = NonNullable<DeleteBranchRequest["alsoRemote"]>;

export function deleteBranchRows(req: DeleteBranchRequest, withRemote: boolean): string[] {
  const local = [`Delete local ${req.branch}`, "Refresh graph"];
  return withRemote && req.alsoRemote
    ? [`Delete ${req.alsoRemote.remote}/${req.alsoRemote.branch}`, ...local]
    : local;
}

export function useDeleteBranchRun(req: DeleteBranchRequest): DeleteBranchRun {
  const [phase, setPhase] = useState<DeleteBranchPhase>("configure");
  const [rows, setRows] = useState<string[]>(() => deleteBranchRows(req, false));
  const [reached, setReached] = useState(0);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const { mounted, start: startRun } = useStepRun();

  const start = (localOid: string, remote: RemoteTarget | null) => {
    // The store latch blocks a reopened dialog while a closed one's delete runs.
    if (useUi.getState().deleteBranchRunning) return;
    const runRows = deleteBranchRows(req, remote !== null);
    // Mirrors `reached` for the catch block, which closes over a stale render.
    let at = 0;
    const advance = (row: number) => {
      at = Math.max(at, row);
      if (mounted.current) setReached(at);
    };
    const started = startRun(async () => {
      try {
        const repo = useRepo.getState();
        const msg = remote
          ? await repo.deleteBranchAndRemote(req.branch, localOid, remote, req.repoPath, (step) =>
              advance(step === "local" ? 1 : 2),
            )
          : await repo.removeBranch(req.branch, localOid, req.repoPath, true, () => advance(1));
        const routine = remote ? `Deleted ${req.branch} and ${remote.remote}/${remote.branch}` : `Deleted ${req.branch}`;
        // Shown whether or not the dialog is still open; routine success stays silent.
        notifyCaveat(msg, routine);
        if (!mounted.current) return;
        setReached(runRows.length);
        // The heading; a caveat already went to the notification.
        setMessage(routine);
        setPhase("done");
      } catch (e) {
        if (!mounted.current) {
          useUi.getState().showToast(e, "error");
          return;
        }
        setFailedAt(at);
        setMessage(friendlyRepoError(e));
        setPhase("error");
      } finally {
        useUi.getState().setDeleteBranchRunning(false);
      }
    });
    if (!started) return;
    useUi.getState().setDeleteBranchRunning(true);
    setRows(runRows);
    setReached(0);
    setPhase("running");
  };

  return { phase, rows, reached, failedAt, message, start };
}
