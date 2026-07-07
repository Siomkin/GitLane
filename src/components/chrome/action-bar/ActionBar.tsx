import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { currentBranchSyncView, defaultPublishTarget } from "../../../lib/branchSync";
import { ForgeKind } from "../../../lib/api";
import { changeTotal, summarizeChanges } from "../../../lib/changeSummary";
import { useDismiss } from "../../../hooks/useDismiss";
import { focusRing } from "../../../lib/ui";
import type { LeftTab } from "../../../lib/ui";
import { useRepo } from "../../../store/repo";
import { usePulls } from "../../../store/pulls";
import { useUi } from "../../../store/ui";
import { useAccounts } from "../../../store/accounts";
import { BranchNavigator } from "../../navigation/branch-navigator";
import {
  BranchIcon,
  ClockIcon,
  FetchIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  StashIcon,
  TerminalIcon,
} from "../../ui/icons";
import { SegTab } from "./SegTab";
import { ToolbarAction } from "./ToolbarAction";
import { Separator } from "./Separator";
import { WorktreeIndicator } from "./WorktreeIndicator";
import { ProviderIndicator, deriveProviderState } from "./provider-indicator";
import type { ProviderState } from "./provider-indicator";

/** Network ops that surface a per-button spinner driven by their command promise. */
type NetOp = "fetch" | "pull" | "push";

const PR_BADGE_REFRESH_MS = 60_000;

