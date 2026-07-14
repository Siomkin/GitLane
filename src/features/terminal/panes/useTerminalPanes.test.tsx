// Lifecycle interleaving for the terminal panes hook (GL-177), plus injection
// ownership (GL-176 review). The hook is rendered with a real host element and
// fake xterm/PTY adapters, so the tests drive the exact interleavings React
// cannot typecheck: repo/tab switches that must not remount hidden panes, exit
// routing to the owning pane, listener cleanup on unmount, a tab closed while
// its spawn is still in flight, and a delayed agent injection cancelled by
// unmount.
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Capture pty-data/pty-exit handlers so tests can fire backend events, and
// track unlisten so cleanup is observable.
const ptyEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    ptyEvents.handlers.set(name, cb);
    return Promise.resolve(() => {
      ptyEvents.handlers.delete(name);
    });
  },
}));

// Headless xterm: records writes/pastes/disposal per instance, in creation
// order (instance N = the Nth pane created across all repos).
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    options: Record<string, unknown>;
    modes = { bracketedPasteMode: false };
    cols = 80;
    rows = 24;
    lines: string[] = [];
    pasted: string[] = [];
    disposed = false;
    cleared = 0;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
    loadAddon() {}
    open() {}
    write() {}
    writeln(text: string) {
      this.lines.push(text);
    }
    paste(text: string) {
      this.pasted.push(text);
    }
    clear() {
      this.cleared += 1;
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
    onData() {
      return { dispose: () => {} };
    }
  }
  const instances: FakeTerminal[] = [];
  return { FakeTerminal, instances };
});
vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

// jsdom has no ResizeObserver; the drawer-resize effect only needs it to exist.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
// Run refit's deferred frame synchronously so the reconcile → refit →
// pty_resize wire is observable without racing jsdom's rAF timer.
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});

import { useTerminalPanes, type TerminalPanes } from "./useTerminalPanes";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useTerminals } from "@/store/terminals";
import { useTerminalAgents } from "@/store/terminalAgents";

const summaryFor = (path: string) => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "x",
  detached: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render the hook with its host element attached (renderHook alone leaves
 * `hostRef` empty, so reconciliation would bail before creating any pane). */
function renderPanes() {
  const result: { current: TerminalPanes } = { current: null as unknown as TerminalPanes };
  function Harness() {
    result.current = useTerminalPanes();
    return <div data-testid="host" ref={result.current.hostRef} />;
  }
  const utils = render(<Harness />);
  const host = utils.getByTestId("host");
  return { result, host, unmount: utils.unmount };
}

const spawnCalls = () => invokeMock.mock.calls.filter((c) => c[0] === "pty_spawn");
const killCalls = () => invokeMock.mock.calls.filter((c) => c[0] === "pty_kill");
const flush = () => act(async () => {});

let nextSession: number;

