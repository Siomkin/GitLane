import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acpAgent } from "@/test/agents";
import { api } from "@/lib/api";
import { AiActionScopeKind, type AiActionScope } from "@/lib/aiActionScope";
import { INLINE_DIFF_MAX_BYTES } from "@/lib/inlineDiff";
import { useRepo } from "@/store/repo";
import { AiActionPhase, readScopePatch, useAiActionRun } from "./useAiActionRun";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const WORKING: AiActionScope = { kind: AiActionScopeKind.Working };

const setup = (opts: { answer?: () => Promise<string> } = {}) => {
  const acpPrompt = vi.fn(async (..._args: unknown[]) => (opts.answer ? opts.answer() : "done"));
  const acpCancel = vi.fn(async () => true);
  useRepo.setState({ acpPrompt, acpCancel } as never);
  return { hook: renderHook(() => useAiActionRun()), acpPrompt, acpCancel };
};

describe("useAiActionRun", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "diffPatch").mockResolvedValue(null);
  });

  it("lands the answer and leaves the turn idle", async () => {
    const { hook, acpPrompt } = setup();
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc", WORKING);
    });
    await waitFor(() => expect(hook.result.current.phase).toBe(AiActionPhase.Done));
    expect(hook.result.current.out).toBe("done");
    expect(hook.result.current.streaming).toBe(false);
    expect(acpPrompt).toHaveBeenCalledTimes(1);
  });

  it("inlines the scope's diff so the agent need not read it with tools", async () => {
    const diffPatch = vi.spyOn(api, "diffPatch").mockResolvedValue("diff --git a/x b/x\n+one\n");
    const { hook, acpPrompt } = setup();
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc", {
        kind: AiActionScopeKind.Commits,
        commits: ["abc"],
      });
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));
    expect(diffPatch).toHaveBeenCalledWith("/repo", null, "abc", INLINE_DIFF_MAX_BYTES);
    expect(acpPrompt.mock.calls[0]?.[4]).toBe(
      "read abc\n\nThe complete diff is below, so there is no need to run `git show` or `git diff`.\n\n<diff>\ndiff --git a/x b/x\n+one\n</diff>",
    );
  });

  it("sends the prompt as it is when the diff is over the cap or unreadable", async () => {
    vi.spyOn(api, "diffPatch").mockRejectedValue(new Error("unborn HEAD"));
    const { hook, acpPrompt } = setup();
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc", WORKING);
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));
    expect(acpPrompt.mock.calls[0]?.[4]).toBe("read abc");
  });

  it("launches no agent when stopped while the diff is read", async () => {
    let release: (patch: string) => void = () => {};
    vi.spyOn(api, "diffPatch").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { hook, acpPrompt } = setup();
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc", WORKING);
    });
    act(() => hook.result.current.stop());
    release("diff");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acpPrompt).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe(AiActionPhase.Idle);
  });

  it("does not land an answer after Stop", async () => {
    let release: (value: string) => void = () => {};
    const { hook, acpPrompt } = setup({
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc", WORKING);
    });
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.stop());
    release("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(hook.result.current.out).toBe("");
    expect(hook.result.current.phase).toBe(AiActionPhase.Idle);
  });
});

describe("readScopePatch", () => {
  const reader = () => vi.fn(async (..._args: unknown[]): Promise<string | null> => null);

  it("joins one read per commit plus the working tree under one shared cap", async () => {
    const diffPatch = reader()
      .mockResolvedValueOnce("aé\n")
      .mockResolvedValueOnce("b\n")
      .mockResolvedValueOnce("w\n");
    const scope: AiActionScope = { kind: AiActionScopeKind.CommitsWithWorking, commits: ["a", "b"] };
    await expect(readScopePatch(diffPatch, "/r", scope, 100)).resolves.toBe("aé\nb\nw\n");
    // Each read gets what the earlier ones left, in UTF-8 bytes.
    expect(diffPatch.mock.calls).toEqual([
      ["/r", null, "a", 100],
      ["/r", null, "b", 96],
      ["/r", "HEAD", null, 94],
    ]);
  });

  it("gives up when any read is over what is left", async () => {
    const diffPatch = reader().mockResolvedValueOnce("a\n").mockResolvedValueOnce(null);
    const scope: AiActionScope = { kind: AiActionScopeKind.Commits, commits: ["a", "b"] };
    await expect(readScopePatch(diffPatch, "/r", scope, 100)).resolves.toBeNull();
  });
});