export const ActionBar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
}) => {
  const summary = useRepo((state) => state.summary);
  const forge = useRepo((state) => state.forge);
  const branches = useRepo((state) => state.branches);
  const loading = useRepo((state) => state.loading);
  const fetch = useRepo((state) => state.fetch);
  const pull = useRepo((state) => state.pull);
  const push = useRepo((state) => state.push);
  const publishBranch = useRepo((state) => state.publishBranch);
  const stash = useRepo((state) => state.stash);
  const changes = useRepo((state) => state.changes);
  const pullRequests = usePulls((state) => state.pullRequests);
  const loadPullRequests = usePulls((state) => state.loadPullRequests);
  const openCreateBranch = useUi((state) => state.setCreateBranchOpen);
  const openSettings = useUi((state) => state.openSettings);
  const openRepoSettings = useUi((state) => state.openRepoSettings);
  const toggleTerminal = useUi((state) => state.toggleTerminal);
  const openRecovery = useUi((state) => state.openRecovery);
  const terminalVisible = useUi((state) => state.terminalView !== "hidden");
  const navOpen = useUi((state) => state.navOpen);
  const toggleNav = useUi((state) => state.toggleNav);
  const openNav = useUi((state) => state.openNav);
  const closeNav = useUi((state) => state.closeNav);
  const requestPrompt = useUi((state) => state.requestPrompt);
  const selectPr = useUi((state) => state.selectPr);
  const accounts = useAccounts((state) => state.accounts);
  const accountsError = useAccounts((state) => state.accountsError);
  const accountsLoading = useAccounts((state) => state.accountsLoading);
  const repoAccountRef = useAccounts((state) => state.repoAccountRef);
  // Whether GitLab MRs can be fetched (glab / stored token) — drives the provider
  // popover's connected-vs-needs-auth state for a GitLab repo (GL-145).
  const gitlabReady = useAccounts((state) => state.gitlabPr().ready);
  // Whether Bitbucket PRs can be fetched (stored token) — same connected-vs-
  // needs-auth signal for a Bitbucket repo (GL-141).
  const bitbucketReady = useAccounts((state) => state.bitbucketPr().ready);

  // Per-button in-flight state for the network ops. The store's single global
  // `loading` flag can't say which button is busy (and `pull`/`push` don't even
  // toggle it), so we track each spinner against its own awaited command promise.
  // `busyRef` is the synchronous re-entry guard — `busy` state lags a render, so
  // a fast double-click (or starting a second op before the first resolves)
  // would otherwise run twice and clear `busy` while the first is still in
  // flight. Only one network op runs at a time.
  const [busy, setBusy] = useState<NetOp | null>(null);
  const busyRef = useRef(false);
  const run = (key: NetOp, action: () => Promise<unknown>) => async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // Distinct changed files (conflicts included), so the toolbar badge agrees
  // with the WIP row's per-type breakdown — a path staged *and* edited in the
  // worktree counts once, not twice.
  const workCount = changeTotal(summarizeChanges(changes));
  // Badge counts only open PRs — the list is fetched `--state all`, but a tab
  // badge should reflect what needs attention, not merged/closed history.
  const prCount = pullRequests.filter((pr) => pr.state === "open").length;
  const showPulls = activeTab === "pulls";

  const currentBranch = summary?.detached
    ? `detached @ ${summary.headOid?.slice(0, 7) ?? "?"}`
    : summary?.unborn
      ? "No commits yet"
      : summary?.headBranch ?? "No branch";
  const currentSync = currentBranchSyncView(summary, branches);
  // Open PR whose head is the checked-out branch — surfaced as a clickable badge.
  // An unborn branch has no pushed commits, so it can't own a PR even if one
  // happens to share its name (e.g. the default `main`); skip the match.
  const openPr =
    summary?.detached || summary?.unborn
      ? undefined
      : pullRequests.find((pr) => pr.state === "open" && pr.branch === summary?.headBranch);

  // Remote-provider status: forge detection (backend) combined with auth state
  // (accounts store). GitHub and GitLab support PRs (each surfaces needs-auth
  // when its sign-in is missing); other recognised forges (Bitbucket, …) are
  // "connected" (repo link works, no PRs), and an unrecognised host is
  // "unsupported". See the popover model.
  const providerState: ProviderState | null = forge
    ? deriveProviderState(forge, {
        accounts,
        accountsError,
        accountsLoading,
        repoAccountRef,
        gitlabReady,
        bitbucketReady,
      })
    : null;

  // The PR badge is always visible in the toolbar, so keep its count warm even
  // before the PR panel opens. Foreground loads still happen in LeftPanel for a
  // visible spinner; these quiet loads just keep the badge current.
  useEffect(() => {
    // PRs are supported on GitHub, GitLab (GL-140), and Bitbucket (GL-141); the
    // store's gate handles the account/transport resolution per forge.
    const prForge =
      forge?.kind === ForgeKind.GitHub ||
      forge?.kind === ForgeKind.GitLab ||
      forge?.kind === ForgeKind.Bitbucket;
    if (!summary || !prForge) return;
    void loadPullRequests(false, true);
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void loadPullRequests(false, true);
    }, PR_BADGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [forge?.kind, loadPullRequests, summary?.path, repoAccountRef?.accountId]);

  // ⌘ + Option + F opens the navigator and focuses its filter (the input
  // autofocuses on mount). `code === "KeyF"` since Option+F yields "ƒ" on macOS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyF") {
        e.preventDefault();
        openNav();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openNav]);

  // The 280px dropdown is anchored under the branch button; dismiss it on
  // outside click / Escape.
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(navOpen, closeNav, wrapRef);

  const selectTab = (tab: LeftTab) => {
    closeNav();
    onTabChange(tab);
  };
  const runPush = () => {
    const branch = summary?.headBranch;
    if (branch && currentSync.needsPublishPrompt) {
      const info = branches.find((b) => b.kind === "local" && b.name === branch);
      requestPrompt({
        title: `Publish ${branch}`,
        message: `Remote branch for ${branch} to push to and pull from.`,
        placeholder: "origin/branch",
        defaultValue: defaultPublishTarget(
          branches,
          branch,
          info?.upstream,
          info?.sync?.status !== "staleUpstream",
        ),
        confirmLabel: "Publish",
        onSubmit: (upstream) => void run("push", () => publishBranch(branch, upstream))(),
      });
      return;
    }
    void run("push", push)();
  };

  return (
    <div ref={wrapRef} className="relative flex-none">
      <div className="flex h-14 items-center gap-2 px-3.5">
        <div className="flex h-8 flex-none items-center rounded-lg bg-black/[0.06] p-0.5 text-[13px] dark:bg-white/[0.06]">
          <SegTab
            active={!showPulls}
            onClick={() => selectTab("history")}
            icon={<ClockIcon className="h-3.5 w-3.5" />}
            label="Commits"
            badge={workCount > 0 ? workCount : undefined}
            badgeTone="accent"
          />
          <SegTab
            active={showPulls}
            onClick={() => selectTab("pulls")}
            icon={<PullRequestIcon className="h-3.5 w-3.5" />}
            label="PRs"
            badge={prCount > 0 ? prCount : undefined}
            badgeTone="purple"
          />
        </div>

        <div className="relative">
          <button
            onClick={toggleNav}
            title={`Branches, worktrees & stashes. ${currentSync.title}`}
            className="flex h-8 max-w-[320px] items-center gap-2 rounded-lg border border-black/10 bg-white/40 px-3 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
          >
            <BranchIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
            <span className="truncate text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
              {currentBranch}
            </span>
            {currentSync.label && (
              <span
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  currentSync.canPull || currentSync.canPush
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                    : "bg-black/5 text-neutral-400 dark:bg-white/5",
                )}
              >
                {currentSync.label}
              </span>
            )}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn(
                "h-4 w-4 shrink-0 text-neutral-400 transition-transform",
                navOpen && "rotate-180",
              )}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {navOpen && (
            <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-[280px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.38)] dark:border-white/10 dark:bg-neutral-800">
              <BranchNavigator />
            </div>
          )}
        </div>

        <WorktreeIndicator />

        {openPr && (
          <button
            onClick={() => {
              // Select the PR first so the detail pane shows this one, not a
              // stale selection, when the PRs view opens.
              selectPr(openPr.num);
              selectTab("pulls");
            }}
            title={`PR #${openPr.num} — ${openPr.title}`}
            className={cn(
              "flex h-8 flex-none items-center gap-1 rounded-lg border px-2 text-[12.5px] font-medium",
              "border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15",
              focusRing,
            )}
          >
            <PullRequestIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span className="font-mono text-emerald-600 dark:text-emerald-400">#{openPr.num}</span>
          </button>
        )}

        {forge && providerState && (
          <ProviderIndicator
            className="ml-auto"
            state={providerState}
            forge={forge}
            prCount={prCount}
            errorDetail={accountsError}
            onViewPrs={() => selectTab("pulls")}
            onSignIn={() => openSettings("accounts")}
            onOpenRepoSettings={openRepoSettings}
            onOpen={closeNav}
          />
        )}
        {/* Bare divider — the row's gap-2 already spaces it; the shared Separator's
            own margin would double that. */}
        {forge && providerState && (
          <span className="h-5 w-px flex-none bg-black/10 dark:bg-white/10" aria-hidden />
        )}

        <div className={cn("flex items-center gap-0.5", !(forge && providerState) && "ml-auto")}>
          <ToolbarAction
            label="Fetch"
            icon={<FetchIcon />}
            onClick={run("fetch", fetch)}
            pending={busy === "fetch"}
            disabled={(loading && busy !== "fetch") || !summary}
          />
          <ToolbarAction
            label="Pull"
            icon={<PullIcon />}
            onClick={run("pull", pull)}
            pending={busy === "pull"}
            disabled={(loading && busy !== "pull") || !summary || !currentSync.canPull}
            title={currentSync.canPull ? currentSync.title : `Pull unavailable. ${currentSync.title}`}
          />
          <ToolbarAction
            label="Push"
            icon={<PushIcon />}
            onClick={runPush}
            pending={busy === "push"}
            disabled={(loading && busy !== "push") || !summary || !currentSync.canPush}
            title={currentSync.canPush ? currentSync.title : `Push unavailable. ${currentSync.title}`}
          />
          <ToolbarAction label="Branch" icon={<BranchIcon />} onClick={() => openCreateBranch(true)} disabled={!summary} />
          <ToolbarAction
            label="Recover"
            icon={<ClockIcon />}
            onClick={openRecovery}
            disabled={!summary}
          />
          <ToolbarAction
            label="Stash"
            icon={<StashIcon />}
            onClick={stash}
            disabled={loading || workCount === 0}
          />
          <Separator />
          <ToolbarAction
            label="Terminal"
            icon={<TerminalIcon />}
            disabled={!summary}
            active={terminalVisible}
            onClick={toggleTerminal}
            wide
          />
        </div>
      </div>
    </div>
  );
};
