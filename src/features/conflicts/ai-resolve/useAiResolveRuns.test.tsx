import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConflictFileContent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { acpAgent } from "@/test/agents";
import { useAiResolveRuns } from "./useAiResolveRuns";

const conflicted = (body: string): ConflictFileContent =>
  ({ content: body, binary: false }) as ConflictFileContent;

const setup = (opts: {
  answer?: (prompt: string) => Promise<string>;
  content?: Record<string, string>;
  applyToEditor?: (path: string, proposal: string, source: string) => void;
  readContent?: (path: string) => Promise<ConflictFileContent | null>;
  onReset?: (path: string) => void;
  repoPath?: string | null;
} = {}) => {
  const acpPrompt = vi.fn(async (_c, _p, _m, _cfg, prompt: string) =>
    opts.answer ? opts.answer(prompt) : "```\nresolved\n```",
  );
  const acpCancel = vi.fn(async () => true);
  useRepo.setState({ acpPrompt, acpCancel } as never);
  const bodies = opts.content ?? {};
  const readContent = vi.fn(
    opts.readContent ??
      (async (path: string) =>
        path in bodies
          ? conflicted(bodies[path])
          : conflicted("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n")),
  );
  const applyToEditor = vi.fn(opts.applyToEditor ?? (() => {}));
  const onReset = vi.fn(opts.onReset ?? (() => {}));
  const hook = renderHook(
    ({ repoPath }) => useAiResolveRuns({ repoPath, readContent, applyToEditor, onReset }),
    { initialProps: { repoPath: opts.repoPath ?? "/repo" } },
  );
  return { hook, acpPrompt, acpCancel, applyToEditor, onReset, readContent };
};

describe("useAiResolveRuns", () => {
  it("drains every queued file — the queue must not be read from unflushed state", async () => {
    const { hook, acpPrompt, applyToEditor } = setup();

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts", "c.ts"], () => "");
    });

    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    expect(applyToEditor).toHaveBeenCalledTimes(3);
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      expect(hook.result.current.runs[path]).toMatchObject({ proposed: true, queued: false });
    }
  });

  it("runs two files at a time — bounded, not serial", async () => {
    let inFlight = 0;
    let peak = 0;
    const { hook } = setup({
      answer: async () => {
        peak = Math.max(peak, ++inFlight);
        await Promise.resolve();
        inFlight--;
        return "resolved";
      },
    });

    // Four files against a cap of two: the peak proves both that a second file
    // moves while the first is thinking, and that the other two wait.
    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts", "c.ts", "d.ts"], () => "");
    });

    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    expect(peak).toBe(2);
  });

  it("sends the user's note along with the file", async () => {
    const { hook, acpPrompt } = setup({ content: { "a.ts": "conflicted body" } });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "keep our logging");
    });

    await waitFor(() => expect(acpPrompt).toHaveBeenCalled());
    const prompt = acpPrompt.mock.calls[0][4] as string;
    expect(prompt).toContain("keep our logging");
    expect(prompt).toContain("conflicted body");
  });

  it("lands an answer in the editor and holds the run for Apply & stage", async () => {
    const { hook, applyToEditor } = setup();

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    expect(applyToEditor).toHaveBeenCalledWith(
      "a.ts",
      "resolved\n",
      "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n",
    );
    expect(hook.result.current.runs["a.ts"]).toMatchObject({
      proposed: true,
      runId: null,
      startedAt: null,
      error: null,
    });
    // A proposal waiting on the user is not work in flight — it must not block
    // the next "Resolve all".
    expect(hook.result.current.busy).toBe(false);
  });

  it("does not land an answer after Stop", async () => {
    let release: (value: string) => void = () => {};
    const { hook, applyToEditor } = setup({
      answer: () => new Promise((resolve) => {
        release = resolve;
      }),
    });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.runs["a.ts"]?.runId).toBeTruthy());

    act(() => hook.result.current.clear("a.ts"));
    release("```\nresolved\n```");
    await Promise.resolve();
    await Promise.resolve();

    expect(applyToEditor).not.toHaveBeenCalled();
    expect(hook.result.current.runs["a.ts"]).toBeUndefined();
  });

  it("a restarted run does not inherit the previous turn's answer", async () => {
    const releases: Array<(value: string) => void> = [];
    const { hook, applyToEditor } = setup({
      answer: () => new Promise((resolve) => {
        releases.push(resolve);
      }),
    });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(releases.length).toBe(1));

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(releases.length).toBe(2));

    releases[0]("```\nold\n```");
    await waitFor(() => expect(hook.result.current.runs["a.ts"]?.runId).toBeTruthy());
    expect(applyToEditor).not.toHaveBeenCalled();

    releases[1]("```\nnew\n```");
    await waitFor(() => expect(hook.result.current.runs["a.ts"]?.proposed).toBe(true));
    expect(applyToEditor).toHaveBeenCalledTimes(1);
    expect(applyToEditor).toHaveBeenCalledWith("a.ts", "new\n", expect.any(String));
  });

  it("a queued file keeps the agent it was started with, not the in-flight worker's", async () => {
    const hanging: Array<(value: string) => void> = [];
    const { hook, acpPrompt } = setup({
      answer: (prompt) =>
        prompt.includes("`b.ts`")
          ? Promise.resolve("```\nresolved\n```")
          : new Promise((resolve) => {
              hanging.push(resolve);
            }),
    });

    // Fill the cap so b.ts has to wait for a worker that was spawned by the
    // first start() — the one whose closure still has the first agent.
    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "c.ts"], () => "");
    });
    await waitFor(() => expect(hanging.length).toBe(2));

    act(() => {
      hook.result.current.start(acpAgent("cursor acp"), ["b.ts"], () => "keep theirs");
    });
    hanging[0]("```\nresolved\n```");
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(3));

    const bCall = acpPrompt.mock.calls.find((call) => (call[4] as string).includes("`b.ts`"));
    expect(bCall?.[0]).toBe("cursor acp-acp");
    expect(bCall?.[4]).toContain("keep theirs");
  });

  it("pumps a new sweep after a repo switch while stale workers are still unwinding", async () => {
    let release: (value: string) => void = () => {};
    const { hook, acpPrompt } = setup({
      answer: () => new Promise((resolve) => {
        release = resolve;
      }),
    });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts", "b.ts"], () => "");
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(2));

    act(() => hook.rerender({ repoPath: "/other" }));
    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["c.ts"], () => "");
    });
    // Stale workers still hold the cap until they unwind; the pump has to
    // spawn replacements once they do, or c.ts sits queued forever.
    release("```\nresolved\n```");
    await waitFor(() => expect(acpPrompt.mock.calls.some((c) => c[1] === "/other")).toBe(true));
  });

  it("refuses to land when the file changed while the agent ran", async () => {
    let n = 0;
    const { hook, applyToEditor } = setup({
      readContent: async () => {
        n += 1;
        return conflicted(n === 1 ? "<<<<<<< HEAD\nold\n=======\nx\n>>>>>>> y\n" : "<<<<<<< HEAD\nnew\n=======\nx\n>>>>>>> y\n");
      },
    });

    act(() => {
      hook.result.current.start(acpAgent("codex acp"), ["a.ts"], () => "");
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(false));

    expect(applyToEditor).not.toHaveBeenCalled();
    expect(hook.result.current.runs["a.ts"]?.error).toMatch(/changed on disk/);
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
