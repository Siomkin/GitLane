// One agent run per conflicted file, kept for the whole operation.
//
// The state lives above the selected file on purpose: a run started on
// `README.md` keeps going — and its error stays readable — while the user
// reviews `pricing.ts`. Keying the component by path (the first shape) made a
// file switch look like the run had vanished.
//
// "Resolve all" walks the unresolved text files three at a time. Bounded, not
// unbounded: each run is a whole adapter process, so ten conflicted files would
// be ten of them at once. Three keeps two more files moving while the first is
// thinking without turning the sweep into a fork bomb. Nothing forces them to
// be serial — separate files write separate resolver cells, and no git write is
// involved — so the cap is purely about the machine.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpAgent, ConflictFileContent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { buildResolvePrompt, extractResolvedContent } from "./aiResolveModel";

export interface AiRun {
  /** Set while the turn is in flight; also scopes `acp-progress` ticks. */
  runId: string | null;
  startedAt: number | null;
  /** Waiting its turn behind an earlier file in a "Resolve all" sweep. */
  queued: boolean;
  /** The answer landed in Output and is waiting for Apply & stage / Discard. */
  proposed: boolean;
  agentName: string;
  error: string | null;
}

export type AiRuns = Record<string, AiRun>;

/** What a file's agent run looks like from outside this row — what the
 * conflicted-file list shows so a sweep running on unopened files is visible.
 * A failed run has no list state: its error belongs on the file's own row. */
export type AiRunState = "resolving" | "queued" | "proposed";

export function aiRunState(run: AiRun | undefined): AiRunState | undefined {
  if (!run) return undefined;
  if (run.startedAt != null) return "resolving";
  if (run.queued) return "queued";
  return run.proposed ? "proposed" : undefined;
}

/** How many adapter processes a sweep may have in flight at once. */
const CONCURRENCY = 3;

const blank = (agentName: string): AiRun => ({
  runId: null,
  startedAt: null,
  queued: false,
  proposed: false,
  agentName,
  error: null,
});

/** One queued (or in-flight) turn. The queue stores the whole job, not just a
 * path: two workers can be draining under different `start` calls, and a path
 * alone would let the older worker pick up a file with the wrong agent or note. */
interface Job {
  path: string;
  agent: AcpAgent;
  note: string;
  /** Bumped on start/clear so a cancelled or replaced turn cannot land. */
  token: number;
}

export interface AiResolveRuns {
  runs: AiRuns;
  /** Run the agent over one file, or queue it behind an in-flight run. */
  start: (agent: AcpAgent, paths: string[], noteFor: (path: string) => string) => void;
  /** Drop one file's run (and end its adapter, if any). */
  clear: (path: string) => void;
  /** True while any run is in flight or queued. */
  busy: boolean;
}

/**
 * Owns the AI-resolution runs for the open operation: start/queue and cancel.
 *
 * `readContent` is the resolver's `revalidate`, so a file the user never opened
 * is read from disk (and its cached decisions revalidated) before the prompt.
 * Every successful answer is landed in the Output pane immediately — the review
 * surface is the editor, not a second card — and the run stays in `proposed`
 * until the user applies it (stages) or discards it.
 */
