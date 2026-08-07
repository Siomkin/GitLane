// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { seedPrResource, seedThreads } from "@/test/prResources";
import { PR_RESOURCE } from "@/store/pullsResource";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the single IPC boundary inline (the canonical Vitest hoisted pattern) so
// the store's async loaders run headlessly and we can drive gh failures.
const invokeMock = vi.hoisted(() => vi.fn());
// Two loads fire a companion stack read: `loadPrDetail` → `pull_request_stack`,
// and `loadPullRequests` → `repository_stacks` (the list badges). Most tests
// here queue responses positionally with `mockReturnValueOnce`, and that queue
// is consumed in CALL order regardless of arguments — so without this a
// companion call silently eats the response meant for the next command, and the
// test stops testing what it says it does. Answering them outside `invokeMock`
// keeps every positional queue (and every call-count assertion) about the
// commands the test actually cares about. Tests that need real stack data set
// `stackResponse` / `stackBadgesResponse`.
const stackResponse = vi.hoisted(() => ({ current: null as unknown }));
const stackBadgesResponse = vi.hoisted(() => ({ current: [] as unknown }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    if (command === "pull_request_stack") return Promise.resolve(stackResponse.current);
    if (command === "repository_stacks") return Promise.resolve(stackBadgesResponse.current);
    return invokeMock(command, args);
  },
}));

import { useNotifications } from "./notifications";
import { PR_PENDING_ACTION, usePulls } from "./pulls";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { beginPublishedRepoSession } from "./repoRequests";
import { summaryToPr } from "@/lib/prs";
import {
  ForgeKind,
  type GithubAccountRef,
  type PrCheck,
  type PrCreateInput,
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

const realRepoRefresh = useRepo.getState().refresh;
const realLoadPrDetail = usePulls.getState().loadPrDetail;

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
  stackResponse.current = null;
  stackBadgesResponse.current = [];
  // Toasts outlive a test otherwise, so "stays silent" assertions would see the
  // previous test's card.
  useNotifications.getState().dismissAll();
  usePulls.getState().reset();
  usePulls.setState({ loadPrDetail: realLoadPrDetail });
  useRepo.setState({ summary: SUMMARY, forge: forge({}), refresh: realRepoRefresh });
  useAccounts.setState({ repoAccountId: null, repoAccountRef: null });
});

