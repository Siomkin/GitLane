// Checkout feedback: a delayed progress card while git (and its hooks) run, and
// the hook output afterwards. The store test pins the wiring for remote checkout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoGraph, RepoSummary, WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
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
