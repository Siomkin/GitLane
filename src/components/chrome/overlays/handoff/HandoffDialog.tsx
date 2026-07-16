// The worktree branch hand-off modal (GL-74): one dialog that carries the whole
// flow — pick a destination workspace and confirm, watch the live step
// checklist while the move runs, then read the success (or failure) message.
// Closing it mid-run is safe: the move keeps going and its result lands as a
// toast (see useHandoffRun).

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import {
  carriedLine,
  handoffDestinationOptions,
  worktreeLeaf,
} from "@/lib/worktreeHandoff";
import { CheckIcon, CloseIcon, WarningIcon } from "@/components/ui/icons";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useRepo } from "@/store/repo";
import { useUi, type HandoffRequest } from "@/store/ui";
import { StepRow } from "@/components/chrome/overlays/progress";
import { handoffStepLabels, handoffStepStatus } from "./steps";
import { useHandoffRun } from "./useHandoffRun";
import { Select } from "@/components/ui/Select";

/** The branch-between-workspaces glyph shown in the dialog's badge. */
function HandoffMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M17 3l4 4-4 4" />
      <path d="M21 7H7" />
      <path d="M7 21l-4-4 4-4" />
      <path d="M3 17h14" />
    </svg>
  );
}

export function HandoffDialog() {
  const handoff = useUi((s) => s.handoff);
  if (!handoff) return null;
  // Keyed so reopening (a different branch, source, or preset destination)
  // always starts a fresh flow instead of keeping stale useState picks.
  return (
    <HandoffDialogBody
      key={`${handoff.branch}@${handoff.sourcePath}@${handoff.destPath ?? ""}`}
      req={handoff}
    />
  );
}

function HandoffDialogBody({ req }: { req: HandoffRequest }) {
  const closeHandoff = useUi((s) => s.closeHandoff);
  const worktrees = useRepo((s) => s.worktrees);
  const options = useMemo(
    () => handoffDestinationOptions(worktrees, req.sourcePath),
    [worktrees, req.sourcePath],
  );
  // The user's raw pick. A live worktree refresh (FS watcher) can drop it from
  // `options` while the dialog is still on the configure screen, so it is not
  // necessarily a valid destination — read `selectedDest` (below), never this,
  // for anything that acts on the choice. A caller-preselected destination
  // (`destPath` — e.g. "Check out here" targeting the open worktree) seeds the
  // pick; `selectedDest` validates it against the live options like any pick.
  const [preferredDest, setPreferredDest] = useState(req.destPath ?? options[0]?.value ?? "");
  // Derive the in-range value during render rather than snapping the raw state
  // in an effect: the user's explicit pick is preserved, so if the worktree
  // reappears before they submit it is honored again instead of being silently
  // overwritten.
  const selectedDest = options.some((o) => o.value === preferredDest)
    ? preferredDest
    : options[0]?.value ?? "";
  // The checklist and destination name are captured when the run starts so the
  // mid-run repo refresh (which re-labels the destination with the handed-off
  // branch) can't rewrite the rows or the success title.
  const [stepLabels, setStepLabels] = useState<string[]>([]);
  const [destName, setDestName] = useState("");
  const { phase, reached, message, start } = useHandoffRun(req);

  const sourceName = worktreeLeaf(req.sourcePath);
  const destOption = options.find((o) => o.value === selectedDest);
  const destLabel = destOption?.label ?? (selectedDest ? worktreeLeaf(selectedDest) : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHandoff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHandoff]);

  // The success screen has no footer button (Codex-style) — move focus to the
  // header close button so keyboard users aren't stranded.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "done") closeRef.current?.focus();
  }, [phase]);

  // Keep Tab focus inside the dialog (keyboard users can't reach the content
  // behind it). Dismissal stays with the Escape listener + backdrop above.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);

  const submit = () => {
    if (!selectedDest) return;
    setStepLabels(handoffStepLabels(req.branch, destLabel));
    setDestName(destLabel);
    start(selectedDest);
  };

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      // Mid-run a stray backdrop click shouldn't dismiss the progress view; the
      // explicit close button (and Escape) still work.
      onClick={phase === "running" ? undefined : closeHandoff}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Hand off ${req.branch}`}
        tabIndex={-1}
        className="w-[440px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] outline-none dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="flex items-start justify-between">
          {/* The badge tracks the outcome (Codex-style): neutral hand-off mark
              while configuring/running, green check on success, rose on failure. */}
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-xl",
              phase === "done"
                ? "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400"
                : phase === "error"
                  ? "bg-rose-500/15 text-rose-600 dark:bg-rose-400/15 dark:text-rose-400"
                  : "border border-black/10 bg-black/[0.025] text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200",
            )}
          >
            {phase === "done" ? (
              <CheckIcon className="h-5 w-5" />
            ) : phase === "error" ? (
              <WarningIcon className="h-5 w-5" />
            ) : (
              <HandoffMarkIcon className="h-5 w-5" />
            )}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={closeHandoff}
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
              Hand off branch to another workspace
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              Check out{" "}
              <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-neutral-700 dark:bg-white/[0.07] dark:text-neutral-200">
                {req.branch}
              </span>{" "}
              in another workspace and detach it from{" "}
              <span className="font-semibold text-neutral-600 dark:text-neutral-300">{sourceName}</span>{" "}
              (left with no branch checked out).
            </div>
            <div className="mt-4 flex items-center gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400">
              <span className="shrink-0">Handing off to workspace</span>
              <Select
                wrapperClassName="min-w-0 flex-1"
                value={selectedDest}
                onChange={(e) => setPreferredDest(e.target.value)}
                aria-label="Destination workspace"
                className="w-full truncate rounded-md border border-black/10 bg-white pl-1.5 py-1 text-[12.5px] font-medium text-neutral-700 focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200"
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value} className="dark:bg-neutral-800">
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            {destOption && (
              <div className="mt-1.5 truncate text-right font-mono text-[10.5px] text-neutral-400">
                {destOption.hint}
              </div>
            )}
            <div className="mt-3 text-[12px] leading-relaxed text-neutral-400">
              {carriedLine(req.sourceChanges)}
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={!selectedDest}
              className="mt-5 h-10 w-full rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110 disabled:opacity-45"
            >
              Hand off
            </button>
          </>
        )}

        {phase === "running" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Handing off {req.branch}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              Hang tight, this may take a few moments. You can close this window — the result will
              show up as a notification.
            </div>
            <div className="mt-5 flex flex-col gap-3.5 pb-1">
              {stepLabels.map((label, i) => (
                <StepRow key={label} label={label} status={handoffStepStatus(i, reached, false)} />
              ))}
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Handed off to {destName || "the destination"}
            </div>
            {/* The backend message is the authoritative outcome — it also covers
                the kept-stash / carry-conflict endings, so show it verbatim. */}
            <div className="mt-2 pb-1 text-[12.5px] leading-relaxed text-neutral-400">{message}</div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Hand-off failed
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-neutral-400">
              {message}
            </div>
            <button
              type="button"
              autoFocus
              onClick={closeHandoff}
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
