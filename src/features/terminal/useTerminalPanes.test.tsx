// Injection ownership (GL-176 review): a queued "send to terminal" belongs to
// the repo whose flow queued it. If another repo is active by the time it
// could deliver, it must be discarded — never pasted into that repo's shell.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { useTerminalPanes } from "./useTerminalPanes";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useTerminalAgents } from "@/store/terminalAgents";

const summaryFor = (path: string) => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "x",
  detached: false,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary: summaryFor("/current") });
  useTerminalAgents.setState({ loadAgents: vi.fn() });
  useUi.setState({ terminalView: "hidden", terminalInject: null });
});

describe("terminal injection ownership (GL-176 review)", () => {
  it("discards an injection queued for another repo instead of delivering it", () => {
    renderHook(() => useTerminalPanes());

    // A launch failed in /original (injection kept queued), then the user
    // switched repos — the stale injection must die, not follow the switch.
    act(() => {
      useUi.setState({
        terminalInject: { text: "secret prompt", command: "claude", repoKey: "/original" },
      });
    });

    expect(useUi.getState().terminalInject).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });

  it("keeps an injection owned by the active repo queued while no pane is alive", () => {
    renderHook(() => useTerminalPanes());

    act(() => {
      useUi.setState({
        terminalInject: { text: "prompt", command: "claude", repoKey: "/current" },
      });
    });

    // Owned by the active repo but nothing alive yet → stays queued for the
    // pane, exactly as before.
    expect(useUi.getState().terminalInject).not.toBeNull();
  });

  it("sendToTerminal stamps the injection with the active repo", () => {
    useUi.getState().sendToTerminal("the text", "claude");
    expect(useUi.getState().terminalInject).toMatchObject({
      text: "the text",
      command: "claude",
      repoKey: "/current",
    });
  });
});
