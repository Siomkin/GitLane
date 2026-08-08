// One layer of the stack card: status icon on the connector rail, title,
// `#number · branch`, and a readiness pill. Presentational only.

import { cn } from "@/lib/cn";
import { InlineSpinner } from "@/components/ui/Loading";
import type { StackRow as Row } from "./stackModel";
import { STATUS_LABEL, type StackRowStatus } from "./stackModel";

// Amber, like GitHub's waiting states: the layer isn't broken, it's just held
// by something — a required check or review, or an unmergeable layer below.
// Both blocked states share it; the label carries the distinction.
const AMBER_PILL = "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400";
const AMBER_ICON = "text-amber-500";

// Pill + icon colour per status. "ready" carries the accent so the card reads
// as actionable at a glance; terminal states stay neutral.
const PILL: Record<StackRowStatus, string> = {
  ready: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  merged: "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  closed: "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  draft: "border-black/10 bg-black/[0.04] text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400",
  conflicts: "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  blocked: AMBER_PILL,
  blockedDownstack: AMBER_PILL,
  // Blue, deliberately not the violet of `merged`: in-flight and landed sit next
  // to each other in the same card, and the label alone is a weak distinction.
  merging: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

const ICON: Record<StackRowStatus, string> = {
  ready: "text-emerald-500",
  merged: "text-violet-500",
  closed: "text-rose-500",
  draft: "text-neutral-400",
  conflicts: "text-rose-500",
  blocked: AMBER_ICON,
  blockedDownstack: AMBER_ICON,
  merging: "text-sky-500",
};

function StatusIcon({ status }: { status: StackRowStatus }) {
  const common = "h-[15px] w-[15px] flex-none";
  // A filled dot for "waiting", matching GitHub's amber marker on a Not-ready
  // layer; a hollow ring for the states that carry no progress.
  // GitHub's blocked-downstack marker: a filled amber circle with a dash — the
  // layer itself is fine, the minus says something beneath it is holding it.
  if (status === "blockedDownstack") {
    return (
      <svg viewBox="0 0 24 24" className={cn(common, ICON[status])}>
        <circle cx="12" cy="12" r="9" fill="currentColor" />
        <path d="M8 12h8" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "blocked") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={cn(common, ICON[status])}>
        <circle cx="12" cy="12" r="7" />
      </svg>
    );
  }
  // A spinning arc for a layer whose merge is in flight, like GitHub's card.
  if (status === "merging") {
    return <InlineSpinner className={cn(common, ICON[status], "motion-reduce:animate-none")} />;
  }
  if (status === "conflicts" || status === "draft") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn(common, ICON[status])}>
        <circle cx="12" cy="12" r="9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn(common, ICON[status])}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.7 7.7-5.3 5.3a1 1 0 0 1-1.4 0L7.3 12.3a1 1 0 1 1 1.4-1.4l2 2 4.6-4.6a1 1 0 0 1 1.4 1.4Z" />
    </svg>
  );
}

export function StackRow({ row, last }: { row: Row; last: boolean }) {
  const { entry, status, isCurrent } = row;
  return (
    <div
      className={cn(
        "relative flex items-start gap-2.5 py-2 pl-3 pr-3",
        // The viewed PR gets the accent bar + tint, as on GitHub's stack map.
        isCurrent && "bg-black/[0.03] dark:bg-white/[0.05]",
      )}
    >
      {isCurrent && (
        <span className="absolute inset-y-0 left-0 w-[3px] rounded-r bg-[color:var(--accent)]" aria-hidden />
      )}
      <div className="relative flex flex-none flex-col items-center self-stretch pt-[3px]">
        <StatusIcon status={status} />
        {/* Connector down to the next layer — the rail that makes it a stack. */}
        {!last && <span className="mt-1 w-px flex-1 bg-black/12 dark:bg-white/15" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-[13px] leading-tight",
            isCurrent
              ? "font-semibold text-neutral-900 dark:text-neutral-50"
              : "font-medium text-neutral-700 dark:text-neutral-200",
          )}
        >
          {entry.title}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-neutral-400">
          #{entry.number} <span className="px-0.5">·</span>
          <span className="font-mono">{entry.headRef}</span>
        </div>
      </div>
      <span
        className={cn(
          "mt-[1px] flex-none rounded-full border px-2 py-[3px] text-[11px] font-medium",
          PILL[status],
        )}
        // The label matches GitHub's wording; the PR that must be fixed first
        // is still named, one hover away.
        title={row.blockedBy != null ? `Blocked by #${row.blockedBy}` : undefined}
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}
