import { isPrForge } from "@/components/chrome/action-bar/actionBarModel";
import {
  BranchKind,
  type BranchInfo,
  type CommitNode,
  type RepoForge,
  type RepoGraph,
  type RepoSummary,
  type AcpAgent,
  type TerminalAgent,
  type WorkingChanges,
} from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { currentBranchSyncView, defaultPublishTarget } from "@/lib/branchSync";
import { fullCommitMessage } from "@/lib/commitMessage";
import { ComposerMode, type ConventionalFields } from "@/lib/conventionalCommit";
import { isCommitReachableFromRemote } from "@/store/selection";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { selectInAppAgents } from "@/store/acpAgents";

/** The structural subset of the store's draft request this pure module needs —
 *  kept local rather than imported so the derivation has no store dependency. */
interface ActiveAgentDraft {
  repoPath: string;
  agentName: string;
  startedAt: number;
  token: string;
}

export interface CommitComposerDerivationInput {
  changes: WorkingChanges;
  summary: RepoSummary | null;
  forge: RepoForge | null;
  graph: RepoGraph | null;
  message: string;
  mode: ComposerMode;
  fields: ConventionalFields;
  identityUsable: boolean;
  agents: TerminalAgent[];
  acpAgents: AcpAgent[];
  agentDraft: ActiveAgentDraft | null;
  amend: boolean;
}

export interface CommitComposerDerivations {
  staged: WorkingChanges["staged"];
  branch: string;
  headCommit: CommitNode | null;
  canAmend: boolean;
  headPublished: boolean;
  /** Agents that can answer in-app — the Draft / Improve picker. */
  agents: AcpAgent[];
  /** Agents that can be launched into a terminal — "Commit with agent", which
   *  hands the work off rather than collecting an answer. */
  terminalAgents: TerminalAgent[];
  draftingAgent: string | null;
  /** The in-flight draft request scoped to this repo — carries when it started,
   *  for the waiting banner's elapsed clock. */
  draftRun: ActiveAgentDraft | null;
  commitBlocked: string | null;
  hasStaged: boolean;
  messageReady: boolean;
  canCommit: boolean;
  commitDisabledTitle: string | null;
  pushBlockedTitle: string | null;
  showOpenPr: boolean;
  draftDisabled: boolean;
  draftDisabledTitle: string;
  agentsDisabled: boolean;
  agentsDisabledTitle: string;
}

export function deriveCommitComposer({
  changes,
  summary,
  forge,
  graph,
  message,
  mode,
  fields,
  identityUsable,
  agents: agentsRaw,
  acpAgents,
  agentDraft,
  amend,
}: CommitComposerDerivationInput): CommitComposerDerivations {
  const staged = changes.staged;
  const headCommit =
    graph?.commits.find((commit) => commit.id === graph.head && !commit.stash) ?? null;
  const canAmend = Boolean(summary?.headBranch) && headCommit !== null;
  const headPublished =
    headCommit !== null && isCommitReachableFromRemote(graph, headCommit.id);
  // Draft / Improve need an answer back, so only ACP-capable agents qualify.
  const agents = selectInAppAgents(acpAgents);
  const terminalAgents = selectEnabledAgents(agentsRaw);
  const draftRun = agentDraft && agentDraft.repoPath === summary?.path ? agentDraft : null;
  const draftingAgent = draftRun?.agentName ?? null;
  const commitBlocked = fileWriteGuard(findGuardedFile(staged, changes), changes);
  const hasStaged = staged.length > 0;
  const messageReady =
    mode === ComposerMode.Conventional
      ? fields.subject.trim().length > 0
      : message.trim().length > 0;
  const canCommit = hasStaged && messageReady && !commitBlocked && identityUsable;
  const commitDisabledTitle =
    commitBlocked ??
    (!hasStaged
      ? "Stage files to commit"
      : !messageReady
        ? mode === ComposerMode.Conventional
          ? "Write a short summary first"
          : "Write a commit message first"
        : !identityUsable
          ? "Set a usable Git identity before committing"
          : null);

  return {
    staged,
    branch: summary?.headBranch ?? "HEAD",
    headCommit,
    canAmend,
    headPublished,
    agents,
    terminalAgents,
    draftingAgent,
    draftRun,
    commitBlocked,
    hasStaged,
    messageReady,
    canCommit,
    commitDisabledTitle,
    pushBlockedTitle:
      amend && headPublished
        ? "Amending a published commit requires Force push with lease from the branch menu"
        : summary?.headBranch
          ? null
          : "Check out a branch to push",
    showOpenPr: isPrForge(forge?.kind),
    draftDisabled: !hasStaged || Boolean(commitBlocked) || draftingAgent !== null,
    draftDisabledTitle: !hasStaged
      ? "Stage files before drafting a commit message"
      : commitBlocked ?? "Wait for the current agent draft",
    agentsDisabled: !hasStaged || Boolean(commitBlocked) || !identityUsable,
    agentsDisabledTitle: !hasStaged
      ? "Stage files before committing with an agent"
      : commitBlocked ?? "Set a usable Git identity before committing with an agent",
  };
}

