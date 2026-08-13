// "Resolve with AI" for the conflict workspace: one agent run per conflicted
// file, a note the user can send along, and a progress banner while it runs.
//
// Purely presentational over `useAiResolveRuns` — the runs outlive the selected
// file, so switching files (or starting a "Resolve all" sweep) never loses work
// that is still running. The row shows only the selected file's own run: a
// sweep resolves several files at once, so another file's status here says
// nothing about this one. Answers land in Output (ticks, custom hunk text, or a
// whole-file rewrite) — Output is the review surface, so this row holds no diff
// of its own, only the Apply & stage / Discard pair for what landed there.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AcpAgent } from "@/lib/api";
import { useAcpAgents, selectInAppAgents } from "@/store/acpAgents";
import { AgentActionControl } from "@/features/changes/AgentActionControl";
import { AgentSpinner } from "@/features/changes/AgentSpinner";
import { useAcpProgress, useElapsed, waitingStatus } from "@/features/changes/agentRun";
import { basename } from "@/lib/paths";
import type { AiResolveRuns } from "./useAiResolveRuns";

const EMPTY_AGENTS: AcpAgent[] = [];

export function AiConflictResolve({
  path,
  /** Every unresolved text conflict, in list order — the "Resolve all" target. */
  allPaths,
  runs,
  onDiscardProposal,
}: {
  path: string;
  allPaths: string[];
  runs: AiResolveRuns;
  /** Throw the proposal away and put the editor back the way it was. */
  onDiscardProposal: (path: string) => void;
}) {
  const agentsRaw = useAcpAgents((s) => s.agents ?? EMPTY_AGENTS);
  const agents = useMemo(() => selectInAppAgents(agentsRaw), [agentsRaw]);
  const loadAgents = useAcpAgents((s) => s.loadAgents);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const run = runs.runs[path];
  const elapsed = useElapsed(run?.startedAt ?? null);
  const progress = useAcpProgress(run?.runId ?? null);
  const waitingLabel =
    run?.startedAt != null
      ? waitingStatus({
          agentName: run.agentName,
          progress,
          elapsedMs: Date.now() - run.startedAt,
          verb: "resolving",
        })
      : null;

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Nothing to offer until an ACP agent is configured in Settings.
  if (agents.length === 0) return null;

  const noteFor = (target: string) => notes[target] ?? "";
  const start = (agent: AcpAgent, targets: string[]) =>
    runs.start(agent, targets, noteFor);
  const label =
    run?.startedAt != null
      ? "Resolving…"
      : run?.error
        ? "Try again"
        : run?.proposed
          ? "Resolve again"
          : "Resolve with AI";

  return (
    <section
      aria-label="AI conflict resolution"
      className="rounded-xl border border-black/5 bg-white px-3 py-2.5 dark:border-white/5 dark:bg-neutral-800"
    >
      <div className="flex items-center gap-2">
        <input
          value={noteFor(path)}
          onChange={(e) => setNotes((prev) => ({ ...prev, [path]: e.target.value }))}
          placeholder={`Anything the agent should know about ${basename(path)}? (optional)`}
          aria-label="Note for the agent"
          className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10"
        />
        {run && (
          <button
            type="button"
            onClick={() => (run.proposed ? onDiscardProposal(path) : runs.clear(path))}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200"
          >
            {run.startedAt != null || run.queued ? "Stop" : "Discard"}
          </button>
        )}
        {allPaths.length > 1 && (
          <AgentActionControl
            agents={agents}
            activeAgentId={null}
            label={`Resolve all ${allPaths.length}`}
            actionTitle="Run the agent over every unresolved text conflict, two at a time"
            buttonAriaLabel={`Resolve all ${allPaths.length} conflicted files with an agent`}
            menuLabel="Resolve all with"
            placement="down"
            disabled={runs.busy}
            disabledTitle="Wait for the current agent resolution"
            onPick={(agent) => start(agent, allPaths)}
          />
        )}
        <AgentActionControl
          agents={agents}
          activeAgentId={null}
          label={label}
          buttonAriaLabel={`${label} — resolve this conflict with an agent`}
          menuLabel="Resolve with"
          placement="down"
          disabled={run?.startedAt != null || !!run?.queued}
          disabledTitle="Wait for the current agent resolution"
          onPick={(agent) => start(agent, [path])}
        />
      </div>

      {/* A queued file reads as the same kind of work as a running one — same
          banner, same spinner — or a stalled-looking row is all the user sees
          while the sweep is busy elsewhere. */}
      {/* No "waiting on <file>": a sweep runs several files at once, so there
          is no single file this one is behind. */}
      {run?.queued && <RunStatus>Queued for {run.agentName}…</RunStatus>}
      {waitingLabel && (
        <RunStatus elapsed={elapsed}>{waitingLabel}</RunStatus>
      )}
      {run?.proposed && (
        <p role="status" className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {run.agentName} resolved {basename(path)} — review it in Output, then apply.
        </p>
      )}
      {run?.error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {run.error}
        </p>
      )}
    </section>
  );
}

function RunStatus({ children, elapsed }: { children: ReactNode; elapsed?: string | null }) {
  return (
    <p
      role="status"
      className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs text-[color:var(--accent)]"
    >
      <AgentSpinner />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {elapsed && <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>}
    </p>
  );
}
