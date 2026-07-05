// The delete-branch-and-worktree modal (GL-107): one dialog carrying the whole
// flow — preview the destructive impact and confirm, watch the live step
// checklist (remove worktree → delete branch → refresh) while the two-phase
// backend op runs, then read the success (or failure) message. Closing it
// mid-run is safe: the delete keeps going and its result lands as a toast (see
// useDeleteWorktreeRun). Follows the GL-105 hand-off / GL-106 sign-in shell and
// the shared step checklist.

import { useEffect, useRef, useState } from "react";

import { type DestructivePreview } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { basename } from "@/lib/paths";
import {
  BranchIcon,
  CheckIcon,
  CloseIcon,
  TrashIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import { useRepo } from "@/store/repo";
import { useUi, type DeleteWorktreeRequest } from "@/store/ui";
import { StepRow } from "../progress";
import {
  deleteWorktreeStepLabels,
  deleteWorktreeStepStatus,
} from "./steps";
import { useDeleteWorktreeRun } from "./useDeleteWorktreeRun";

export function DeleteWorktreeDialog() {
  const req = useUi((s) => s.deleteWorktree);
  if (!req) return null;
  // Keyed so reopening (or a different branch) always starts a fresh flow.
  return <DeleteWorktreeDialogBody key={`${req.branch}@${req.worktreePath}`} req={req} />;
}

/** The impact preview: `null` while loading, a fetched preview, or the error
 * string. Fail closed — the Delete button stays disabled until it resolves, so a
 * failed preview never offers a one-click destructive action (GL-42). */
type PreviewState = { kind: "loading" } | { kind: "ready"; preview: DestructivePreview } | { kind: "error"; error: string };

function DeleteWorktreeDialogBody({ req }: { req: DeleteWorktreeRequest }) {
  const closeDeleteWorktree = useUi((s) => s.closeDeleteWorktree);
  const previewDeleteBranch = useRepo((s) => s.previewDeleteBranch);
  const { phase, reached, message, start } = useDeleteWorktreeRun(req);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const stepLabels = deleteWorktreeStepLabels();

  // Fetch the destructive impact for the configure screen. A live repo switch or
  // a gone branch surfaces as the error state (Delete disabled), never a silent
  // no-warning confirm.
  useEffect(() => {
    let alive = true;
    setPreview({ kind: "loading" });
    previewDeleteBranch(req.branch)
      .then((p) => alive && setPreview({ kind: "ready", preview: p }))
      .catch((e) => alive && setPreview({ kind: "error", error: String(e) }));
    return () => {
      alive = false;
    };
  }, [previewDeleteBranch, req.branch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDeleteWorktree();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDeleteWorktree]);

  // The success screen has no footer button (Codex-style) — move focus to the
  // header close button so keyboard users aren't stranded.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "done") closeRef.current?.focus();
  }, [phase]);

  const worktreeLeaf = basename(req.worktreePath);

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      // Mid-run a stray backdrop click shouldn't dismiss the progress view; the
      // explicit close button (and Escape) still work.
      onClick={phase === "running" ? undefined : closeDeleteWorktree}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Delete ${req.branch} and its worktree`}
        className="w-[440px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="flex items-start justify-between">
          {/* The badge tracks the outcome (Codex-style): rose trash while
              configuring (a destructive confirm), neutral trash while running,
              green check on success, rose warning on failure. */}
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-xl",
              phase === "done"
                ? "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400"
                : phase === "error"
                  ? "bg-rose-500/15 text-rose-600 dark:bg-rose-400/15 dark:text-rose-400"
                  : phase === "configure"
                    ? "bg-rose-500/[0.12] text-rose-600 dark:bg-rose-400/15 dark:text-rose-400"
                    : "border border-black/10 bg-black/[0.025] text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200",
            )}
          >
            {phase === "done" ? (
              <CheckIcon className="h-5 w-5" />
            ) : phase === "error" ? (
              <WarningIcon className="h-5 w-5" />
            ) : (
              <TrashIcon className="h-5 w-5" />
            )}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={closeDeleteWorktree}
            aria-label="Close dialog"
            className={cn(
              "grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {phase === "configure" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Delete branch and its worktree
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              Deletes{" "}
              <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-neutral-700 dark:bg-white/[0.07] dark:text-neutral-200">
                {req.branch}
              </span>{" "}
              and removes its linked worktree — both in one step.
            </div>
            <div className="mt-3.5 overflow-hidden rounded-lg border border-black/[0.07] dark:border-white/[0.08]">
              <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-2.5 dark:border-white/[0.07]">
                <BranchIcon className="h-4 w-4 shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-neutral-600 dark:text-neutral-300">
                  Worktree ·{" "}
                  <span className="font-mono text-[11.5px] text-neutral-500 dark:text-neutral-400">
                    {worktreeLeaf}
                  </span>
                </span>
              </div>
              <ImpactRow state={preview} />
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={closeDeleteWorktree}
                className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={start}
                disabled={preview.kind !== "ready"}
                className="h-10 flex-1 rounded-xl bg-rose-600 text-[13.5px] font-medium text-white hover:bg-rose-500 disabled:opacity-45"
              >
                Delete anyway
              </button>
            </div>
          </>
        )}

        {phase === "running" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Deleting {req.branch}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              Hang tight, this only takes a moment. You can close this window — the result will show
              up as a notification.
            </div>
            <div className="mt-5 flex flex-col gap-3.5 pb-1">
              {stepLabels.map((label, i) => (
                <StepRow key={label} label={label} status={deleteWorktreeStepStatus(i, reached, false)} />
              ))}
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Deleted {req.branch}
            </div>
            {/* The backend message is the authoritative outcome — show it verbatim. */}
            <div className="mt-2 pb-1 text-[12.5px] leading-relaxed text-neutral-400">{message}</div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Couldn’t delete the branch
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-neutral-400">
              {message}
            </div>
            <button
              type="button"
              autoFocus
              onClick={closeDeleteWorktree}
              className="mt-5 h-10 w-full rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The lower half of the impact card: a spinner while the preview loads, the
 * amber destructive warning once it's ready, or a rose failure line if it
 * couldn't be computed (Delete stays disabled in that case). */
function ImpactRow({ state }: { state: PreviewState }) {
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] text-neutral-400">
        <InlineSpinner className="h-4 w-4" />
        Checking what deleting this loses…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-start gap-2.5 bg-rose-500/[0.08] px-3 py-2.5 dark:bg-rose-400/[0.07]">
        <WarningIcon className="mt-px h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <div className="text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
          Couldn’t preview the impact: {state.error}
        </div>
      </div>
    );
  }
  // The recovery warning always applies; the commits-ahead detail (when present)
  // is the "unmerged commits are lost" emphasis, surfaced bold.
  const ahead = state.preview.details.find((d) => d.startsWith("Commits ahead"));
  return (
    <div className="flex items-start gap-2.5 bg-amber-500/[0.08] px-3 py-2.5 dark:bg-amber-400/[0.07]">
      <WarningIcon className="mt-px h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="text-pretty text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
        {ahead && (
          <span className="font-semibold text-neutral-800 dark:text-neutral-100">{ahead} </span>
        )}
        {state.preview.warnings.join(" ")}
      </div>
    </div>
  );
}