export interface AmendTransition {
  amend: boolean;
  /** Null means the shared draft must be left exactly as-is. */
  message: string | null;
}

export function nextAmendTransition(
  canAmend: boolean,
  amend: boolean,
  message: string,
  headCommit: CommitNode | null,
): AmendTransition | null {
  if (!canAmend) return null;
  const next = !amend;
  const prefill = headCommit
    ? fullCommitMessage(headCommit.summary, headCommit.body)
    : "";
  if (next && message.trim().length === 0 && prefill) {
    return { amend: next, message: prefill };
  }
  if (!next && message === prefill) {
    return { amend: next, message: "" };
  }
  return { amend: next, message: null };
}

export interface PublishPromptDetails {
  title: string;
  message: string;
  placeholder: string;
  defaultValue: string;
  confirmLabel: string;
}

export function publishPromptDetails(
  summary: RepoSummary | null,
  branches: BranchInfo[],
): PublishPromptDetails | null {
  const branch = summary?.headBranch;
  if (!branch || !currentBranchSyncView(summary, branches).needsPublishPrompt) return null;
  const info = branches.find(
    (candidate) => candidate.kind === BranchKind.Local && candidate.name === branch,
  );
  return {
    title: `Publish ${branch}`,
    message: `Remote branch for ${branch} to push to and pull from.`,
    placeholder: "origin/branch",
    defaultValue: defaultPublishTarget(
      branches,
      branch,
      info?.upstream,
      info?.sync?.status !== "staleUpstream",
    ),
    confirmLabel: "Publish",
  };
}

export function branchSyncIsUpToDate(branches: BranchInfo[], branch: string): boolean {
  const head = branches.find(
    (candidate) => candidate.kind === BranchKind.Local && candidate.name === branch,
  );
  return head?.sync?.status === "upToDate";
}

export function buildCommitAgentInstruction(
  message: string,
  amend: boolean,
  configuredInstruction: string,
): string {
  return (
    message.trim() ||
    (amend
      ? "Read the staged diff once (`git diff --staged`), add it to the previous commit, and update the commit message only if it no longer fits. Do not open files, run tests, or review the code — be fast."
      : configuredInstruction.trim())
  );
}

/** What the agent is asked to do — draft a message, or improve the one already
 *  in the composer. This is the whole prompt: ACP carries the answer back, so
 *  nothing about delivery belongs in the text. */
export function buildDraftAgentTask(draftInstruction: string, existingMessage: string): string {
  const existingDraft = existingMessage.trim();
  return existingDraft
    ? `${draftInstruction.trim()} Use it to improve this existing conventional commit message: ${JSON.stringify(existingDraft)}.`
    : draftInstruction.trim();
}
