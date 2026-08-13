// Elapsed-time readout and live ACP progress for a running agent request,
// shared by the commit-draft banner and the inline change description.
//
// The answer still arrives whole, but tool-call titles stream as `acp-progress`
// events while the turn runs — Rust already formats those labels. Each turn
// passes a `runId` so Draft and Describe banners never cross-talk.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** `8s`, `1m 04s`, `12m 30s` — seconds stay zero-padded past a minute so the
 *  readout doesn't jitter in width as it ticks. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Live elapsed label for a request that began at `startedAt`, or `null` when
 *  nothing is running. Ticks once a second and stops when `startedAt` clears, so
 *  an idle composer schedules no timer at all. */
export function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt === null ? null : formatElapsed(now - startedAt);
}

const VAGUE_PROGRESS = new Set([
  "Starting the agent…",
  "Sending the prompt…",
  "Thinking…",
  "Working…",
  "Reading…",
  "Searching…",
  "Fetching…",
  "Editing…",
  "Running…",
  "Writing the answer…",
]);

/** Handshake / prompt-sent milestones and bare verbs — useful briefly, but not
 *  proof of ongoing work once enough time has passed. */
export function isVagueProgress(message: string): boolean {
  return VAGUE_PROGRESS.has(message) || /^Using .+…$/.test(message);
}

/** Latest `acp-progress` message for `runId`, or `null` when idle / mismatched.
 *  Clears when `runId` changes so a previous run's last title cannot leak. */
export function useAcpProgress(runId: string | null): string | null {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setMessage(null);
      return;
    }
    setMessage(null);
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{ runId: string; message: string }>("acp-progress", ({ payload }) => {
      if (payload.runId !== runId) return;
      const next = payload.message.trim();
      if (next) setMessage(next);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [runId]);

  return message;
}

/** What the agent is busy doing, for the waiting copy. */
export type AgentVerb = "drafting" | "describing" | "resolving";

/** What to show when the agent has not reported a tool title yet. Keeps a slow
 *  silent turn from looking identical to a hang. */
export function waitingFallback(elapsedMs: number, verb: AgentVerb): string {
  if (elapsedMs < 8_000) return `Starting the agent…`;
  if (elapsedMs < 25_000) return `Waiting while ${verb}…`;
  if (elapsedMs < 60_000) return `Still working — this can take a minute…`;
  return `Still waiting — the agent has not answered yet…`;
}

/** Prefer a titled progress label; escalate past vague labels with a timed
 *  fallback so quiet adapters don't look frozen. */
export function waitingStatus({
  agentName,
  progress,
  elapsedMs,
  verb,
}: {
  agentName: string;
  progress: string | null;
  elapsedMs: number;
  verb: AgentVerb;
}): string {
  if (progress && !isVagueProgress(progress)) return progress;

  const fallback = waitingFallback(elapsedMs, verb);
  if (elapsedMs < 8_000) {
    return progress ?? `${agentName} · ${fallback}`;
  }
  if (fallback.startsWith("Waiting")) return `${agentName} · ${fallback}`;
  return fallback;
}
