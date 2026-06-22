import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import { PrMeta } from "./PrMeta";

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

// A merged, self-authored PR: no reviewers/assignees/labels/milestone, and the
// only participant is the author (as `detailToPr` always seeds it). This is the
// case that previously rendered an empty bordered box.
function makePr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    num: 27,
    state: "merged",
    draft: false,
    title: "feat: selectable accent colour",
    branch: "feat/accent",
    base: "develop",
    author,
    age: "17h",
    add: 296,
    del: 12,
    files: [],
    comments: 0,
    body: "",
    url: "https://github.com/x/y/pull/27",
    commentList: [],
    mergeable: "",
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
    participants: [author],
    ...over,
  };
}

describe("PrMeta", () => {
  it("renders nothing when the only metadata is the author in participants", () => {
    const { container } = render(<PrMeta pr={makePr()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the strip once a real reviewer is present", () => {
    render(<PrMeta pr={makePr({ reviewers: [{ name: "Sam", initials: "SA", state: "approved" }] })} />);
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
  });

  it("hides extras (Labels) behind the chevron when a primary row is present", async () => {
    const pr = makePr({
      reviewers: [{ name: "Sam", initials: "SA", state: "approved" }],
      labels: [{ name: "enhancement", color: "a2eeef" }],
    });
    render(<PrMeta pr={pr} />);
    // Collapsed by default — Labels not visible until the chevron is clicked.
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTitle("Show more"));
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getByText("enhancement")).toBeInTheDocument();
  });

  it("reveals extras inline when there's no reviewers/assignees row to host the chevron", () => {
    // Labels present but no reviewers/assignees: the strip must still surface the
    // labels (previously they were trapped behind a chevron that never rendered).
    const pr = makePr({ labels: [{ name: "bug", color: "d73a4a" }] });
    render(<PrMeta pr={pr} />);
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
  });
});
