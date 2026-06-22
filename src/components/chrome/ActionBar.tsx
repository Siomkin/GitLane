import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { useDismiss } from "../../hooks/useDismiss";
import type { MouseEvent, ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { focusRing } from "../../lib/ui";
import type { LeftTab } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { BranchNavigator } from "../navigation/branch-navigator";
import {
  BranchIcon,
  ClockIcon,
  FetchIcon,
  GitHubIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  StashIcon,
  TerminalIcon,
} from "../ui/icons";

export function ActionBar({
  activeTab,
  onTabChange,
}: {
  activeTab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
}) {
  const summary = useRepo((state) => state.summary);
  const loading = useRepo((state) => state.loading);
  const fetch = useRepo((state) => state.fetch);
  const pull = useRepo((state) => state.pull);
  const push = useRepo((state) => state.push);
  const stash = useRepo((state) => state.stash);
  const changes = useRepo((state) => state.changes);
  const pullRequests = usePulls((state) => state.pullRequests);
  const openCreateBranch = useUi((state) => state.setCreateBranchOpen);
  const toggleTerminal = useUi((state) => state.toggleTerminal);
  const terminalVisible = useUi((state) => state.terminalView !== "hidden");
  const navOpen = useUi((state) => state.navOpen);
  const toggleNav = useUi((state) => state.toggleNav);
  const openNav = useUi((state) => state.openNav);
  const closeNav = useUi((state) => state.closeNav);

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
        <div className="flex flex-none rounded-lg bg-black/[0.06] p-0.5 text-[13px] dark:bg-white/[0.06]">
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
            className="flex h-10 max-w-[320px] items-center gap-2 rounded-lg border border-black/10 bg-white/40 px-3 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
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
            onClick={() => void openUrl(openPr.url)}
            title={`Open PR #${openPr.num} on GitHub — ${openPr.title}`}
            className="flex h-10 flex-none items-center gap-1.5 rounded-lg border border-black/10 bg-white/40 px-2.5 text-[13px] font-medium hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
          >
            <GitHubIcon className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />
            <span className="h-3.5 w-px bg-black/10 dark:bg-white/10" />
            <span className="font-mono text-[12.5px] text-[color:var(--accent)]">#{openPr.num}</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarAction label="Fetch" icon={<FetchIcon />} onClick={fetch} disabled={loading || !summary} />
          <ToolbarAction label="Pull" icon={<PullIcon />} onClick={pull} disabled={loading || !summary} />
          <ToolbarAction label="Push" icon={<PushIcon />} onClick={push} disabled={loading || !summary} />
          <ToolbarAction label="Branch" icon={<BranchIcon />} onClick={() => openCreateBranch(true)} disabled={!summary} />
          <ToolbarAction
            label="Stash"
            icon={<StashIcon />}
            onClick={stash}
            disabled={loading || workCount === 0}
          />
          <ToolbarAction
            label="Terminal"
            icon={<TerminalIcon />}
            disabled={!summary}
            active={terminalVisible}
            onClick={toggleTerminal}
          />
        </div>
      </div>
    </div>
  );
}

function SegTab({
  active,
  onClick,
  icon,
  label,
  badge,
  badgeTone,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeTone: "accent" | "purple";
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition",
        focusRing,
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
      onClick={onClick}
    >
      {icon}
      {label}
      {badge !== undefined && (
        <span
          className={cn(
            "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-semibold text-white",
            badgeTone === "accent" ? "bg-[var(--accent)]" : "bg-purple-500",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function ToolbarAction({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  icon: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={cn(
        "flex h-12 w-[54px] flex-col items-center justify-center gap-1 rounded-lg text-[11px] text-neutral-600 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/5",
        focusRing,
        active && "bg-black/5 text-[color:var(--accent)] dark:bg-white/5",
      )}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      <span className="grid h-[18px] w-[18px] place-items-center leading-none">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
