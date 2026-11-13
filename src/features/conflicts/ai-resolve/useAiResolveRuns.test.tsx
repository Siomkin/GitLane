import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConflictFileContent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { acpAgent } from "@/test/agents";
import { MAX_SWEEP_BYTES } from "./aiResolveModel";
import { useAiResolveRuns } from "./useAiResolveRuns";

const CONFLICT = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n";

const conflicted = (body: string): ConflictFileContent =>
  ({ content: body, binary: false }) as ConflictFileContent;

/** An answer resolving every file named in the prompt to "resolved <path>". */
const answerAll = (prompt: string) =>
  [...prompt.matchAll(/^=== FILE: (.+) ===$/gm)]
    .map(([, path]) => `=== FILE: ${path} ===\nresolved ${path}\n=== END FILE ===`)
    .join("\n");

const setup = (opts: {
  answer?: (prompt: string) => Promise<string>;
  content?: Record<string, string>;
  readContent?: (path: string) => Promise<ConflictFileContent | null>;
  repoPath?: string | null;
} = {}) => {
  const acpPrompt = vi.fn(async (_c, _p, _m, _cfg, prompt: string) =>
    opts.answer ? opts.answer(prompt) : answerAll(prompt),
  );
  const acpCancel = vi.fn(async () => true);
  useRepo.setState({ acpPrompt, acpCancel } as never);
  const bodies = opts.content ?? {};
  const readContent = vi.fn(
    opts.readContent ??
      (async (path: string) => conflicted(path in bodies ? bodies[path] : CONFLICT)),
  );
  const applyToEditor = vi.fn();
  const onReset = vi.fn();
  const hook = renderHook(
    ({ repoPath }) => useAiResolveRuns({ repoPath, readContent, applyToEditor, onReset }),
    { initialProps: { repoPath: opts.repoPath ?? "/repo" } },
  );
  return { hook, acpPrompt, acpCancel, applyToEditor, onReset, readContent };
};

/** A prompt that hangs until released. */
const deferred = () => {
  const releases: Array<(value: string) => void> = [];
  const prompts: string[] = [];
  const answer = (prompt: string) =>
    new Promise<string>((resolve) => {
      prompts.push(prompt);
      releases.push(resolve);
    });
  return { answer, releases, prompts };
};