describe("pulls lazy-load error isolation", () => {
  it("clears pending writes when the repository PR state resets", () => {
    usePulls.setState({
      prPendingActions: [
        { id: 1, action: PR_PENDING_ACTION.State, prNum: 7, stateAction: "close" },
      ],
    });

    usePulls.getState().reset();

    expect(usePulls.getState().prPendingActions).toEqual([]);
  });

  it("tracks and removes concurrent same-PR writes by stable pending IDs", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstWrite = usePulls.getState().commentPr(7, "first");
    const secondWrite = usePulls.getState().commentPr(7, "second");

    const pending = usePulls.getState().prPendingActions;
    expect(pending).toHaveLength(2);
    expect(pending.map(({ action, prNum }) => ({ action, prNum }))).toEqual([
      { action: PR_PENDING_ACTION.Comment, prNum: 7 },
      { action: PR_PENDING_ACTION.Comment, prNum: 7 },
    ]);
    expect(new Set(pending.map(({ id }) => id)).size).toBe(2);

    first.reject(new Error("first failed"));
    await expect(firstWrite).rejects.toThrow("first failed");
    expect(usePulls.getState().prPendingActions.map(({ id }) => id)).toEqual([pending[1].id]);

    second.reject(new Error("second failed"));
    await expect(secondWrite).rejects.toThrow("second failed");
    expect(usePulls.getState().prPendingActions).toEqual([]);
  });

  it("scopes a diff failure to the PR without touching prError or the list", async () => {
    usePulls.setState({ pullRequests: [{ num: 7 } as never] });
    invokeMock.mockRejectedValueOnce("diff blew up");

    await usePulls.getState().loadPrDiff(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull(); // list error untouched → sidebar stays visible
    expect(s.pullRequests).toHaveLength(1); // list not cleared
    expect(s.prResources.diff.errors[7]).toContain("diff blew up");
    expect(s.prResources.diff.data[7]).toBeUndefined();
  });

  it("scopes a threads failure the same way (auto-loaded, most visible)", async () => {
    invokeMock.mockRejectedValueOnce("threads blew up");

    await usePulls.getState().loadPrThreads(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull();
    expect(s.prResources.threads.errors[7]).toContain("threads blew up");
  });

  it("records when the review-thread result hit its page cap", async () => {
    invokeMock.mockResolvedValueOnce({ threads: [], truncated: true });

    await usePulls.getState().loadPrThreads(7);

    expect(usePulls.getState().prResources.threads.data[7]?.threads).toEqual([]);
    expect(usePulls.getState().prResources.threads.data[7]?.truncated).toBe(true);
  });

  it("clears the per-PR error and caches the result on a successful retry", async () => {
    invokeMock.mockRejectedValueOnce("checks blew up");
    await usePulls.getState().loadPrChecks(7);
    expect(usePulls.getState().prResources.checks.errors[7]).toBeDefined();

    invokeMock.mockResolvedValueOnce([{ name: "build", state: "pass" }]);
    await usePulls.getState().loadPrChecks(7, true);

    const s = usePulls.getState();
    expect(s.prResources.checks.errors[7]).toBeUndefined();
    expect(s.prResources.checks.data[7]).toEqual([{ name: "build", state: "pass" }]);
  });

  it("keeps one PR's error from leaking into another PR's tab", async () => {
    invokeMock.mockRejectedValueOnce("diff blew up");
    await usePulls.getState().loadPrDiff(7);

    invokeMock.mockResolvedValueOnce([]);
    await usePulls.getState().loadPrDiff(9);

    const s = usePulls.getState();
    expect(s.prResources.diff.errors[7]).toBeDefined();
    expect(s.prResources.diff.errors[9]).toBeUndefined();
    expect(s.prResources.diff.data[9]).toEqual([]);
  });

  it("replies to a review thread and refreshes that PR's thread cache", async () => {
    invokeMock.mockResolvedValueOnce("reply ok");
    invokeMock.mockResolvedValueOnce({ threads: [], truncated: false });

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
    invokeMock.mockResolvedValueOnce({ threads: [], truncated: false });
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
    expect(Object.keys(usePulls.getState().prResources.checks.slots).sort()).toEqual(["7", "9"]);

    second.resolve([{ name: "lint", state: "pass" }]);
    await loadSecond;

    expect(usePulls.getState().prResources.checks.data[9]).toEqual([{ name: "lint", state: "pass" }]);
    expect(usePulls.getState().prResources.checks.slots).not.toEqual({});
    expect(usePulls.getState().prResources.checks.slots[7]).toBeTruthy();

    first.resolve([{ name: "build", state: "pending" }]);
    await loadFirst;

    expect(usePulls.getState().prResources.checks.data[7]).toEqual([{ name: "build", state: "pending" }]);
    expect(usePulls.getState().prResources.checks.slots).toEqual({});
    expect(usePulls.getState().prResources.checks.slots).toEqual({});
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

    expect(usePulls.getState().prResources.checks.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.checks.slots[7]).toBeTruthy();

    newChecks.resolve([{ name: "new repo", state: "pass" }]);
    await newLoad;

    expect(usePulls.getState().prResources.checks.data[7]).toEqual([{ name: "new repo", state: "pass" }]);
    expect(usePulls.getState().prResources.checks.slots).toEqual({});
  });

  it("clears the loading token when checks resolve after an account change", async () => {
    const checks = deferred<PrCheck[]>();
    invokeMock.mockReturnValueOnce(checks.promise);

    const load = usePulls.getState().loadPrChecks(7); // under account A (null)
    expect(usePulls.getState().prResources.checks.slots[7]).toBeTruthy();

    // Account rebinds while the request is in flight; no new load supersedes it.
    useAccounts.setState({ repoAccountRef: account("88") });
    checks.resolve([{ name: "old account", state: "pass" }]);
    await load;

    // The stale response is dropped, but its token must be cleared so the detail
    // effect / poll can issue a fresh load (otherwise checks stay loading forever).
    expect(usePulls.getState().prResources.checks.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.checks.slots[7]).toBeUndefined();
    expect(usePulls.getState().prResources.checks.slots).toEqual({});
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
    expect(usePulls.getState().prResources.checks.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.checks.slots[7]).toBeTruthy();

    freshChecks.resolve([{ name: "fresh checks", state: "pass" }]);
    await freshLoad;

    expect(usePulls.getState().prResources.checks.data[7]).toEqual([{ name: "fresh checks", state: "pass" }]);
    expect(usePulls.getState().prResources.checks.slots).toEqual({});
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
    expect(usePulls.getState().prResources.checks.slots).toEqual({});

    const freshLoad = usePulls.getState().loadPrChecks(7);
    expect(invokeMock).toHaveBeenCalledTimes(3);

    oldChecks.resolve([{ name: "old checks", state: "fail" }]);
    await oldLoad;
    expect(usePulls.getState().prResources.checks.data[7]).toBeUndefined();

    list.resolve([prSummary(7)]);
    await refresh;
    freshChecks.resolve([{ name: "fresh checks", state: "pass" }]);
    await freshLoad;

    expect(usePulls.getState().prResources.checks.data[7]).toEqual([{ name: "fresh checks", state: "pass" }]);
  });
});

// PRs are supported for GitHub (via `gh`), GitLab (via glab / REST v4), and
// Bitbucket (via REST 2.0). The list load must NOT attempt the provider
// resolution for any *other* forge or a remote-less repo — that's the "asks
// GitHub for a non-GitHub repo" bug.
describe("pulls forge gating", () => {
  it("skips the provider call for an unsupported forge and explains why", async () => {
    useRepo.setState({
      forge: forge({ kind: ForgeKind.AzureDevOps, forge: "Azure DevOps", host: "dev.azure.com" }),
    });

    await usePulls.getState().loadPullRequests();

    const s = usePulls.getState();
    expect(invokeMock).not.toHaveBeenCalled(); // never resolved a repo
    expect(s.pullRequests).toEqual([]);
    expect(s.prsLoading).toBe(false);
    expect(s.prError).toContain("Azure DevOps");
  });

  it("runs the load for a Bitbucket forge (GL-141)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    useRepo.setState({ forge: forge({ kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org" }) });

    await usePulls.getState().loadPullRequests();

    // No stored Bitbucket token in the test env → the account resolves to null;
    // the backend (dispatching by forge) then reports how to sign in.
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", { path: SUMMARY.path, account: null });
    expect(usePulls.getState().prError).toBeNull();
  });

  it("runs the load for a GitLab forge (GL-140)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    useRepo.setState({ forge: forge({ kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" }) });

    await usePulls.getState().loadPullRequests();

    // No glab/keychain token in the test env → the account resolves to null and
    // the backend (dispatching by forge) uses glab's zero-config transport.
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", { path: SUMMARY.path, account: null });
    expect(usePulls.getState().prError).toBeNull();
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
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: { num: 7 } as never } });
    seedPrResource(PR_RESOURCE.Checks, { data: { 7: [{ name: "old", state: "pass" }] } });

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
    expect(s.prResources.detail.data).toEqual({});
    expect(s.prResources.checks.data).toEqual({});
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
    // The list load awaits `Promise.all([list, repositoryStacks])`, which settles
    // one microtask later than a bare await — so reaching the queued fetch takes
    // an extra tick. Behaviour is unchanged; only the tick count is.
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
    // One more tick than before: the list load now awaits `Promise.all([list,
    // repositoryStacks])`, which settles a microtask later than a bare await.
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
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7)) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // The summary now says closed, so the stale open detail is evicted and the
    // detail effect (keyed on prsFetchedAt) will refetch it.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().pullRequests.map((p) => p.num)).toEqual([7]);
  });

  it("drops a cached detail when new commits change the diff size", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7, { additions: 1 })) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { additions: 42 })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Same open state, but additions changed (new commits) → evict so the
    // Diff/Commits tabs refetch instead of showing stale files.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("drops a cached detail when only the changed-file count differs", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7, { changedFiles: 3 })) } });
    // Net +/- unchanged (default 1/0) but files moved/replaced → changedFiles differs.
    invokeMock.mockResolvedValueOnce([prSummary(7, { changedFiles: 5 })]);

    await usePulls.getState().loadPullRequests(false, true);

    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("drops a cached detail when mergeability flips to a definitive verdict", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7, { mergeable: "MERGEABLE" })) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { mergeable: "CONFLICTING" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Base advanced into a conflict → invalidate so MergeMenu stops offering Merge.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("ignores an UNKNOWN mergeable verdict when pruning", async () => {
    const detail = summaryToPr(prSummary(7, { mergeable: "MERGEABLE" }));
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: detail } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { mergeable: "UNKNOWN" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // UNKNOWN is indefinite (GitHub hasn't computed it) → don't churn the cache.
    expect(usePulls.getState().prResources.detail.data[7]).toBe(detail);
  });

  it("discards an in-flight diff load when a refresh prunes the PR", async () => {
    const diff = deferred<never[]>();
    invokeMock.mockReturnValueOnce(diff.promise);
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7)) } });

    const load = usePulls.getState().loadPrDiff(7); // captures version 0

    // A quiet refresh sees #7's state change and prunes it (bumps the version).
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);
    await usePulls.getState().loadPullRequests(false, true);

    // The pre-prune diff resolves afterward → its write must be discarded.
    diff.resolve([]);
    await load;
    expect(usePulls.getState().prResources.diff.data[7]).toBeUndefined();
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
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
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
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("evicts the diff/checks/threads caches when a summary changes", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7)) } });
    seedPrResource(PR_RESOURCE.Diff, { data: { 7: [] as never } });
    seedPrResource(PR_RESOURCE.Checks, { data: { 7: [{ name: "build", state: "pass" }] } });
    seedThreads({ 7: [] as never });
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Detail AND its derived caches are evicted so no tab shows stale data.
    const s = usePulls.getState();
    expect(s.prResources.detail.data[7]).toBeUndefined();
    expect(s.prResources.diff.data[7]).toBeUndefined();
    expect(s.prResources.checks.data[7]).toBeUndefined();
    expect(s.prResources.threads.data[7]?.threads).toBeUndefined();
  });

  it("keeps a cached detail whose summary is unchanged on a quiet refresh", async () => {
    const detail = summaryToPr(prSummary(7));
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: detail } });
    invokeMock.mockResolvedValueOnce([prSummary(7)]);

    await usePulls.getState().loadPullRequests(false, true);

    // Unchanged → keep the cached detail so re-opening the PR stays instant.
    expect(usePulls.getState().prResources.detail.data[7]).toBe(detail);
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

