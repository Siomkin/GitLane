// Center panel for the PRs view: the container that selects the active PR,
// drives the detail fetch, and gates the body on load state. The header renders
// from the list summary immediately; the body fetches full detail (body, files,
// checks, commits) via `gh`. Tab bodies live in sibling Pr*Tab files.

import { useEffect } from "react";
import type { PrStack } from "@/lib/api";
import { selectVisiblePrs, type PrDetail, type PrSummary } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
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
  const prDetails = usePulls((s) => s.prResources.detail.data);
  const prDetailLoadingByNum = usePulls((s) => s.prResources.detail.slots);
  const prDetailError = usePulls((s) => s.prResources.detail.errors);
  const prStacks = usePulls((s) => s.prStacks);
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
      if (usePulls.getState().prResources.checks.slots[activeNum]) return;
      void loadPrChecks(activeNum, true);
    }, CHECK_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeNum, loadPrChecks, summary?.state]);

  if (!summary) {
    // The list is still being fetched from gh — show a skeleton, not "empty".
    if (prsLoading && pullRequests.length === 0) {
      return (
        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white px-6 pb-7 pt-5 shadow-sm dark:border-white/5 dark:bg-neutral-800">
          <PrDetailSkeleton />
        </main>
      );
    }
    return (
      <main className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-black/5 bg-white text-neutral-400 shadow-sm dark:border-white/5 dark:bg-neutral-800">
        <PullRequestIcon className="h-8 w-8" />
        <span className="text-[13px]">No pull requests in this view</span>
      </main>
    );
  }

  // Prefer cached detail once loaded for this PR; fall back to the list summary
  // (the header renders either shape, the tab bodies only the detail).
  const detail: PrDetail | undefined = prDetails[summary.num];
  // Scoped to this PR so another PR's stale failure never bleeds in — and gated
  // on THIS PR's in-flight load (not the global flag), so another PR's pending
  // request can't mask the selected PR's error (GL-166).
  const detailError = prDetailLoadingByNum[summary.num] ? null : (prDetailError[summary.num] ?? null);

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <PrHeader pr={detail ?? summary} />
      <Body
        summary={summary}
        detail={detail ?? null}
        stack={prStacks[summary.num] ?? null}
        error={detailError}
        onRetry={() => void loadPrDetail(summary.num, true)}
      />
    </main>
  );
}

function Body({
  summary,
  detail,
  stack,
  error,
  onRetry,
}: {
  summary: PrSummary;
  /** Null until the detail fetch lands — the tab bodies only ever render a
   * full `PrDetail`, so they can read detail-only fields without narrowing. */
  detail: PrDetail | null;
  stack: PrStack | null;
  error: string | null;
  onRetry: () => void;
}) {
  const prTab = useUi((s) => s.prTab);
  // Not ready means we're fetching (or about to) — show a spinner unless an
  // actual error came back. This avoids any "blank"/"could not load" gap.
  if (!detail) {
    return (
      <div key={summary.num} className="min-h-0 flex-1 overflow-auto px-6 pb-7 pt-5">
        {error ? <LoadError message={error} onRetry={onRetry} /> : <PrDetailSkeleton />}
      </div>
    );
  }
  return (
    <div
      key={summary.num}
      className={`min-h-0 flex-1 px-6 pb-7 pt-5 ${prTab === "diff" ? "flex flex-col overflow-hidden" : "overflow-auto"}`}
    >
      {prTab === "info" && <PrInfoTab pr={detail} stack={stack} />}
      {prTab === "diff" && <PrDiffTab pr={detail} />}
      {prTab === "checks" && <PrChecksTab pr={detail} />}
      {prTab === "commits" && <PrCommitsTab pr={detail} />}
    </div>
  );
}