describe("useAiResolveRuns", () => {
  it("resolves a whole sweep in one agent session", async () => {
    const { hook, acpPrompt, applyToEditor } = setup();

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts", "c.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    expect(acpPrompt).toHaveBeenCalledTimes(1);
    const prompt = acpPrompt.mock.calls[0][4] as string;
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      expect(prompt).toContain(`=== FILE: ${path} ===`);
      expect(applyToEditor).toHaveBeenCalledWith(path, `resolved ${path}\n`, CONFLICT);
      expect(hook.result.current.runs[path]).toMatchObject({ proposed: true, error: null });
    }
  });

  it("shares one run id across the job's files while it runs", async () => {
    const d = deferred();
    const { hook } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    const { runs } = hook.result.current;
    expect(runs["a.ts"].runId).toBeTruthy();
    expect(runs["b.ts"].runId).toBe(runs["a.ts"].runId);
  });

  it("sends each note with its own file", async () => {
    const { hook, acpPrompt } = setup({ content: { "a.ts": "conflicted body" } });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], (p) =>
        p === "a.ts" ? "keep our logging" : "",
      );
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalled());
    const prompt = acpPrompt.mock.calls[0][4] as string;
    expect(prompt).toContain("The user says about `a.ts`: keep our logging");
    expect(prompt).not.toContain("The user says about `b.ts`");
    expect(prompt).toContain("conflicted body");
  });

  it("judges each file on its own: missing, stale, and good in one answer", async () => {
    const reads: Record<string, number> = {};
    const { hook, applyToEditor } = setup({
      readContent: async (path) => {
        reads[path] = (reads[path] ?? 0) + 1;
        // stale.ts changes on disk between the prompt and the landing.
        return conflicted(path === "stale.ts" && reads[path] > 1 ? CONFLICT + "edit\n" : CONFLICT);
      },
      answer: async () =>
        "=== FILE: good.ts ===\nok\n=== END FILE ===\n=== FILE: stale.ts ===\nok\n=== END FILE ===\n",
    });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["good.ts", "missing.ts", "stale.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    const { runs } = hook.result.current;
    expect(runs["good.ts"]).toMatchObject({ proposed: true, error: null });
    expect(runs["missing.ts"].error).toBe("The agent didn't return this file.");
    expect(runs["stale.ts"].error).toMatch(/changed on disk/);
    expect(applyToEditor).toHaveBeenCalledTimes(1);
  });

  it("stopping one file keeps the session for the others", async () => {
    const d = deferred();
    const { hook, acpCancel, applyToEditor } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts", "c.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));

    act(() => hook.result.current.clear("b.ts"));
    expect(acpCancel).not.toHaveBeenCalled();

    d.releases[0](answerAll(d.prompts[0]));
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    expect(applyToEditor.mock.calls.map((c) => c[0])).toEqual(["a.ts", "c.ts"]);
    expect(hook.result.current.runs["b.ts"]).toBeUndefined();
  });

  it("ends the session once every file of it is stopped", async () => {
    const d = deferred();
    const { hook, acpCancel } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts", "c.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    const runId = hook.result.current.runs["a.ts"].runId;

    act(() => hook.result.current.clear("a.ts"));
    act(() => hook.result.current.clear("b.ts"));
    expect(acpCancel).not.toHaveBeenCalled();
    act(() => hook.result.current.clear("c.ts"));
    expect(acpCancel).toHaveBeenCalledTimes(1);
    expect(acpCancel).toHaveBeenCalledWith(runId);
  });

  it("Stop on one file of a sweep ends the whole session", async () => {
    const d = deferred();
    const { hook, acpCancel, applyToEditor } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    const runId = hook.result.current.runs["a.ts"].runId;

    act(() => hook.result.current.stop("b.ts"));
    expect(acpCancel).toHaveBeenCalledWith(runId);
    expect(hook.result.current.runs).toEqual({});
    expect(hook.result.current.busy).toBe(false);

    d.releases[0](answerAll(d.prompts[0]));
    await new Promise((r) => setTimeout(r, 0));
    expect(applyToEditor).not.toHaveBeenCalled();
  });

  it("Stop keeps a sibling's pre-prompt error and still ends the session", async () => {
    const d = deferred();
    const nested = "<<<<<<< HEAD\n<<<<<<< literal\n=======\nb\n>>>>>>> x\n";
    const { hook, acpCancel } = setup({ answer: d.answer, content: { "bad.ts": nested } });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "bad.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    // Refused before the prompt, so it never reaches the agent.
    expect(d.prompts[0]).not.toContain("bad.ts");
    expect(hook.result.current.runs["bad.ts"].error).toMatch(/ambiguous/);

    act(() => hook.result.current.stop("a.ts"));
    expect(acpCancel).toHaveBeenCalledTimes(1);
    expect(hook.result.current.runs["a.ts"]).toBeUndefined();
    expect(hook.result.current.runs["bad.ts"].error).toMatch(/ambiguous/);
  });

  it("a restarted file does not inherit the previous turn's answer", async () => {
    const d = deferred();
    const { hook, applyToEditor } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(2));

    d.releases[0]("=== FILE: a.ts ===\nold\n=== END FILE ===");
    await Promise.resolve();
    expect(applyToEditor).not.toHaveBeenCalled();

    d.releases[1]("=== FILE: a.ts ===\nnew\n=== END FILE ===");
    await waitFor(() => expect(hook.result.current.runs["a.ts"]?.proposed).toBe(true));
    expect(applyToEditor).toHaveBeenCalledTimes(1);
    expect(applyToEditor).toHaveBeenCalledWith("a.ts", "new\n", expect.any(String));
  });

  it("does not cancel a finished session when its proposals are discarded", async () => {
    const { hook, acpCancel } = setup();

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    act(() => hook.result.current.clear("a.ts"));
    act(() => hook.result.current.clear("b.ts"));
    expect(acpCancel).not.toHaveBeenCalled();
  });

  it("never sends a file that holds a sentinel line, and still resolves the rest", async () => {
    const { hook, acpPrompt } = setup({ content: { "odd.txt": "=== END FILE ===\n" + CONFLICT } });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["odd.txt", "a.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    expect(acpPrompt.mock.calls[0][4]).not.toContain("odd.txt");
    expect(hook.result.current.runs["odd.txt"]?.error).toMatch(/resolve it by hand/);
    expect(hook.result.current.runs["a.ts"]?.proposed).toBe(true);
  });

  it("restarting every file of a running job ends its old session", async () => {
    const d = deferred();
    const { hook, acpCancel } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(d.releases.length).toBe(1));
    const oldRun = hook.result.current.runs["a.ts"].runId;

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    // b.ts still waits on the old session.
    expect(acpCancel).not.toHaveBeenCalled();
    act(() => {
      hook.result.current.start(acpAgent("cursor acp"), ["b.ts"], () => "");
    });
    expect(acpCancel).toHaveBeenCalledWith(oldRun);
  });

  it("a failed turn errors every file of the job and frees the sweep", async () => {
    const { hook } = setup({ answer: async () => Promise.reject(new Error("adapter crashed")) });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    for (const path of ["a.ts", "b.ts"]) {
      expect(hook.result.current.runs[path]).toMatchObject({
        runId: null,
        startedAt: null,
        error: expect.stringContaining("adapter crashed"),
      });
    }
  });

  it("refuses an oversized sweep before any prompt", async () => {
    const big = "x".repeat(MAX_SWEEP_BYTES / 2 + 1);
    const { hook, acpPrompt } = setup({ content: { "a.ts": big, "b.ts": big } });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    expect(acpPrompt).not.toHaveBeenCalled();
    expect(hook.result.current.runs["a.ts"].error).toMatch(/Too large for one pass/);
  });

  it("starts a new job after a repo switch", async () => {
    const d = deferred();
    const { hook, acpPrompt, acpCancel } = setup({ answer: d.answer });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));

    act(() => hook.rerender({ repoPath: "/other" }));
    expect(acpCancel).toHaveBeenCalledTimes(1);
    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["c.ts"], () => "");
    });
    await waitFor(() => expect(acpPrompt.mock.calls.some((c) => c[1] === "/other")).toBe(true));
  });

  it("clears the previous landing when a new turn actually starts", async () => {
    const { hook, onReset } = setup();

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    expect(onReset).toHaveBeenCalledWith("a.ts");
  });
});
