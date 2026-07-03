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
  it("groups same-path cards under their commits' headers", () => {
    usePulls.setState({
      prDiffs: {
        42: [
          fileDiff({
            commitOid: "aaaaaaa1111111111111111111111111111111111",
            commitSubject: "feat: first commit",
            hunks: [
              {
                header: "@@ -1 +1 @@",
                lines: [{ kind: "add", oldNo: null, newNo: 1, content: "from first commit" }],
              },
            ],
          }),
          fileDiff({
            commitOid: "bbbbbbb2222222222222222222222222222222222",
            commitSubject: "fix: second commit",
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

    // One header per commit: short SHA + subject.
    expect(screen.getAllByTestId("commit-group-header")).toHaveLength(2);
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("feat: first commit")).toBeInTheDocument();
    expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
    expect(screen.getByText("fix: second commit")).toBeInTheDocument();
  });

  it("stays flat — no commit headers — for a single-commit PR", () => {
    usePulls.setState({
      prDiffs: {
        42: [
          fileDiff({
            commitOid: "aaaaaaa1111111111111111111111111111111111",
            commitSubject: "feat: only commit",
          }),
          fileDiff({
            path: "src/other.txt",
            commitOid: "aaaaaaa1111111111111111111111111111111111",
            commitSubject: "feat: only commit",
          }),
        ],
      },
    });
    render(<PrDiffTab pr={makePr()} />);

    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("other.txt")).toBeInTheDocument();
    expect(screen.queryAllByTestId("commit-group-header")).toHaveLength(0);
    expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
    expect(screen.queryByText("feat: only commit")).not.toBeInTheDocument();
  });

  it("stays flat when diffs carry no commit attribution", () => {
    usePulls.setState({
      prDiffs: { 42: [fileDiff(), fileDiff({ path: "src/other.txt" })] },
    });
    render(<PrDiffTab pr={makePr()} />);

    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("other.txt")).toBeInTheDocument();
    expect(screen.queryAllByTestId("commit-group-header")).toHaveLength(0);
  });

  it("shows the empty state when the PR changes no files", () => {
    usePulls.setState({ prDiffs: { 42: [] } });
    render(<PrDiffTab pr={makePr()} />);
    expect(screen.getByText("No file changes in this PR.")).toBeInTheDocument();
  });
});
