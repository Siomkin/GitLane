// The "Commit Changes" modal raised by the Start-commit button. Operates on the
// staged set: every file can be excluded from this commit (unchecked), the body
// switches between a flat List and a collapsible Tree with an inline diff
// preview, and the footer commits (optionally handing the message to an agent in
// the terminal). See store/ui.ts (commit* state) and store/repo.ts
// (commitSelected).

import { useEffect, useState, type ReactNode } from "react";
import { type FileChange, type TerminalAgent } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { cn } from "@/lib/cn";
import { fullCommitMessage } from "@/lib/commitMessage";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { isCommitReachableFromRemote } from "@/store/selection";
import { ListView } from "./ListView";
import { TreeView } from "./TreeView";
import { CommitIdentitySelector } from "./CommitIdentitySelector";
import { CommitWithAgentButton } from "./CommitWithAgentButton";
import { useCommitIdentity } from "./useCommitIdentity";

export const CommitModal = () => {
  const open = useUi((s) => s.commitOpen);
  if (!open) return null;
  return <CommitModalBody />;
};

const CommitModalBody = () => {
  const close = useUi((s) => s.closeCommit);
  const view = useUi((s) => s.commitView);
  const setView = useUi((s) => s.setCommitView);
  // Store-owned draft state intentionally survives close/reopen; the modal's
  // ephemeral `amend` choice resets on remount.
  const msg = useUi((s) => s.commitMsg);
  const setMsg = useUi((s) => s.setCommitMsg);
  const excluded = useUi((s) => s.commitExcluded);
  const sendToTerminal = useUi((s) => s.sendToTerminal);
  const agentCommitDraft = useUi((s) => s.agentCommitDraft);
  const startAgentCommitDraft = useUi((s) => s.startAgentCommitDraft);
  const cancelAgentCommitDraft = useUi((s) => s.cancelAgentCommitDraft);
  const changes = useRepo((s) => s.changes);
  const staged = changes.staged;
  const summary = useRepo((s) => s.summary);
  const graph = useRepo((s) => s.graph);
  const commitSelected = useRepo((s) => s.commitSelected);
  const [amend, setAmend] = useState(false);
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const identity = useCommitIdentity();
  const identityUsable = identity.usable;

  const headCommit = graph?.commits.find((commit) => commit.id === graph.head && !commit.stash) ?? null;
  const canAmend =
    !!summary?.headBranch &&
    !!headCommit &&
    !isCommitReachableFromRemote(graph, headCommit.id);
  const agents = selectEnabledAgents(agentsRaw);
  const draftingAgent = agentCommitDraft && agentCommitDraft.repoPath === summary?.path
    ? agentCommitDraft.agentName
    : null;

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  // The repository can refresh while this modal is open. If HEAD becomes
  // reachable from a remote, an in-progress amend must be disabled at once.
  useEffect(() => {
    if (!canAmend) setAmend(false);
  }, [canAmend]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const branch = summary?.headBranch ?? "HEAD";
  const excludedPaths: string[] = [];
  const included: FileChange[] = [];
  for (const file of staged) {
    if (excluded[file.path]) {
      excludedPaths.push(file.path);
    } else {
      included.push(file);
    }
  }
  const includedGuarded = findGuardedFile(included, changes);
  const commitBlocked = fileWriteGuard(includedGuarded, changes);
  const includedCount = included.length;
  const canCommit = includedCount > 0 && msg.trim().length > 0 && !commitBlocked && identityUsable;

  const doCommit = () => {
    if (!canCommit) return;
    void commitSelected(msg.trim(), excludedPaths, amend);
    close();
  };

  const commitWithAgent = (agent: TerminalAgent) => {
    if (!identityUsable || !agent.available) return;
    const instruction =
      msg.trim() ||
      (amend
        ? "Review the staged changes, add them to the previous commit, and update the commit message if needed."
        : "Review the staged changes, write a concise conventional-commit message, and commit them.");
    sendToTerminal(instruction, agent.command);
    close();
  };

  const draftWithAgent = (agent: TerminalAgent) => {
    if (!agent.available || !summary) return;
    const token = crypto.randomUUID().replace(/-/g, "");
    const filename = `gitlane-commit-draft-${token}`;
    const existingDraft = msg.trim();
    const ignored = excludedPaths.length
      ? ` Ignore these staged paths when describing the commit: ${excludedPaths.map((path) => JSON.stringify(path)).join(", ")}.`
      : "";
    const task = existingDraft
      ? `Review the staged changes and improve this existing conventional commit message: ${JSON.stringify(existingDraft)}.`
      : "Review the staged changes and draft a concise conventional commit message.";
    const instruction =
      `${task} Do not commit and do not modify the working tree.${ignored} ` +
      "Finish all analysis before delivering the draft. Write only the final plain-text commit message to a temporary file. " +
      `As your final tool action, atomically rename it to the path printed by: git rev-parse --git-path '${filename}'. ` +
      "That destination is a one-shot mailbox which GitLane deletes immediately after reading. A successful rename means delivery succeeded even if the destination disappears; do not inspect, read, list, or verify it afterward. " +
      "Once the rename succeeds, end the turn immediately and run no more tools or commands.";
    startAgentCommitDraft(
      { token, agentName: agent.name, repoPath: summary.path, startedAt: Date.now() },
      instruction,
      agent.command,
    );
  };

  const toggleAmend = () => {
    if (!canAmend) return;
    const next = !amend;
    setAmend(next);
    const prefill = headCommit ? fullCommitMessage(headCommit.summary, headCommit.body) : "";
    if (next) {
      if (msg.trim().length === 0 && prefill) setMsg(prefill);
    } else if (msg === prefill) {
      // Turning amend off: drop the auto-prefilled HEAD message when the user
      // hasn't edited it, so a normal commit doesn't silently reuse it.
      setMsg("");
    }
  };

  const modalSize =
    view === "tree"
      ? "h-[760px] w-[1280px] max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)]"
      : "h-[560px] w-[920px] max-h-[90%] max-w-full";

  return (
    <div className="fixed inset-0 z-[58] grid place-items-center p-8">
      <button
        type="button"
        aria-label="Close commit dialog"
        onClick={close}
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
      />
      <div
        className={cn(
          "relative flex flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800",
          modalSize,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-5 dark:border-white/5">
          <span className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            Commit Changes
          </span>
          <span className="text-[12px] text-neutral-400">
            {includedCount} staged · {branch}
          </span>
          <div className="ml-auto flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]">
            <SegBtn active={view === "list"} onClick={() => setView("list")}>
              List
            </SegBtn>
            <SegBtn active={view === "tree"} onClick={() => setView("tree")}>
              Tree
            </SegBtn>
          </div>
          <button
            type="button"
            onClick={close}
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
            title="Close"
            aria-label="Close commit dialog"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {staged.length === 0 ? (
          <div className="flex-1 px-5 py-6 text-[13px] text-neutral-400">
            No staged files — stage files first, or commit with an agent.
          </div>
        ) : view === "list" ? (
          <ListView staged={staged} />
        ) : (
          <TreeView staged={staged} repoPath={summary?.path ?? null} />
        )}

        <div className="shrink-0 space-y-2.5 border-t border-black/5 px-4 pb-3 pt-3 dark:border-white/5">
          {commitBlocked && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
              {commitBlocked}
            </div>
          )}
          {canAmend && (
            <button
              type="button"
              role="switch"
              aria-checked={amend}
              onClick={toggleAmend}
              className="flex w-full items-center gap-3 rounded-lg border border-black/10 px-3 py-2 text-left hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            >
              <span
                className={cn(
                  "flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                  amend ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
                )}
              >
                <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                  Add to previous commit
                </span>
                <span className="block truncate text-[11.5px] text-neutral-400">
                  Available because {headCommit?.shortId} has not been pushed
                </span>
              </span>
            </button>
          )}
          <textarea
            aria-label="Commit message"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder={amend ? "Amended commit message" : "Commit message (optional — leave empty to let the agent write it)"}
            className="h-14 w-full resize-none rounded-lg border border-black/10 bg-transparent p-2.5 text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
          />
          {draftingAgent && (
            <div role="status" className="flex items-center justify-between rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-[12px] text-[color:var(--accent)]">
              <span>{draftingAgent} is drafting a message in the terminal…</span>
              <button type="button" className="font-semibold" onClick={cancelAgentCommitDraft}>
                Stop waiting
              </button>
            </div>
          )}
          <CommitIdentitySelector identity={identity} />
          <div className="flex items-center gap-2">
            {agents.length === 0 ? (
              <span className="text-[12px] text-amber-600 dark:text-amber-400">No enabled agents. Add one in Settings.</span>
            ) : (
              <>
                <CommitWithAgentButton
                  agents={agents}
                  disabled={draftingAgent !== null}
                  onPick={draftWithAgent}
                  label={msg.trim() ? "Improve with agent" : "Draft with agent"}
                  disabledTitle="Wait for the current agent draft"
                />
                <CommitWithAgentButton agents={agents} disabled={!identityUsable} onPick={commitWithAgent} />
              </>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={close}
                className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doCommit}
                disabled={!canCommit}
                title={commitBlocked ?? undefined}
                className={cn(
                  "h-9 rounded-lg px-4 text-[13px] font-medium",
                  canCommit
                    ? "bg-[var(--accent)] text-white hover:brightness-110"
                    : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
                )}
              >
                {amend ? "Amend" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// The single trivial presentational leaf that stays co-located (rules §4): the
// List/Tree segment button in the modal header.
const SegBtn = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-6 rounded-md px-2.5",
        active
          ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 dark:text-neutral-400",
      )}
    >
      {children}
    </button>
  );
};
