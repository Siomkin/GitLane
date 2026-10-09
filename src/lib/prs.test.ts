import { describe, it, expect } from "vitest";
import { detailToPr, selectVisiblePrs, summaryToPr, uiCommits } from "./prs";
import { ForgeKind, type PrComment, type PullRequestDetail, type PullRequestSummary, type RepoForge } from "./api";

const ISO = "2026-01-01T00:00:00Z";

const repoForge = (kind: ForgeKind, webUrl: string): RepoForge => ({
  hasRemote: true,
  kind,
  forge: kind,
  host: new URL(webUrl).host,
  webUrl,
});
const GH = repoForge(ForgeKind.GitHub, "https://github.com/acme/widgets");

function makeSummary(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: "t",
    state: "OPEN",
    headRef: "feat",
    baseRef: "main",
    author: { login: "alexsmith", name: "Alex Smith" },
    createdAt: ISO,
    additions: 3,
    deletions: 2,
    changedFiles: 4,
    isDraft: false,
    url: "https://github.com/o/r/pull/1",
    mergeable: "UNKNOWN",
    ...over,
  };
}

function makeDetail(over: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    ...makeSummary(),
    body: "",
    comments: 0,
    files: [],
    commentList: [],
    mergeable: "MERGEABLE",
    reviewers: [],
    reviews: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
    ...over,
  };
}

const comment = (login: string, name: string): PrComment => ({
  author: { login, name },
  body: "hi",
  createdAt: ISO,
});

describe("summaryToPr", () => {
  it("carries the list fields, including the changed-file count", () => {
    const pr = summaryToPr(makeSummary());
    expect(pr).toMatchObject({
      num: 1,
      state: "open",
      draft: false,
      title: "t",
      branch: "feat",
      base: "main",
      add: 3,
      del: 2,
      changedFiles: 4,
      url: "https://github.com/o/r/pull/1",
      mergeable: "UNKNOWN",
    });
    expect(pr.author).toMatchObject({ name: "Alex Smith", login: "alexsmith", initials: "AS" });
  });

  it("invents no detail sentinels — the detail-only fields are absent, not zeroed", () => {
    const pr = summaryToPr(makeSummary());
    // The live bug this split fixes: a summary whose `files`/`commits` read as
    // `[]` rendered literal 0 badges while `changedFiles` held the real count.
    expect(pr).not.toHaveProperty("files");
    expect(pr).not.toHaveProperty("comments");
    expect(pr).not.toHaveProperty("body");
    expect(pr).not.toHaveProperty("commentList");
    expect(pr).not.toHaveProperty("reviewers");
    expect(pr).not.toHaveProperty("assignees");
    expect(pr).not.toHaveProperty("labels");
    expect(pr).not.toHaveProperty("milestone");
    expect(pr).not.toHaveProperty("commits");
    expect(pr).not.toHaveProperty("participants");
  });

  it("maps merged/closed states to their lowercase view forms", () => {
    expect(summaryToPr(makeSummary({ state: "MERGED" })).state).toBe("merged");
    expect(summaryToPr(makeSummary({ state: "CLOSED" })).state).toBe("closed");
  });

  it("keeps an unrecognised forge state raw instead of coercing it to closed", () => {
    const pr = summaryToPr(makeSummary({ state: "QUEUED" }));
    expect(pr.state).toBe("other");
    expect(pr.rawState).toBe("QUEUED");
    expect(summaryToPr(makeSummary({ state: "OPEN" }))).not.toHaveProperty("rawState");
  });

  it("does not list an unrecognised state under Open", () => {
    const prs = [
      summaryToPr(makeSummary({ number: 1, state: "OPEN" })),
      summaryToPr(makeSummary({ number: 2, state: "QUEUED" })),
    ];
    expect(selectVisiblePrs(prs, "open").map((p) => p.num)).toEqual([1]);
    expect(selectVisiblePrs(prs, "all").map((p) => p.num)).toEqual([1, 2]);
  });
});

