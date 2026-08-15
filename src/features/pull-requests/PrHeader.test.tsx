// Finding: the tab badges used to read `files.length` / `commits.length` off
// whatever PR shape the header was handed. During the summary phase those
// fields were sentinel `[]`s, so the Diff and Commits tabs showed literal 0s
// while `changedFiles` on the same object held the real count. The header must
// show the summary's real count and no Commits count at all until the detail
// lands.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrAuthor, PrCommitView, PrDetail, PrSummary } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { emptyPrResources } from "@/store/pullsResource";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { PrHeader } from "./PrHeader";

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

const commit = (oid: string): PrCommitView => ({
  oid,
  shortOid: oid.slice(0, 7),
  headline: "feat: thing",
  age: "1h",
  author,
  hasAuthor: true,
  url: "",
  verified: false,
});

/** List-summary shape only — exactly what renders before the detail fetch. */
const summary: PrSummary = {
  num: 42,
  state: "open",
  draft: false,
  title: "feat: thing",
  branch: "feat/thing",
  base: "develop",
  author,
  age: "2h",
  add: 10,
  del: 2,
  changedFiles: 7,
  url: "https://github.com/x/y/pull/42",
  mergeable: "MERGEABLE",
};

const detail: PrDetail = {
  ...summary,
  // Consistent with `files` below — the badge reads `changedFiles` for both
  // shapes, so a detail's count must agree with its file list.
  changedFiles: 2,
  files: ["a.ts", "b.ts"],
  comments: 3,
  body: "A description.",
  commentList: [],
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  commits: [commit("9f2c1ab4e7d05c1182a6f0b3d4e8a91c77b25a30")],
  participants: [author],
};

beforeEach(() => {
  useUi.setState({ prTab: "info" });
  useRepo.setState({ forge: null });
  usePulls.setState({ prResources: emptyPrResources() });
});

describe("PrHeader tab badges", () => {
  it("shows the summary's changedFiles on the Diff tab — never a sentinel 0", () => {
    render(<PrHeader pr={summary} />);

    const diffTab = screen.getByRole("button", { name: /diff/i });
    expect(diffTab).toHaveTextContent("7");
    expect(diffTab).not.toHaveTextContent("0");
  });

  it("shows no Commits count for a summary-only PR (there is no commit list yet)", () => {
    render(<PrHeader pr={summary} />);

    expect(screen.getByRole("button", { name: /^commits$/i })).toHaveTextContent(/^Commits$/);
  });

  it("shows the file and commit counts once the detail lands", () => {
    render(<PrHeader pr={detail} />);

    expect(screen.getByRole("button", { name: /diff/i })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /commits/i })).toHaveTextContent("1");
  });
});
