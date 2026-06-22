// PR Checks tab: lazily fetches CI check runs for the PR and renders a
// pass/fail summary plus a row per check. Refetches after a manual refresh
// (prsFetchedAt bumps, caches cleared).
import { useEffect } from "react";
import type { PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { Loading, LoadError } from "@/components/ui/Loading";

export function PrChecksTab({ pr }: { pr: PullRequest }) {
  const checks = usePulls((s) => s.prChecks[pr.num]);
  const checksError = usePulls((s) => s.prChecksError[pr.num]);
  const loadPrChecks = usePulls((s) => s.loadPrChecks);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);

  // Lazily fetch checks when the tab is first shown for this PR; refetch after
  // a manual refresh (caches cleared, prsFetchedAt bumps).
  useEffect(() => {
    void loadPrChecks(pr.num);
  }, [pr.num, prsFetchedAt, loadPrChecks]);

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

  const allPassed = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok).length;

  return (
    <div className="space-y-3">
      {allPassed ? (
        <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <circle cx="12" cy="12" r="9" />
            <path d="m8.5 12 2.5 2.5 4.5-5" />
          </svg>
          All checks have passed
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[13px] font-medium text-rose-600 dark:text-rose-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          {failed} {failed === 1 ? "check" : "checks"} failing
        </div>
      )}
      <div className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-neutral-800">
        {checks.map((check) => (
          <div key={check.name} className="flex h-11 items-center gap-2.5 px-3.5">
            {check.ok ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4 text-emerald-500">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4 text-rose-500">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            )}
            <span className="flex-1 truncate text-[13px] text-neutral-700 dark:text-neutral-200">
              {check.name}
            </span>
            <span className="text-[12px] text-neutral-400">{check.ok ? "passed" : "failed"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
