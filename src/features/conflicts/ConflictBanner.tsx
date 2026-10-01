import { cn } from "@/lib/cn";
import { operationLabel } from "@/store/operation";
import type { ActiveOperationKind } from "@/store/repo";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";

const continueLabel = (kind: ActiveOperationKind) =>
  kind === "merge"
    ? "Commit merge"
    : kind === "carry"
      ? "Finish carry"
      : `Continue ${operationLabel(kind).toLowerCase()}`;

export const ConflictBanner = ({
  kind,
  canSkip,
  total,
  unresolved,
  allResolved,
  onContinue,
  onAbort,
  onSkip,
}: {
  kind: ActiveOperationKind;
  canSkip: boolean;
  total: number;
  unresolved: number;
  allResolved: boolean;
  onContinue: () => void;
  onAbort: () => void;
  onSkip: () => void;
}) => {
  const label = operationLabel(kind);
  const sub = allResolved
    ? `All conflicts resolved and staged — ready to ${continueLabel(kind).toLowerCase()}`
    : unresolved > 0
      ? `${unresolved} of ${total} file${total === 1 ? "" : "s"} ${unresolved === 1 ? "has" : "have"} unresolved conflicts`
      : "Stage your resolved files to continue";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-xl border px-3.5 py-1.5",
        allResolved
          ? "border-[color:var(--accent)]/30 bg-[var(--accent-soft)]"
          : "border-amber-200 bg-amber-50 dark:border-amber-400/20 dark:bg-amber-400/[0.08]",
      )}
    >
      <div
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-full",
          allResolved
            ? "bg-[var(--accent)] text-white"
            : "bg-amber-400/20 text-amber-600 dark:text-amber-300",
        )}
      >
        {allResolved ? <CheckIcon className="h-4 w-4" /> : <WarningIcon strokeWidth="1.9" className="h-4 w-4" />}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          {label} in progress
        </span>
        <span
          className={cn(
            "grid h-5 shrink-0 place-items-center rounded-md px-1.5 text-[10px] font-semibold uppercase tracking-wide",
            allResolved
              ? "bg-[var(--accent)] text-white"
              : "bg-amber-400/20 text-amber-700 dark:text-amber-300",
          )}
        >
          {label}
        </span>
        <span className="truncate text-[12px] text-neutral-500 dark:text-neutral-400">{sub}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button"
          onClick={onAbort}
          className="h-8 rounded-lg border border-rose-300/60 px-3 text-[12.5px] font-medium text-rose-600 hover:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-400"
        >
          Abort {label.toLowerCase()}
        </button>
        {canSkip && (
          <button type="button"
            onClick={onSkip}
            className="h-8 rounded-lg border border-black/10 px-3 text-[12.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            Skip commit
          </button>
        )}
        <button type="button"
          onClick={onContinue}
          disabled={!allResolved}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium",
            allResolved
              ? "bg-[var(--accent)] text-white hover:brightness-110"
              : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          {continueLabel(kind)}
        </button>
      </div>
    </div>
  );
};
