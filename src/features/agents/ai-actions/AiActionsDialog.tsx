// AI actions popup: pick a description kind, run it over the selected commits
// / working tree through an ACP agent, then copy (or post) the result.
//
// Container: store slices, local UI affordances, and layout. The ACP turn lives
// in `useAiActionRun`; mapping lives in `aiActions.ts` / `aiActionsView.ts`.
// The agent reads the repo itself — GitLane never ships a diff over IPC.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AcpAgent } from "@/lib/api";
import { DIALOG_LAYER, ModalFrame } from "@/components/chrome/overlays/dialogs/frame";
import { isMac } from "@/lib/platform";
import { waitingStatus } from "@/features/changes/agentRun";
import { AgentRunStatus } from "@/features/changes/AgentRunStatus";
import { selectInAppAgents, useAcpAgents } from "@/store/acpAgents";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi, type AiActionsRequest } from "@/store/ui";
import { AiActionId, aiActionDef, buildAiActionPrompt, instructionFor, jiraKeyFrom, pickerActions, resolveAction, scopeCommits } from "./aiActions";
import {
  AiActionMenu,
  AiActionView,
  filesForScope,
  idleHint,
  matchingOpenPr,
  scopeCommitRows,
  scopeTally,
  type AiActionMenu as Menu,
  type AiActionView as View,
} from "./aiActionsView";
import { AiActionsBody } from "./AiActionsBody";
import { AiActionsFooter } from "./AiActionsFooter";
import { AiActionsHeader } from "./AiActionsHeader";
import { AiActionsPromptPreview } from "./AiActionsPromptPreview";
import { AiActionsToolbar } from "./AiActionsToolbar";
import { AiActionPhase, useAiActionRun } from "./useAiActionRun";

const EMPTY_AGENTS: AcpAgent[] = [];

export function AiActionsDialog() {
  const req = useUi((s) => s.aiActions);
  if (!req) return null;
  return (
    // A new request is a new turn, so the body remounts rather than carrying a
    // previous answer over. Keying on the whole request means a variant that
    // gains a field can't quietly go missing from the key.
    <AiActionsDialogBody key={JSON.stringify(req)} req={req} />
  );
}

