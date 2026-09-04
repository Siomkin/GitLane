// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { seedPrResource } from "@/test/prResources";
import { PR_RESOURCE } from "@/store/pullsResource";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useNotifications } from "@/store/notifications";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { summaryToPr, type PrDetail } from "@/lib/prs";
import {
  ForgeKind,
  type GithubAccountRef,
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
    seedPrResource(PR_RESOURCE.Detail, {
      // A detail seeded from a summary + capped commits: the other detail fields
      // are irrelevant to the commits load under test, so the cast fills them.
      data: { 7: { ...summaryToPr(prSummary(7)), commits: [cappedRow] } as PrDetail },
    });
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

  it("force list refresh keeps the in-flight commits slot but its version bump discards the late write (GL-164)", async () => {
    seedDetail();
    const pending = deferred<unknown>();
    const list = deferred<PullRequestSummary[]>();
    invokeMock.mockReturnValueOnce(pending.promise).mockReturnValueOnce(list.promise);

    const load = usePulls.getState().loadPrCommits(7);
    const slot = usePulls.getState().prResources.commits.slots[7];
    expect(slot).toBeTruthy();

    const refresh = usePulls.getState().loadPullRequests(true);
    // clearPrResources: every other resource's slots empty, but the commits
    // slot deliberately survives so the in-flight request still owns it…
    expect(usePulls.getState().prResources.commits.slots[7]).toBe(slot);

    list.resolve([prSummary(7)]);
    await refresh;

    // …and the force path's version bump is what discards its late write.
    pending.resolve(
      commitResult([
        { oid: "c9", headline: "stale", authoredDate: "2026-01-01T00:00:00Z", authorName: "A", authorLogin: "a", verified: false },
      ]),
    );
    await load;

    const s = usePulls.getState();
    expect(s.prResources.commits.data[7]).toBeUndefined();
    // The surviving claim let the settled request release its own slot.
    expect(s.prResources.commits.slots).toEqual({});
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
      seed: () => seedPrResource(PR_RESOURCE.Detail, { data: { 7: prDetail(prSummary(7)) } }),
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