describe("create PR follow-up ownership", () => {
  it("does not refresh repo B when repo A's create finishes after a switch", async () => {
    beginPublishedRepoSession();
    const create = deferred<string>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request") return create.promise;
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().createPr(createInput("Repo A PR"));
    expect(invokeMock).toHaveBeenCalledWith(
      "create_pull_request",
      expect.objectContaining({
        path: "/repo",
        input: expect.objectContaining({ title: "Repo A PR" }),
      }),
    );

    usePulls.getState().reset();
    beginPublishedRepoSession();
    useRepo.setState({ summary: OTHER_SUMMARY });
    const repoBPr = summaryToPr(prSummary(42, { title: "Repo B marker" }));
    usePulls.setState({ pullRequests: [repoBPr], prError: "repo-b-marker" });

    create.resolve("https://github.com/o/r/pull/99");
    await expect(pending).resolves.toBe("https://github.com/o/r/pull/99");

    expect(invokeMock.mock.calls.filter(([command]) => command === "list_pull_requests")).toEqual([]);
    expect(usePulls.getState().pullRequests).toEqual([repoBPr]);
    expect(usePulls.getState().prError).toBe("repo-b-marker");
  });

  it("does not refresh a reopened same-path repository session", async () => {
    beginPublishedRepoSession();
    const create = deferred<string>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request") return create.promise;
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().createPr(createInput("Old session PR"));

    usePulls.getState().reset();
    beginPublishedRepoSession();
    useRepo.setState({ summary: { ...SUMMARY } });
    const reopenedPr = summaryToPr(prSummary(43, { title: "Reopened session marker" }));
    usePulls.setState({ pullRequests: [reopenedPr], prError: "reopened-marker" });

    create.resolve("https://github.com/o/r/pull/100");
    await expect(pending).resolves.toBe("https://github.com/o/r/pull/100");

    expect(invokeMock.mock.calls.filter(([command]) => command === "list_pull_requests")).toEqual([]);
    expect(usePulls.getState().pullRequests).toEqual([reopenedPr]);
    expect(usePulls.getState().prError).toBe("reopened-marker");
  });

  it("does not refresh under a different bound account", async () => {
    beginPublishedRepoSession();
    const create = deferred<string>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request") return create.promise;
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().createPr(createInput("Account A PR"));
    useAccounts.setState({ repoAccountRef: account("22") });

    create.resolve("https://github.com/o/r/pull/101");
    await expect(pending).resolves.toBe("https://github.com/o/r/pull/101");

    expect(invokeMock.mock.calls.filter(([command]) => command === "list_pull_requests")).toEqual([]);
  });
});

