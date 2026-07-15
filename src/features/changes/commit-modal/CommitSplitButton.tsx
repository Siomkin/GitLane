// Outcome-labelled split commit action (commit panel redesign): the primary
// button says exactly what will happen ("Commit 2 files → develop"), and the
// caret opens the variants — commit & push, commit + push + open PR, amend —
// plus the commit-with-agent list that used to be a separate button.

import type { ReactNode } from "react";

import type { TerminalAgent } from "@/lib/api";
import { CheckIcon, PushIcon, RefreshIcon, BranchIcon, ChevronDownIcon, SparkleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useFixedPopover } from "@/features/changes/useFixedPopover";

function MenuItem({
  icon,
  disabled,
  title,
  onPick,
  trailing,
  children,
}: {
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  onPick: () => void;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onPick}
      className={cn(
        "flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] text-neutral-700 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:text-neutral-200 dark:hover:bg-white/5",
        focusRing,
      )}
    >
      <span aria-hidden className="shrink-0 text-neutral-400">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

export function CommitSplitButton({
  stagedCount,
  branch,
  amend,
  canCommit,
  blockedTitle,
  canAmend,
  amendTitle,
  pushBlockedTitle,
  showOpenPr,
  agents,
  agentsDisabled,
  agentsDisabledTitle,
  onCommit,
  onCommitAndPush,
  onCommitPushOpenPr,
  onToggleAmend,
  onCommitWithAgent,
}: {
  stagedCount: number;
  /** The checked-out branch the commit lands on. */
  branch: string;
  amend: boolean;
  canCommit: boolean;
  /** Reason the plain commit actions are unavailable (shown as tooltip). */
  blockedTitle: string | null;
  canAmend: boolean;
  /** Tooltip for the amend item — the reason when disabled, hint when enabled. */
  amendTitle: string;
  /** Why the chained push actions are unavailable (e.g. detached HEAD), or
   * null when pushing is possible. Chained items disable on it — a plain
   * commit still works without a branch, but `pushCurrentBranch` cannot. */
  pushBlockedTitle: string | null;
  /** Whether the repo's forge supports pull requests. */
  showOpenPr: boolean;
  agents: TerminalAgent[];
  agentsDisabled: boolean;
  agentsDisabledTitle: string;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onCommitPushOpenPr: () => void;
  onToggleAmend: () => void;
  onCommitWithAgent: (agent: TerminalAgent) => void;
}) {
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover();

  const label = amend
    ? "Amend last commit"
    : `Commit ${stagedCount} ${stagedCount === 1 ? "file" : "files"} → ${branch}`;
  const pick = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        title={blockedTitle ?? undefined}
        className={cn(
          "h-10 min-w-0 flex-1 truncate rounded-l-lg px-3 text-[13px] font-semibold transition-[filter]",
          canCommit
            ? "bg-[var(--accent)] text-white hover:brightness-110"
            : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
          focusRing,
        )}
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="More commit actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "flex h-10 items-center justify-center rounded-r-lg border-l px-3 transition-[filter]",
          canCommit
            ? "border-white/25 bg-[var(--accent)] text-white hover:brightness-110"
            : "border-black/[0.06] bg-black/[0.06] text-neutral-500 hover:bg-black/10 dark:border-white/10 dark:bg-white/10 dark:text-neutral-300 dark:hover:bg-white/15",
          focusRing,
        )}
      >
        <ChevronDownIcon className="h-4 w-4" />
      </button>

      {portal(() => (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Commit actions"
          style={menuStyle}
          className="fixed z-[80] max-h-[min(420px,60vh)] w-[250px] overflow-auto rounded-xl border border-black/10 bg-white py-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        >
          <MenuItem
            icon={<CheckIcon className="h-3.5 w-3.5" />}
            disabled={!canCommit}
            title={blockedTitle ?? undefined}
            onPick={pick(onCommit)}
          >
            {amend ? "Amend last commit" : `Commit to ${branch}`}
          </MenuItem>
          <MenuItem
            icon={<PushIcon className="h-3.5 w-3.5" />}
            disabled={!canCommit || Boolean(pushBlockedTitle)}
            title={pushBlockedTitle ?? blockedTitle ?? undefined}
            onPick={pick(onCommitAndPush)}
          >
            {amend ? "Amend & push" : "Commit & push"}
          </MenuItem>
          {showOpenPr && !amend && (
            <MenuItem
              icon={<BranchIcon className="h-3.5 w-3.5" />}
              disabled={!canCommit || Boolean(pushBlockedTitle)}
              title={pushBlockedTitle ?? blockedTitle ?? undefined}
              onPick={pick(onCommitPushOpenPr)}
            >
              Commit, push & open PR…
            </MenuItem>
          )}
          <MenuItem
            icon={<RefreshIcon className="h-3.5 w-3.5" />}
            disabled={!canAmend}
            title={amendTitle}
            onPick={pick(onToggleAmend)}
            trailing={
              amend ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" /> : undefined
            }
          >
            Amend previous commit
          </MenuItem>
          {agents.length > 0 && (
            <>
              <div aria-hidden className="mx-2 my-1 h-px bg-black/5 dark:bg-white/10" />
              <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                Commit with agent
              </div>
              {agents.map((agent) => (
                <MenuItem
                  key={agent.id}
                  icon={<SparkleIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />}
                  disabled={agentsDisabled || !agent.available}
                  title={
                    agentsDisabled
                      ? agentsDisabledTitle
                      : agent.available
                        ? agent.command
                        : `${agent.command} was not found on PATH`
                  }
                  onPick={pick(() => onCommitWithAgent(agent))}
                  trailing={
                    !agent.available ? (
                      <span className="shrink-0 text-[11px] text-neutral-400">not on PATH</span>
                    ) : undefined
                  }
                >
                  {agent.name}
                </MenuItem>
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
