// AI-resolution runs for the open operation: one agent session per request.
//
// The state lives above the selected file on purpose: a run started on
// `README.md` keeps going — and its error stays readable — while the user
// reviews `pricing.ts`. Keying the component by path (the first shape) made a
// file switch look like the run had vanished.
//
// A request — one file or "Resolve all" — is one job: every target file goes
// into one prompt, so the agent sees the whole merge in one session instead of
// N adapters each seeing one file. The answer is split per path and each file
// is judged and landed on its own. All of a job's files share its `runId`, so
// every row shows the same progress; stopping one file detaches only that file,
// and the adapter ends once none of the job's files is still waiting.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpAgent, ConflictFileContent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import {
  SENTINEL_IN_FILE,
  TOO_LARGE,
  buildResolvePrompt,
  holdsSentinel,
  splitResolvedAnswer,
  sweepTooLarge,
} from "./aiResolveModel";

export interface AiRun {
  /** Set while the turn is in flight; also scopes `acp-progress` ticks. */
  runId: string | null;
  startedAt: number | null;
  /** Started, but its files are still being read before the prompt goes out
   * (the list chip still says "queued"; the row says "Preparing"). */
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

const blank = (agentName: string): AiRun => ({
  runId: null,
  startedAt: null,
  queued: false,
  proposed: false,
  agentName,
  error: null,
});

/** One resolve request: one prompt, one adapter, many files. */
interface Job {
  runId: string;
  paths: string[];
  /** Each path's token at start; a bumped token means that file was stopped or restarted. */
  tokens: Record<string, number>;
  /** The prompt went out, so there is an adapter to end. */
  sent: boolean;
}

export interface AiResolveRuns {
  runs: AiRuns;
  /** Run the agent over these files in one session. */
  start: (agent: AcpAgent, paths: string[], noteFor: (path: string) => string) => void;
  /** Drop one file's run (and end its adapter once no other file needs it). */
  clear: (path: string) => void;
  /** True while any run is in flight. */
  busy: boolean;
}

/**
 * Owns the AI-resolution runs for the open operation: start and cancel.
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
  const acpCancelRef = useRef(acpCancel);
  acpCancelRef.current = acpCancel;
  const readContentRef = useRef(readContent);
  readContentRef.current = readContent;
  const [runs, setRuns] = useState<AiRuns>({});
  // Bumped by every cancel-all / repo switch: a job whose generation is stale
  // must not write back. Per-file Stop uses `tokens` instead, so the rest of
  // the job keeps going.
  const generation = useRef(0);
  const tokens = useRef<Record<string, number>>({});
  /** The job each path currently belongs to. */
  const owner = useRef<Record<string, Job>>({});
  const jobs = useRef(new Set<Job>());

  const bumpToken = (path: string) => {
    tokens.current[path] = (tokens.current[path] ?? 0) + 1;
    return tokens.current[path];
  };

  const live = (job: Job, path: string) => tokens.current[path] === job.tokens[path];

