// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { seedPrResource, seedThreads } from "@/test/prResources";
import { PR_RESOURCE } from "@/store/pullsResource";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useNotifications } from "@/store/notifications";
import { PR_PENDING_ACTION, anyPrActionPending, isPrActionPending, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { summaryToPr, type PrDetail } from "@/lib/prs";
import {
  ForgeKind,
  type GithubAccountRef,
  type PrCheck,
  type PullRequestSummary,
  type RepoForge,
  type RepoSummary,
}from "@/lib/api";

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

/** Cached-detail fixture: the summary plus the detail-only fields a real
 * `detailToPr` fills (empty is fine — these tests compare summary-level
 * staleness and assert only cache presence/absence). */
const prDetail = (s: PullRequestSummary): PrDetail => ({
  ...summaryToPr(s),
  files: [],
  comments: 0,
  body: "",
  commentList: [],
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  commits: [],
  participants: [],
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

    const firstWrite = usePulls.getState().approvePr(7);
    const secondWrite = usePulls.getState().approvePr(7);

    const pending = usePulls.getState().prPendingActions;
    expect(pending).toHaveLength(2);
    expect(pending.map(({ action, prNum }) => ({ action, prNum }))).toEqual([
      { action: PR_PENDING_ACTION.Approve, prNum: 7 },
      { action: PR_PENDING_ACTION.Approve, prNum: 7 },
    ]);
    expect(new Set(pending.map(({ id }) => id)).size).toBe(2);

    first.reject(new Error("first failed"));
    await expect(firstWrite).rejects.toThrow("first failed");
    expect(usePulls.getState().prPendingActions.map(({ id }) => id)).toEqual([pending[1].id]);

    second.reject(new Error("second failed"));
    await expect(secondWrite).rejects.toThrow("second failed");
    expect(usePulls.getState().prPendingActions).toEqual([]);
  });

  it("pending-action predicates match action + PR, not other PRs or other actions", () => {
    usePulls.setState({
      prPendingActions: [
        { id: 1, action: PR_PENDING_ACTION.Merge, prNum: 7 },
        { id: 2, action: PR_PENDING_ACTION.Approve, prNum: 9 },
      ],
    });
    const s = usePulls.getState();

    expect(isPrActionPending(PR_PENDING_ACTION.Merge, 7)(s)).toBe(true);
    // Same PR, different action — the merge button must not light up for approval.
    expect(isPrActionPending(PR_PENDING_ACTION.Approve, 7)(s)).toBe(false);
    // Same action, different PR — one PR's merge is not another's.
    expect(isPrActionPending(PR_PENDING_ACTION.Merge, 9)(s)).toBe(false);
    // Action-only (no PR): matches the action on any PR.
    expect(isPrActionPending(PR_PENDING_ACTION.Approve)(s)).toBe(true);
    expect(anyPrActionPending()(s)).toBe(true);
  });

  it("pending-action predicates narrow State entries to the exact verb", () => {
    usePulls.setState({
      prPendingActions: [
        { id: 1, action: PR_PENDING_ACTION.State, prNum: 7, stateAction: "close" },
        { id: 2, action: PR_PENDING_ACTION.Approve, prNum: 7 },
      ],
    });
    const s = usePulls.getState();

    expect(isPrActionPending(PR_PENDING_ACTION.State, 7, { stateAction: "close" })(s)).toBe(true);
    expect(isPrActionPending(PR_PENDING_ACTION.State, 7, { stateAction: "reopen" })(s)).toBe(false);
    expect(isPrActionPending(PR_PENDING_ACTION.Approve, 7)(s)).toBe(true);
  });

  it("pending-action predicates report nothing pending on an empty multiset", () => {
    const s = usePulls.getState(); // reset in beforeEach

    expect(isPrActionPending(PR_PENDING_ACTION.Merge, 7)(s)).toBe(false);
    expect(isPrActionPending(PR_PENDING_ACTION.Create)(s)).toBe(false);
    expect(anyPrActionPending()(s)).toBe(false);
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

  it("does not use the global PR pending flag for review-thread actions", async () => {
    let finishResolve!: (value: string) => void;
    invokeMock.mockReturnValueOnce(new Promise<string>((resolve) => {
      finishResolve = resolve;
    }));

    const pending = usePulls.getState().resolveThread(7, "thread-1", true);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "resolve_review_thread", {
      path: "/repo",
      number: 7,
      threadId: "thread-1",
      resolved: true,
      account: null,
    });
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
    expect(usePulls.getState().prsRefresh).toEqual(
      expect.objectContaining({ requestId: expect.any(Number), key: expect.any(String) }),
    );
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
    expect(usePulls.getState().prsRefresh).not.toBeNull();
    expect(usePulls.getState().pullRequests).toEqual([]);

    newFetch.resolve([prSummary(9)]);
    await newLoad;

    expect(usePulls.getState().prsLoading).toBe(false);
    expect(usePulls.getState().prsRefresh).toBeNull();
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
    // And one more: `lib/api/invoke` hands back the transport's promise with a
    // rejection handler attached (CommandError conversion), so every IPC
    // result lands a microtask after the mocked promise does.
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
    expect(s.prsRefresh).toBeNull();
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
    expect(s.prsRefresh).toBeNull();
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
    // And another for `lib/api/invoke`'s rejection handler (CommandError
    // conversion), which settles one microtask after the mocked promise.
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
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7)) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { state: "CLOSED" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // The summary now says closed, so the stale open detail is evicted and the
    // detail effect (keyed on prsFetchedAt) will refetch it.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
    expect(usePulls.getState().pullRequests.map((p) => p.num)).toEqual([7]);
  });

  it("drops a cached detail when new commits change the diff size", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7, { additions: 1 })) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { additions: 42 })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Same open state, but additions changed (new commits) → evict so the
    // Diff/Commits tabs refetch instead of showing stale files.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("drops a cached detail when only the changed-file count differs", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7, { changedFiles: 3 })) } });
    // Net +/- unchanged (default 1/0) but files moved/replaced → changedFiles differs.
    invokeMock.mockResolvedValueOnce([prSummary(7, { changedFiles: 5 })]);

    await usePulls.getState().loadPullRequests(false, true);

    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("drops a cached detail when mergeability flips to a definitive verdict", async () => {
    usePulls.setState({ prsFetchedAt: 1 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7, { mergeable: "MERGEABLE" })) } });
    invokeMock.mockResolvedValueOnce([prSummary(7, { mergeable: "CONFLICTING" })]);

    await usePulls.getState().loadPullRequests(false, true);

    // Base advanced into a conflict → invalidate so MergeMenu stops offering Merge.
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("ignores an UNKNOWN mergeable verdict when pruning", async () => {
    const detail = prDetail(prSummary(7, { mergeable: "MERGEABLE" }));
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
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7)) } });

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
    seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7)) } });
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
    const detail = prDetail(prSummary(7));
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
    // re-probes the CLIs (one awaited IPC round-trip) and then queues a forced
    // load behind the prefetch.
    const refresh = usePulls.getState().refreshPullRequests();
    await vi.waitFor(() => expect(usePulls.getState().prsRefreshQueued).not.toBeNull());

    // Switching/closing the repo cancels the queued force load — refreshPullRequests
    // must resolve quietly rather than surface an unhandled rejection.
    usePulls.getState().reset();
    await expect(refresh).resolves.toBeUndefined();

    prefetch.resolve([prSummary(7)]);
    await load;
  });
});
