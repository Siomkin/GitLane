// PR Diff tab: lazily fetches the full file diff for the PR and renders each
// file as a unified-diff card, grouped under a commit header when the PR spans
// several commits (the patch is per-commit, so a path touched by two commits
// appears once per commit). Refetches after a manual refresh (prsFetchedAt
// bumps, caches cleared).
import { useEffect } from "react";
import type { PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { Loading, LoadError } from "@/components/ui/Loading";
import { StatusPill } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { UnifiedDiffBody } from "../review/DiffBody";
import { BinaryDiff } from "../review/BinaryDiff";
import { HandToAgentBar } from "../review/comments";
import { groupByCommit, showCommitHeaders } from "./prDiffGroups";

export function PrDiffTab({ pr }: { pr: PullRequest }) {
  const diffs = usePulls((s) => s.prDiffs[pr.num]);
  const diffError = usePulls((s) => s.prDiffError[pr.num]);
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

  const groups = groupByCommit(diffs);
  const showHeaders = showCommitHeaders(groups);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group, gi) => (
        <div key={`${gi}:${group.oid ?? ""}`} className="flex flex-col gap-4">
          {showHeaders && group.oid && (
            <div data-testid="commit-group-header" className="flex min-w-0 items-center gap-2 px-1 pt-1">
              <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
                {group.oid.slice(0, 7)}
              </span>
              <span className="min-w-0 truncate text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
                {group.subject ?? ""}
              </span>
            </div>
          )}
          {group.files.map(({ file, index }) => {
            const name = file.path.split("/").pop() ?? file.path;
            const dir = file.path.split("/").slice(0, -1).join("/");
            return (
              <div
                // The patch is per-commit, so a path touched by several commits
                // appears once per commit — the path alone would collide.
                key={`${index}:${file.path}`}
                className="overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800"
              >
                <div className="flex items-center gap-2.5 border-b border-black/5 px-3.5 py-2.5 dark:border-white/5">
                  <StatusPill status={file.status} />
                  <div className="min-w-0 flex-1 truncate text-[12.5px]">
                    <span className="text-neutral-400">{dir ? `${dir}/` : ""}</span>
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">{name}</span>
                  </div>
                  <ChangeCounts add={file.add} del={file.del} binary={file.binary} className="shrink-0 text-[11px]" />
                </div>
                {file.binary ? (
                  // GitHub patches carry no byte sizes, so this shows the type +
                  // change-kind card (no image preview) rather than the old "Binary
                  // file" text.
                  <BinaryDiff diff={file} />
                ) : (
                  <UnifiedDiffBody hunks={file.hunks} file={file.path} surface={surface} />
                )}
              </div>
            );
          })}
        </div>
      ))}
      {/* Comments made on PR diffs are reachable here too (docked at the bottom). */}
      <HandToAgentBar surfaces={[surface]} branch={pr.branch} />
    </div>
  );
}
