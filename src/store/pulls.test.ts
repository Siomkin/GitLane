// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the single IPC boundary inline (the canonical Vitest hoisted pattern) so
// the store's async loaders run headlessly and we can drive gh failures.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { usePulls } from "./pulls";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { summaryToPr } from "@/lib/prs";
import {
  ForgeKind,
  type GithubAccountRef,
  type PrCheck,
  type PullRequestSummary,
  type RepoForge,
  type RepoSummary,
} from "@/lib/api";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc",
  detached: false,
};

const OTHER_SUMMARY: RepoSummary = {
  ...SUMMARY,
  path: "/other",
  workdir: "/other",
  headOid: "def",
};

const account = (accountId: string): GithubAccountRef => ({
  provider: "gh",
  host: "github.com",
  accountId,
  login: `user-${accountId}`,
});

const forge = (over: Partial<RepoForge>): RepoForge => ({
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
  ...over,
});

const prSummary = (number: number, over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number,
  title: `PR ${number}`,
  state: "OPEN",
  headRef: `branch-${number}`,
  baseRef: "main",
  author: { login: "alex", name: "Alex" },
  createdAt: "2026-01-01T00:00:00Z",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  isDraft: false,
  url: `https://github.com/o/r/pull/${number}`,
  mergeable: "UNKNOWN",
  ...over,
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

beforeEach(() => {
  invokeMock.mockReset();
  usePulls.getState().reset();
  useRepo.setState({ summary: SUMMARY, forge: forge({}) });
  useAccounts.setState({ repoAccountId: null, repoAccountRef: null });
});

describe("pulls lazy-load error isolation", () => {
  it("scopes a diff failure to the PR without touching prError or the list", async () => {
    usePulls.setState({ pullRequests: [{ num: 7 } as never] });
    invokeMock.mockRejectedValueOnce("diff blew up");

    await usePulls.getState().loadPrDiff(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull(); // list error untouched → sidebar stays visible
    expect(s.pullRequests).toHaveLength(1); // list not cleared
    expect(s.prDiffError[7]).toContain("diff blew up");
    expect(s.prDiffs[7]).toBeUndefined();
  });

  it("scopes a threads failure the same way (auto-loaded, most visible)", async () => {
    invokeMock.mockRejectedValueOnce("threads blew up");

    await usePulls.getState().loadPrThreads(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull();
    expect(s.prThreadsError[7]).toContain("threads blew up");
  });

  it("clears the per-PR error and caches the result on a successful retry", async () => {
    invokeMock.mockRejectedValueOnce("checks blew up");
    await usePulls.getState().loadPrChecks(7);
    expect(usePulls.getState().prChecksError[7]).toBeDefined();

    invokeMock.mockResolvedValueOnce([{ name: "build", ok: true }]);
    await usePulls.getState().loadPrChecks(7, true);

    const s = usePulls.getState();
    expect(s.prChecksError[7]).toBeUndefined();
    expect(s.prChecks[7]).toEqual([{ name: "build", ok: true }]);
  });

  it("keeps one PR's error from leaking into another PR's tab", async () => {
    invokeMock.mockRejectedValueOnce("diff blew up");
    await usePulls.getState().loadPrDiff(7);

    invokeMock.mockResolvedValueOnce([]);
    await usePulls.getState().loadPrDiff(9);

    const s = usePulls.getState();
    expect(s.prDiffError[7]).toBeDefined();
    expect(s.prDiffError[9]).toBeUndefined();
    expect(s.prDiffs[9]).toEqual([]);
  });

  it("replies to a review thread and refreshes that PR's thread cache", async () => {
    invokeMock.mockResolvedValueOnce("reply ok");
    invokeMock.mockResolvedValueOnce([]);

    const out = await usePulls.getState().replyThread(7, "thread-1", "Fixed in this patch");

    expect(out).toBe("reply ok");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "reply_review_thread", {
      path: "/repo",
      threadId: "thread-1",
      body: "Fixed in this patch",
      account: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "pull_request_review_threads", {
      path: "/repo",
      number: 7,
      account: null,
    });
  });

  it("does not use the global PR pending flag for review-thread actions", async () => {
    let finishResolve!: (value: string) => void;
    invokeMock.mockReturnValueOnce(new Promise<string>((resolve) => {
      finishResolve = resolve;
    }));

    const pending = usePulls.getState().resolveThread(7, "thread-1", true);

    expect(usePulls.getState().prPendingActions).toEqual([]);
    finishResolve("ok");
    invokeMock.mockResolvedValueOnce([]);
    await pending;
    expect(usePulls.getState().prPendingActions).toEqual([]);
  });

  it("loads checks for a newly selected PR while another PR's checks are still pending", async () => {
    const first = deferred<PrCheck[]>();
    const second = deferred<PrCheck[]>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const loadFirst = usePulls.getState().loadPrChecks(7);
    const loadSecond = usePulls.getState().loadPrChecks(9);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(usePulls.getState().prChecksLoadingByNum).sort()).toEqual(["7", "9"]);

    second.resolve([{ name: "lint", state: "pass" }]);
    await loadSecond;

    expect(usePulls.getState().prChecks[9]).toEqual([{ name: "lint", state: "pass" }]);
    expect(usePulls.getState().prChecksLoading).toBe(true);
    expect(usePulls.getState().prChecksLoadingByNum[7]).toBeTruthy();

    first.resolve([{ name: "build", state: "pending" }]);
    await loadFirst;

    expect(usePulls.getState().prChecks[7]).toEqual([{ name: "build", state: "pending" }]);
    expect(usePulls.getState().prChecksLoading).toBe(false);
    expect(usePulls.getState().prChecksLoadingByNum).toEqual({});
  });

  it("ignores stale checks when the repo switches before the old request resolves", async () => {
    const oldChecks = deferred<PrCheck[]>();
    const newChecks = deferred<PrCheck[]>();
    invokeMock.mockReturnValueOnce(oldChecks.promise).mockReturnValueOnce(newChecks.promise);

    const oldLoad = usePulls.getState().loadPrChecks(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });
    const newLoad = usePulls.getState().loadPrChecks(7);

    oldChecks.resolve([{ name: "old repo", state: "fail" }]);
    await oldLoad;

    expect(usePulls.getState().prChecks[7]).toBeUndefined();
    expect(usePulls.getState().prChecksLoadingByNum[7]).toBeTruthy();

    newChecks.resolve([{ name: "new repo", state: "pass" }]);
    await newLoad;

    expect(usePulls.getState().prChecks[7]).toEqual([{ name: "new repo", state: "pass" }]);
    expect(usePulls.getState().prChecksLoadingByNum).toEqual({});
  });

  it("clears the loading token when checks resolve after an account change", async () => {
    const checks = deferred<PrCheck[]>();
    invokeMock.mockReturnValueOnce(checks.promise);

    const load = usePulls.getState().loadPrChecks(7); // under account A (null)
    expect(usePulls.getState().prChecksLoadingByNum[7]).toBeTruthy();

    // Account rebinds while the request is in flight; no new load supersedes it.
    useAccounts.setState({ repoAccountRef: account("88") });
    checks.resolve([{ name: "old account", state: "pass" }]);
    await load;

    // The stale response is dropped, but its token must be cleared so the detail
    // effect / poll can issue a fresh load (otherwise checks stay loading forever).
    expect(usePulls.getState().prChecks[7]).toBeUndefined();
    expect(usePulls.getState().prChecksLoadingByNum[7]).toBeUndefined();
    expect(usePulls.getState().prChecksLoading).toBe(false);
  });

  it("lets a forced checks load supersede an in-flight checks load", async () => {
    const oldChecks = deferred<PrCheck[]>();
    const freshChecks = deferred<PrCheck[]>();
    invokeMock.mockReturnValueOnce(oldChecks.promise).mockReturnValueOnce(freshChecks.promise);

    const oldLoad = usePulls.getState().loadPrChecks(7);
    const freshLoad = usePulls.getState().loadPrChecks(7, true);

    expect(invokeMock).toHaveBeenCalledTimes(2);

    oldChecks.resolve([{ name: "old checks", state: "fail" }]);
    await oldLoad;
    expect(usePulls.getState().prChecks[7]).toBeUndefined();
    expect(usePulls.getState().prChecksLoadingByNum[7]).toBeTruthy();

    freshChecks.resolve([{ name: "fresh checks", state: "pass" }]);
    await freshLoad;

    expect(usePulls.getState().prChecks[7]).toEqual([{ name: "fresh checks", state: "pass" }]);
    expect(usePulls.getState().prChecksLoadingByNum).toEqual({});
  });

  it("invalidates in-flight checks when a forced PR-list refresh clears checks", async () => {
    const oldChecks = deferred<PrCheck[]>();
    const list = deferred<PullRequestSummary[]>();
    const freshChecks = deferred<PrCheck[]>();
    invokeMock
      .mockReturnValueOnce(oldChecks.promise)
      .mockReturnValueOnce(list.promise)
      .mockReturnValueOnce(freshChecks.promise);

    const oldLoad = usePulls.getState().loadPrChecks(7);
    const refresh = usePulls.getState().loadPullRequests(true);
    expect(usePulls.getState().prChecksLoadingByNum).toEqual({});

    const freshLoad = usePulls.getState().loadPrChecks(7);
    expect(invokeMock).toHaveBeenCalledTimes(3);

    oldChecks.resolve([{ name: "old checks", state: "fail" }]);
    await oldLoad;
    expect(usePulls.getState().prChecks[7]).toBeUndefined();

    list.resolve([prSummary(7)]);
    await refresh;
    freshChecks.resolve([{ name: "fresh checks", state: "pass" }]);
    await freshLoad;

    expect(usePulls.getState().prChecks[7]).toEqual([{ name: "fresh checks", state: "pass" }]);
  });
});

// PRs are GitHub-only (they run through `gh`). The list load must NOT attempt
// the `gh` resolution for a non-GitHub forge or a remote-less repo — that's the
// "asks GitHub for a non-GitHub repo" bug.
describe("pulls GitHub-only gating", () => {
  it("skips the gh call for a non-GitHub forge and explains why", async () => {
    useRepo.setState({ forge: forge({ kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" }) });

    await usePulls.getState().loadPullRequests();

    const s = usePulls.getState();
    expect(invokeMock).not.toHaveBeenCalled(); // never resolved a GitHub repo
    expect(s.pullRequests).toEqual([]);
    expect(s.prsLoading).toBe(false);
    expect(s.prError).toContain("GitHub");
    expect(s.prError).toContain("GitLab");
  });

  it("skips the gh call for a repo with no remote", async () => {
    useRepo.setState({
      forge: forge({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null }),
    });

    await usePulls.getState().loadPullRequests();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(usePulls.getState().prError).toContain("no remote");
  });

  it("still runs the gh load for a GitHub forge", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await usePulls.getState().loadPullRequests();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(usePulls.getState().prError).toBeNull();
  });
});

describe("pulls PR list refresh coalescing", () => {
  it("lets a foreground panel load show loading while a quiet prefetch is in flight", async () => {
    const quietFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(quietFetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    expect(usePulls.getState().prsRefreshInFlight).toBe(true);
    expect(usePulls.getState().prsLoading).toBe(false);

    await usePulls.getState().loadPullRequests();

    expect(usePulls.getState().prsLoading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    quietFetch.resolve([prSummary(7)]);
    await load;

    expect(usePulls.getState().prsLoading).toBe(false);
    expect(usePulls.getState().pullRequests.map((pr) => pr.num)).toEqual([7]);
  });

  it("queues a forced foreground refresh requested during a quiet prefetch", async () => {
    const quietFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(quietFetch.promise).mockResolvedValueOnce([prSummary(9)]);
    usePulls.setState({
      prDetails: { 7: { num: 7 } as never },
      prChecks: { 7: [{ name: "old", state: "pass" }] },
    });

    const load = usePulls.getState().loadPullRequests(false, true);
    const queuedLoad = usePulls.getState().loadPullRequests(true);

    expect(usePulls.getState().prsLoading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    quietFetch.resolve([prSummary(7)]);
    await queuedLoad;
    await load;

    const s = usePulls.getState();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(s.pullRequests.map((pr) => pr.num)).toEqual([9]);
    expect(s.prDetails).toEqual({});
    expect(s.prChecks).toEqual({});
    expect(s.prsRefreshQueued).toBeNull();
  });

  it("does not let a stale PR-list load clear a newer repo's active refresh state", async () => {
    const oldFetch = deferred<PullRequestSummary[]>();
    const newFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(oldFetch.promise).mockReturnValueOnce(newFetch.promise);

    const oldLoad = usePulls.getState().loadPullRequests(false, true);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });
    const newLoad = usePulls.getState().loadPullRequests();

    oldFetch.resolve([prSummary(7)]);
    await oldLoad;

    expect(usePulls.getState().prsLoading).toBe(true);
    expect(usePulls.getState().prsRefreshInFlight).toBe(true);
    expect(usePulls.getState().pullRequests).toEqual([]);

    newFetch.resolve([prSummary(9)]);
    await newLoad;

    expect(usePulls.getState().prsLoading).toBe(false);
    expect(usePulls.getState().prsRefreshInFlight).toBe(false);
    expect(usePulls.getState().pullRequests.map((pr) => pr.num)).toEqual([9]);
  });

  it("queues a non-force account reload when the bound account changes during prefetch", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise).mockResolvedValueOnce([prSummary(9)]);

    const load = usePulls.getState().loadPullRequests(false, true);
    useAccounts.setState({ repoAccountRef: account("42") });
    const accountReload = usePulls.getState().loadPullRequests();

    expect(usePulls.getState().prsLoading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    prefetch.resolve([prSummary(7)]);
    await accountReload;
    await load;

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(usePulls.getState().pullRequests.map((pr) => pr.num)).toEqual([9]);
    expect(usePulls.getState().prsRefreshQueued).toBeNull();
  });

  it("waits for a queued force refresh before resolving the caller's promise", async () => {
    const quietFetch = deferred<PullRequestSummary[]>();
    const forceFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(quietFetch.promise).mockReturnValueOnce(forceFetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    let forcedSettled = false;
    const forcedLoad = usePulls.getState().loadPullRequests(true).then(() => {
      forcedSettled = true;
    });

    await Promise.resolve();
    expect(forcedSettled).toBe(false);

    quietFetch.resolve([prSummary(7)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(forcedSettled).toBe(false);

    forceFetch.resolve([prSummary(9)]);
    await forcedLoad;
    await load;

    expect(forcedSettled).toBe(true);
    expect(usePulls.getState().pullRequests.map((pr) => pr.num)).toEqual([9]);
  });

  it("preserves the last successful list when a quiet background refresh fails", async () => {
    invokeMock.mockRejectedValueOnce("offline");
    usePulls.setState({
      pullRequests: [{ num: 7 } as never],
      prsFetchedAt: 123,
    });

    await usePulls.getState().loadPullRequests(false, true);

    const s = usePulls.getState();
    expect(s.pullRequests.map((pr) => pr.num)).toEqual([7]);
    expect(s.prsFetchedAt).toBe(123);
    expect(s.prError).toBeNull();
    expect(s.prsRefreshInFlight).toBe(false);
  });

  it("preserves a successful empty PR list when a quiet background refresh fails", async () => {
    invokeMock.mockRejectedValueOnce("offline");
    usePulls.setState({
      pullRequests: [],
      prsFetchedAt: 123,
    });

    await usePulls.getState().loadPullRequests(false, true);

    const s = usePulls.getState();
    expect(s.pullRequests).toEqual([]);
    expect(s.prsFetchedAt).toBe(123);
    expect(s.prError).toBeNull();
    expect(s.prsRefreshInFlight).toBe(false);
  });

  it("drops a list response fetched under a previous account", async () => {
    const aFetch = deferred<PullRequestSummary[]>();
    const bFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(aFetch.promise).mockReturnValueOnce(bFetch.promise);

    const aLoad = usePulls.getState().loadPullRequests(false, true); // account A (null)
    useAccounts.setState({ repoAccountRef: account("77") }); // rebind → key differs
    const bLoad = usePulls.getState().loadPullRequests(); // non-force, queued under B

    // Account-A response resolves first: it must NOT populate the list now bound
    // to account B; the slot is released so the queued B load can run.
    aFetch.resolve([prSummary(1)]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(usePulls.getState().pullRequests).toEqual([]);

    // The queued B load then populates the bound account's list.
    bFetch.resolve([prSummary(2)]);
    await bLoad;
    await aLoad;
    expect(usePulls.getState().pullRequests.map((p) => p.num)).toEqual([2]);
  });

  it("does not let a quiet retry mask a foreground failure's error", async () => {
    usePulls.setState({ pullRequests: [{ num: 7 } as never], prsFetchedAt: 123 });

    // Foreground refresh fails: clear the list, show the error, and drop the
    // stale "last successful fetch" marker.
    invokeMock.mockRejectedValueOnce("gh exploded");
    await usePulls.getState().loadPullRequests();
    expect(usePulls.getState().prError).toContain("gh exploded");
    expect(usePulls.getState().pullRequests).toEqual([]);
    expect(usePulls.getState().prsFetchedAt).toBeNull();

    // A later quiet/background retry that also fails must keep surfacing the
    // error, not flip to a misleading empty-no-error state.
    invokeMock.mockRejectedValueOnce("still offline");
    await usePulls.getState().loadPullRequests(false, true);
    expect(usePulls.getState().prError).toContain("still offline");
    expect(usePulls.getState().pullRequests).toEqual([]);
  });

  it("rejects queued PR refresh waiters when reset abandons the queued load", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    const queued = usePulls.getState().loadPullRequests(true);

    expect(usePulls.getState().prsRefreshQueued).not.toBeNull();

    usePulls.getState().reset();
    await expect(queued).rejects.toThrow("canceled");

    prefetch.resolve([prSummary(7)]);
    await load;

    expect(usePulls.getState().pullRequests).toEqual([]);
    expect(usePulls.getState().prsRefreshQueued).toBeNull();
  });

  it("resolves (does not reject) a queued fire-and-forget reload when reset cancels it", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    // A non-force reload (account/filter change) queues because the key differs.
    useAccounts.setState({ repoAccountRef: account("42") });
    const queued = usePulls.getState().loadPullRequests();
    expect(usePulls.getState().prsRefreshQueued).not.toBeNull();

    // Fire-and-forget callers don't await, so cancellation must resolve quietly
    // rather than surface an unhandled rejection.
    usePulls.getState().reset();
    await expect(queued).resolves.toBeUndefined();

    prefetch.resolve([prSummary(7)]);
    await load;
  });

  it("rejects a dequeued queued refresh when the repo switches before it resolves", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    const queuedFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise).mockReturnValueOnce(queuedFetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    const queued = usePulls.getState().loadPullRequests(true);
    expect(usePulls.getState().prsRefreshQueued).not.toBeNull();

    // Prefetch resolves → runQueued dequeues (clears prsRefreshQueued) and starts
    // the queued fetch, so there is no queue entry left for reset() to cancel.
    prefetch.resolve([prSummary(7)]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(usePulls.getState().prsRefreshQueued).toBeNull();

    // Repo switches while the queued fetch is still in flight.
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    queuedFetch.resolve([prSummary(9)]);
    await expect(queued).rejects.toThrow("canceled");
    await load;

    // The stale fetch never populates the newly opened repo's list.
    expect(usePulls.getState().pullRequests).toEqual([]);
  });

  it("cancels the old force waiter when the bound account changes before the queue drains", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    const queuedFetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise).mockReturnValueOnce(queuedFetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true); // account A (null)
    const queued = usePulls.getState().loadPullRequests(true); // force, queued under A
    expect(usePulls.getState().prsRefreshQueued).not.toBeNull();

    // The bound account rebinds before the prefetch finishes and the queue drains;
    // the queued load then runs under the new account, so the old waiter cancels.
    useAccounts.setState({ repoAccountRef: account("99") });

    prefetch.resolve([prSummary(7)]);
    queuedFetch.resolve([prSummary(9)]);
    await expect(queued).rejects.toThrow("canceled");
    await load;
  });

  it("drops a cached detail whose state changed on a quiet refresh", async () => {
    usePulls.setState({
      prDetails: { 7: summaryToPr(prSummary(7)) },
      prsFetchedAt: 1,
    });
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // The summary now says closed, so the stale open detail is evicted and the
    // detail effect (keyed on prsFetchedAt) will refetch it.
    expect(usePulls.getState().prDetails[7]).toBeUndefined();
    expect(usePulls.getState().pullRequests.map((p) => p.num)).toEqual([7]);
  });

  it("drops a cached detail when new commits change the diff size", async () => {
    usePulls.setState({
      prDetails: { 7: summaryToPr(prSummary(7, { additions: 1 })) },
      prsFetchedAt: 1,
    });
    invokeMock.mockResolvedValueOnce([prSummary(7, { additions: 42 })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Same open state, but additions changed (new commits) → evict so the
    // Diff/Commits tabs refetch instead of showing stale files.
    expect(usePulls.getState().prDetails[7]).toBeUndefined();
  });

  it("drops a cached detail when only the changed-file count differs", async () => {
    usePulls.setState({
      prDetails: { 7: summaryToPr(prSummary(7, { changedFiles: 3 })) },
      prsFetchedAt: 1,
    });
    // Net +/- unchanged (default 1/0) but files moved/replaced → changedFiles differs.
    invokeMock.mockResolvedValueOnce([prSummary(7, { changedFiles: 5 })]);

    await usePulls.getState().loadPullRequests(false, true);

    expect(usePulls.getState().prDetails[7]).toBeUndefined();
  });

  it("drops a cached detail when mergeability flips to a definitive verdict", async () => {
    usePulls.setState({
      prDetails: { 7: summaryToPr(prSummary(7, { mergeable: "MERGEABLE" })) },
      prsFetchedAt: 1,
    });
    invokeMock.mockResolvedValueOnce([prSummary(7, { mergeable: "CONFLICTING" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Base advanced into a conflict → invalidate so MergeMenu stops offering Merge.
    expect(usePulls.getState().prDetails[7]).toBeUndefined();
  });

  it("ignores an UNKNOWN mergeable verdict when pruning", async () => {
    const detail = summaryToPr(prSummary(7, { mergeable: "MERGEABLE" }));
    usePulls.setState({ prDetails: { 7: detail }, prsFetchedAt: 1 });
    invokeMock.mockResolvedValueOnce([prSummary(7, { mergeable: "UNKNOWN" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // UNKNOWN is indefinite (GitHub hasn't computed it) → don't churn the cache.
    expect(usePulls.getState().prDetails[7]).toBe(detail);
  });

  it("discards an in-flight diff load when a refresh prunes the PR", async () => {
    const diff = deferred<never[]>();
    invokeMock.mockReturnValueOnce(diff.promise);
    usePulls.setState({ prDetails: { 7: summaryToPr(prSummary(7)) }, prsFetchedAt: 1 });

    const load = usePulls.getState().loadPrDiff(7); // captures version 0

    // A quiet refresh sees #7's state change and prunes it (bumps the version).
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);
    await usePulls.getState().loadPullRequests(false, true);

    // The pre-prune diff resolves afterward → its write must be discarded.
    diff.resolve([]);
    await load;
    expect(usePulls.getState().prDiffs[7]).toBeUndefined();
  });

  it("discards a first detail load when the refreshed summary changed mid-flight", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);
    // #7 is in the previous list but has no cached detail yet (first load).
    usePulls.setState({ pullRequests: [summaryToPr(prSummary(7))], prsFetchedAt: 1 });

    const load = usePulls.getState().loadPrDetail(7); // captures version 0

    // Quiet refresh: #7's summary changed → bumps its version via the previous
    // summary baseline, even with no cache entry to compare.
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);
    await usePulls.getState().loadPullRequests(false, true);

    detail.resolve({});
    await load;
    expect(usePulls.getState().prDetails[7]).toBeUndefined();
    expect(usePulls.getState().prDetailLoading).toBe(false);
  });

  it("discards an in-flight detail load when a forced refresh clears caches", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);
    usePulls.setState({ pullRequests: [summaryToPr(prSummary(7))], prsFetchedAt: 1 });

    const load = usePulls.getState().loadPrDetail(7); // captures version 0

    // Forced refresh clears caches AND bumps known PRs' versions (incl. 7).
    invokeMock.mockResolvedValueOnce([prSummary(7)]);
    await usePulls.getState().loadPullRequests(true);

    // The pre-refresh detail resolves afterward → discarded, so the detail effect
    // refetches fresh instead of the reload skipping on a stale cache hit.
    detail.resolve({});
    await load;
    expect(usePulls.getState().prDetails[7]).toBeUndefined();
  });

  it("evicts the diff/checks/threads caches when a summary changes", async () => {
    usePulls.setState({
      prDetails: { 7: summaryToPr(prSummary(7)) },
      prDiffs: { 7: [] as never },
      prChecks: { 7: [{ name: "build", state: "pass" }] },
      prThreads: { 7: [] as never },
      prsFetchedAt: 1,
    });
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Detail AND its derived caches are evicted so no tab shows stale data.
    const s = usePulls.getState();
    expect(s.prDetails[7]).toBeUndefined();
    expect(s.prDiffs[7]).toBeUndefined();
    expect(s.prChecks[7]).toBeUndefined();
    expect(s.prThreads[7]).toBeUndefined();
  });

  it("keeps a cached detail whose summary is unchanged on a quiet refresh", async () => {
    const detail = summaryToPr(prSummary(7));
    usePulls.setState({ prDetails: { 7: detail }, prsFetchedAt: 1 });
    invokeMock.mockResolvedValueOnce([prSummary(7)]);

    await usePulls.getState().loadPullRequests(false, true);

    // Unchanged → keep the cached detail so re-opening the PR stays instant.
    expect(usePulls.getState().prDetails[7]).toBe(detail);
  });

  it("swallows the cancellation when a fire-and-forget manual refresh is abandoned", async () => {
    const prefetch = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(prefetch.promise);

    const load = usePulls.getState().loadPullRequests(false, true);
    // The panel Refresh button calls refreshPullRequests() fire-and-forget; it
    // queues a forced load behind the prefetch.
    const refresh = usePulls.getState().refreshPullRequests();
    expect(usePulls.getState().prsRefreshQueued).not.toBeNull();

    // Switching/closing the repo cancels the queued force load — refreshPullRequests
    // must resolve quietly rather than surface an unhandled rejection.
    usePulls.getState().reset();
    await expect(refresh).resolves.toBeUndefined();

    prefetch.resolve([prSummary(7)]);
    await load;
  });
});