describe("createPr stack linking", () => {
  const inputFor = (title: string): PrCreateInput => ({
    base: "fix/scroll",
    head: "feat/x",
    title,
    body: "",
    draft: false,
    reviewers: [],
  });

  it("links the new pull request onto the layers below, bottom-first", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request")
        return Promise.resolve("https://github.com/o/r/pull/143");
      if (command === "link_pull_request_stack") return Promise.resolve("linked");
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await usePulls.getState().createPr(inputFor("Stacked"), [141, 142]);

    // The created number is appended to the layers below — `gh stack link`
    // takes the whole chain bottom-to-top.
    expect(invokeMock).toHaveBeenCalledWith(
      "link_pull_request_stack",
      expect.objectContaining({ numbers: [141, 142, 143] }),
    );
  });

  it("does not link when nothing is below", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request")
        return Promise.resolve("https://github.com/o/r/pull/144");
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await usePulls.getState().createPr(inputFor("Plain"));

    expect(invokeMock.mock.calls.filter(([c]) => c === "link_pull_request_stack")).toEqual([]);
  });

  it("reports a link failure without failing the create", async () => {
    // The pull request exists once `gh pr create` returns. Missing the stack
    // extension must read as "opened but not linked", not as a failed create.
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request")
        return Promise.resolve("https://github.com/o/r/pull/145");
      if (command === "link_pull_request_stack")
        return Promise.reject("needs `gh extension install github/gh-stack`");
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await expect(usePulls.getState().createPr(inputFor("Stacked"), [141])).resolves.toBe(
      "https://github.com/o/r/pull/145",
    );
    const toasts = useNotifications.getState().toasts;
    expect(toasts[toasts.length - 1]?.title).toContain("was not linked");
  });

  it("does not link against a repository switched to mid-create", async () => {
    beginPublishedRepoSession();
    const create = deferred<string>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "create_pull_request") return create.promise;
      if (command === "list_pull_requests") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().createPr(inputFor("Stacked"), [141]);

    usePulls.getState().reset();
    beginPublishedRepoSession();
    useRepo.setState({ summary: OTHER_SUMMARY });

    create.resolve("https://github.com/o/r/pull/146");
    await expect(pending).resolves.toBe("https://github.com/o/r/pull/146");

    // Repo B never sees the link; the unlinked stack is still reported.
    expect(invokeMock.mock.calls.filter(([c]) => c === "link_pull_request_stack")).toEqual([]);
    const toasts = useNotifications.getState().toasts;
    expect(toasts[toasts.length - 1]?.title).toContain("was not linked");
  });
});

function createInput(title: string): PrCreateInput {
  return { base: "main", head: "feat/x", title, body: "", draft: false, reviewers: [] };
}

