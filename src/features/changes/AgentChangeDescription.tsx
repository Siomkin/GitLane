import { useEffect, useMemo, useRef, useState } from "react";
import type { AcpAgent } from "@/lib/api";
import { Markdown } from "@/components/ui/Markdown";
import { CodeIcon, EyeIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useCommitAgentMessages } from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { selectInAppAgents, useAcpAgents } from "@/store/acpAgents";
import { AgentActionControl } from "./AgentActionControl";
import { useAcpProgress, useElapsed, waitingStatus } from "./agentRun";
import { AgentSpinner } from "./AgentSpinner";

const EMPTY_AGENTS: AcpAgent[] = [];

type DescriptionView = "preview" | "source";

export function AgentChangeDescription({
  contextKey,
  instruction,
}: {
  /** Stable identity of the working snapshot, commit, range, or selection. */
  contextKey: string;
  /** Tells the terminal agent which changes it should inspect. */
  instruction: string;
}) {
  const agentsRaw = useAcpAgents((state) => state.agents ?? EMPTY_AGENTS);
  const agents = useMemo(() => selectInAppAgents(agentsRaw), [agentsRaw]);
  const loadAgents = useAcpAgents((state) => state.loadAgents);
  const descriptionInstruction = useCommitAgentMessages(
    (state) => state.messages.descriptionInstruction,
  );
  const loadMessages = useCommitAgentMessages((state) => state.loadMessages);
  const acpPrompt = useRepo((state) => state.acpPrompt);
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const [agentId, setAgentId] = useState("");
  const [description, setDescription] = useState("");
  const [view, setView] = useState<DescriptionView>("preview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-null only while a run is in flight; drives the elapsed clock and
  // scopes `acp-progress` ticks so a concurrent Draft can't steal this banner.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const elapsed = useElapsed(startedAt);
  const progress = useAcpProgress(runId);
  const generation = useRef(0);
  // Derive the selection when the list drops the remembered id — don't sync
  // with an effect (architecture-rules-react.md §1).
  const selectedAgentId = agents.some((agent) => agent.id === agentId)
    ? agentId
    : (agents[0]?.id ?? "");
  const runningAgent = agents.find((agent) => agent.id === selectedAgentId);
  const waitingLabel =
    loading && runningAgent && startedAt !== null
      ? waitingStatus({
          agentName: runningAgent.name,
          progress,
          elapsedMs: Date.now() - startedAt,
          verb: "describing",
        })
      : null;

  useEffect(() => {
    void loadAgents();
    void loadMessages();
  }, [loadAgents, loadMessages]);

  useEffect(() => {
    generation.current += 1;
    setDescription("");
    setView("preview");
    setLoading(false);
    setStartedAt(null);
    setRunId(null);
    setError(null);
  }, [contextKey, repoPath]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const generate = (agent: AcpAgent) => {
    if (loading || !repoPath) return;
    setAgentId(agent.id);
    const task = `${instruction} ${descriptionInstruction.trim()}`;

    const requestGeneration = ++generation.current;
    const nextRunId = crypto.randomUUID().replace(/-/g, "");
    setDescription("");
    setView("preview");
    setError(null);
    setLoading(true);
    setStartedAt(Date.now());
    setRunId(nextRunId);
    const settle = () => {
      setLoading(false);
      setStartedAt(null);
      setRunId(null);
    };
    void acpPrompt(agent.command, repoPath, agent.model, agent.config, task, nextRunId)
      .then((next) => {
        if (generation.current !== requestGeneration) return;
        setDescription(next);
        settle();
      })
      .catch((promptError) => {
        if (generation.current !== requestGeneration) return;
        settle();
        setError(String(promptError));
      });
  };

  if (agents.length === 0 && !description && !loading) return null;

  const actionLabel = loading ? "Describing…" : description ? "Describe again" : "Describe";
  const clear = () => {
    generation.current += 1;
    setLoading(false);
    setStartedAt(null);
    setRunId(null);
    setDescription("");
    setView("preview");
    setError(null);
  };

  return (
    <section
      aria-label="AI change description"
      className="border-b border-black/5 bg-white px-4 py-3 dark:border-white/5 dark:bg-neutral-800"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            AI description
          </div>
          <div className="text-[11px] text-neutral-400">Explain what these changes do</div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {description && (
            <div
              role="group"
              aria-label="Description view"
              className="mr-1 flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]"
            >
              <button
                type="button"
                className={cn(viewButton(view === "source"), "flex items-center gap-1.5")}
                title="Show the raw Markdown source"
                aria-pressed={view === "source"}
                onClick={() => setView("source")}
              >
                <CodeIcon width={13} height={13} />
                Source
              </button>
              <button
                type="button"
                className={cn(viewButton(view === "preview"), "flex items-center gap-1.5")}
                title="Render as formatted Markdown"
                aria-pressed={view === "preview"}
                onClick={() => setView("preview")}
              >
                <EyeIcon width={13} height={13} />
                Preview
              </button>
            </div>
          )}
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
            activeAgentId={selectedAgentId || null}
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
      {waitingLabel && (
        <p
          role="status"
          className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs text-[color:var(--accent)]"
        >
          <AgentSpinner />
          <span className="min-w-0 flex-1 truncate">{waitingLabel}</span>
          {elapsed && <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>}
        </p>
      )}
      {description && (
        <div className="mt-2 select-text rounded-lg border border-black/5 bg-black/[0.02] px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.03]">
          {view === "preview" ? (
            <Markdown content={description} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-neutral-700 dark:text-neutral-200">
              {description}
            </pre>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

function viewButton(active: boolean) {
  return cn(
    "h-6 rounded-md px-2.5",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );
}