  const patch = (job: Job, path: string, next: Partial<AiRun>) => {
    if (!live(job, path)) return;
    setRuns((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path], ...next } } : prev));
  };

  /** End a job's adapter once none of its files is still waiting on it. */
  const releaseIfIdle = (job: Job) => {
    if (job.paths.some((path) => live(job, path))) return;
    // A finished job is already out of the set — its adapter has exited.
    if (jobs.current.delete(job) && job.sent) void acpCancelRef.current(job.runId).catch(() => {});
  };

  const run = async (job: Job, agent: AcpAgent, notes: Record<string, string>, cwd: string) => {
    const mine = generation.current;
    const alive = (path: string) => generation.current === mine && live(job, path);
    const done = { runId: null, startedAt: null, queued: false } as const;

    const contents: Record<string, string> = {};
    const read = await Promise.all(job.paths.map((path) => readContentRef.current(path)));
    for (const [i, path] of job.paths.entries()) {
      const content = read[i];
      if (!alive(path)) continue;
      if (!content || content.binary) {
        patch(job, path, {
          ...done,
          error: content ? "This file is binary — resolve it as a whole file." : "Couldn't read the file.",
        });
      } else if (holdsSentinel(content.content)) {
        patch(job, path, { ...done, error: SENTINEL_IN_FILE });
      } else {
        contents[path] = content.content;
      }
    }
    const targets = job.paths.filter((path) => path in contents && alive(path));
    if (targets.length === 0) return jobs.current.delete(job);
    if (sweepTooLarge(targets.map((path) => contents[path]))) {
      const error = targets.length === 1 ? "Too large for the agent — resolve it by hand." : TOO_LARGE;
      for (const path of targets) patch(job, path, { ...done, error });
      return jobs.current.delete(job);
    }

    for (const path of targets) {
      // A "Resolve again" must not keep the previous landing visible under a
      // new spinner — the editor goes back to undecided until this answer lands.
      onResetRef.current?.(path);
      patch(job, path, { queued: false, runId: job.runId, startedAt: Date.now() });
    }
    job.sent = true;
    let answer: string;
    try {
      answer = await acpPromptRef.current(
        agent.command,
        cwd,
        agent.model,
        agent.config,
        buildResolvePrompt(targets.map((path) => ({ path, content: contents[path], note: notes[path] }))),
        job.runId,
      );
    } catch (error) {
      for (const path of targets) if (alive(path)) patch(job, path, { ...done, error: String(error) });
      return jobs.current.delete(job);
    }
    jobs.current.delete(job);

    const sources = Object.fromEntries(targets.map((path) => [path, contents[path]]));
    const results = splitResolvedAnswer(answer, sources);
    for (const path of targets) {
      if (!alive(path)) continue;
      const out = results[path];
      if ("error" in out) {
        patch(job, path, { ...done, error: out.error });
        continue;
      }
      // The prompt was built against `contents`. If the worktree moved while
      // the agent ran, landing those picks would stamp them with the *new*
      // hunk fingerprints (GL-180) and apply old line indexes to a changed
      // hunk. Refuse rather than silently mis-merge.
      const latest = await readContentRef.current(path);
      if (!alive(path)) continue;
      if (!latest || latest.content !== contents[path]) {
        patch(job, path, { ...done, error: "The file changed on disk — resolve it again." });
        continue;
      }
      applyToEditorRef.current(path, out.text, contents[path]);
      patch(job, path, { ...done, proposed: true });
    }
  };

  const stopAll = useRef<() => void>(() => {});
  stopAll.current = () => {
    generation.current += 1;
    for (const job of jobs.current) {
      if (job.sent) void acpCancelRef.current(job.runId).catch(() => {});
    }
    jobs.current.clear();
    owner.current = {};
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
      const job: Job = {
        runId: crypto.randomUUID().replace(/-/g, ""),
        paths,
        tokens: {},
        sent: false,
      };
      const replaced = new Set<Job>();
      for (const path of paths) {
        const prev = owner.current[path];
        if (prev) replaced.add(prev);
        job.tokens[path] = bumpToken(path);
        owner.current[path] = job;
      }
      replaced.forEach(releaseIfIdle);
      jobs.current.add(job);
      setRuns((prev) => {
        const next = { ...prev };
        for (const path of paths) next[path] = { ...blank(agent.name), queued: true };
        return next;
      });
      const notes = Object.fromEntries(paths.map((path) => [path, noteFor(path)]));
      void run(job, agent, notes, repoPath);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only; `run` reads everything through them
    [repoPath],
  );

  const clear = useCallback((path: string) => {
    bumpToken(path);
    const job = owner.current[path];
    delete owner.current[path];
    if (job) releaseIfIdle(job);
    setRuns((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, []);

  const busy = Object.values(runs).some((r) => r.queued || r.runId !== null);

  return { runs, start, clear, busy };
}
