// Checkout feedback: a delayed progress card while git (and its hooks) run, and
// the hook output afterwards. The store test pins the wiring for remote checkout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoGraph, RepoSummary, WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { CHECKOUT_PROGRESS_DELAY_MS, withCheckoutFeedback } from "./checkoutFeedback";

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

  it("shows the hook output, keeping its last lines", async () => {
    const output = Array.from({ length: 20 }, (_, i) => `[php-switch] line ${i + 1}`).join("\n");
    await withCheckoutFeedback("develop", () => Promise.resolve(`${output}\n`));

    const [card] = toasts();
    expect(card).toMatchObject({ kind: "info", title: "Checked out develop" });
    expect(card.body?.split("\n")).toHaveLength(12);
    expect(card.body).toMatch(/^\[php-switch\] line 9\n/);
    expect(card.body).toMatch(/line 20$/);
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
