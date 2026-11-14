// Checkout feedback: a delayed progress card while git (and its hooks) run, and
// the hook output afterwards. The store test pins the wiring for remote checkout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoGraph, RepoSummary, WorkingChanges, WorktreeInfo } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useNotifications } from "@/store/notifications";
import { CheckoutBusyError } from "@/lib/checkoutPending";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import {
  CHECKOUT_OUTPUT_MS,
  CHECKOUT_PROGRESS_DELAY_MS,
  OUTPUT_HEAD_LINES,
  OUTPUT_TAIL_LINES,
  withCheckoutFeedback,
} from "./checkoutFeedback";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const toasts = () => useNotifications.getState().toasts;
const realOpenWorktree = useRepo.getState().openWorktree;
const resolveAfter = (ms: number, value: string) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  vi.useFakeTimers();
  useNotifications.getState().dismissAll();
  useNotifications.setState({ paused: false });
  invokeMock.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("withCheckoutFeedback", () => {
  it("shows a progress card for a slow checkout and drops it when git returns", async () => {
    const done = withCheckoutFeedback("develop", () => resolveAfter(1000, ""));

    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "progress", title: "Checking out develop…" }),
    ]);

    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(toasts()).toEqual([]);
  });

  it("shows no card for a checkout that finishes within the delay", async () => {
    const done = withCheckoutFeedback("develop", () => resolveAfter(100, ""));
    await vi.advanceTimersByTimeAsync(100);
    await done;
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([]);
  });

  it("shows the whole hook output for long enough to read", async () => {
    const output = Array.from({ length: 20 }, (_, i) => `[php-switch] line ${i + 1}`).join("\n");
    await withCheckoutFeedback("develop", () => Promise.resolve(`${output}\n`));

    const [card] = toasts();
    expect(card).toMatchObject({
      kind: "info",
      title: "Checked out develop",
      body: output,
      duration: CHECKOUT_OUTPUT_MS,
    });
  });

  it("says Updating/Updated for a branch advanced in another worktree", async () => {
    const done = withCheckoutFeedback("develop", () => resolveAfter(1000, "[hook] ok"), {
      mode: "update",
    });
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()[0]).toMatchObject({ kind: "progress", title: "Updating develop…" });
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(toasts()).toEqual([expect.objectContaining({ kind: "info", title: "Updated develop" })]);
  });

  it("keeps the head and tail of very long output", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    await withCheckoutFeedback("develop", () => Promise.resolve(lines.join("\n")));

    const body = toasts()[0].body?.split("\n") ?? [];
    expect(body).toHaveLength(OUTPUT_HEAD_LINES + 1 + OUTPUT_TAIL_LINES);
    expect(body[0]).toBe("line 1");
    expect(body[OUTPUT_HEAD_LINES]).toBe(
      `… ${200 - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES} lines omitted …`,
    );
    expect(body[body.length - 1]).toBe("line 200");
  });

  it("names the repository once it is no longer the open one", async () => {
    let current = true;
    const done = withCheckoutFeedback("develop", () => resolveAfter(1000, "[hook] ok"), {
      repoPath: "/work/GoldX",
      isCurrent: () => current,
    });
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()[0].title).toBe("Checking out develop…");
    current = false;
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(toasts()).toEqual([
      expect.objectContaining({ title: "Checked out develop in GoldX" }),
    ]);
  });

  it("posts nothing when git printed nothing", async () => {
    await withCheckoutFeedback("develop", () => Promise.resolve("  \n"));
    expect(toasts()).toEqual([]);
  });

  it("drops the card and rethrows when the checkout fails", async () => {
    const done = withCheckoutFeedback(
      "develop",
      () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("dirty")), 1000)),
    );
    const settled = expect(done).rejects.toThrow("dirty");
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(toasts()).toEqual([]);
  });
});

