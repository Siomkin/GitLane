import { useRef } from "react";
import { cn } from "@/lib/cn";
import { useDismiss } from "@/hooks/useDismiss";
import { focusRing } from "@/lib/ui";
import { BranchNavigator } from "@/components/navigation/branch-navigator";
import {
  BranchIcon,
  ClockIcon,
  FetchIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  StashIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import { SegTab } from "./SegTab";
import { ToolbarAction } from "./ToolbarAction";
import { Separator } from "./Separator";
import { WorktreeIndicator } from "./WorktreeIndicator";
import { ProviderIndicator } from "./provider-indicator";
import { useActionBarModel } from "./useActionBarModel";

/** The toolbar: History/PRs tab toggle, the "Checked out" branch trigger (and
 * its anchored navigator dropdown), the current-branch PR badge, the provider
 * indicator, and the network/worktree actions. All state and commands come from
 * `useActionBarModel` (GL-182) — this component owns only render structure and
 * the DOM-anchored dropdown dismissal. */
export const ActionBar = () => {
  const m = useActionBarModel();
  const {
    summary,
    forge,
    loading,
    busy,
    fetchBlocked,
    showPulls,
    workCount,
    prCount,
    currentBranch,
    currentSync,
    openPr,
    providerState,
    navOpen,
  } = m;

  // The 280px dropdown is anchored under the branch button; dismiss it on
  // outside click / Escape.
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(navOpen, m.closeNav, wrapRef);

  return (
    <div ref={wrapRef} className="relative z-40 flex-none">
      <div className="flex h-12 -translate-y-px items-center gap-2 px-3.5">
        <div className="flex h-8 flex-none items-center rounded-lg bg-black/[0.06] p-0.5 text-[13px] dark:bg-white/[0.06]">
          <SegTab
            active={!showPulls}
            onClick={() => m.selectTab("history")}
            icon={<ClockIcon className="h-3.5 w-3.5" />}
            label="Commits"
            badge={workCount > 0 ? workCount : undefined}
            badgeTone="accent"
          />
          <SegTab
            active={showPulls}
            onClick={() => m.selectTab("pulls")}
            icon={<PullRequestIcon className="h-3.5 w-3.5" />}
            label="PRs"
            badge={prCount > 0 ? prCount : undefined}
            badgeTone="purple"
          />
        </div>

        <div className="relative">
          <button type="button"
            onClick={m.toggleNav}
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
          <button type="button"
            onClick={() => {
              // Select the PR first so the detail pane shows this one, not a
              // stale selection, when the PRs view opens.
              m.selectPr(openPr.num);
              m.selectTab("pulls");
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
            errorDetail={m.accountsError}
            onViewPrs={() => m.selectTab("pulls")}
            onSignIn={() => m.openSettings("accounts")}
            onOpenRepoSettings={m.openRepoSettings}
            onOpen={m.closeNav}
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
            onClick={m.runFetch}
            pending={busy === "fetch"}
            disabled={(loading && busy !== "fetch") || fetchBlocked || !summary}
          />
          <ToolbarAction
            label="Pull"
            icon={<PullIcon />}
            onClick={m.runPull}
            pending={busy === "pull"}
            disabled={
              (loading && busy !== "pull") ||
              busy === "fetch" ||
              fetchBlocked ||
              !summary ||
              !currentSync.canPull
            }
            title={currentSync.canPull ? currentSync.title : `Pull unavailable. ${currentSync.title}`}
          />
          <ToolbarAction
            label="Push"
            icon={<PushIcon />}
            onClick={m.runPush}
            pending={busy === "push"}
            disabled={
              (loading && busy !== "push") ||
              busy === "fetch" ||
              fetchBlocked ||
              !summary ||
              !currentSync.canPush
            }
            title={currentSync.canPush ? currentSync.title : `Push unavailable. ${currentSync.title}`}
          />
          <ToolbarAction label="Branch" icon={<BranchIcon />} onClick={m.openCreateBranch} disabled={!summary} />
          <ToolbarAction
            label="Recover"
            icon={<ClockIcon />}
            onClick={m.openRecovery}
            disabled={!summary}
          />
          <ToolbarAction
            label="Stash"
            icon={<StashIcon />}
            onClick={m.stash}
            disabled={loading || workCount === 0}
          />
          <Separator />
          <ToolbarAction
            label="Terminal"
            icon={<TerminalIcon />}
            disabled={!summary}
            active={m.terminalVisible}
            onClick={m.toggleTerminal}
            wide
          />
        </div>
      </div>
    </div>
  );
};
