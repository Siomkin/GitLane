// PR Diff tab: lazily fetches the full file diff for the PR and renders each
// file as a unified-diff card. Refetches after a manual refresh (prsFetchedAt
// bumps, caches cleared).
import { useEffect } from "react";
import type { PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { Loading, LoadError } from "@/components/ui/Loading";
import { StatusPill } from "@/components/ui/StatusBadge";
import { UnifiedDiffBody } from "../review/DiffBody";

export function PrDiffTab({ pr }: { pr: PullRequest }) {
  const diffs = usePulls((s) => s.prDiffs[pr.num]);
  const diffError = usePulls((s) => s.prDiffError[pr.num]);
  const loadPrDiff = usePulls((s) => s.loadPrDiff);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);

  // Lazily fetch the full diff when the tab is first shown for this PR; refetch
  // after a manual refresh (caches cleared, prsFetchedAt bumps).
  useEffect(() => {
    void loadPrDiff(pr.num);
  }, [pr.num, prsFetchedAt, loadPrDiff]);

  if (diffs === undefined) {
    return diffError ? (
      <LoadError message={diffError} onRetry={() => void loadPrDiff(pr.num, true)} />
    ) : (
      <Loading label="Loading diff…" />
    );
  }
  if (diffs.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-neutral-400">
        No file changes in this PR.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {diffs.map((file) => {
        const name = file.path.split("/").pop() ?? file.path;
        const dir = file.path.split("/").slice(0, -1).join("/");
        return (
          <div
            key={file.path}
            className="overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800"
          >
            <div className="flex items-center gap-2.5 border-b border-black/5 px-3.5 py-2.5 dark:border-white/5">
              <StatusPill status={file.status} />
              <div className="min-w-0 flex-1 truncate text-[12.5px]">
                <span className="text-neutral-400">{dir ? `${dir}/` : ""}</span>
                <span className="font-medium text-neutral-800 dark:text-neutral-100">{name}</span>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                <span className="text-emerald-500">+{file.add}</span>
                <span className="text-rose-500">−{file.del}</span>
              </span>
            </div>
            {file.binary ? (
              <div className="px-4 py-3 text-[12px] italic text-neutral-400">Binary file</div>
            ) : (
              <UnifiedDiffBody hunks={file.hunks} file={file.path} />
            )}
          </div>
        );
      })}
    </div>
  );
}