describe("checkoutRemoteBranch", () => {
  const summary: RepoSummary = {
    path: "/repo",
    workdir: "/repo",
    headBranch: "main",
    headOid: "1111111",
    detached: false,
    unborn: false,
    isWorktree: false,
  };
  const graph: RepoGraph = { commits: [], edges: [], laneCount: 1, wipLane: null, head: null, truncated: false };
  const changes: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };

  const refreshOr = (overrides: Record<string, unknown>) => (cmd: string) => {
    if (cmd in overrides) return Promise.resolve(overrides[cmd]);
    switch (cmd) {
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(graph);
      case "working_changes":
        return Promise.resolve(changes);
      default:
        return emptyIpcInvoke(cmd);
    }
  };

  it("shows hook output for the checkout after creating a branch", async () => {
    invokeMock.mockImplementation(refreshOr({ checkout: "[php-switch] vendor -> vendor-8.4" }));
    useRepo.setState({ summary, branches: [], worktrees: [] });

    await useRepo.getState().createBranchAt("topic");

    expect(invokeMock).toHaveBeenCalledWith("checkout", {
      path: "/repo",
      target: "topic",
      detached: false,
    });
    expect(toasts()).toEqual([
      expect.objectContaining({
        kind: "info",
        title: "Checked out topic",
        body: "[php-switch] vendor -> vendor-8.4",
      }),
    ]);
  });

  it("routes through the feedback helper and shows the hook output", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "checkout_remote_branch":
          return Promise.resolve("[php-switch] ready: Laravel 13 on PHP 8.4");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(graph);
        case "working_changes":
          return Promise.resolve(changes);
        default:
          return emptyIpcInvoke(cmd);
      }
    });
    useRepo.setState({ summary, branches: [], worktrees: [] });

    await useRepo.getState().checkoutRemoteBranch("origin", "develop");

    expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", {
      path: "/repo",
      remote: "origin",
      branch: "develop",
    });
    expect(toasts()).toEqual([
      expect.objectContaining({
        kind: "info",
        title: "Checked out develop",
        body: "[php-switch] ready: Laravel 13 on PHP 8.4",
      }),
    ]);
  });
});

