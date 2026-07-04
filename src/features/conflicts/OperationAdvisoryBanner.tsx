import type { OperationAdvisory } from "../../lib/api";

/** A slim, read-only banner for a non-drivable in-progress git state (`git am`
 * or bisect). GitLane can't continue/abort these in-app — unlike the
 * merge/rebase conflict workspace — so this only *informs* the user and points
 * them at the terminal, without taking over the center pane. */
const COPY: Record<Exclude<OperationAdvisory, "">, { label: string; detail: string }> = {
  "apply-mailbox": {
    label: "Applying patches (git am)",
    detail: "A git am is in progress. Continue, skip, or abort it from the terminal.",
  },
  bisect: {
    label: "Bisect in progress",
    detail: "A git bisect session is active. Mark commits or end it from the terminal.",
  },
};

export const OperationAdvisoryBanner = ({
  advisory,
  hasConflicts = false,
}: {
  advisory: OperationAdvisory;
  /** True when the working tree still has conflicted paths. GitLane can't drive
   * these operations, so the copy tells the user the conflicts (visible in the
   * Changes view) must be resolved from the terminal too. */
  hasConflicts?: boolean;
}) => {
  if (advisory === "") return null;
  const { label } = COPY[advisory];
  const detail = hasConflicts
    ? "Conflicted files are listed under Changes; resolve them and continue this operation from the terminal."
    : COPY[advisory].detail;

  return (
    <div className="mb-2.5 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-1.5 dark:border-amber-400/20 dark:bg-amber-400/[0.08]">
      <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-400/20 text-amber-600 dark:text-amber-300">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          {label}
        </span>
        <span className="truncate text-[12px] text-neutral-500 dark:text-neutral-400">{detail}</span>
      </div>
      <span className="grid h-5 shrink-0 place-items-center rounded-md bg-amber-400/20 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Read-only
      </span>
    </div>
  );
};