describe("PR write follow-up ownership", () => {
  const switchToOtherRepo = () => {
    usePulls.getState().reset();
    beginPublishedRepoSession();
    useRepo.setState({
      summary: OTHER_SUMMARY,
      forge: forge({ webUrl: "https://github.com/o/other" }),
    });
  };

  it.each([
    {
      label: "reply",
      command: "reply_review_thread",
      run: () => usePulls.getState().replyThread(7, "thread-1", "fixed"),
    },
    {
      label: "resolve",
      command: "resolve_review_thread",
      run: () => usePulls.getState().resolveThread(7, "thread-1", true),
    },
    {
      label: "comment",
      command: "comment_pull_request",
      run: () => usePulls.getState().commentPr(7, "looks good"),
    },
  ])("returns the $label server output without refreshing repo B", async ({ command, run }) => {
    beginPublishedRepoSession();
    const serverWrite = deferred<string>();
    invokeMock.mockImplementation((actual: string) => {
      if (actual === command) return serverWrite.promise;
      return Promise.reject(new Error(`Unexpected command: ${actual}`));
    });

    const pending = run();
    switchToOtherRepo();
    const repoBThread = { id: "repo-b-thread" } as never;
    const repoBPr = summaryToPr(prSummary(91, { title: "Repo B marker" }));
    usePulls.setState({ pullRequests: [repoBPr], prError: "repo-b-marker" });
    seedThreads({ 7: [repoBThread] });

    serverWrite.resolve(`${command} ok`);
    await expect(pending).resolves.toBe(`${command} ok`);

    expect(invokeMock.mock.calls.map(([actual]) => actual)).toEqual([command]);
    expect(usePulls.getState().pullRequests).toEqual([repoBPr]);
    expect(usePulls.getState().prResources.threads.data[7]?.threads).toEqual([repoBThread]);
    expect(usePulls.getState().prError).toBe("repo-b-marker");
  });

  it("stops a review after its detail follow-up when the account changes", async () => {
    beginPublishedRepoSession();
    const detail = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "review_pull_request") return Promise.resolve("review ok");
      if (command === "pull_request_detail") return detail.promise;
      if (command === "pull_request_checks") {
        return Promise.reject(new Error("stale checks must not start"));
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().reviewPr(7, "approve", "ship it");
    await vi.waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_detail")).toBe(true),
    );

    useAccounts.setState({ repoAccountRef: account("33") });
    detail.resolve({});
    await expect(pending).resolves.toBe("review ok");

    expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_checks")).toBe(false);
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("preserves a same-owner follow-up failure after the server write succeeds", async () => {
    beginPublishedRepoSession();
    const loadPrDetail = vi.fn().mockRejectedValue(new Error("detail refresh failed"));
    try {
      usePulls.setState({ loadPrDetail });
      invokeMock.mockImplementation((command: string) => {
        if (command === "comment_pull_request") return Promise.resolve("comment ok");
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      });

      await expect(usePulls.getState().commentPr(7, "looks good")).rejects.toThrow(
        "detail refresh failed",
      );
      expect(loadPrDetail).toHaveBeenCalledWith(7, true);
    } finally {
      usePulls.setState({ loadPrDetail: realLoadPrDetail });
    }
  });

  it("returns state output when a queued force refresh is canceled after server success", async () => {
    beginPublishedRepoSession();
    const prefetch = deferred<PullRequestSummary[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_pull_requests") return prefetch.promise;
      if (command === "set_pull_request_state") return Promise.resolve("state ok");
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const prefetchLoad = usePulls.getState().loadPullRequests(false, true);
    const pending = usePulls.getState().setPrState(7, "close");
    await vi.waitFor(() => expect(usePulls.getState().prsRefreshQueued).not.toBeNull());

    switchToOtherRepo();
    const repoBPr = summaryToPr(prSummary(92, { title: "Repo B after cancel" }));
    usePulls.setState({ pullRequests: [repoBPr], prError: "repo-b-marker" });

    await expect(pending).resolves.toBe("state ok");
    expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_detail")).toBe(false);
    expect(usePulls.getState().pullRequests).toEqual([repoBPr]);
    expect(usePulls.getState().prError).toBe("repo-b-marker");

    prefetch.resolve([prSummary(7)]);
    await prefetchLoad;
    expect(usePulls.getState().pullRequests).toEqual([repoBPr]);
  });

  // GL-345: the merge itself is routine success and stays silent, but a branch
  // the provider could not delete appears in no view, so it must be said.
  it("warns when a merge left the head branch undeleted", async () => {
    beginPublishedRepoSession();
    useRepo.setState({ refresh: vi.fn().mockResolvedValue(true) });
    invokeMock.mockImplementation((command: string) => {
      if (command === "merge_pull_request")
        return Promise.resolve({ undeletedBranch: "feature/x" });
      if (command === "list_pull_requests") return Promise.resolve([prSummary(7)]);
      return Promise.resolve(null);
    });

    await usePulls.getState().mergePr(7, "squash", true);

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("warning");
    expect(toast?.title).toBe("Merged #7, but feature/x was not deleted");
  });

  // The merge + its head-ref probe are two blocking IPC calls; the user can
  // switch repo or account in between. A stale warning must not land in the
  // newly opened context (the ownership contract in `pullsActionOwner.ts`).
  it("suppresses the undeleted-branch warning when the repo switched mid-merge", async () => {
    beginPublishedRepoSession();
    useRepo.setState({ refresh: vi.fn().mockResolvedValue(true) });
    const merge = deferred<{ undeletedBranch: string }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "merge_pull_request") return merge.promise;
      if (command === "list_pull_requests") return Promise.resolve([prSummary(7)]);
      return Promise.resolve(null);
    });

    const pending = usePulls.getState().mergePr(7, "squash", true);
    switchToOtherRepo();
    merge.resolve({ undeletedBranch: "feature/x" });
    await pending;

    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("stays silent on a merge that deleted the branch", async () => {
    beginPublishedRepoSession();
    useRepo.setState({ refresh: vi.fn().mockResolvedValue(true) });
    invokeMock.mockImplementation((command: string) => {
      if (command === "merge_pull_request") return Promise.resolve({ undeletedBranch: null });
      if (command === "list_pull_requests") return Promise.resolve([prSummary(7)]);
      return Promise.resolve(null);
    });

    await usePulls.getState().mergePr(7, "squash", true);

    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("stops merge follow-ups when the repo switches during the list reload", async () => {
    beginPublishedRepoSession();
    const list = deferred<PullRequestSummary[]>();
    const refresh = vi.fn().mockResolvedValue(true);
    useRepo.setState({ refresh });
    invokeMock.mockImplementation((command: string) => {
      if (command === "merge_pull_request") return Promise.resolve({ undeletedBranch: null });
      if (command === "list_pull_requests") return list.promise;
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().mergePr(7, "squash", true);
    await vi.waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "list_pull_requests")).toBe(true),
    );

    switchToOtherRepo();
    const repoBPr = summaryToPr(prSummary(93, { title: "Repo B during merge refresh" }));
    usePulls.setState({ pullRequests: [repoBPr], prError: "repo-b-marker" });
    list.resolve([prSummary(7)]);

    await expect(pending).resolves.toBe("");
    expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_detail")).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(usePulls.getState().pullRequests).toEqual([repoBPr]);
    expect(usePulls.getState().prError).toBe("repo-b-marker");
  });
});

// Repo reset (open/close/switch) must orphan every in-flight per-PR resource
// request: a pre-switch detail/diff/threads response may publish neither data
// nor an error into the fresh state, and must never leave (or clear) a loading
// flag it no longer owns. Mirrors the checks/commits ownership (GL-164).
describe("PR resource request ownership across repo reset (GL-166)", () => {
  const prDetailPayload = (number: number) => ({
    ...prSummary(number),
    body: "",
    comments: 0,
    files: [],
    commentList: [],
    mergeable: "UNKNOWN",
    reviewers: [],
    reviews: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
  });

  it("drops a detail response that resolves after a repo switch", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);

    const load = usePulls.getState().loadPrDetail(7);
    expect(usePulls.getState().prResources.detail.slots).not.toEqual({});

    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    detail.resolve(prDetailPayload(7));
    await load;

    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });

  it("drops a detail failure that rejects after a repo switch", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);

    const load = usePulls.getState().loadPrDetail(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    detail.reject(new Error("old repo blew up"));
    await load;

    expect(usePulls.getState().prResources.detail.errors[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });

  it("keeps the new repo's diff load intact while the old repo's diff resolves late", async () => {
    const oldDiff = deferred<never[]>();
    const newDiff = deferred<never[]>();
    invokeMock.mockReturnValueOnce(oldDiff.promise).mockReturnValueOnce(newDiff.promise);

    const oldLoad = usePulls.getState().loadPrDiff(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });
    const newLoad = usePulls.getState().loadPrDiff(7);

    oldDiff.resolve([]);
    await oldLoad;

    // The stale response neither populated the cache nor cleared the fresh
    // request's loading flag.
    expect(usePulls.getState().prResources.diff.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.diff.slots).not.toEqual({});

    newDiff.resolve([]);
    await newLoad;

    expect(usePulls.getState().prResources.diff.data[7]).toEqual([]);
    expect(usePulls.getState().prResources.diff.slots).toEqual({});
  });

  it("drops a threads response that resolves after a repo switch", async () => {
    const threads = deferred<never[]>();
    invokeMock.mockReturnValueOnce(threads.promise);

    const load = usePulls.getState().loadPrThreads(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    threads.resolve([]);
    await load;

    expect(usePulls.getState().prResources.threads.data[7]?.threads).toBeUndefined();
    expect(usePulls.getState().prResources.threads.slots).toEqual({});
  });

  it("drops a threads failure that rejects after a repo switch", async () => {
    const threads = deferred<never[]>();
    invokeMock.mockReturnValueOnce(threads.promise);

    const load = usePulls.getState().loadPrThreads(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    threads.reject(new Error("old repo threads blew up"));
    await load;

    expect(usePulls.getState().prResources.threads.errors[7]).toBeUndefined();
    expect(usePulls.getState().prResources.threads.slots).toEqual({});
  });

  it("drops a diff failure that rejects after a repo switch", async () => {
    const diff = deferred<never[]>();
    invokeMock.mockReturnValueOnce(diff.promise);

    const load = usePulls.getState().loadPrDiff(7);
    usePulls.getState().reset();
    useRepo.setState({ summary: OTHER_SUMMARY, forge: forge({ webUrl: "https://github.com/o/other" }) });

    diff.reject(new Error("old repo diff blew up"));
    await load;

    expect(usePulls.getState().prResources.diff.errors[7]).toBeUndefined();
    expect(usePulls.getState().prResources.diff.slots).toEqual({});
  });

  it("clears the detail loading flag as soon as a forced refresh clears the caches", async () => {
    const detail = deferred<unknown>();
    const list = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(detail.promise).mockReturnValueOnce(list.promise);
    usePulls.setState({ pullRequests: [summaryToPr(prSummary(7))], prsFetchedAt: 1 });

    const load = usePulls.getState().loadPrDetail(7);
    expect(usePulls.getState().prResources.detail.slots).not.toEqual({});

    // Force refresh evicts the slots synchronously (same as the quiet prune),
    // so the flag doesn't hold a spinner until the orphaned request settles.
    const refresh = usePulls.getState().loadPullRequests(true);
    expect(usePulls.getState().prResources.detail.slots).toEqual({});

    list.resolve([prSummary(7)]);
    await refresh;
    detail.resolve(prDetailPayload(7));
    await load;
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });

  it("clears the detail loading flag as soon as a quiet refresh prunes the PR", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);
    usePulls.setState({ pullRequests: [summaryToPr(prSummary(7))], prsFetchedAt: 1 });

    const load = usePulls.getState().loadPrDetail(7);
    expect(usePulls.getState().prResources.detail.slots).not.toEqual({});

    // The quiet refresh prunes #7 (summary changed) → the slot evicts NOW, so
    // the flag can't hold a spinner (or mask another PR's error) until the
    // stale network call returns.
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);
    await usePulls.getState().loadPullRequests(false, true);
    expect(usePulls.getState().prResources.detail.slots).toEqual({});

    detail.resolve(prDetailPayload(7));
    await load;
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });

  it("clears every stuck loading flag on reset, before the old requests settle", async () => {
    const detail = deferred<unknown>();
    const diff = deferred<never[]>();
    const threads = deferred<never[]>();
    invokeMock
      .mockReturnValueOnce(detail.promise)
      .mockReturnValueOnce(diff.promise)
      .mockReturnValueOnce(threads.promise);

    void usePulls.getState().loadPrDetail(7);
    void usePulls.getState().loadPrDiff(7);
    void usePulls.getState().loadPrThreads(7);
    expect(usePulls.getState().prResources.detail.slots).not.toEqual({});
    expect(usePulls.getState().prResources.diff.slots).not.toEqual({});
    expect(usePulls.getState().prResources.threads.slots).not.toEqual({});

    usePulls.getState().reset();

    const s = usePulls.getState();
    expect(s.prResources.detail.slots).toEqual({});
    expect(s.prResources.diff.slots).toEqual({});
    expect(s.prResources.threads.slots).toEqual({});
  });

  it("keeps detail loading while another PR's earlier detail load completes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    // Two loads are interleaved, so route by PR number rather than by position.
    // (The companion stack read is answered outside `invokeMock` — see the mock
    // at the top of this file.)
    const detailByNum = new Map<number, Promise<unknown>>([
      [7, first.promise],
      [9, second.promise],
    ]);
    invokeMock.mockImplementation((command: string, args: { number: number }) => {
      if (command === "pull_request_detail") return detailByNum.get(args.number);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const loadFirst = usePulls.getState().loadPrDetail(7);
    const loadSecond = usePulls.getState().loadPrDetail(9);

    // The selected PR (9) is still pending; 7 finishing must not clear its flag.
    first.resolve(prDetailPayload(7));
    await loadFirst;
    expect(usePulls.getState().prResources.detail.data[7]).toBeDefined();
    expect(usePulls.getState().prResources.detail.slots).not.toEqual({});

    second.resolve(prDetailPayload(9));
    await loadSecond;
    expect(usePulls.getState().prResources.detail.data[9]).toBeDefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });

  it("drops a detail response fetched under a previous account but clears its token", async () => {
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);

    const load = usePulls.getState().loadPrDetail(7); // under account A (null)
    // Account rebinds while the request is in flight; no new load supersedes it.
    useAccounts.setState({ repoAccountRef: account("88") });

    detail.resolve(prDetailPayload(7));
    await load;

    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.slots).toEqual({});
  });
});

