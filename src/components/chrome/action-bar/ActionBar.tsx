import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { ForgeKind } from "../../../lib/api";
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
import { ProviderIndicator } from "./ProviderIndicator";
import { deriveProviderState } from "./provider";
import type { ProviderState } from "./provider";

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
  const loading = useRepo((state) => state.loading);
  const fetch = useRepo((state) => state.fetch);
  const pull = useRepo((state) => state.pull);
  const push = useRepo((state) => state.push);
  const stash = useRepo((state) => state.stash);
  const changes = useRepo((state) => state.changes);
  const pullRequests = usePulls((state) => state.pullRequests);
  const loadPullRequests = usePulls((state) => state.loadPullRequests);
  const openCreateBranch = useUi((state) => state.setCreateBranchOpen);
  const toggleTerminal = useUi((state) => state.toggleTerminal);
  const terminalVisible = useUi((state) => state.terminalView !== "hidden");
  const navOpen = useUi((state) => state.navOpen);
  const toggleNav = useUi((state) => state.toggleNav);
  const openNav = useUi((state) => state.openNav);
  const closeNav = useUi((state) => state.closeNav);
  const selectPr = useUi((state) => state.selectPr);
  const accounts = useAccounts((state) => state.accounts);
  const accountsError = useAccounts((state) => state.accountsError);
  const accountsLoading = useAccounts((state) => state.accountsLoading);
  const repoAccountRef = useAccounts((state) => state.repoAccountRef);

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

  const workCount = changes.staged.length + changes.unstaged.length;
  // Badge counts only open PRs — the list is fetched `--state all`, but a tab
  // badge should reflect what needs attention, not merged/closed history.
  const prCount = pullRequests.filter((pr) => pr.state === "open").length;
  const showPulls = activeTab === "pulls";

  const currentBranch = summary?.detached
    ? `detached @ ${summary.headOid?.slice(0, 7) ?? "?"}`
    : summary?.headBranch ?? "No branch";
  // Open PR whose head is the checked-out branch — surfaced as a clickable badge.
  const openPr = summary?.detached
    ? undefined
    : pullRequests.find((pr) => pr.state === "open" && pr.branch === summary?.headBranch);

  // Remote-provider status: forge detection (backend) combined with GitHub auth
  // state (accounts store). Only GitHub supports PRs today; other forges are
  // surfaced as "unsupported" with the forge named in the tooltip.
  const providerState: ProviderState | null = forge
    ? deriveProviderState(forge, { accounts, accountsError, accountsLoading, repoAccountRef })
    : null;

  // The PR badge is always visible in the toolbar, so keep its count warm even
  // before the PR panel opens. Foreground loads still happen in LeftPanel for a
  // visible spinner; these quiet loads just keep the badge current.
  useEffect(() => {
    if (!summary || forge?.kind !== ForgeKind.GitHub) return;
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

  return (
    <div ref={wrapRef} className="relative flex-none">
      <div className="flex h-14 items-center gap-3 px-3.5">
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
            title="Branches, worktrees & stashes"
            className="flex h-8 max-w-[320px] items-center gap-2 rounded-lg border border-black/10 bg-white/40 px-3 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
          >
            <BranchIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
            <span className="truncate text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
              {currentBranch}
            </span>
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

        <div className="ml-auto flex items-center gap-0.5">
          {forge && providerState && (
            <>
              <ProviderIndicator state={providerState} forge={forge} />
              <Separator />
            </>
          )}
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
            disabled={(loading && busy !== "pull") || !summary}
          />
          <ToolbarAction
            label="Push"
            icon={<PushIcon />}
            onClick={run("push", push)}
            pending={busy === "push"}
            disabled={(loading && busy !== "push") || !summary}
          />
          <ToolbarAction label="Branch" icon={<BranchIcon />} onClick={() => openCreateBranch(true)} disabled={!summary} />
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
