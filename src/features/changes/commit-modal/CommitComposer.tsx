// Inline commit controls for the Working Changes inspector (commit panel
// redesign). The staged list directly above this composer is the source of
// truth for commit inclusion. One collapsible surface, two message styles —
// free-form or structured conventional commit — with the agent Draft control
// folded into the editor row. Amend stays visible because selecting it prefills
// the previous message; push / open-PR / agent variants live behind the split
// button's caret.

import { useState } from "react";
import { ChevronDownIcon } from "@/components/ui/icons";
import { CommitIdentitySelector } from "./CommitIdentitySelector";
import { CommitAmendOption } from "./CommitAmendOption";
import { CommitMessageEditor } from "./CommitMessageEditor";
import { CommitSplitButton } from "./CommitSplitButton";
import { DraftAgentControl } from "./DraftAgentControl";
import { useCommitExecutionController } from "./useCommitExecutionController";

export function CommitComposer() {
  // Collapsed by default — the slim bar keeps the file list roomy until the
  // user actually starts a commit.
  const [composerOpen, setComposerOpen] = useState(false);
  const controller = useCommitExecutionController();
  const {
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
    staged,
    branch,
    headCommit,
    canAmend,
    headPublished,
    agents,
    draftingAgent,
    commitBlocked,
    canCommit,
    commitDisabledTitle,
    pushBlockedTitle,
    showOpenPr,
    draftDisabled,
    draftDisabledTitle,
    agentsDisabled,
    agentsDisabledTitle,
    toggleAmend,
    doCommit,
    commitAndPush,
    commitPushOpenPr,
    commitWithAgent,
    draftWithAgent,
  } = controller;

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
      <CommitAmendOption
        checked={amend}
        disabled={!canAmend}
        headShortId={headCommit?.shortId ?? null}
        published={headPublished}
        disabledReason={
          headCommit === null
            ? "Available after the first commit"
            : !summary?.headBranch
              ? "Check out a branch to amend its latest commit"
              : null
        }
        onChange={toggleAmend}
      />
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
              disabled={draftDisabled}
              disabledTitle={draftDisabledTitle}
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
      <CommitIdentitySelector identity={identity} />
      <CommitSplitButton
        stagedCount={staged.length}
        branch={branch}
        amend={amend}
        canCommit={canCommit}
        blockedTitle={commitDisabledTitle}
        pushBlockedTitle={pushBlockedTitle}
        showOpenPr={showOpenPr}
        agents={agents}
        agentsDisabled={agentsDisabled}
        agentsDisabledTitle={agentsDisabledTitle}
        onCommit={() => void doCommit()}
        onCommitAndPush={() => void commitAndPush()}
        onCommitPushOpenPr={() => void commitPushOpenPr()}
        onCommitWithAgent={commitWithAgent}
      />
    </div>
  );
}