export function useAiResolveRuns({
  repoPath,
  readContent,
  applyToEditor,
  onReset,
}: {
  repoPath: string | null;
  readContent: (path: string) => Promise<ConflictFileContent | null>;
  /** Land the answer in the line editor. */
  applyToEditor: (path: string, proposal: string, source: string) => void;
  /** Drop this file's prior landing before a new turn overwrites it. */
  onReset?: (path: string) => void;
}): AiResolveRuns {
  const acpPrompt = useRepo((s) => s.acpPrompt);
  const acpCancel = useRepo((s) => s.acpCancel);
  const applyToEditorRef = useRef(applyToEditor);
  applyToEditorRef.current = applyToEditor;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  const acpPromptRef = useRef(acpPrompt);
  acpPromptRef.current = acpPrompt;
  const readContentRef = useRef(readContent);
  readContentRef.current = readContent;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const [runs, setRuns] = useState<AiRuns>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  // Bumped by every cancel-all / repo switch: a turn whose generation is stale
  // must not write back. Per-file Stop uses `tokens` instead, so a sibling
  // still in flight is not cancelled with it.
  const generation = useRef(0);
  const tokens = useRef<Record<string, number>>({});
  // Drain loops currently alive. Each decrements itself as it unwinds, so a
  // sweep that is still finishing never blocks the next one from topping up.
  const workers = useRef(0);
  const queue = useRef<Job[]>([]);

  const bumpToken = (path: string) => {
    tokens.current[path] = (tokens.current[path] ?? 0) + 1;
    return tokens.current[path];
  };

  const patch = useCallback((path: string, token: number, next: Partial<AiRun>) => {
    if (tokens.current[path] !== token) return;
    setRuns((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path], ...next } } : prev));
  }, []);

  const current = (job: Job, mine: number) =>
    generation.current === mine && tokens.current[job.path] === job.token;

  const drain = async () => {
    const mine = generation.current;
    for (;;) {
      if (generation.current !== mine) return;
      const job = queue.current.shift();
      if (!job) break;
      if (tokens.current[job.path] !== job.token) continue;
      const { path, agent, note, token } = job;
      // A "Resolve again" must not keep the previous landing visible under a
      // new spinner — the editor goes back to undecided until this answer lands.
      onResetRef.current?.(path);
      const nextRunId = crypto.randomUUID().replace(/-/g, "");
      patch(path, token, { queued: false, runId: nextRunId, startedAt: Date.now() });
      const content = await readContentRef.current(path);
      if (!current(job, mine)) return;
      if (!content || content.binary) {
        patch(path, token, {
          runId: null,
          startedAt: null,
          error: content ? "This file is binary — resolve it as a whole file." : "Couldn't read the file.",
        });
        continue;
      }
      const cwd = repoPathRef.current;
      if (!cwd) return;
      try {
        const answer = await acpPromptRef.current(
          agent.command,
          cwd,
          agent.model,
          agent.config,
          // ponytail: the whole file goes in the prompt; a very large
          // conflicted file can outgrow the adapter's answer cap. Chunk per
          // hunk if that bites.
          buildResolvePrompt({ path, content: content.content, note }),
          nextRunId,
        );
        if (!current(job, mine)) return;
        const out = extractResolvedContent(answer);
        if ("error" in out) {
          patch(path, token, { runId: null, startedAt: null, error: out.error });
          continue;
        }
        // The prompt was built against `content`. If the worktree moved while
        // the agent ran, landing those picks would stamp them with the *new*
        // hunk fingerprints (GL-180) and apply old line indexes to a changed
        // hunk. Refuse rather than silently mis-merge.
        const latest = await readContentRef.current(path);
        if (!current(job, mine)) return;
        if (!latest || latest.content !== content.content) {
          patch(path, token, {
            runId: null,
            startedAt: null,
            error: "The file changed on disk — resolve it again.",
          });
          continue;
        }
        applyToEditorRef.current(path, out.text, content.content);
        patch(path, token, { runId: null, startedAt: null, proposed: true });
      } catch (error) {
        if (!current(job, mine)) return;
        patch(path, token, { runId: null, startedAt: null, error: String(error) });
      }
    }
  };

  // Finishing workers re-pump so a repo switch that left stale drains alive
  // can still spawn replacements once they unwind — `start` alone would see
  // `workers === CONCURRENCY` and enqueue without a live drain.
  const pump = () => {
    while (workers.current < CONCURRENCY && queue.current.length > 0) {
      workers.current += 1;
      void drain().finally(() => {
        workers.current -= 1;
        // Always the latest pump: a drain spawned before a repo switch would
        // otherwise re-pump with its own stale `drain` / `repoPath`.
        pumpRef.current();
      });
    }
  };
  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  const stopAll = useRef<() => void>(() => {});
  stopAll.current = () => {
    generation.current += 1;
    queue.current = [];
    for (const run of Object.values(runsRef.current)) {
      if (run.runId) void acpCancel(run.runId).catch(() => {});
    }
  };

  // A different repo is a different set of conflicts — end every run with it.
  useEffect(() => {
    stopAll.current();
    setRuns({});
  }, [repoPath]);

  useEffect(() => () => stopAll.current(), []);

  const start: AiResolveRuns["start"] = useCallback(
    (agent, paths, noteFor) => {
      if (!repoPath || paths.length === 0) return;
      setRuns((prev) => {
        const next = { ...prev };
        for (const path of paths) next[path] = { ...blank(agent.name), queued: true };
        return next;
      });
      queue.current = queue.current.filter((job) => !paths.includes(job.path));
      for (const path of paths) {
        const run = runsRef.current[path];
        if (run?.runId) void acpCancel(run.runId).catch(() => {});
        queue.current.push({ path, agent, note: noteFor(path), token: bumpToken(path) });
      }
      pumpRef.current();
    },
    [acpCancel, repoPath],
  );

  const clear = useCallback(
    (path: string) => {
      bumpToken(path);
      const run = runsRef.current[path];
      if (run?.runId) void acpCancel(run.runId).catch(() => {});
      queue.current = queue.current.filter((job) => job.path !== path);
      setRuns((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [acpCancel],
  );

  const busy = Object.values(runs).some((run) => run.queued || run.runId !== null);

  return { runs, start, clear, busy };
}