describe("stack cache (rides the detail load)", () => {
  const prDetailPayload = (number: number) => ({
    ...prSummary(number),
    body: "",
    comments: 0,
    files: [],
    commentList: [],
    mergeable: "UNKNOWN",
    reviewers: [],
    reviews: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
  });

  const stack = (num: number) => ({
    number: 310,
    size: 1,
    baseRef: "latest",
    position: 1,
    entries: [
      {
        position: 1,
        number: num,
        title: `PR ${num}`,
        state: "OPEN",
        isDraft: false,
        headRef: `branch-${num}`,
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
    ],
  });

  it("indexes the repo's stack badges by PR number with the list", async () => {
    // One call covers every row; the per-PR read can't, since it only runs for
    // an open detail.
    stackBadgesResponse.current = [
      { prNumber: 308, stackNumber: 310, position: 1, size: 2 },
      { prNumber: 309, stackNumber: 310, position: 2, size: 2 },
    ];
    invokeMock.mockResolvedValueOnce([prSummary(308), prSummary(309)]);

    await usePulls.getState().loadPullRequests(true);

    expect(usePulls.getState().prStackBadges[309]).toMatchObject({ position: 2, size: 2 });
    expect(usePulls.getState().prStackBadges[308]?.stackNumber).toBe(310);
  });

  it("keeps the previous badges when the stack read fails", async () => {
    // Same contract as the per-PR stack: a failed read is not evidence the
    // stacks are gone, and it must never cost the list itself.
    usePulls.setState({ prStackBadges: { 309: { prNumber: 309, stackNumber: 310, position: 2, size: 2 } } });
    stackBadgesResponse.current = Promise.reject(new Error("stacks blew up"));
    invokeMock.mockResolvedValueOnce([prSummary(309)]);

    await usePulls.getState().loadPullRequests(true);

    expect(usePulls.getState().prStackBadges[309]?.position).toBe(2);
    expect(usePulls.getState().pullRequests).toHaveLength(1);
    expect(usePulls.getState().prError).toBeNull();
  });

  it("publishes the stack with the detail", async () => {
    stackResponse.current = stack(7);
    invokeMock.mockResolvedValueOnce(prDetailPayload(7));

    await usePulls.getState().loadPrDetail(7);

    expect(usePulls.getState().prStacks[7]?.number).toBe(310);
  });

  it("clears the stack when the PR is confirmed unstacked", async () => {
    usePulls.setState({ prStacks: { 7: stack(7) } as never });
    stackResponse.current = null;
    invokeMock.mockResolvedValueOnce(prDetailPayload(7));

    await usePulls.getState().loadPrDetail(7, true);

    // A PR that genuinely left its stack must not keep the card.
    expect(usePulls.getState().prStacks[7]).toBeUndefined();
  });

  it("keeps the cached stack when the stack read fails", async () => {
    // A failed read is not evidence the stack is gone. Deleting it here made one
    // transient GraphQL blip remove a working card, which a cached detail then
    // never re-fetched — the card stayed missing until a forced refresh.
    usePulls.setState({ prStacks: { 7: stack(7) } as never });
    stackResponse.current = Promise.reject(new Error("graphql blew up"));
    invokeMock.mockResolvedValueOnce(prDetailPayload(7));

    await usePulls.getState().loadPrDetail(7, true);

    expect(usePulls.getState().prStacks[7]?.number).toBe(310);
    // The detail itself still loads — a stack failure must not cost the body.
    expect(usePulls.getState().prResources.detail.data[7]).toBeDefined();
    expect(usePulls.getState().prResources.detail.errors[7]).toBeUndefined();
  });

  it("does not publish a stack fetched under a previous account", async () => {
    stackResponse.current = stack(7);
    const detail = deferred<unknown>();
    invokeMock.mockReturnValueOnce(detail.promise);

    const load = usePulls.getState().loadPrDetail(7);
    useAccounts.setState({ repoAccountRef: account("88") });
    detail.resolve(prDetailPayload(7));
    await load;

    expect(usePulls.getState().prStacks[7]).toBeUndefined();
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });
});

describe("loadPrCommits (paginated commit list replaces the capped fast-path)", () => {
  // The `gh pr view` fast-path list a detail is seeded with: one commit, unverified.
  const cappedRow = {
    oid: "c0",
    shortOid: "c0",
    headline: "capped",
    age: "1h",
    author: { name: "A", login: "a", initials: "A" },
    hasAuthor: true,
    url: "https://github.com/o/r/commit/c0",
    verified: false,
  };
  const seedDetail = () =>
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: { ...summaryToPr(prSummary(7)), commits: [cappedRow] } } });
  const commitResult = (commits: unknown[], truncated = false) => ({ commits, truncated });

  it("replaces the capped list with the full, verified GraphQL list", async () => {
    seedDetail();
    invokeMock.mockResolvedValueOnce(
      commitResult([
        { oid: "c0", headline: "first", authoredDate: "2026-01-01T00:00:00Z", authorName: "A", authorLogin: "a", verified: true },
        { oid: "c1", headline: "second", authoredDate: "2026-01-02T00:00:00Z", authorName: "B", authorLogin: "b", verified: false },
      ], true),
    );

    await usePulls.getState().loadPrCommits(7);

    const s = usePulls.getState();
    expect(invokeMock).toHaveBeenCalledWith("pull_request_commits", {
      path: "/repo",
      number: 7,
      account: null,
    });
    // The whole list is replaced (2 rows, past the fast-path's 1) with real verified flags.
    expect(s.prResources.detail.data[7].commits.map((c) => c.oid)).toEqual(["c0", "c1"]);
    expect(s.prResources.detail.data[7].commits.map((c) => c.verified)).toEqual([true, false]);
    expect(s.prResources.commits.data[7]).toBeTruthy();
    expect(s.prResources.commits.data[7]?.truncated).toBe(true);
  });

  it("keeps the fast-path list and records a scoped error on failure", async () => {
    seedDetail();
    invokeMock.mockRejectedValueOnce("commits blew up");

    await usePulls.getState().loadPrCommits(7);

    const s = usePulls.getState();
    expect(s.prResources.commits.errors[7]).toContain("commits blew up");
    expect(s.prResources.detail.data[7].commits).toEqual([cappedRow]); // fast-path list preserved
    expect(s.prError).toBeNull(); // list-level error untouched
    expect(s.prResources.commits.data[7]).toBeUndefined();
  });

  it("discards a stale response when the PR's resource version changed mid-flight", async () => {
    seedDetail();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = usePulls.getState().loadPrCommits(7);
    // A refresh bumps the PR's resource version while the read is in flight.
    usePulls.setState((s) => ({ prResourceVersion: { ...s.prResourceVersion, 7: 1 } }));
    pending.resolve(
      commitResult([
        { oid: "c9", headline: "late", authoredDate: "2026-01-03T00:00:00Z", authorName: "C", authorLogin: "c", verified: true },
      ]),
    );
    await load;

    // The pre-refresh response is dropped rather than repopulating the evicted cache.
    expect(usePulls.getState().prResources.detail.data[7].commits).toEqual([cappedRow]);
  });

  it("discards a stale error when the PR's resource version changed mid-flight (GL-164)", async () => {
    seedDetail();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = usePulls.getState().loadPrCommits(7);
    // A refresh prunes the PR while the read is in flight — the slow failure
    // that lands afterwards belongs to the evicted generation.
    usePulls.setState((s) => ({ prResourceVersion: { ...s.prResourceVersion, 7: 1 } }));
    pending.reject(new Error("slow failure after prune"));
    await load;

    expect(usePulls.getState().prResources.commits.errors[7]).toBeUndefined();
  });

  it("discards an older request's late failure after a newer same-generation load succeeded (GL-164)", async () => {
    seedDetail();
    const older = deferred<unknown>();
    invokeMock.mockReturnValueOnce(older.promise);
    const loadA = usePulls.getState().loadPrCommits(7);

    // An unchanged refresh reruns the Commits tab effect: same resource
    // version, second load. It succeeds while A is still pending.
    invokeMock.mockResolvedValueOnce(
      commitResult([
        { oid: "c1", headline: "fresh", authoredDate: "2026-01-02T00:00:00Z", authorName: "B", authorLogin: "b", verified: true },
      ]),
    );
    await usePulls.getState().loadPrCommits(7, true);
    expect(usePulls.getState().prResources.commits.data[7]).toBeTruthy();

    older.reject(new Error("slow failure from the superseded request"));
    await loadA;

    const s = usePulls.getState();
    expect(s.prResources.commits.errors[7]).toBeUndefined(); // the stale error never lands
    expect(s.prResources.detail.data[7].commits.map((c) => c.oid)).toEqual(["c1"]);
  });

  it("keeps the newer request's commits when an older same-generation success lands late (GL-164)", async () => {
    seedDetail();
    const older = deferred<unknown>();
    invokeMock.mockReturnValueOnce(older.promise);
    const loadA = usePulls.getState().loadPrCommits(7);

    invokeMock.mockResolvedValueOnce(
      commitResult([
        { oid: "c2", headline: "newer", authoredDate: "2026-01-02T00:00:00Z", authorName: "B", authorLogin: "b", verified: true },
      ]),
    );
    await usePulls.getState().loadPrCommits(7, true);

    older.resolve(
      commitResult([
        { oid: "c9", headline: "stale", authoredDate: "2026-01-01T00:00:00Z", authorName: "A", authorLogin: "a", verified: false },
      ]),
    );
    await loadA;

    // The newer request's list stays authoritative.
    expect(usePulls.getState().prResources.detail.data[7].commits.map((c) => c.oid)).toEqual(["c2"]);
  });

  it("drops a commits response fetched under a previous account (GL-166)", async () => {
    seedDetail();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = usePulls.getState().loadPrCommits(7); // under account A (null)
    // Account rebinds while the request is in flight; the detail cache survives,
    // so without the key guard the old account's commits would merge into it.
    useAccounts.setState({ repoAccountRef: account("88") });

    pending.resolve(
      commitResult([
        { oid: "c9", headline: "old account", authoredDate: "2026-01-03T00:00:00Z", authorName: "C", authorLogin: "c", verified: true },
      ]),
    );
    await load;

    expect(usePulls.getState().prResources.detail.data[7].commits).toEqual([cappedRow]);
    expect(usePulls.getState().prResources.commits.data[7]).toBeUndefined();
  });

  it("clears a prior commits error when a retry succeeds (GL-164)", async () => {
    seedDetail();
    seedPrResource(PR_RESOURCE.Commits, { errors: { 7: "earlier failure" } });
    invokeMock.mockResolvedValueOnce(
      commitResult([
        { oid: "c0", headline: "retry", authoredDate: "2026-01-01T00:00:00Z", authorName: "A", authorLogin: "a", verified: true },
      ]),
    );

    await usePulls.getState().loadPrCommits(7, true);

    const s = usePulls.getState();
    expect(s.prResources.commits.errors[7]).toBeUndefined();
    expect(s.prResources.commits.data[7]).toBeTruthy();
  });
});

