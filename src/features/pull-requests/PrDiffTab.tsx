// PR Diff tab: lazily fetches the full file diff for the PR and renders each
// file in one virtualized row window, grouped under a commit header when the PR
// spans several commits (the patch is per-commit, so a path touched by two
// commits appears once per commit). Refetches after a manual refresh
// (prsFetchedAt bumps, caches cleared).
import { useEffect } from "react";
import type { PrSummary } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { Loading, LoadError } from "@/components/ui/Loading";
import { HandToAgentBar } from "@/features/review/comments";
import { PrDiffList } from "./PrDiffList";

export function PrDiffTab({ pr }: { pr: PrSummary }) {
  const diffs = usePulls((s) => s.prResources.diff.data[pr.num]);
  const diffError = usePulls((s) => s.prResources.diff.errors[pr.num]);
  const loadPrDiff = usePulls((s) => s.loadPrDiff);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);
  // Notes are scoped to this PR, and the hand-off names the PR's head branch.
  const surface = `pr:${pr.num}`;

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
    <div className="flex min-h-0 flex-1 flex-col">
      <PrDiffList diffs={diffs} surface={surface} />
      {/* Comments made on PR diffs remain reachable below the virtual window. */}
      <HandToAgentBar surfaces={[surface]} branch={pr.branch} />
    </div>
  );
}
