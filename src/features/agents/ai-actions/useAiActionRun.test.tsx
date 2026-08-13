import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { acpAgent } from "@/test/agents";
import { useRepo } from "@/store/repo";
import { AiActionPhase, useAiActionRun } from "./useAiActionRun";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const setup = (opts: { answer?: () => Promise<string> } = {}) => {
  const acpPrompt = vi.fn(async () => (opts.answer ? opts.answer() : "done"));
  const acpCancel = vi.fn(async () => true);
  useRepo.setState({ acpPrompt, acpCancel } as never);
  return { hook: renderHook(() => useAiActionRun()), acpPrompt, acpCancel };
};

describe("useAiActionRun", () => {
  it("lands the answer and leaves the turn idle", async () => {
    const { hook, acpPrompt } = setup();
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc");
    });
    await waitFor(() => expect(hook.result.current.phase).toBe(AiActionPhase.Done));
    expect(hook.result.current.out).toBe("done");
    expect(hook.result.current.streaming).toBe(false);
    expect(acpPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not land an answer after Stop", async () => {
    let release: (value: string) => void = () => {};
    const { hook } = setup({
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    act(() => {
      hook.result.current.run(acpAgent("Claude Code"), "/repo", "read abc");
    });
    await waitFor(() => expect(hook.result.current.streaming).toBe(true));
    act(() => hook.result.current.stop());
    release("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(hook.result.current.out).toBe("");
    expect(hook.result.current.phase).toBe(AiActionPhase.Idle);
  });
});
