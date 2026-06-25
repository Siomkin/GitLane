// Center panel for the PRs view: the container that selects the active PR,
// drives the detail fetch, and gates the body on load state. The header renders
// from the list summary immediately; the body fetches full detail (body, files,
// checks, commits) via `gh`. Tab bodies live in sibling Pr*Tab files.

import { useEffect } from "react";
import { selectVisiblePrs, type PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { LoadError } from "@/components/ui/Loading";
import { PrDetailSkeleton } from "@/components/ui/Skeleton";
import { PullRequestIcon } from "@/components/ui/icons";
import { PrHeader } from "./PrHeader";
import { PrInfoTab } from "./PrInfoTab";
import { PrDiffTab } from "./PrDiffTab";
import { PrChecksTab } from "./PrChecksTab";
import { PrCommitsTab } from "./PrCommitsTab";

const CHECK_REFRESH_MS = 30_000;

export function PullRequestDetail() {
  const prFilter = useUi((s) => s.prFilter);
  const prSelected = useUi((s) => s.prSelected);
  const pullRequests = usePulls((s) => s.pullRequests);
  const prsLoading = usePulls((s) => s.prsLoading);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);
  const prDetails = usePulls((s) => s.prDetails);
  const prDetailLoading = usePulls((s) => s.prDetailLoading);
  const prDetailError = usePulls((s) => s.prDetailError);
  const loadPrDetail = usePulls((s) => s.loadPrDetail);
  const loadPrChecks = usePulls((s) => s.loadPrChecks);

  const visible = selectVisiblePrs(pullRequests, prFilter);
  const summary = visible.find((p) => p.num === prSelected) ?? visible[0] ?? null;
  const activeNum = summary?.num ?? null;

  // Fetch detail when the selection changes (cache makes re-opens instant) or
  // after a manual refresh (prsFetchedAt bumps, caches were cleared).
  useEffect(() => {
    if (activeNum != null) void loadPrDetail(activeNum);
  }, [activeNum, prsFetchedAt, loadPrDetail]);

  // Checks drive the tab badge, so start loading them with the selected PR
  // instead of waiting for the user to open the Checks tab.
  useEffect(() => {
    if (activeNum != null) void loadPrChecks(activeNum);
  }, [activeNum, prsFetchedAt, loadPrChecks]);

  // GitHub does not push check-state changes into the desktop app. Poll the
  // selected open PR's checks while this view is open so CI progress updates
  // without a manual refresh. Closed/merged PR checks are historical, so the
  // one-time load above is enough for them.
  useEffect(() => {
    if (activeNum == null || summary?.state !== "open") return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      // Skip if the previous poll's checks load is still in flight (the endpoint
      // is already treated as slow) so requests don't stack past the interval.
      if (usePulls.getState().prChecksLoadingByNum[activeNum]) return;
      void loadPrChecks(activeNum, true);
    }, CHECK_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeNum, loadPrChecks, summary?.state]);

  if (!summary) {
    // The list is still being fetched from gh — show a skeleton, not "empty".
    if (prsLoading && pullRequests.length === 0) {
      return (
        <main className="flex min-h-0 min-w-0 flex-col bg-neutral-50 px-6 pb-7 pt-5 dark:bg-neutral-900">
          <PrDetailSkeleton />
        </main>
      );
    }
    return (
      <main className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2.5 bg-neutral-50 text-neutral-400 dark:bg-neutral-900">
        <PullRequestIcon className="h-8 w-8" />
        <span className="text-[13px]">No pull requests in this view</span>
      </main>
    );
  }

  // Prefer cached detail once loaded for this PR; fall back to the list summary.
  const detail = prDetails[summary.num];
  const detailReady = detail != null;
  const pr = detail ?? summary;
  // Scoped to this PR so another PR's stale failure never bleeds in.
  const detailError = prDetailLoading ? null : (prDetailError[summary.num] ?? null);

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-neutral-50 dark:bg-neutral-900">
      <PrHeader pr={pr} />
      <Body
        pr={pr}
        detailReady={detailReady}
        error={detailError}
        onRetry={() => void loadPrDetail(summary.num, true)}
      />
    </main>
  );
}

function Body({
  pr,
  detailReady,
  error,
  onRetry,
}: {
  pr: PullRequest;
  detailReady: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const prTab = useUi((s) => s.prTab);
  // Not ready means we're fetching (or about to) — show a spinner unless an
  // actual error came back. This avoids any "blank"/"could not load" gap.
  if (!detailReady) {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-7 pt-5">
        {error ? <LoadError message={error} onRetry={onRetry} /> : <PrDetailSkeleton />}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-7 pt-5">
      {prTab === "info" && <PrInfoTab pr={pr} />}
      {prTab === "diff" && <PrDiffTab pr={pr} />}
      {prTab === "checks" && <PrChecksTab pr={pr} />}
      {prTab === "commits" && <PrCommitsTab pr={pr} />}
    </div>
  );
}
