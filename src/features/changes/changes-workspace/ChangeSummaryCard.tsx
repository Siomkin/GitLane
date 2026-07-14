import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalAgent, WorkingChanges } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";

const EMPTY_AGENTS: TerminalAgent[] = [];

export function ChangeSummaryCard({ changes }: { changes: WorkingChanges }) {
  // A defensive fallback keeps older persisted/test snapshots that predate the
  // configurable-agent store shape from breaking the changes view.
  const agentsRaw = useTerminalAgents((state) => state.agents ?? EMPTY_AGENTS);
  const agents = useMemo(
    () => agentsRaw.filter((agent) => agent.enabled && agent.available),
    [agentsRaw],
  );
  const loadAgents = useTerminalAgents((state) => state.loadAgents);
  const sendToTerminal = useUi((state) => state.sendToTerminal);
  const takeAgentChangeSummary = useRepo((state) => state.takeAgentChangeSummary);
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const [agentId, setAgentId] = useState("");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agents, agentId]);

  useEffect(() => {
    generation.current += 1;
    setSummary("");
    setLoading(false);
    setError(null);
  }, [changes, repoPath]);

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  const generate = () => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent || loading || !repoPath) return;
    const token = crypto.randomUUID().replace(/-/g, "");
    const filename = `gitlane-change-summary-${token}`;
    const requestGeneration = ++generation.current;
    setSummary("");
    setError(null);
    setLoading(true);
    sendToTerminal(
      "Review all staged and unstaged changes in this repository. Write a useful plain-text summary in 200 characters or fewer. " +
        "Mention the main intent and distinguish staged from unstaged work when relevant. Do not modify files and do not commit. " +
        `Write to a temporary file, then atomically rename it to the path printed by: git rev-parse --git-path '${filename}'.`,
      agent.command,
    );

    const startedAt = Date.now();
    const poll = async () => {
      if (generation.current !== requestGeneration) return;
      try {
        const next = await takeAgentChangeSummary(repoPath, token);
        if (generation.current !== requestGeneration) return;
        if (next) {
          setSummary(next);
          setLoading(false);
          return;
        }
        if (Date.now() - startedAt >= 120_000) {
          setLoading(false);
          setError("The agent did not return a summary within two minutes.");
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

  if (agents.length === 0 && !summary && !loading) return null;

  return (
    <section aria-label="Change summary" className="border-b border-black/5 bg-[var(--accent-soft)] px-4 py-3 dark:border-white/5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Summary</span>
        <select
          aria-label="Summary agent"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          disabled={loading}
          className="h-7 rounded-md border border-black/10 bg-white px-2 text-xs dark:border-white/10 dark:bg-neutral-900"
        >
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
        <button
          type="button"
          onClick={generate}
          disabled={!agentId || loading}
          className="h-7 rounded-md border border-black/10 px-2.5 text-[11px] font-semibold hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
        >
          {loading ? "Summarizing…" : summary ? "Regenerate" : "Summarize changes"}
        </button>
        {(summary || loading) && (
          <button type="button" onClick={() => { generation.current += 1; setLoading(false); setSummary(""); }} className="text-[11px] text-neutral-400 hover:text-neutral-600">
            Clear
          </button>
        )}
      </div>
      {loading && <p role="status" className="mt-2 text-xs text-neutral-400">The agent is reviewing changes in the terminal…</p>}
      {summary && <p className="mt-2 select-text text-[13px] leading-5 text-neutral-700 dark:text-neutral-200">{summary}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
