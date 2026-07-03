// Finding: the Diff tab renders one card per FileDiff — and `gh pr diff
// --patch` is per-commit, so a path touched by several commits legitimately
// appears more than once (GL-112). Both cards must render with their own
// hunks; a path-only React key used to collide here. The diff is seeded into
// the store directly; loadPrDiff no-ops because the repo summary is null in
// tests, so no IPC is involved.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import type { FileDiff } from "../../lib/api/git";
import { usePulls } from "../../store/pulls";
import { PrDiffTab } from "./PrDiffTab";

const author: PrAuthor = { name: "Alex Smith", login: "alexsmith", initials: "AS" };

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
    changedFiles: 0,
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
    commits: [],
    participants: [author],
    ...over,
  };
}

function fileDiff(over: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/one.txt",
    status: "M",
    add: 1,
    del: 0,
    binary: false,
    hunks: [],
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  usePulls.setState({ prDiffs: {}, prDiffError: {} });
});

describe("PR Diff tab", () => {
  it("renders a card per FileDiff even when two commits touch the same path", () => {
    usePulls.setState({
      prDiffs: {
        42: [
          fileDiff({
            hunks: [
              {
                header: "@@ -1 +1 @@",
                lines: [{ kind: "add", oldNo: null, newNo: 1, content: "from first commit" }],
              },
            ],
          }),
          fileDiff({
            hunks: [
              {
                header: "@@ -2 +2 @@",
                lines: [{ kind: "add", oldNo: null, newNo: 2, content: "from second commit" }],
              },
            ],
          }),
        ],
      },
    });
    const { container } = render(<PrDiffTab pr={makePr()} />);

    // Two cards for the same path, each with its own commit's hunk. Hunk text
    // is asserted via textContent: syntax highlighting splits it into spans.
    expect(screen.getAllByText("one.txt")).toHaveLength(2);
    expect(container.textContent).toContain("from first commit");
    expect(container.textContent).toContain("from second commit");
  });

  it("shows the empty state when the PR changes no files", () => {
    usePulls.setState({ prDiffs: { 42: [] } });
    render(<PrDiffTab pr={makePr()} />);
    expect(screen.getByText("No file changes in this PR.")).toBeInTheDocument();
  });
});