describe("pending checkout", () => {
  const summary: RepoSummary = {
    path: "/repo",
    workdir: "/repo",
    headBranch: "main",
    headOid: "1111111",
    detached: false,
    unborn: false,
    isWorktree: false,
  };
  const graph: RepoGraph = { commits: [], edges: [], laneCount: 1, wipLane: null, head: null, truncated: false };
  const changes: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };
  const worktree = (path: string, branch: string, isMain: boolean): WorktreeInfo => ({
    name: path,
    path,
    branch,
    isMain,
    bare: false,
    prunable: false,
    locked: false,
  });

  /** Routes the IPC calls a checkout + refresh makes; `delays` holds a command's
   *  result back, `fail` rejects it. */
  const ipc =
    (opts: { delays?: Record<string, number>; fail?: string; worktrees?: WorktreeInfo[] } = {}) =>
    (cmd: string) => {
      const value = (() => {
        switch (cmd) {
          case "open_repo":
            return summary;
          case "commit_graph":
            return graph;
          case "working_changes":
            return changes;
          case "list_worktrees":
            return opts.worktrees ?? [];
          case "checkout":
          case "checkout_remote_branch":
            return "";
          default:
            return undefined;
        }
      })();
      if (value === undefined) return emptyIpcInvoke(cmd);
      if (cmd === opts.fail) return Promise.reject(new Error("dirty"));
      const ms = opts.delays?.[cmd];
      return ms ? new Promise((resolve) => setTimeout(() => resolve(value), ms)) : Promise.resolve(value);
    };

  const pending = () => useRepo.getState().checkoutPending;
  const checkoutCalls = () =>
    invokeMock.mock.calls.filter(([cmd]) => cmd === "checkout" || cmd === "checkout_remote_branch");

  beforeEach(() => {
    useRepo.setState({
      summary,
      branches: [],
      worktrees: [],
      checkoutPending: {},
      openWorktree: realOpenWorktree,
    });
  });

  it("marks the acted-on remote ref pending at once and clears it after the refresh", async () => {
    invokeMock.mockImplementation(ipc());
    const done = useRepo.getState().checkoutRemoteBranch("origin", "develop");
    expect(pending()).toEqual({ "/repo": { ref: "origin/develop", kind: "remote" } });
    await vi.runAllTimersAsync();
    await done;
    expect(pending()).toEqual({});
  });

  it("keeps the progress card up through a slow refresh after a fast git checkout", async () => {
    invokeMock.mockImplementation(ipc({ delays: { commit_graph: 3000 } }));
    const done = useRepo.getState().checkoutBranch("develop");

    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(invokeMock).toHaveBeenCalledWith("checkout", { path: "/repo", target: "develop", detached: false });
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "progress", title: "Checking out develop…" }),
    ]);

    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(toasts()).toEqual([]);
    expect(pending()).toEqual({});
  });

  it("shows no card when the checkout and its refresh are fast", async () => {
    invokeMock.mockImplementation(ipc());
    await useRepo.getState().checkoutBranch("develop");
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([]);
  });

  it("clears the pending ref when git refuses the checkout", async () => {
    invokeMock.mockImplementation(ipc({ fail: "checkout" }));
    await expect(useRepo.getState().checkoutBranch("feature/x")).rejects.toThrow("dirty");
    expect(pending()).toEqual({});
  });

  it("clears the pending ref when the checkout hands off to the worktree dialog", async () => {
    const worktrees = [worktree("/repo", "main", true), worktree("/wt", "feature/x", false)];
    invokeMock.mockImplementation(ipc({ worktrees }));
    const requestConfirm = vi.spyOn(useUi.getState(), "requestConfirm").mockImplementation(() => {});
    useRepo.setState({ worktrees });

    await expect(useRepo.getState().checkoutBranch("feature/x")).resolves.toBe("");
    expect(requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Branch is in another worktree" }),
    );
    expect(pending()).toEqual({});
    requestConfirm.mockRestore();
  });

  it("refuses a second checkout in the same repository while one runs", async () => {
    invokeMock.mockImplementation(ipc({ delays: { checkout_remote_branch: 1000 } }));
    const first = useRepo.getState().checkoutRemoteBranch("origin", "develop");

    await expect(useRepo.getState().checkoutRemoteBranch("origin", "develop")).rejects.toBeInstanceOf(
      CheckoutBusyError,
    );
    await expect(useRepo.getState().checkoutBranch("main")).rejects.toBeInstanceOf(CheckoutBusyError);
    expect(pending()).toEqual({ "/repo": { ref: "origin/develop", kind: "remote" } });

    await vi.runAllTimersAsync();
    await first;
    expect(checkoutCalls()).toHaveLength(1);
  });

  it("checks out a detached commit as a pending checkout keyed by its id", async () => {
    invokeMock.mockImplementation(ipc({ delays: { checkout: 1000 } }));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const done = useRepo.getState().checkoutDetached(sha);

    expect(pending()).toEqual({ "/repo": { ref: sha, kind: "commit" } });
    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "progress", title: "Checking out 0123456…" }),
    ]);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe("Checked out 0123456 (detached)");
    expect(invokeMock).toHaveBeenCalledWith("checkout", { path: "/repo", target: sha, detached: true });
    expect(pending()).toEqual({});
  });

  it("does not block a checkout while another repository has one pending", async () => {
    invokeMock.mockImplementation(ipc());
    useRepo.setState({ checkoutPending: { "/other": { ref: "main", kind: "local" } } });
    await useRepo.getState().checkoutBranch("develop");
    expect(checkoutCalls()).toHaveLength(1);
    // The other repository's run still owns its entry.
    expect(pending()).toEqual({ "/other": { ref: "main", kind: "local" } });
  });

  it("names the running checkout when it refuses another one", async () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "origin/develop", kind: "remote" } } });
    await expect(useRepo.getState().checkoutBranch("main")).rejects.toThrow(
      "A checkout of origin/develop is already running",
    );
  });

  it("refuses to create and check out a branch while a checkout runs", async () => {
    invokeMock.mockImplementation(ipc());
    useRepo.setState({ checkoutPending: { "/repo": { ref: "origin/develop", kind: "remote" } } });
    await expect(useRepo.getState().createBranchAt("topic")).rejects.toBeInstanceOf(CheckoutBusyError);
    expect(invokeMock).not.toHaveBeenCalledWith("create_branch", expect.anything());
    expect(checkoutCalls()).toEqual([]);
  });

  it("refuses merge, rebase and reset while a checkout runs", async () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "develop", kind: "local" } } });
    const preview = { targetOid: "abc", expectedSourceOid: "def" } as Parameters<
      ReturnType<typeof useRepo.getState>["resetBranchTo"]
    >[3];
    await expect(useRepo.getState().mergeInto("feature", "main")).rejects.toBeInstanceOf(CheckoutBusyError);
    await expect(useRepo.getState().rebaseOnto("feature", "main")).rejects.toBeInstanceOf(CheckoutBusyError);
    await expect(useRepo.getState().resetBranchTo("feature", "main", "mixed", preview)).rejects.toBeInstanceOf(
      CheckoutBusyError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("holds the other worktree's slot while updating a branch checked out there", async () => {
    const worktrees = [worktree("/repo", "main", true), worktree("/wt", "develop", false)];
    invokeMock.mockImplementation(ipc({ worktrees, delays: { checkout_remote_branch: 1000 } }));
    const openWorktree = vi.fn().mockResolvedValue("deferred");
    useRepo.setState({ worktrees, openWorktree });

    const done = useRepo.getState().checkoutRemoteBranch("origin", "develop");
    await vi.advanceTimersByTimeAsync(10);
    const entry = { ref: "origin/develop", kind: "remote" };
    expect(pending()).toEqual({ "/repo": entry, "/wt": entry });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe("Updated develop");
    expect(pending()).toEqual({});
  });

  it("ends the progress card when the hook output card appears", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "checkout"
        ? new Promise((resolve) => setTimeout(() => resolve("[hook] ready"), 1000))
        : ipc({ delays: { commit_graph: 3000 } })(cmd),
    );
    const done = useRepo.getState().checkoutBranch("develop");

    await vi.advanceTimersByTimeAsync(CHECKOUT_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([expect.objectContaining({ kind: "progress" })]);
    await vi.advanceTimersByTimeAsync(1000);
    // Git returned with output; the refresh is still running.
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "info", title: "Checked out develop", body: "[hook] ready" }),
    ]);
    await vi.runAllTimersAsync();
    await done;
  });
});
