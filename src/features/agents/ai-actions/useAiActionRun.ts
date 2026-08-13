// One ACP turn for the AI actions popup: start, stop, and ignore a stale
// answer. Lives in a hook so the dialog only paints — the generation token and
// adapter cancel are not a render concern.
//
// Local UI (which action, extra notes, formatted/raw) stays in the dialog;
// this owns only the turn.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpAgent } from "@/lib/api";
import { useAcpProgress, useElapsed } from "@/features/changes/agentRun";
import { useRepo } from "@/store/repo";

export const AiActionPhase = {
  Idle: "idle",
  Run: "run",
  Done: "done",
} as const;
export type AiActionPhase = (typeof AiActionPhase)[keyof typeof AiActionPhase];

export function useAiActionRun() {
  const acpPrompt = useRepo((s) => s.acpPrompt);
  const acpCancel = useRepo((s) => s.acpCancel);
  const [phase, setPhase] = useState<AiActionPhase>(AiActionPhase.Idle);
  const [out, setOut] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const generation = useRef(0);
  const elapsed = useElapsed(startedAt);
  const progress = useAcpProgress(runId);
  const streaming = phase === AiActionPhase.Run;
  const hasOutput = phase !== AiActionPhase.Idle;

  const settle = useCallback(() => {
    setStartedAt(null);
    setRunId(null);
  }, []);

  const stopRun = useRef<() => void>(() => {});
  stopRun.current = () => {
    generation.current += 1;
    if (runId) void acpCancel(runId).catch(() => {});
  };

  useEffect(
    () => () => {
      stopRun.current();
    },
    [],
  );

  const run = useCallback(
    (agent: AcpAgent, repoPath: string, prompt: string) => {
      if (phase === AiActionPhase.Run) return;
      const requestGeneration = ++generation.current;
      const nextRunId = crypto.randomUUID().replace(/-/g, "");
      setOut("");
      setError(null);
      setPhase(AiActionPhase.Run);
      setStartedAt(Date.now());
      setRunId(nextRunId);
      void acpPrompt(agent.command, repoPath, agent.model, agent.config, prompt, nextRunId)
        .then((next) => {
          if (generation.current !== requestGeneration) return;
          setOut(next);
          setPhase(AiActionPhase.Done);
          settle();
        })
        .catch((promptError) => {
          if (generation.current !== requestGeneration) return;
          settle();
          setPhase(AiActionPhase.Idle);
          setError(String(promptError));
        });
    },
    [acpPrompt, phase, settle],
  );

  const stop = useCallback(() => {
    stopRun.current();
    settle();
    setPhase(out ? AiActionPhase.Done : AiActionPhase.Idle);
  }, [out, settle]);

  const reset = useCallback(() => {
    stopRun.current();
    settle();
    setOut("");
    setError(null);
    setPhase(AiActionPhase.Idle);
  }, [settle]);

  return {
    phase,
    out,
    setOut,
    error,
    startedAt,
    runId,
    elapsed,
    progress,
    streaming,
    hasOutput,
    run,
    stop,
    reset,
  };
}
