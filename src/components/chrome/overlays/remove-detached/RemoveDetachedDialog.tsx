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
import { useBackdropDismiss } from "@/hooks/useBackdropDismiss";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUi, type RemoveDetachedRequest } from "@/store/ui";
import { StepRow } from "@/components/chrome/overlays/progress";
import { describeCollateral, describeSkip } from "./plan";
import { removeDetachedStepLabels, removeDetachedStepStatus } from "./steps";
import { useRemoveDetachedPreview } from "./useRemoveDetachedPreview";
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
  // Probe every candidate before offering to remove anything: "detached" alone
  // does not mean "disposable" (GL-297).
  const { ready, plan } = useRemoveDetachedPreview(req.targets);
  // The sweep and its checklist act on the worktrees themselves; the plan rows
  // additionally carry what each removal takes with it.
  const removeTargets = plan.remove.map((r) => r.worktree);
  const { phase, outcomes, message, hadFailure, start } = useRemoveDetachedRun(removeTargets);
  const stepLabels = removeDetachedStepLabels(removeTargets);
  const count = removeTargets.length;
  const noun = count === 1 ? "detached worktree" : "detached worktrees";
  // One source for the configure heading and the dialog's accessible name, so a
  // screen reader is never told "Remove 0 detached worktrees" while the dialog
  // visibly says it is still checking (or that there is nothing to remove).
  const heading = !ready
    ? "Checking worktrees…"
    : count > 0
      ? `Remove ${count} ${noun}`
      : "Nothing to remove";

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
  const backdrop = useBackdropDismiss();

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      // Mid-run a stray backdrop click shouldn't dismiss the progress view; the
      // explicit close button (and Escape) still work.
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick(phase === "running" ? undefined : closeRemoveDetached)}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={phase === "configure" ? heading : `Remove ${count} ${noun}`}
        aria-busy={phase === "configure" && !ready}
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
              {heading}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              {!ready
                ? "Checking each detached worktree for uncommitted work before offering to delete it."
                : count > 0
                  ? "These worktrees have no branch checked out and no uncommitted work. Removing them deletes their linked directories — commits reachable only from a detached HEAD may become unreachable."
                  : // Deliberately does not claim what the skipped rows contain:
                    // a withheld candidate may be dirty, agent-owned, or simply
                    // unverifiable, and each row states its own reason.
                    "None of these can be removed in bulk — each row below says why. Remove one individually to decide what happens to it."}
            </div>
            {/* The concrete target list (name + path) so the sweep is never a
                blind bulk action — each row it will act on is spelled out. */}
            {count > 0 && (
              <div className="mt-3.5 max-h-[168px] overflow-auto rounded-lg border border-black/[0.07] dark:border-white/[0.08]">
                {plan.remove.map((removable) => {
                  const collateral = describeCollateral(removable);
                  return (
                    <div
                      key={removable.worktree.path}
                      className="flex items-center gap-2 border-b border-black/[0.05] px-3 py-2 last:border-b-0 dark:border-white/[0.06]"
                    >
                      <TrashIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-neutral-700 dark:text-neutral-200">
                          {worktreeName(removable.worktree, req.targets)}
                        </div>
                        <div
                          className="truncate font-mono text-[10.5px] text-neutral-400"
                          title={removable.worktree.path}
                        >
                          {removable.worktree.path}
                        </div>
                        {/* Ignored files do not block the sweep — git deletes
                            them unforced — but a local .env is ignored too, so
                            say they are going rather than let them vanish. */}
                        {collateral && (
                          <div className="truncate text-[10.5px] text-neutral-400">{collateral}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Withheld candidates are listed, not silently dropped: a sweep that
                quietly shrinks its own target set is indistinguishable from one
                that found nothing. Each row says why it is being left alone. */}
            {ready && plan.skip.length > 0 && (
              <div className="mt-3.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06]">
                <div className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  Kept ({plan.skip.length})
                </div>
                <div className="max-h-[132px] overflow-auto">
                  {plan.skip.map((skipped) => (
                    <div key={skipped.worktree.path} className="flex items-center gap-2 px-3 py-2">
                      <WarningIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-neutral-700 dark:text-neutral-200">
                          {worktreeName(skipped.worktree, req.targets)}
                        </div>
                        <div className="truncate text-[10.5px] text-amber-700 dark:text-amber-400">
                          {describeSkip(skipped)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={closeRemoveDetached}
                className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                {ready && count === 0 ? "Close" : "Cancel"}
              </button>
              {(!ready || count > 0) && (
                <button
                  type="button"
                  onClick={start}
                  disabled={removeDetachedRunning || !ready}
                  className="h-10 flex-1 rounded-xl bg-rose-600 text-[13.5px] font-medium text-white hover:bg-rose-500 disabled:opacity-45"
                >
                  {ready ? `Remove ${count}` : "Checking…"}
                </button>
              )}
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
                <StepRow key={removeTargets[i]!.path} label={label} status={removeDetachedStepStatus(i, outcomes, true)} />
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
                <StepRow key={removeTargets[i]!.path} label={label} status={removeDetachedStepStatus(i, outcomes, false)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
