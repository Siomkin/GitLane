// Finding: the Diff tab renders one card per FileDiff — and `gh pr diff
// --patch` is per-commit, so a path touched by several commits legitimately
// appears more than once (GL-112). Both cards must render with their own
// hunks; a path-only React key used to collide here. The diff is seeded into
// the store directly; loadPrDiff no-ops because the repo summary is null in
// tests, so no IPC is involved.
import { seedPrResource } from "@/test/prResources";
import { PR_RESOURCE } from "@/store/pullsResource";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrAuthor, PullRequest } from "@/lib/prs";
import type { FileDiff } from "@/lib/api/git";
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
  seedPrResource(PR_RESOURCE.Diff, { data: {}, errors: {} });
});

describe("PR Diff tab", () => {
  it("groups same-path cards under their commits' headers", () => {
    seedPrResource(PR_RESOURCE.Diff, { data: {
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
      } });
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
    seedPrResource(PR_RESOURCE.Diff, { data: {
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
      } });
    render(<PrDiffTab pr={makePr()} />);

    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("other.txt")).toBeInTheDocument();
    expect(screen.queryAllByTestId("commit-group-header")).toHaveLength(0);
    expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
    expect(screen.queryByText("feat: only commit")).not.toBeInTheDocument();
  });

  it("shows headers only for attributed groups when attribution is mixed", () => {
    seedPrResource(PR_RESOURCE.Diff, { data: {
        42: [
          fileDiff(),
          fileDiff({
            path: "src/other.txt",
            commitOid: "ccccccc3333333333333333333333333333333333",
            commitSubject: "fix: attributed commit",
          }),
        ],
      } });
    render(<PrDiffTab pr={makePr()} />);

    // Two groups, so headers are enabled — but the attribution-less group has
    // no oid to show, so exactly one header renders (documents the guard; a
    // real gh patch never mixes attributed and unattributed files).
    expect(screen.getAllByTestId("commit-group-header")).toHaveLength(1);
    expect(screen.getByText("ccccccc")).toBeInTheDocument();
    expect(screen.getByText("fix: attributed commit")).toBeInTheDocument();
    expect(screen.getAllByText(/\.txt$/)).toHaveLength(2);
  });

  it("stays flat when diffs carry no commit attribution", () => {
    seedPrResource(PR_RESOURCE.Diff, { data: { 42: [fileDiff(), fileDiff({ path: "src/other.txt" })] } });
    render(<PrDiffTab pr={makePr()} />);

    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("other.txt")).toBeInTheDocument();
    expect(screen.queryAllByTestId("commit-group-header")).toHaveLength(0);
  });

  it("shows the empty state when the PR changes no files", () => {
    seedPrResource(PR_RESOURCE.Diff, { data: { 42: [] } });
    render(<PrDiffTab pr={makePr()} />);
    expect(screen.getByText("No file changes in this PR.")).toBeInTheDocument();
  });

  it("bounds mounted DOM rows for a 50k-line PR patch", () => {
    const diffs = Array.from({ length: 200 }, (_, fileIndex) =>
      fileDiff({
        path: `src/file-${fileIndex}.ts`,
        add: 250,
        hunks: [
          {
            header: `@@ -0,0 +1,250 @@ file ${fileIndex}`,
            lines: Array.from({ length: 250 }, (_, lineIndex) => ({
              kind: "add" as const,
              oldNo: null,
              newNo: lineIndex + 1,
              content: `file ${fileIndex} line ${lineIndex + 1}`,
            })),
          },
        ],
      }),
    );
    seedPrResource(PR_RESOURCE.Diff, { data: { 42: diffs } });

    const { container } = render(<PrDiffTab pr={makePr()} />);

    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-index]").length).toBeLessThan(100);
    expect(screen.queryByText("file-199.ts")).not.toBeInTheDocument();
  });

  it("explains provider-side PR diff truncation without an unavailable full-load action", () => {
    seedPrResource(PR_RESOURCE.Diff, { data: { 42: [fileDiff({ truncated: true })] } });

    render(<PrDiffTab pr={makePr()} />);

    expect(
      screen.getByText("Large PR diff capped for performance — remaining lines are not shown."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show full diff" })).not.toBeInTheDocument();
  });
});
