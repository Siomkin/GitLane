// Finding: the card's in-flight state is keyed off a store action kind, and the
// header toolbar's ordinary single-PR merge files a pending entry on the same
// PR number. If the two are ever conflated again, this card announces layers
// that are not being landed — the assertion below is what catches that.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrStack, PrStackEntry } from "@/lib/api";
import type { PrAuthor, PrDetail } from "@/lib/prs";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { PrStackCard } from "./PrStackCard";

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

const pr: PrDetail = {
  num: 32,
  state: "open",
  draft: false,
  title: "Add frontend",
  branch: "frontend",
  base: "latest",
  author,
  age: "2h",
  add: 10,
  del: 2,
  changedFiles: 0,
  files: [],
  comments: 0,
  body: "",
  url: "https://github.com/x/y/pull/32",
  commentList: [],
  mergeable: "MERGEABLE",
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  commits: [],
  participants: [author],
};

const entry = (position: number, number: number): PrStackEntry => ({
  position,
  number,
  title: `layer ${position}`,
  state: "OPEN",
  isDraft: false,
  headRef: `branch-${position}`,
  mergeable: "MERGEABLE",
  checks: "SUCCESS",
});

const stack: PrStack = {
  number: 32,
  size: 3,
  baseRef: "latest",
  position: 3,
  entries: [entry(1, 24), entry(2, 30), entry(3, 32)],
};

beforeEach(() => {
  usePulls.setState({ prPendingActions: [] });
});

describe("PrStackCard merge state", () => {
  it("announces the stack merge while one is in flight", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.MergeStack, prNum: 32 }],
    });

    render(<PrStackCard stack={stack} pr={pr} />);

    // Scoped to the live region — the footer button carries the same label.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Merging stack…");
    expect(status).toHaveTextContent("3 pull requests are being merged.");
    expect(screen.getAllByText("Merging")).toHaveLength(3);
  });

  it("stays idle during an ordinary single-PR merge of the same PR", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Merge, prNum: 32 }],
    });

    render(<PrStackCard stack={stack} pr={pr} />);

    // Merging one PR lands one PR — the card must not claim the layers below it.
    expect(screen.getByText("Able to merge as a stack")).toBeInTheDocument();
    expect(screen.queryByText("Merging")).not.toBeInTheDocument();
  });
});
