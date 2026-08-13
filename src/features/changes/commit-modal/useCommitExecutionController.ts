import { useEffect, useState } from "react";

import { type AcpAgent, type TerminalAgent } from "@/lib/api";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { openIntent, publishedRepoSession } from "@/store/repoRequests";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useAcpAgents } from "@/store/acpAgents";
import { useUi } from "@/store/ui";
import {
  branchSyncIsUpToDate,
  buildCommitAgentInstruction,
  buildDraftAgentTask,
  deriveCommitComposer,
  nextAmendTransition,
  publishPromptDetails,
} from "./commitComposerModel";
import { useCommitIdentity } from "./useCommitIdentity";
import { useConventionalFields } from "./useConventionalFields";

export function useCommitExecutionController() {
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
  const agentsRaw = useTerminalAgents((state) => state.agents);
  const loadAgents = useTerminalAgents((state) => state.loadAgents);
  const acpAgents = useAcpAgents((state) => state.agents);
  const loadAcpAgents = useAcpAgents((state) => state.loadAgents);
  const agentMessages = useCommitAgentMessages((state) => state.messages);
  const loadAgentMessages = useCommitAgentMessages((state) => state.loadMessages);
  const identity = useCommitIdentity();
  const [amend, setAmend] = useState(false);

  const { fields, updateFields } = useConventionalFields(msg, setMsg);

  const model = deriveCommitComposer({
    changes,
    summary,
    forge,
    graph,
    message: msg,
    mode,
    fields,
    identityUsable: identity.usable,
    agents: agentsRaw,
    acpAgents,
    agentDraft: agentCommitDraft,
    amend,
  });

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadAcpAgents();
  }, [loadAcpAgents]);

  useEffect(() => {
    void loadAgentMessages();
  }, [loadAgentMessages]);

  useEffect(() => {
    if (!model.canAmend) setAmend(false);
  }, [model.canAmend]);

  const doCommit = async (): Promise<boolean> => {
    if (!model.canCommit) return false;
    // Snapshot the submitted values before the first await. The shared draft
    // and amend control remain editable while git and the refresh are running.
    const submittedMessage = msg;
    const submittedAmend = amend;
    const repoPath = useRepo.getState().summary?.path ?? null;
    const repoSession = publishedRepoSession.current();
    const committed = await commitSelected(submittedMessage.trim(), submittedAmend);
    if (!committed) return false;
    if (
      !repoPath ||
      useRepo.getState().summary?.path !== repoPath ||
      !publishedRepoSession.isCurrent(repoSession)
    ) {
      return false;
    }
    // A newer open intent by itself does not invalidate the still-published
    // repository's completed commit. Cleanup is owned by its published session;
    // chained writes add the stricter open-intent + branch checks below.
    if (useUi.getState().commitMsg === submittedMessage) setMsg("");
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
    const branch = repo.summary?.headBranch;
    const repoSession = publishedRepoSession.current();
    const intent = openIntent.current();
    if (!repoPath || !branch) return;

    const sameCheckout = () => {
      const state = useRepo.getState();
      return publishedRepoSession.isCurrent(repoSession) &&
        openIntent.isCurrent(intent) &&
        state.summary?.path === repoPath &&
        state.summary.headBranch === branch
        ? state
        : null;
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
      if (after && branchSyncIsUpToDate(after.branches, branch)) afterPushed();
    };

    const prompt = publishPromptDetails(repo.summary, repo.branches);
    if (prompt) {
      requestPrompt({
        ...prompt,
        onSubmit: (upstream) => {
          // The prompt can outlive the checkout that opened it. Recheck all
          // ownership here, before selecting the write action from the store.
          const state = sameCheckout();
          if (state) void finish(() => state.publishBranch(branch, upstream));
        },
      });
      return;
    }
    void finish(() => repo.push());
  };

  /** Commit, then run `then` only if the same repo + branch are still checked
   * out. Capture both owner tokens before the commit await: a pending newer
   * open invalidates the chain before its summary is published, while the
   * published session closes same-path close/reopen ABA. */
  const commitThen = async (then: () => void) => {
    const before = useRepo.getState().summary;
    const repoSession = publishedRepoSession.current();
    const intent = openIntent.current();
    if (!(await doCommit())) return;
    const after = useRepo.getState().summary;
    if (
      publishedRepoSession.isCurrent(repoSession) &&
      openIntent.isCurrent(intent) &&
      after?.path === before?.path &&
      after?.headBranch === before?.headBranch
    ) {
      then();
    }
  };

  const commitAndPush = () => commitThen(() => pushCurrentBranch());

  const commitPushOpenPr = () =>
    commitThen(() => pushCurrentBranch(() => openCreatePr()));

  const commitWithAgent = (agent: TerminalAgent) => {
    if (
      !model.hasStaged ||
      model.commitBlocked ||
      !identity.usable ||
      !agent.available
    ) {
      return;
    }
    sendToTerminal(
      buildCommitAgentInstruction(msg, amend, agentMessages.draftInstruction),
      agent.command,
    );
  };

  const draftWithAgent = (agent: AcpAgent) => {
    if (!model.hasStaged || model.commitBlocked || !agent.command || !summary) return;
    setDraftAgentId(agent.id);
    startAgentCommitDraft(
      {
        // Identifies this run so a superseded answer can't land in the composer.
        token: crypto.randomUUID().replace(/-/g, ""),
        agentName: agent.name,
        repoPath: summary.path,
        startedAt: Date.now(),
      },
      buildDraftAgentTask(agentMessages.draftInstruction, msg),
      agent,
    );
  };

  const toggleAmend = () => {
    const transition = nextAmendTransition(
      model.canAmend,
      amend,
      msg,
      model.headCommit,
    );
    if (!transition) return;
    setAmend(transition.amend);
    if (transition.message !== null) setMsg(transition.message);
  };

  return {
    ...model,
    msg,
    setMsg,
    mode,
    setMode,
    draftAgentId,
    cancelAgentCommitDraft,
    summary,
    amend,
    fields,
    updateFields,
    identity,
    toggleAmend,
    doCommit,
    commitAndPush,
    commitPushOpenPr,
    commitWithAgent,
    draftWithAgent,
  };
}