function AiActionsDialogBody({ req }: { req: AiActionsRequest }) {
  const close = useUi((s) => s.closeAiActions);
  const showToast = useUi((s) => s.showToast);
  const agentsRaw = useAcpAgents((s) => s.agents ?? EMPTY_AGENTS);
  const agents = useMemo(() => selectInAppAgents(agentsRaw), [agentsRaw]);
  const loadAgents = useAcpAgents((s) => s.loadAgents);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const headBranch = useRepo((s) => s.summary?.headBranch ?? null);
  const graph = useRepo((s) => s.graph);
  const commitFiles = useRepo((s) => s.commitFiles);
  const selectionDiff = useRepo((s) => s.selectionDiff);
  const changes = useRepo((s) => s.changes);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const pullRequests = usePulls((s) => s.pullRequests);
  const commentPr = usePulls((s) => s.commentPr);
  const messages = useCommitAgentMessages((s) => s.messages);
  const loadMessages = useCommitAgentMessages((s) => s.loadMessages);
  const turn = useAiActionRun();

  const commands = messages.aiActions;
  const picker = pickerActions(commands);
  const [picked, setPicked] = useState<string | undefined>(req.action);
  const action = resolveAction(picked, commands);
  const [agentId, setAgentId] = useState("");
  const [extra, setExtra] = useState("");
  const [view, setView] = useState<View>(AiActionView.Formatted);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [postedPr, setPostedPr] = useState(false);
  const [posting, setPosting] = useState(false);
  const [menu, setMenu] = useState<Menu>(AiActionMenu.None);

  const selectedAgentId = agents.some((a) => a.id === agentId) ? agentId : (agents[0]?.id ?? "");
  const agent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const def = aiActionDef(action, commands);
  const instruction = instructionFor(action, commands);
  const jiraKey = jiraKeyFrom(headBranch);
  const customBlocked = action === AiActionId.Custom && extra.trim() === "";
  const canRun = !!repoPath && !!agent && !customBlocked;
  const files = filesForScope(req, { commitFiles, selectionDiff, changes, selectedCommit });
  const tally = scopeTally(files);
  const commits = scopeCommitRows(scopeCommits(req), graph?.commits);
  const matchingPr = matchingOpenPr(pullRequests, headBranch);

  useEffect(() => {
    void loadAgents();
    void loadMessages();
  }, [loadAgents, loadMessages]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const startTurn = () => {
    if (!canRun || !agent || !repoPath || turn.streaming) return;
    setView(AiActionView.Formatted);
    setEditing(false);
    setCopied(false);
    setPostedPr(false);
    setMenu(AiActionMenu.None);
    turn.run(
      agent,
      repoPath,
      buildAiActionPrompt({
        scope: req,
        action,
        extra,
        jiraKey,
        instruction,
      }),
    );
  };

  const runOrStop = () => {
    if (turn.streaming) turn.stop();
    else startTurn();
  };

  const runOrStopRef = useRef(runOrStop);
  runOrStopRef.current = runOrStop;
  // Editing the result owns the chord: a run clears `out`, so letting the
  // shortcut through here would throw away the edit the user is mid-way into.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.key !== "Enter") return;
      if (editingRef.current) return;
      e.preventDefault();
      runOrStopRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickAction = (id: AiActionId) => {
    setPicked(id);
    turn.reset();
    setEditing(false);
    setCopied(false);
    setPostedPr(false);
    setMenu(AiActionMenu.None);
  };

  const copy = () => {
    void navigator.clipboard?.writeText(turn.out).then(() => setCopied(true));
  };

  const postToPr = () => {
    if (!matchingPr || posting || !turn.out.trim()) return;
    setPosting(true);
    void commentPr(matchingPr.num, turn.out)
      .then(() => setPostedPr(true))
      .catch((postError) => showToast(String(postError), "error"))
      .finally(() => setPosting(false));
  };

  const waitingLabel =
    turn.streaming && agent && turn.startedAt !== null
      ? waitingStatus({
          agentName: agent.name,
          progress: turn.progress,
          elapsedMs: Date.now() - turn.startedAt,
          verb: "describing",
        })
      : null;

  return (
    <ModalFrame
      z={DIALOG_LAYER.Base}
      bare
      labelledBy="ai-actions-title"
      panelClassName="flex h-[min(724px,calc(100vh-32px))] w-[min(1020px,calc(100vw-32px))] flex-col overflow-hidden"
      onDismiss={close}
    >
      <AiActionsHeader
        req={req}
        tally={tally}
        files={files}
        commits={commits}
        agents={agents}
        agent={agent}
        selectedAgentId={selectedAgentId}
        streaming={turn.streaming}
        menu={menu}
        onToggleMenu={(next) => setMenu(next)}
        onPickAgent={(id) => {
          setAgentId(id);
          setMenu(AiActionMenu.None);
        }}
        onClose={close}
      />
      <AiActionsToolbar
        action={action}
        actions={picker}
        def={def}
        extra={extra}
        jiraKey={jiraKey}
        streaming={turn.streaming}
        phase={turn.phase}
        canRun={canRun}
        menu={menu}
        onToggleMenu={setMenu}
        onPickAction={pickAction}
        onExtra={setExtra}
        onRunOrStop={runOrStop}
      />
      {instruction && (
        <AiActionsPromptPreview
          key={action}
          instruction={instruction}
          // Close first: two stacked modals both keep a focus trap and this
          // dialog's Run chord live, so Cmd+Enter in Settings would start a
          // run the user can no longer see.
          onEdit={() => {
            useUi.getState().closeAiActions();
            useUi.getState().openSettings("prompts");
          }}
        />
      )}
      {waitingLabel && (
        <div className="px-4">
          <AgentRunStatus elapsed={turn.elapsed}>{waitingLabel}</AgentRunStatus>
        </div>
      )}
      <AiActionsBody
        hasOutput={turn.hasOutput}
        editing={editing}
        view={view}
        out={turn.out}
        def={def}
        hint={idleHint({ req, tally, agentName: agent?.name ?? "the agent you pick" })}
        error={turn.error}
        canRun={canRun}
        onRun={startTurn}
        onChangeOut={turn.setOut}
      />
      {turn.phase === AiActionPhase.Done && (
        <AiActionsFooter
          statusLabel={`${(agent?.name ?? "agent").toLowerCase()} · ${def.label.toLowerCase()} ready`}
          view={view}
          copied={copied}
          postedPr={postedPr}
          posting={posting}
          matchingPr={matchingPr}
          editing={editing}
          onView={(next) => {
            setView(next);
            setEditing(false);
          }}
          onCopy={copy}
          onPost={postToPr}
          onEdit={() => setEditing((v) => !v)}
        />
      )}
    </ModalFrame>
  );
}
