// Inline commit controls for the Working Changes inspector. The staged list
// directly above this composer is the source of truth for commit inclusion, so
// there is no second modal-only file selector to reconcile.

import { useEffect, useState } from "react";
import { type TerminalAgent } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { cn } from "@/lib/cn";
import { fullCommitMessage } from "@/lib/commitMessage";
import { useRepo } from "@/store/repo";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { isCommitReachableFromRemote } from "@/store/selection";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { CommitIdentitySelector } from "./CommitIdentitySelector";
import { CommitWithAgentButton } from "./CommitWithAgentButton";
import { useCommitIdentity } from "./useCommitIdentity";

export function CommitComposer() {
  const msg = useUi((state) => state.commitMsg);
  const setMsg = useUi((state) => state.setCommitMsg);
  const sendToTerminal = useUi((state) => state.sendToTerminal);
  const agentCommitDraft = useUi((state) => state.agentCommitDraft);
  const startAgentCommitDraft = useUi((state) => state.startAgentCommitDraft);
  const cancelAgentCommitDraft = useUi((state) => state.cancelAgentCommitDraft);
  const changes = useRepo((state) => state.changes);
  const summary = useRepo((state) => state.summary);
  const graph = useRepo((state) => state.graph);
  const commitSelected = useRepo((state) => state.commitSelected);
  const [amend, setAmend] = useState(false);
  const agentsRaw = useTerminalAgents((state) => state.agents);
  const loadAgents = useTerminalAgents((state) => state.loadAgents);
  const agentMessages = useCommitAgentMessages((state) => state.messages);
  const loadAgentMessages = useCommitAgentMessages((state) => state.loadMessages);
  const identity = useCommitIdentity();

  const staged = changes.staged;
  const headCommit = graph?.commits.find((commit) => commit.id === graph.head && !commit.stash) ?? null;
  const canAmend =
    Boolean(summary?.headBranch) && headCommit !== null && !isCommitReachableFromRemote(graph, headCommit.id);
  const agents = selectEnabledAgents(agentsRaw);
  const draftingAgent = agentCommitDraft && agentCommitDraft.repoPath === summary?.path
    ? agentCommitDraft.agentName
    : null;
  const commitBlocked = fileWriteGuard(findGuardedFile(staged, changes), changes);
  const hasStaged = staged.length > 0;
  const canCommit = hasStaged && msg.trim().length > 0 && !commitBlocked && identity.usable;

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadAgentMessages();
  }, [loadAgentMessages]);

  useEffect(() => {
    if (!canAmend) setAmend(false);
  }, [canAmend]);

  const doCommit = async () => {
    if (!canCommit) return;
    const committed = await commitSelected(msg.trim(), amend);
    if (!committed) return;
    setMsg("");
    setAmend(false);
  };

  const commitWithAgent = (agent: TerminalAgent) => {
    if (!hasStaged || commitBlocked || !identity.usable || !agent.available) return;
    const instruction =
      msg.trim() ||
      (amend
        ? "Review the staged changes, add them to the previous commit, and update the commit message if needed."
        : agentMessages.commitInstruction.trim());
    sendToTerminal(instruction, agent.command);
  };

  const draftWithAgent = (agent: TerminalAgent) => {
    if (!hasStaged || commitBlocked || !agent.available || !summary) return;
    const token = crypto.randomUUID().replace(/-/g, "");
    const filename = `gitlane-commit-draft-${token}`;
    const existingDraft = msg.trim();
    const task = existingDraft
      ? `${agentMessages.draftInstruction.trim()} Use it to improve this existing conventional commit message: ${JSON.stringify(existingDraft)}.`
      : agentMessages.draftInstruction.trim();
    const instruction =
      `${task}\n\nDo not commit. Do not create, edit, stage, delete, or otherwise alter any tracked or untracked working-tree file. ` +
      `For delivery only, you are explicitly authorized to create a temporary sibling and the final mailbox inside this repository's Git metadata at the path printed by: git rev-parse --git-path '${filename}'. ` +
      "These two Git-metadata paths are the only authorized filesystem writes and do not count as working-tree modifications. " +
      "Finish all analysis before delivering the draft. Using shell file commands, not apply_patch, write only the final plain-text commit message to `<mailbox-path>.tmp`. " +
      "As your final tool action, atomically rename that sibling temporary file to `<mailbox-path>`. " +
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
      setMsg("");
    }
  };

  return (
    <div className="space-y-2.5">
      {commitBlocked && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
          {commitBlocked}
        </div>
      )}
      {canAmend && (
        <button type="button" role="switch" aria-checked={amend} onClick={toggleAmend}
          className="flex w-full items-center gap-3 rounded-lg border border-black/10 px-3 py-2 text-left hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
        >
          <span className={cn("flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors", amend ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20") }>
            <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-neutral-800 dark:text-neutral-100">Add to previous commit</span>
            <span className="block truncate text-[11.5px] text-neutral-400">Available because {headCommit?.shortId} has not been pushed</span>
          </span>
        </button>
      )}
      <textarea
        aria-label="Commit message"
        value={msg}
        onChange={(event) => setMsg(event.target.value)}
        placeholder={amend ? "Amended commit message" : "Commit message (optional — leave empty to let the agent write it)"}
        className="h-20 w-full resize-y rounded-lg border border-black/10 bg-transparent p-2.5 text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
      />
      {draftingAgent && (
        <div role="status" className="flex items-center justify-between rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-[12px] text-[color:var(--accent)]">
          <span>{draftingAgent} is drafting a message in the terminal…</span>
          <button type="button" className="font-semibold" onClick={cancelAgentCommitDraft}>Stop waiting</button>
        </div>
      )}
      <CommitIdentitySelector identity={identity} />
      <div className="flex flex-wrap items-center gap-2">
        {agents.length === 0 ? (
          <span className="text-[12px] text-amber-600 dark:text-amber-400">
            No enabled agents. Add one in Settings.
          </span>
        ) : (
          <>
            <CommitWithAgentButton
              agents={agents}
              disabled={!hasStaged || Boolean(commitBlocked) || draftingAgent !== null}
              onPick={draftWithAgent}
              label={msg.trim() ? "Improve with agent" : "Draft with agent"}
              disabledTitle={!hasStaged ? "Stage files before drafting a commit message" : commitBlocked ?? "Wait for the current agent draft"}
            />
            <CommitWithAgentButton
              agents={agents}
              disabled={!hasStaged || Boolean(commitBlocked) || !identity.usable}
              onPick={commitWithAgent}
              disabledTitle={!hasStaged ? "Stage files before committing with an agent" : commitBlocked ?? "Set a usable Git identity before committing with an agent"}
            />
          </>
        )}
        <button type="button" onClick={() => void doCommit()} disabled={!canCommit} title={commitBlocked ?? undefined}
          className={cn("ml-auto h-9 rounded-lg px-4 text-[13px] font-medium", canCommit ? "bg-[var(--accent)] text-white hover:brightness-110" : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10")}
        >
          {amend ? "Amend" : "Commit"}
        </button>
      </div>
    </div>
  );
}
