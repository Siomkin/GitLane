// Inline commit controls for the Working Changes inspector (commit panel
// redesign). The staged list directly above this composer is the source of
// truth for commit inclusion. One collapsible surface, two message styles —
// free-form or structured conventional commit — with the agent Draft control
// folded into the editor row and the commit variants (& push / & open PR /
// amend / with agent) behind the split button's caret.

import { useEffect, useRef, useState } from "react";
import { BranchKind, type TerminalAgent } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { currentBranchSyncView, defaultPublishTarget } from "@/lib/branchSync";
import { fullCommitMessage } from "@/lib/commitMessage";
import {
  ComposerMode,
  composeConventionalMessage,
  parseConventionalMessage,
  type ConventionalFields,
} from "@/lib/conventionalCommit";
import { isPrForge } from "@/components/chrome/action-bar/actionBarModel";
import { ChevronDownIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { isCommitReachableFromRemote } from "@/store/selection";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { CommitIdentitySelector } from "./CommitIdentitySelector";
import { useCommitIdentity } from "./useCommitIdentity";
import { CommitMessageEditor } from "./CommitMessageEditor";
import { CommitSplitButton } from "./CommitSplitButton";
import { DraftAgentControl } from "./DraftAgentControl";

export function CommitComposer() {
  const msg = useUi((state) => state.commitMsg);
  const setMsg = useUi((state) => state.setCommitMsg);
  const mode = useUi((state) => state.commitComposerMode);
  const setMode = useUi((state) => state.setCommitComposerMode);
  const draftAgentId = useUi((state) => state.commitDraftAgent);
  const setDraftAgentId = useUi((state) => state.setCommitDraftAgent);
  const sendToTerminal = useUi((state) => state.sendToTerminal);
  const agentCommitDraft = useUi((state) => state.agentCommitDraft);
  const startAgentCommitDraft = useUi((state) => state.startAgentCommitDraft);
  const cancelAgentCommitDraft = useUi((state) => state.cancelAgentCommitDraft);
  const requestPrompt = useUi((state) => state.requestPrompt);
  const openCreatePr = useUi((state) => state.openCreatePr);
  const changes = useRepo((state) => state.changes);
  const summary = useRepo((state) => state.summary);
  const forge = useRepo((state) => state.forge);
  const graph = useRepo((state) => state.graph);
  const commitSelected = useRepo((state) => state.commitSelected);
  // Collapsed by default — the slim bar keeps the file list roomy until the
  // user actually starts a commit.
  const [composerOpen, setComposerOpen] = useState(false);
  const [amend, setAmend] = useState(false);
  const agentsRaw = useTerminalAgents((state) => state.agents);
  const loadAgents = useTerminalAgents((state) => state.loadAgents);
  const agentMessages = useCommitAgentMessages((state) => state.messages);
  const loadAgentMessages = useCommitAgentMessages((state) => state.loadMessages);
  const identity = useCommitIdentity();

  // The structured (conventional) view of `commitMsg`. Field edits compose back
  // into the message; any external message change — an agent draft landing, the
  // post-commit clear, the amend prefill — re-parses into the fields. The ref
  // marks messages we composed ourselves so those don't re-parse mid-typing.
  const [fields, setFields] = useState<ConventionalFields>(() => parseConventionalMessage(msg));
  const lastSyncedMsg = useRef(msg);
  useEffect(() => {
    if (msg === lastSyncedMsg.current) return;
    lastSyncedMsg.current = msg;
    setFields(parseConventionalMessage(msg));
  }, [msg]);
  const updateFields = (patch: Partial<ConventionalFields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    const composed = composeConventionalMessage(next);
    lastSyncedMsg.current = composed;
    setMsg(composed);
  };

  const staged = changes.staged;
  const branch = summary?.headBranch ?? "HEAD";
  const headCommit = graph?.commits.find((commit) => commit.id === graph.head && !commit.stash) ?? null;
  const canAmend =
    Boolean(summary?.headBranch) && headCommit !== null && !isCommitReachableFromRemote(graph, headCommit.id);
  const agents = selectEnabledAgents(agentsRaw);
  const draftingAgent = agentCommitDraft && agentCommitDraft.repoPath === summary?.path
    ? agentCommitDraft.agentName
    : null;
  const commitBlocked = fileWriteGuard(findGuardedFile(staged, changes), changes);
  const hasStaged = staged.length > 0;
  const messageReady =
    mode === ComposerMode.Conventional ? fields.subject.trim().length > 0 : msg.trim().length > 0;
  const canCommit = hasStaged && messageReady && !commitBlocked && identity.usable;
  const commitDisabledTitle =
    commitBlocked ??
    (!hasStaged
      ? "Stage files to commit"
      : !messageReady
        ? mode === ComposerMode.Conventional
          ? "Write a short summary first"
          : "Write a commit message first"
        : !identity.usable
          ? "Set a usable Git identity before committing"
          : null);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadAgentMessages();
  }, [loadAgentMessages]);

  useEffect(() => {
    if (!canAmend) setAmend(false);
  }, [canAmend]);

  const doCommit = async (): Promise<boolean> => {
    if (!canCommit) return false;
    const submitted = msg;
    const committed = await commitSelected(submitted.trim(), amend);
    if (!committed) return false;
    // Don't wipe edits (or a delivered agent draft) that landed while the
    // commit IPC was in flight — clear only the message that was committed.
    if (useUi.getState().commitMsg === submitted) setMsg("");
    setAmend(false);
    return true;
  };

  /** Push the checked-out branch the way the toolbar does — through the publish
   * prompt when it has no (resolvable) upstream. Every step is scoped to the
   * checkout captured here: switching repo tabs or branches while a step is in
   * flight (or the prompt is open) aborts the chain instead of acting on the
   * new checkout. `afterPushed` chains only when the refreshed sync state shows
   * the branch verifiably reached its upstream (`upToDate`) — `push()` toasts
   * its own failures and resolves, so its promise proves nothing. */
  const pushCurrentBranch = (afterPushed?: () => void) => {
    const repo = useRepo.getState();
    const repoPath = repo.summary?.path;
    const current = repo.summary?.headBranch;
    if (!repoPath || !current) return;
    const sameCheckout = () => {
      const state = useRepo.getState();
      return state.summary?.path === repoPath && state.summary.headBranch === current ? state : null;
    };
    const finish = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        // `publishBranch` rejects for the caller to toast (runOp contract);
        // `push` handles its own failures and resolves.
        useUi.getState().showToast(String(error), "error");
        return;
      }
      if (!afterPushed) return;
      const after = sameCheckout();
      const head = after?.branches.find((b) => b.kind === BranchKind.Local && b.name === current);
      if (head?.sync?.status === "upToDate") afterPushed();
    };
    if (currentBranchSyncView(repo.summary, repo.branches).needsPublishPrompt) {
      const info = repo.branches.find((b) => b.kind === BranchKind.Local && b.name === current);
      requestPrompt({
        title: `Publish ${current}`,
        message: `Remote branch for ${current} to push to and pull from.`,
        placeholder: "origin/branch",
        defaultValue: defaultPublishTarget(
          repo.branches,
          current,
          info?.upstream,
          info?.sync?.status !== "staleUpstream",
        ),
        confirmLabel: "Publish",
        onSubmit: (upstream) => {
          const state = sameCheckout();
          if (state) void finish(() => state.publishBranch(current, upstream));
        },
      });
      return;
    }
    void finish(() => repo.push());
  };

  /** Commit, then run `then` only if the same repo + branch are still checked
   * out — the user can switch tabs while the commit IPC is in flight, and the
   * chained push must never target that other checkout. */
  const commitThen = async (then: () => void) => {
    const before = useRepo.getState().summary;
    if (!(await doCommit())) return;
    const after = useRepo.getState().summary;
    if (after?.path === before?.path && after?.headBranch === before?.headBranch) then();
  };

  const commitAndPush = () => commitThen(() => pushCurrentBranch());

  const commitPushOpenPr = () => commitThen(() => pushCurrentBranch(() => openCreatePr()));

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
    setDraftAgentId(agent.id);
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

  if (!composerOpen) {
    return (
      <button
        type="button"
        aria-label="Expand commit composer"
        aria-expanded={false}
        onClick={() => setComposerOpen(true)}
        className="flex h-12 w-full items-center gap-2.5 px-4 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <ChevronDownIcon className="h-4 w-4 shrink-0 -rotate-90 text-neutral-400" />
        <span className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">Commit</span>
        <span className="text-[12px] text-neutral-400">{staged.length} staged</span>
        <span className="ml-auto shrink-0 text-[12px] font-medium text-[color:var(--accent)]">
          {draftingAgent
            ? `${draftingAgent} is drafting…`
            : msg.trim()
              ? "Continue message →"
              : "Write message →"}
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4 pt-2.5">
      <div className="flex items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Commit · {staged.length} staged
        </span>
        <button
          type="button"
          aria-label="Collapse commit composer"
          aria-expanded
          onClick={() => setComposerOpen(false)}
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <ChevronDownIcon className="h-4 w-4" />
        </button>
      </div>
      {commitBlocked && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
          {commitBlocked}
        </div>
      )}
      <CommitMessageEditor
        mode={mode}
        onModeChange={setMode}
        msg={msg}
        onMsgChange={setMsg}
        fields={fields}
        onFieldsChange={updateFields}
        amend={amend}
        actions={
          agents.length === 0 ? (
            <span className="text-[12px] text-amber-600 dark:text-amber-400">
              No enabled agents. Add one in Settings.
            </span>
          ) : (
            <DraftAgentControl
              agents={agents}
              activeAgentId={draftAgentId}
              improve={msg.trim().length > 0}
              disabled={!hasStaged || Boolean(commitBlocked) || draftingAgent !== null}
              disabledTitle={
                !hasStaged
                  ? "Stage files before drafting a commit message"
                  : commitBlocked ?? "Wait for the current agent draft"
              }
              onPick={draftWithAgent}
            />
          )
        }
      />
      {draftingAgent && (
        <div role="status" className="flex items-center justify-between rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-[12px] text-[color:var(--accent)]">
          <span>{draftingAgent} is drafting a message in the terminal…</span>
          <button type="button" className="font-semibold" onClick={cancelAgentCommitDraft}>Stop waiting</button>
        </div>
      )}
      {amend && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
          <span className="min-w-0">
            Amending {headCommit?.shortId} — the staged files join the previous commit
          </span>
          <button type="button" className="shrink-0 font-semibold" onClick={toggleAmend}>
            Cancel
          </button>
        </div>
      )}
      <CommitIdentitySelector identity={identity} />
      <CommitSplitButton
        stagedCount={staged.length}
        branch={branch}
        amend={amend}
        canCommit={canCommit}
        blockedTitle={commitDisabledTitle}
        canAmend={canAmend}
        pushBlockedTitle={summary?.headBranch ? null : "Check out a branch to push"}
        amendTitle={
          canAmend
            ? `Rewrite ${headCommit?.shortId} with the staged changes and message`
            : "Available when the previous commit has not been pushed"
        }
        showOpenPr={isPrForge(forge?.kind)}
        agents={agents}
        agentsDisabled={!hasStaged || Boolean(commitBlocked) || !identity.usable}
        agentsDisabledTitle={
          !hasStaged
            ? "Stage files before committing with an agent"
            : commitBlocked ?? "Set a usable Git identity before committing with an agent"
        }
        onCommit={() => void doCommit()}
        onCommitAndPush={() => void commitAndPush()}
        onCommitPushOpenPr={() => void commitPushOpenPr()}
        onToggleAmend={toggleAmend}
        onCommitWithAgent={commitWithAgent}
      />
    </div>
  );
}
