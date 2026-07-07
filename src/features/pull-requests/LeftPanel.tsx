import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { relativeSince, selectVisiblePrs } from "../../lib/prs";
import { ForgeKind } from "../../lib/api";
import { usePulls } from "../../store/pulls";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { Spinner } from "@/components/ui/Loading";
import { PrListSkeleton } from "@/components/ui/Skeleton";
import { PlusIcon } from "@/components/ui/icons";
import { stateView } from "./prState";

// Docked sidebar for PR mode. The branch navigator that used to share this panel
// now floats from the "Checked out" trigger (see BranchNavigator), so in history
// mode the graph reclaims the full width.
export function LeftPanel() {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800 max-[820px]:hidden">
      <PullRequestsPanel />
    </aside>
  );
}

function PullRequestsPanel() {
  const prFilter = useUi((state) => state.prFilter);
  const setPrFilter = useUi((state) => state.setPrFilter);
  const prSelected = useUi((state) => state.prSelected);
  const selectPr = useUi((state) => state.selectPr);
  const pullRequests = usePulls((state) => state.pullRequests);
  const prsLoading = usePulls((state) => state.prsLoading);
  const prError = usePulls((state) => state.prError);
  const prsFetchedAt = usePulls((state) => state.prsFetchedAt);
  const refreshPullRequests = usePulls((state) => state.refreshPullRequests);
  const loadPullRequests = usePulls((state) => state.loadPullRequests);
  const openCreatePr = useUi((state) => state.openCreatePr);
  const headBranch = useRepo((state) => state.summary?.headBranch ?? null);
  // An unborn branch resolves a name but has no commits, so there's nothing to
  // open a PR from — keep "New PR" disabled even though `headBranch` is set.
  const unborn = useRepo((state) => state.summary?.unborn ?? false);
  // Creating a PR is supported on GitHub (via `gh`), GitLab (via glab / REST v4,
  // GL-140), and Bitbucket (via REST 2.0, GL-141). Treat an unknown forge
  // (`null` — still loading, or detection failed) as capable, matching the
  // store's load gate (`loadPullRequests` only blocks a *known* unsupported
  // forge); otherwise a supported repo whose list still loads would have
  // "New PR" wrongly disabled.
  const prsUnsupported = useRepo(
    (state) =>
      state.forge != null &&
      state.forge.kind !== ForgeKind.GitHub &&
      state.forge.kind !== ForgeKind.GitLab &&
      state.forge.kind !== ForgeKind.Bitbucket,
  );
  const [now, setNow] = useState(() => Date.now());

  // Foreground-load whenever the panel opens so the spinner is visible (the
  // repo-open prefetch is quiet and only feeds the badge).
  useEffect(() => {
    void loadPullRequests();
  }, [loadPullRequests]);

  useEffect(() => {
    if (!prsFetchedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [prsFetchedAt]);

  const visible = selectVisiblePrs(pullRequests, prFilter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2.5 border-b border-black/5 p-2.5 dark:border-white/5">
        <div className="flex rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/[0.06]">
          {(["open", "closed", "all"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setPrFilter(key)}
              className={cn(
                "flex-1 rounded-md py-1.5 text-[13px] capitalize transition-colors",
                prFilter === key
                  ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                  : "font-medium text-neutral-500 dark:text-neutral-400",
              )}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-400">
          <span>
            {prsLoading
              ? "Updating…"
              : prsFetchedAt
                ? `Updated ${relativeSince(prsFetchedAt, now)} ago`
                : "Not loaded"}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={openCreatePr}
              disabled={!headBranch || unborn || prsUnsupported}
              title={
                prsUnsupported
                  ? "Pull requests aren't available for this repository's remote"
                  : unborn
                    ? "Make the first commit before opening a pull request"
                    : headBranch
                      ? "Open a new pull request"
                      : "Check out a branch first"
              }
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            >
              <PlusIcon className="h-3 w-3" />
              New PR
            </button>
            <span className="h-3 w-px bg-black/10 dark:bg-white/10" />
            <button
              onClick={() => void refreshPullRequests()}
              disabled={prsLoading}
              title="Refresh pull requests"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            >
              {prsLoading ? (
                <Spinner className="h-3 w-3" />
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  className="h-3 w-3"
                >
                  <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
                </svg>
              )}
              Refresh
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {prError && !prsLoading && (
          <div className="px-2 py-3 text-[11.5px] leading-relaxed text-neutral-400">
            {prError.includes("gh) not found")
              ? "GitHub CLI (gh) not found. Install it from cli.github.com to see pull requests."
              : prError}
          </div>
        )}
        {!prError && prsLoading && <PrListSkeleton />}
        {!prError && !prsLoading && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-neutral-400">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-8 w-8"
            >
              <circle cx="6" cy="6" r="2" />
              <circle cx="18" cy="18" r="2" />
              <path d="M6 8v10" />
              <path d="M18 16V9a3 3 0 0 0-3-3h-2" />
              <path d="m13 3-3 3 3 3" />
            </svg>
            <span className="text-[13px]">
              {prFilter === "open"
                ? "No open pull requests"
                : prFilter === "closed"
                  ? "No closed pull requests"
                  : "No pull requests"}
            </span>
          </div>
        )}
        {!prError &&
          !prsLoading &&
          visible.map((pr) => {
            const sv = stateView(pr);
            const selected = pr.num === prSelected;
            return (
              <div
                key={pr.num}
                onClick={() => selectPr(pr.num)}
                className={cn(
                  "cursor-pointer rounded-xl border p-3 transition-colors",
                  selected
                    ? "border-[color:var(--accent)] bg-[var(--accent-soft)]"
                    : "border-black/5 hover:bg-black/5 dark:border-white/5 dark:hover:bg-white/5",
                )}
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-neutral-400">#{pr.num}</span>
                  <span className={cn("flex items-center gap-1 font-medium", sv.text)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", sv.dot)} />
                    {sv.label}
                  </span>
                  <span className="ml-auto text-neutral-400">{pr.age}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-neutral-800 dark:text-neutral-100">
                  {pr.title}
                </div>
                <div className="mt-2 flex items-center gap-2 font-mono text-[11px]">
                  <span className="flex min-w-0 items-center gap-1 text-neutral-400">
                    <span className="truncate">{pr.branch}</span>
                    <span className="shrink-0">→</span>
                    <span className="shrink-0">{pr.base}</span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="text-[color:var(--accent)]">+{pr.add}</span>
                    <span className="text-rose-500">−{pr.del}</span>
                  </span>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
