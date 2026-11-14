// One ACP turn for the AI actions popup: start, stop, and ignore a stale
// answer. Lives in a hook so the dialog only paints — the generation token and
// adapter cancel are not a render concern.
//
// Local UI (which action, extra notes, formatted/raw) stays in the dialog;
// this owns only the turn.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpAgent } from "@/lib/api";
import type { AiActionScope } from "@/lib/aiActionScope";
import { INLINE_DIFF_MAX_BYTES, withInlineDiff } from "@/lib/inlineDiff";
import { useAcpProgress, useElapsed } from "@/features/changes/agentRun";
import { useRepo } from "@/store/repo";
import type { RepoState } from "@/store/repoTypes";
import { scopePatchReads } from "./aiActions";

/** Every diff `scope` names as one patch text, or null when the reads together
 *  pass `maxBytes` or one fails — the agent then reads the diff itself. */
export async function readScopePatch(
  diffPatch: RepoState["diffPatch"],
  repoPath: string,
  scope: AiActionScope,
  maxBytes = INLINE_DIFF_MAX_BYTES,
): Promise<string | null> {
  let out = "";
  let used = 0;
  for (const [base, head] of scopePatchReads(scope)) {
    const patch = await diffPatch(repoPath, base, head, maxBytes - used).catch(() => null);
    if (patch === null) return null;
    out += patch;
    used += new TextEncoder().encode(patch).length;
  }
  return out;
}

/** The action prompt with the scope's diff attached (unchanged without one). */
export const withScopeDiff = (prompt: string, patch: string | null) =>
  withInlineDiff(prompt, patch, "diff", "`git show` or `git diff`");

export const AiActionPhase = {
  Idle: "idle",
  Run: "run",
  Done: "done",
} as const;
export type AiActionPhase = (typeof AiActionPhase)[keyof typeof AiActionPhase];

export function useAiActionRun() {
  const acpPrompt = useRepo((s) => s.acpPrompt);
  const acpCancel = useRepo((s) => s.acpCancel);
  const diffPatch = useRepo((s) => s.diffPatch);
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
    (agent: AcpAgent, repoPath: string, prompt: string, scope: AiActionScope) => {
      if (phase === AiActionPhase.Run) return;
      const requestGeneration = ++generation.current;
      const current = () => generation.current === requestGeneration;
      const nextRunId = crypto.randomUUID().replace(/-/g, "");
      setOut("");
      setError(null);
      setPhase(AiActionPhase.Run);
      setStartedAt(Date.now());
      setRunId(nextRunId);
      void readScopePatch(diffPatch, repoPath, scope)
        .then((patch) =>
          // Stopped while the diff was read: launch nothing.
          current()
            ? acpPrompt(agent.command, repoPath, agent.model, agent.config, withScopeDiff(prompt, patch), nextRunId)
            : "",
        )
        .then((next) => {
          if (!current()) return;
          setOut(next);
          setPhase(AiActionPhase.Done);
          settle();
        })
        .catch((promptError) => {
          if (!current()) return;
          settle();
          setPhase(AiActionPhase.Idle);
          setError(String(promptError));
        });
    },
    [acpPrompt, diffPatch, phase, settle],
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
