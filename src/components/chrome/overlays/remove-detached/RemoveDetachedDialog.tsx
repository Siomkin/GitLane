// The bulk remove-detached-worktrees modal: one dialog carrying the whole flow —
// preview the destructive impact and confirm, watch a live per-worktree checklist
// while the frontend-driven sweep removes each one, then read the summary.
// Closing it mid-run is safe: the sweep keeps going and its summary lands as a
// toast (see useRemoveDetachedRun). Follows the GL-105 hand-off / GL-107
// delete-worktree shell and the shared step checklist.

import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { worktreeName } from "@/lib/worktrees";
import { CheckIcon, CloseIcon, TrashIcon, WarningIcon } from "@/components/ui/icons";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUi, type RemoveDetachedRequest } from "@/store/ui";
import { StepRow } from "@/components/chrome/overlays/progress";
import { removeDetachedStepLabels, removeDetachedStepStatus } from "./steps";
import { useRemoveDetachedRun } from "./useRemoveDetachedRun";

export function RemoveDetachedDialog() {
  const req = useUi((s) => s.removeDetached);
  if (!req) return null;
  // Keyed on the target set so reopening always starts a fresh flow.
  return <RemoveDetachedDialogBody key={req.targets.map((t) => t.path).join("|")} req={req} />;
}

function RemoveDetachedDialogBody({ req }: { req: RemoveDetachedRequest }) {
  const closeRemoveDetached = useUi((s) => s.closeRemoveDetached);
  // A background sweep from a prior, closed dialog may still be running; block a
  // second one and say why, rather than leaving an enabled button that no-ops.
  const removeDetachedRunning = useUi((s) => s.removeDetachedRunning);
  const { phase, outcomes, message, hadFailure, start } = useRemoveDetachedRun(req);
  const stepLabels = removeDetachedStepLabels(req.targets);
  const count = req.targets.length;
  const noun = count === 1 ? "detached worktree" : "detached worktrees";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRemoveDetached();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeRemoveDetached]);

  // The success screen has no footer button (Codex-style) — move focus to the
  // header close button so keyboard users aren't stranded.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "done") closeRef.current?.focus();
  }, [phase]);

  // Trap Tab focus inside the dialog; dismissal stays with Escape + backdrop.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      // Mid-run a stray backdrop click shouldn't dismiss the progress view; the
      // explicit close button (and Escape) still work.
      onClick={phase === "running" ? undefined : closeRemoveDetached}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Remove ${count} ${noun}`}
        tabIndex={-1}
        className="w-[440px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] outline-none dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="flex items-start justify-between">
          {/* The badge tracks the outcome (Codex-style): rose trash while
              configuring (a destructive confirm), neutral trash while running,
              green check on a clean sweep, rose warning when some failed. */}
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-xl",
              phase === "done" && !hadFailure
                ? "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400"
                : phase === "done"
                  ? "bg-rose-500/15 text-rose-600 dark:bg-rose-400/15 dark:text-rose-400"
                  : phase === "configure"
                    ? "bg-rose-500/[0.12] text-rose-600 dark:bg-rose-400/15 dark:text-rose-400"
                    : "border border-black/10 bg-black/[0.025] text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200",
            )}
          >
            {phase === "done" && !hadFailure ? (
              <CheckIcon className="h-5 w-5" />
            ) : phase === "done" ? (
              <WarningIcon className="h-5 w-5" />
            ) : (
              <TrashIcon className="h-5 w-5" />
            )}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={closeRemoveDetached}
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
              Remove {count} {noun}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              These worktrees have no branch checked out. Removing them deletes their linked
              directories — commits reachable only from a detached HEAD may become unreachable.
            </div>
            {/* The concrete target list (name + path) so the sweep is never a
                blind bulk action — each row it will act on is spelled out. */}
            <div className="mt-3.5 max-h-[168px] overflow-auto rounded-lg border border-black/[0.07] dark:border-white/[0.08]">
              {req.targets.map((wt) => (
                <div
                  key={wt.path}
                  className="flex items-center gap-2 border-b border-black/[0.05] px-3 py-2 last:border-b-0 dark:border-white/[0.06]"
                >
                  <TrashIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-neutral-700 dark:text-neutral-200">
                      {worktreeName(wt, req.targets)}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-neutral-400" title={wt.path}>
                      {wt.path}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={closeRemoveDetached}
                className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={start}
                disabled={removeDetachedRunning}
                className="h-10 flex-1 rounded-xl bg-rose-600 text-[13.5px] font-medium text-white hover:bg-rose-500 disabled:opacity-45"
              >
                Remove {count}
              </button>
            </div>
            {removeDetachedRunning && (
              <div className="mt-2.5 text-center text-[11.5px] text-neutral-400">
                Another sweep is still finishing — this will be ready in a moment.
              </div>
            )}
          </>
        )}

        {phase === "running" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Removing {count} {noun}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              Hang tight, this only takes a moment. You can close this window — the result will show
              up as a notification.
            </div>
            <div className="mt-5 flex max-h-[240px] flex-col gap-3.5 overflow-auto pb-1">
              {stepLabels.map((label, i) => (
                <StepRow key={req.targets[i].path} label={label} status={removeDetachedStepStatus(i, outcomes, true)} />
              ))}
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              {hadFailure ? "Some worktrees couldn’t be removed" : `Removed ${count} ${noun}`}
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-neutral-400">
              {message}
            </div>
            {/* Keep the checklist visible so a partial failure shows exactly
                which rows failed (rose ✗) versus removed (accent ✓). */}
            <div className="mt-4 flex max-h-[240px] flex-col gap-3.5 overflow-auto pb-1">
              {stepLabels.map((label, i) => (
                <StepRow key={req.targets[i].path} label={label} status={removeDetachedStepStatus(i, outcomes, false)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
