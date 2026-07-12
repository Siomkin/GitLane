// PR Checks tab: renders the selected PR's CI checks once the parent detail
// container has loaded them, plus an inline retry on checks-load failure.
import type { PullRequest } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { Loading, LoadError } from "@/components/ui/Loading";
import { CHECK_STATUS_LABEL, checkSummary, countChecks, type PrCheckTone } from "./prChecks";

const summaryToneClass: Record<PrCheckTone, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  fail: "text-rose-600 dark:text-rose-400",
  pending: "text-amber-600 dark:text-amber-400",
  skipped: "text-neutral-500 dark:text-neutral-400",
  none: "text-neutral-500 dark:text-neutral-400",
};

const rowIconClass: Record<PrCheckTone, string> = {
  pass: "text-emerald-500",
  fail: "text-rose-500",
  pending: "text-amber-500",
  skipped: "text-neutral-400",
  none: "text-neutral-400",
};

export const PrChecksTab = ({ pr }: { pr: PullRequest }) => {
  const checks = usePulls((s) => s.prChecks[pr.num]);
  const checksError = usePulls((s) => s.prChecksError[pr.num]);
  const loadPrChecks = usePulls((s) => s.loadPrChecks);

  if (checks === undefined) {
    return checksError ? (
      <LoadError message={checksError} onRetry={() => void loadPrChecks(pr.num, true)} />
    ) : (
      <Loading label="Loading checks…" />
    );
  }
  if (checks.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-neutral-400">No checks on this PR.</div>
    );
  }

  const summary = checkSummary(countChecks(checks));

  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 text-[13px] font-medium ${summaryToneClass[summary.tone]}`}>
        <CheckIcon tone={summary.tone} />
        {summary.label}
      </div>
      <div className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-neutral-800">
        {checks.map((check) => (
          <div key={check.name} className="flex h-11 items-center gap-2.5 px-3.5">
            <CheckIcon
              tone={check.state}
              className={`h-4 w-4 ${rowIconClass[check.state]}`}
              strokeWidth="2.2"
            />
            <span className="flex-1 truncate text-[13px] text-neutral-700 dark:text-neutral-200">
              {check.name}
            </span>
            <span className="text-[12px] text-neutral-400">
              {CHECK_STATUS_LABEL[check.state]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const CheckIcon = ({
  tone,
  className,
  strokeWidth = "2",
}: {
  tone: PrCheckTone;
  className?: string;
  strokeWidth?: string;
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    className={className ?? "h-4 w-4"}
  >
    {tone === "pass" ? (
      <path d="M20 6 9 17l-5-5" />
    ) : tone === "fail" ? (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </>
    ) : tone === "pending" ? (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ) : (
      <>
        <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
        <path d="M9 12h6" />
      </>
    )}
  </svg>
);
