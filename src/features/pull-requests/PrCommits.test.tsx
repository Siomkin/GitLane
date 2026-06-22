// Finding: the Commits tab must render the count badge + every commit row from
// GitHub, fall back when author metadata is missing, copy the full SHA, and show
// an intentional empty state — without disturbing the other tabs. The detail is
// seeded into the store directly; loadPrDetail no-ops because the repo summary is
// null in tests, so no IPC is involved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PrCommitView, PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { PullRequestDetail } from "./PullRequestDetail";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const author: PrAuthor = { name: "Alex Smith", login: "alexsmith", initials: "AS" };

const commit = (over: Partial<PrCommitView> = {}): PrCommitView => ({
  oid: "9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30",
  shortOid: "9f2c1ab",
  headline: "feat: add the thing",
  age: "2h",
  author,
  hasAuthor: true,
  url: "https://github.com/x/y/commit/9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30",
  verified: false,
  ...over,
});

function makePr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    num: 42,
    state: "open",
    draft: false,
    title: "feat: thing",
    branch: "feat/thing",
    base: "develop",
    author,
    age: "2h",
    add: 1,
    del: 0,
    files: [],
    comments: 0,
    body: "",
    url: "https://github.com/x/y/pull/42",
    commentList: [],
    mergeable: "MERGEABLE",
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [commit()],
    participants: [author],
    ...over,
  };
}

function seed(pr: PullRequest) {
  usePulls.setState({ pullRequests: [pr], prDetails: { [pr.num]: pr } });
  useUi.setState({ prSelected: pr.num, prFilter: "all", prTab: "commits" });
}

beforeEach(() => {
  usePulls.setState({ pullRequests: [], prDetails: {}, prDetailError: {} });
  useUi.setState({ prSelected: null, prTab: "info" });
});

describe("Commits tab", () => {
  it("shows the commit count badge and a row per commit", () => {
    const commits = [
      commit({ oid: "aaaaaaa1111", shortOid: "aaaaaa1", headline: "first commit" }),
      commit({ oid: "bbbbbbb2222", shortOid: "bbbbbb2", headline: "second commit" }),
    ];
    seed(makePr({ commits }));
    render(<PullRequestDetail />);

    // Tab label + count, and both commit subjects with their short SHAs.
    expect(screen.getByText("Commits")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("first commit")).toBeInTheDocument();
    expect(screen.getByText("second commit")).toBeInTheDocument();
    expect(screen.getByText("aaaaaa1")).toBeInTheDocument();
    expect(screen.getByText("bbbbbb2")).toBeInTheDocument();
  });

  it("shows a Verified badge only for GitHub-verified commits", () => {
    seed(
      makePr({
        commits: [
          commit({ oid: "v1", shortOid: "v1", headline: "signed commit", verified: true }),
          commit({ oid: "u1", shortOid: "u1", headline: "unsigned commit", verified: false }),
        ],
      }),
    );
    render(<PullRequestDetail />);
    // Exactly one badge — the signed commit.
    expect(screen.getAllByText("Verified")).toHaveLength(1);
    expect(screen.getByTitle("Signature verified by GitHub")).toBeInTheDocument();
  });

  it("renders a fallback when GitHub returns no author", () => {
    seed(
      makePr({
        commits: [
          commit({
            hasAuthor: false,
            author: { name: "Unknown author", login: "", initials: "?" },
          }),
        ],
      }),
    );
    render(<PullRequestDetail />);
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
  });

  it("copies the full SHA when the SHA pill is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    seed(makePr());
    render(<PullRequestDetail />);

    await userEvent.click(screen.getByTitle(/Copy full SHA/));
    expect(writeText).toHaveBeenCalledWith("9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30");
  });

  it("shows an intentional empty state when there are no commits", () => {
    seed(makePr({ commits: [] }));
    render(<PullRequestDetail />);
    expect(screen.getByText("No commits on this pull request.")).toBeInTheDocument();
  });

  it("opens the commit on GitHub from the row's link", async () => {
    seed(makePr());
    render(<PullRequestDetail />);
    await userEvent.click(screen.getByLabelText("Open commit on GitHub"));
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/x/y/commit/9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25e30",
    );
  });

  it("omits the GitHub link when no commit url could be derived", () => {
    seed(makePr({ commits: [commit({ url: "" })] }));
    render(<PullRequestDetail />);
    expect(screen.queryByLabelText("Open commit on GitHub")).not.toBeInTheDocument();
  });
});