describe("detailToPr participants", () => {
  it("dedupes the author when they reappear as a login-only commenter", () => {
    // The PR author carries a display name; the same person's comment carries
    // only a login. Deduping by name would list them twice — dedupe by login.
    const pr = detailToPr(makeDetail({ commentList: [comment("alexsmith", "")] }), GH);
    expect(pr.participants.map((p) => p.login)).toEqual(["alexsmith"]);
  });

  it("keeps two different people who happen to share a display name", () => {
    const pr = detailToPr(
      makeDetail({ commentList: [comment("other", "Alex Smith")] }),
      GH,
    );
    expect(pr.participants.map((p) => p.login).sort()).toEqual(["alexsmith", "other"]);
  });

  it("preserves login on the view-model author", () => {
    const pr = detailToPr(makeDetail(), GH);
    expect(pr.author.login).toBe("alexsmith");
  });
});

describe("detailToPr commits", () => {
  it("maps commits in order with a short SHA, age, and author initials", () => {
    const pr = detailToPr(
      makeDetail({
        commits: [
          {
            oid: "9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30",
            headline: "feat: thing",
            authoredDate: ISO,
            authorName: "Alex Smith",
            authorLogin: "alexsmith",
            verified: false,
          },
        ],
      }),
      GH,
    );
    expect(pr.commits).toHaveLength(1);
    const c = pr.commits[0];
    expect(c.oid).toBe("9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30");
    expect(c.shortOid).toBe("9f2c1ab");
    expect(c.headline).toBe("feat: thing");
    expect(c.hasAuthor).toBe(true);
    expect(c.author.name).toBe("Alex Smith");
    expect(c.author.initials).toBe("AS");
  });

  it("falls back gracefully when GitHub returns no author metadata", () => {
    const pr = detailToPr(
      makeDetail({
        commits: [
          { oid: "abc1234def", headline: "chore: tidy", authoredDate: ISO, authorName: "", authorLogin: "", verified: false },
        ],
      }),
      GH,
    );
    const c = pr.commits[0];
    expect(c.hasAuthor).toBe(false);
    expect(c.author.name).toBe("Unknown author");
    expect(c.author.initials).toBe("?");
    expect(c.shortOid).toBe("abc1234");
  });

  it("links each commit on the repo forge", () => {
    const pr = detailToPr(
      makeDetail({
        url: "https://github.com/acme/widgets/pull/42",
        commits: [
          { oid: "deadbeef", headline: "x", authoredDate: ISO, authorName: "A", authorLogin: "a", verified: false },
        ],
      }),
      GH,
    );
    expect(pr.commits[0].url).toBe("https://github.com/acme/widgets/commit/deadbeef");
  });
});

describe("PR commit links", () => {
  const commit = { oid: "abc123", headline: "x", authoredDate: ISO, authorName: "A", authorLogin: "a", verified: false };

  it("links each commit to its page on the repo's own forge", () => {
    expect(uiCommits([commit], GH)[0].url).toBe("https://github.com/acme/widgets/commit/abc123");
    // GitLab and Bitbucket PR urls have no `/pull/` segment; the rows still link.
    expect(uiCommits([commit], repoForge(ForgeKind.GitLab, "https://gitlab.com/acme/widgets"))[0].url).toBe(
      "https://gitlab.com/acme/widgets/-/commit/abc123",
    );
    expect(uiCommits([commit], repoForge(ForgeKind.Bitbucket, "https://bitbucket.org/acme/widgets"))[0].url).toBe(
      "https://bitbucket.org/acme/widgets/commits/abc123",
    );
  });

  it("is empty when there is no forge web URL", () => {
    expect(uiCommits([commit], null)[0].url).toBe("");
    expect(uiCommits([commit], { ...GH, webUrl: null })[0].url).toBe("");
  });
});

describe("uiCommits", () => {
  it("maps the full commit list, carrying each commit's authoritative verified flag", () => {
    const rows = uiCommits(
      [
        { oid: "signed", headline: "a", authoredDate: ISO, authorName: "A", authorLogin: "a", verified: true },
        { oid: "unsigned", headline: "b", authoredDate: ISO, authorName: "B", authorLogin: "b", verified: false },
      ],
      GH,
    );
    expect(rows.map((c) => c.verified)).toEqual([true, false]);
    // Order preserved; per-commit url derived from the PR url.
    expect(rows.map((c) => c.oid)).toEqual(["signed", "unsigned"]);
    expect(rows[0].url).toBe("https://github.com/acme/widgets/commit/signed");
  });

  it("returns an empty list for an empty commit set", () => {
    expect(uiCommits([], GH)).toEqual([]);
  });
});