beforeEach(() => {
  nextSession = 1;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "pty_spawn" ? Promise.resolve({ sessionId: nextSession++ }) : Promise.resolve(null),
  );
  xterm.instances.length = 0;
  ptyEvents.handlers.clear();
  useRepo.setState({ summary: summaryFor("/current") });
  useTerminals.setState({ byRepo: {} });
  useTerminalAgents.setState({ loadAgents: vi.fn() });
  useUi.setState({
    terminalView: "hidden",
    terminalViewByRepo: {},
    terminalExpanded: false,
    terminalInject: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pane lifecycle across repo/tab switches (GL-177)", () => {
  it("hides a terminal in a new repo and restores the original repo's live pane", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.getState().expandTerminal();
    const { host } = renderPanes();
    await flush();

    expect(spawnCalls()).toHaveLength(1);
    expect(spawnCalls()[0][1]).toMatchObject({ path: "/repoA" });
    const paneA = host.children[0] as HTMLElement;
    expect(paneA.style.display).toBe("block");

    // A repository with no terminal state stays hidden and must not spawn a
    // shell merely because repo A's terminal was open.
    await act(async () => {
      useRepo.setState({ summary: summaryFor("/repoB") });
      useUi.getState().onRepoSwitched();
    });
    await flush();

    expect(useUi.getState().terminalView).toBe("hidden");
    expect(spawnCalls()).toHaveLength(1);
    expect(xterm.instances[0].disposed).toBe(false);
    expect(paneA.style.display).toBe("none");

    // Returning to repo A restores its open state and the exact pane without a
    // respawn, preserving the terminal process and scrollback.
    await act(async () => {
      useRepo.setState({ summary: summaryFor("/repoA") });
      useUi.getState().onRepoSwitched();
    });
    await flush();

    expect(useUi.getState().terminalView).toBe("open");
    expect(spawnCalls()).toHaveLength(1);
    expect(xterm.instances).toHaveLength(1);
    expect(xterm.instances[0].disposed).toBe(false);
    expect(paneA.style.display).toBe("block");
  });

  it("routes pty-exit to the owning pane only and flips alive for the active pane", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    const { result } = renderPanes();
    await flush();
    await act(async () => {
      useRepo.setState({ summary: summaryFor("/repoB") });
    });
    await flush();
    expect(result.current.alive).toBe(true); // active pane = repo B, session 2

    // Repo A's shell (session 1) exits in the background.
    await act(async () => {
      ptyEvents.handlers.get("pty-exit")?.({ payload: { sessionId: 1 } });
    });

    expect(xterm.instances[0].lines.some((l) => l.includes("[shell exited]"))).toBe(true);
    expect(xterm.instances[1].lines.some((l) => l.includes("[shell exited]"))).toBe(false);
    expect(result.current.alive).toBe(true); // the ACTIVE pane is unaffected

    // Now the active pane's shell exits — the status flag must flip.
    await act(async () => {
      ptyEvents.handlers.get("pty-exit")?.({ payload: { sessionId: 2 } });
    });
    expect(result.current.alive).toBe(false);
  });

  it("routes pty-data to the owning pane only", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    renderPanes();
    await flush();
    await act(async () => {
      useRepo.setState({ summary: summaryFor("/repoB") });
    });
    await flush();

    const writeA = vi.spyOn(xterm.instances[0], "write");
    const writeB = vi.spyOn(xterm.instances[1], "write");
    await act(async () => {
      ptyEvents.handlers.get("pty-data")?.({ payload: { sessionId: 2, data: [104, 105] } });
    });
    expect(writeB).toHaveBeenCalledTimes(1);
    expect(writeA).not.toHaveBeenCalled();
  });

  it("cleans up PTY event listeners and disposes every pane on unmount", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    const { unmount } = renderPanes();
    await flush();
    expect(ptyEvents.handlers.size).toBe(2);

    unmount();

    // Unlisten resolves through a microtask (`unlisten.then(f => f())`).
    await waitFor(() => expect(ptyEvents.handlers.size).toBe(0));
    expect(xterm.instances[0].disposed).toBe(true);
    expect(killCalls()).toHaveLength(1);
    expect(killCalls()[0][1]).toMatchObject({ sessionId: 1 });
  });

  it("kills a spawn that resolves after its tab was closed; the replacement keeps its own session", async () => {
    // Distinct deferred per spawn so the orphan and the replacement model
    // separate backend sessions.
    const spawns = [deferred<{ sessionId: number }>(), deferred<{ sessionId: number }>()];
    const [orphanSpawn, replacementSpawn] = spawns;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pty_spawn" ? spawns.shift()!.promise : Promise.resolve(null),
    );
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    const { result } = renderPanes();
    await flush();
    expect(spawnCalls()).toHaveLength(1);

    // The user closes the tab while the shell is still starting, then opens a
    // fresh one — the closed tab's pane is disposed immediately, and the new
    // pane spawns its own session (pending on its own deferred).
    const tabId = useTerminals.getState().byRepo["/repoA"].activeId!;
    await act(async () => {
      useTerminals.getState().closeTab("/repoA", tabId);
    });
    expect(xterm.instances[0].disposed).toBe(true);
    await act(async () => {
      useTerminals.getState().openTab("/repoA");
    });
    expect(spawnCalls()).toHaveLength(2);

    // The original spawn finally resolves: its session belongs to a gone
    // pane and must be killed; the replacement then adopts its own session,
    // stays alive, and receives routed output.
    await act(async () => {
      orphanSpawn.resolve({ sessionId: 7 });
    });
    expect(killCalls().map((c) => c[1])).toContainEqual({ sessionId: 7 });

    await act(async () => {
      replacementSpawn.resolve({ sessionId: 8 });
    });
    expect(killCalls().map((c) => c[1])).not.toContainEqual({ sessionId: 8 });
    expect(result.current.alive).toBe(true);
    const write = vi.spyOn(xterm.instances[1], "write");
    await act(async () => {
      ptyEvents.handlers.get("pty-data")?.({ payload: { sessionId: 8, data: [104] } });
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("switches tabs within a repo by toggling visibility — no dispose, kill, or respawn", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    const { host } = renderPanes();
    await flush();

    await act(async () => {
      useTerminals.getState().openTab("/repoA");
    });
    await flush();
    expect(spawnCalls()).toHaveLength(2);
    const [elA, elB] = [...host.children] as HTMLElement[];
    expect(elA.style.display).toBe("none");
    expect(elB.style.display).toBe("block");

    const firstTabId = useTerminals.getState().byRepo["/repoA"].tabs[0].id;
    await act(async () => {
      useTerminals.getState().setActiveTab("/repoA", firstTabId);
    });

    expect(spawnCalls()).toHaveLength(2);
    expect(killCalls()).toHaveLength(0);
    expect(xterm.instances[0].disposed).toBe(false);
    expect(xterm.instances[1].disposed).toBe(false);
    expect(elA.style.display).toBe("block");
    expect(elB.style.display).toBe("none");
  });

  it("disposes a background repo's panes when its terminals are dropped", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    renderPanes();
    await flush();
    await act(async () => {
      useRepo.setState({ summary: summaryFor("/repoB") });
    });
    await flush();

    // Closing repo A's app tab drops its terminal tabs; reconcile must kill
    // the background shell instead of leaving it running with no UI.
    await act(async () => {
      useTerminals.getState().closeRepoTerminals("/repoA");
    });

    expect(xterm.instances[0].disposed).toBe(true);
    expect(killCalls().map((c) => c[1])).toContainEqual({ sessionId: 1 });
    expect(xterm.instances[1].disposed).toBe(false);
  });

  it("re-fits and resizes the active pane's PTY when the drawer expands", async () => {
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    renderPanes();
    await flush(); // session 1 adopted

    const resizes = () => invokeMock.mock.calls.filter((c) => c[0] === "pty_resize");
    const before = resizes().length;
    await act(async () => {
      useUi.setState({ terminalExpanded: true });
    });

    const after = resizes();
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1][1]).toEqual({ sessionId: 1, cols: 80, rows: 24 });
  });
});