// The staleness rule every lazy per-PR resource shares, tested once against the
// module that now owns it (GL-349) rather than five times against five copies.
// The version is bumped directly here so the rule is isolated: in the app a
// prune also evicts the request slot, which would drop the response anyway —
// this asserts the second guard on its own, the one `loadPrChecks` was missing.
describe("per-PR resource staleness (one rule, five resources)", () => {
  const detailPayload = {
    ...prSummary(7),
    body: "",
    comments: 0,
    files: [],
    commentList: [],
    mergeable: "UNKNOWN",
    reviewers: [],
    reviews: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
  };

  const resources = [
    {
      name: "detail",
      response: detailPayload,
      load: (force?: boolean) => usePulls.getState().loadPrDetail(7, force),
      cached: () => usePulls.getState().prResources.detail.data[7],
      errors: () => usePulls.getState().prResources.detail.errors,
    },
    {
      name: "checks",
      response: [{ name: "build", state: "pass" }],
      load: (force?: boolean) => usePulls.getState().loadPrChecks(7, force),
      cached: () => usePulls.getState().prResources.checks.data[7],
      errors: () => usePulls.getState().prResources.checks.errors,
    },
    {
      name: "diff",
      response: [],
      load: (force?: boolean) => usePulls.getState().loadPrDiff(7, force),
      cached: () => usePulls.getState().prResources.diff.data[7],
      errors: () => usePulls.getState().prResources.diff.errors,
    },
    {
      name: "threads",
      response: { threads: [], truncated: false },
      load: (force?: boolean) => usePulls.getState().loadPrThreads(7, force),
      cached: () => usePulls.getState().prResources.threads.data[7]?.threads,
      errors: () => usePulls.getState().prResources.threads.errors,
    },
    {
      name: "commits",
      response: { commits: [], truncated: false },
      // Commits patch a cached detail, so one has to exist for the load to run.
      seed: () => seedPrResource(PR_RESOURCE.Detail, { data: { 7: summaryToPr(prSummary(7)) } }),
      load: (force?: boolean) => usePulls.getState().loadPrCommits(7, force),
      cached: () => usePulls.getState().prResources.commits.data[7],
      errors: () => usePulls.getState().prResources.commits.errors,
    },
  ];

  it.each(resources)("discards a $name response whose version moved mid-flight", async (r) => {
    r.seed?.();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = r.load();
    usePulls.setState((s) => ({ prResourceVersion: { ...s.prResourceVersion, 7: 1 } }));
    pending.resolve(r.response);
    await load;

    expect(r.cached()).toBeUndefined();
  });

  it.each(resources)("discards a $name failure whose version moved mid-flight", async (r) => {
    r.seed?.();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = r.load();
    usePulls.setState((s) => ({ prResourceVersion: { ...s.prResourceVersion, 7: 1 } }));
    pending.reject(new Error("boom"));
    await load;

    expect(r.errors()[7]).toBeUndefined();
  });

  it.each(resources)("releases the $name slot even when the response is stale", async (r) => {
    r.seed?.();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);

    const load = r.load();
    usePulls.setState((s) => ({ prResourceVersion: { ...s.prResourceVersion, 7: 1 } }));
    pending.resolve(r.response);
    await load;

    // A dropped response must still free the slot, or a retry can never load.
    r.seed?.();
    invokeMock.mockResolvedValueOnce(r.response);
    await r.load(true);
    expect(r.cached()).toBeDefined();
  });
});
