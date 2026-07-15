import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalAgent } from "@/lib/api";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { AgentActionControl } from "./AgentActionControl";

const EMPTY_AGENTS: TerminalAgent[] = [];

// Describing a diff is a heavier task than drafting a commit message — the agent
// reads every changed file and writes a detailed explanation — so it needs a
// more generous ceiling than the commit-draft flow's two minutes.
const DESCRIBE_TIMEOUT_MS = 5 * 60_000;

export function AgentChangeDescription({
  contextKey,
  instruction,
}: {
  /** Stable identity of the working snapshot, commit, range, or selection. */
  contextKey: string;
  /** Tells the terminal agent which changes it should inspect. */
  instruction: string;
}) {
  const agentsRaw = useTerminalAgents((state) => state.agents ?? EMPTY_AGENTS);
  const agents = useMemo(
    () => agentsRaw.filter((agent) => agent.enabled && agent.available),
    [agentsRaw],
  );
  const loadAgents = useTerminalAgents((state) => state.loadAgents);
  const descriptionInstruction = useCommitAgentMessages(
    (state) => state.messages.descriptionInstruction,
  );
  const loadMessages = useCommitAgentMessages((state) => state.loadMessages);
  const sendToTerminal = useUi((state) => state.sendToTerminal);
  const takeAgentChangeSummary = useRepo((state) => state.takeAgentChangeSummary);
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const [agentId, setAgentId] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    void loadAgents();
    void loadMessages();
  }, [loadAgents, loadMessages]);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agents, agentId]);

  useEffect(() => {
    generation.current += 1;
    setDescription("");
    setLoading(false);
    setError(null);
  }, [contextKey, repoPath]);

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  const generate = (agent: TerminalAgent) => {
    if (loading || !repoPath) return;
    setAgentId(agent.id);
    const token = crypto.randomUUID().replace(/-/g, "");
    const filename = `gitlane-change-summary-${token}`;
    const requestGeneration = ++generation.current;
    setDescription("");
    setError(null);
    setLoading(true);
    sendToTerminal(
      `${instruction} ${descriptionInstruction.trim()}\n\n` +
        "Do not commit. Do not create, edit, stage, delete, or otherwise alter any tracked or untracked working-tree file. " +
        `For delivery only, you are explicitly authorized to create a temporary sibling and the final mailbox inside this repository's Git metadata at the path printed by: git rev-parse --git-path '${filename}'. ` +
        "These two Git-metadata paths are the only authorized filesystem writes and do not count as working-tree modifications. " +
        "Finish all analysis before delivering the explanation. Using shell file commands, not apply_patch, write only the final plain-text explanation to `<mailbox-path>.tmp`. " +
        "As your final tool action, atomically rename that sibling temporary file to `<mailbox-path>`. " +
        "That destination is a one-shot mailbox which GitLane deletes immediately after reading. A successful rename means delivery succeeded even if the destination disappears; do not inspect, read, list, or verify it afterward. " +
        "Once the rename succeeds, end the turn immediately and run no more tools or commands.",
      agent.command,
    );

    const startedAt = Date.now();
    const poll = async () => {
      if (generation.current !== requestGeneration) return;
      try {
        const next = await takeAgentChangeSummary(repoPath, token);
        if (generation.current !== requestGeneration) return;
        if (next) {
          setDescription(next);
          setLoading(false);
          // Match commit-draft delivery: once the mailbox result is visible in
          // the UI, minimize only an open terminal. Preserve an explicit user
          // collapse/hide, and restore normal size before the next expansion.
          const terminalUi = useUi.getState();
          if (terminalUi.terminalView === "open") {
            terminalUi.collapseTerminal();
            if (terminalUi.terminalExpanded) terminalUi.toggleTerminalExpanded();
          }
          return;
        }
        if (Date.now() - startedAt >= DESCRIBE_TIMEOUT_MS) {
          setLoading(false);
          setError(
            `The agent did not return a description within ${DESCRIBE_TIMEOUT_MS / 60_000} minutes.`,
          );
          return;
        }
        window.setTimeout(() => void poll(), 1_000);
      } catch (pollError) {
        if (generation.current !== requestGeneration) return;
        setLoading(false);
        setError(String(pollError));
      }
    };
    window.setTimeout(() => void poll(), 500);
  };

  if (agents.length === 0 && !description && !loading) return null;

  const actionLabel = loading ? "Describing…" : description ? "Describe again" : "Describe";
  const clear = () => {
    generation.current += 1;
    setLoading(false);
    setDescription("");
    setError(null);
  };

  return (
    <section aria-label="AI change description" className="border-b border-black/5 bg-white px-4 py-3 dark:border-white/5 dark:bg-neutral-800">
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            AI description
          </div>
          <div className="text-[11px] text-neutral-400">Explain what these changes do</div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {(description || loading || error) && (
            <button
              type="button"
              onClick={clear}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200"
            >
              Clear
            </button>
          )}
          <AgentActionControl
            agents={agents}
            activeAgentId={agentId || null}
            label={actionLabel}
            buttonAriaLabel={`${actionLabel} changes with agent`}
            menuLabel={description ? "Describe again with" : "Describe with"}
            placement="down"
            disabled={loading}
            disabledTitle="Wait for the current agent description"
            onPick={generate}
          />
        </div>
      </div>
      {loading && (
        <p role="status" className="mt-2 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs text-[color:var(--accent)]">
          The agent is describing these changes in the terminal…
        </p>
      )}
      {description && (
        <p className="mt-2 select-text whitespace-pre-wrap rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-[13px] leading-5 text-neutral-700 dark:text-neutral-200">
          {description}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
