// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { seedThreads } from "@/test/prResources";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useNotifications } from "@/store/notifications";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { summaryToPr } from "@/lib/prs";
import {
  ForgeKind,
  type GithubAccountRef,
  type PrCreateInput,
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
      label: "resolve",
      command: "resolve_review_thread",
      run: () => usePulls.getState().resolveThread(7, "thread-1", true),
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

  it("stops an approval after its detail follow-up when the account changes", async () => {
    beginPublishedRepoSession();
    const detail = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "approve_pull_request") return Promise.resolve("approval ok");
      if (command === "pull_request_detail") return detail.promise;
      if (command === "pull_request_checks") {
        return Promise.reject(new Error("stale checks must not start"));
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const pending = usePulls.getState().approvePr(7);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "approve_pull_request", {
      path: "/repo",
      number: 7,
      account: null,
    });
    await vi.waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_detail")).toBe(true),
    );

    useAccounts.setState({ repoAccountRef: account("33") });
    detail.resolve({});
    await expect(pending).resolves.toBe("approval ok");

    expect(invokeMock.mock.calls.some(([command]) => command === "pull_request_checks")).toBe(false);
    expect(usePulls.getState().prResources.detail.data[7]).toBeUndefined();
  });

  it("preserves a same-owner follow-up failure after the server write succeeds", async () => {
    beginPublishedRepoSession();
    const loadPrDetail = vi.fn().mockRejectedValue(new Error("detail refresh failed"));
    try {
      usePulls.setState({ loadPrDetail });
      invokeMock.mockImplementation((command: string) => {
        if (command === "approve_pull_request") return Promise.resolve("approval ok");
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      });

      await expect(usePulls.getState().approvePr(7)).rejects.toThrow(
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