describe("delayed injection delivery and cancellation (GL-177)", () => {
  it("launches an agent draft in a new pane without typing into the running pane", async () => {
    vi.useFakeTimers();
    useRepo.setState({
      summary: summaryFor("/repoA"),
      takeAgentCommitDraft: vi.fn().mockResolvedValue(null),
    });
    useUi.setState({ terminalView: "open" });
    const { unmount } = renderPanes();
    await flush();
    const existingId = useTerminals.getState().byRepo["/repoA"].activeId;

    await act(async () => {
      useUi.getState().startAgentCommitDraft(
        { token: "draft-token", agentName: "codex", repoPath: "/repoA", startedAt: 1 },
        "the prompt",
        "codex --model gpt-5.6-sol",
      );
    });
    await flush();
    await flush();

    expect(spawnCalls()).toHaveLength(2);
    expect(useTerminals.getState().byRepo["/repoA"].activeId).not.toBe(existingId);
    const writes = invokeMock.mock.calls.filter((call) => call[0] === "pty_write");
    expect(writes).toContainEqual([
      "pty_write",
      expect.objectContaining({ sessionId: 2 }),
    ]);
    expect(writes.some((call) => call[1]?.sessionId === 1)).toBe(false);

    useUi.getState().cancelAgentCommitDraft();
    unmount();
  });

  it("delivers an agent-launch injection once the agent's prompt is ready", async () => {
    vi.useFakeTimers();
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    renderPanes();
    await flush();

    await act(async () => {
      useUi.setState({
        terminalInject: { text: "the prompt", command: "claude", repoKey: "/repoA" },
      });
    });
    await flush(); // launch write resolved; the prompt-wait timer is armed
    expect(invokeMock).toHaveBeenCalledWith("pty_write", expect.objectContaining({ sessionId: 1 }));

    // The launched agent enables bracketed paste after the command write (its
    // prompt is now ready), rather than inheriting the shell's pre-launch mode.
    xterm.instances[0].modes.bracketedPasteMode = true;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(xterm.instances[0].pasted).toEqual(["the prompt"]);
    expect(useUi.getState().terminalInject).toBeNull();
  });

  it("does not mistake the shell's bracketed-paste mode for an agent-ready prompt", async () => {
    vi.useFakeTimers();
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    renderPanes();
    await flush();

    // zsh may already enable bracketed paste at its own prompt. The command
    // must launch first; that inherited mode cannot release the queued text.
    xterm.instances[0].modes.bracketedPasteMode = true;
    await act(async () => {
      useUi.setState({
        terminalInject: { text: "the prompt", command: "codex", repoKey: "/repoA" },
      });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(xterm.instances[0].pasted).toHaveLength(0);
    expect(useUi.getState().terminalInject).not.toBeNull();

    // Agent startup leaves the shell input mode, then enables bracketed paste
    // for its own prompt. Only that post-launch transition releases the text.
    xterm.instances[0].modes.bracketedPasteMode = false;
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(xterm.instances[0].pasted).toHaveLength(0);

    xterm.instances[0].modes.bracketedPasteMode = true;
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(xterm.instances[0].pasted).toEqual(["the prompt"]);
    expect(useUi.getState().terminalInject).toBeNull();
  });

  it("cancels a pending agent-launch injection on unmount — no late paste", async () => {
    vi.useFakeTimers();
    useRepo.setState({ summary: summaryFor("/repoA") });
    useUi.setState({ terminalView: "open" });
    const { result, unmount } = renderPanes();
    await flush();
    expect(result.current.alive).toBe(true);

    // Queue "open in terminal" text behind an agent launch: the launch write
    // succeeds, then the hook polls for the agent prompt before pasting.
    await act(async () => {
      useUi.setState({
        terminalInject: { text: "the prompt", command: "claude", repoKey: "/repoA" },
      });
    });
    await flush(); // launch write resolved; the prompt-wait timer is armed

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000); // past the poll interval AND the 4s fallback
    });

    // The cancelled wait must neither paste nor consume the injection.
    expect(xterm.instances[0].pasted).toHaveLength(0);
    expect(useUi.getState().terminalInject).not.toBeNull();
  });
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
    expect(useTerminals.getState().byRepo["/current"].tabs).toHaveLength(1);
  });
});
