// Finding: the composer's write buttons (Comment / Approve / Request changes)
// must show *which* action is running, not just disable. The store still gates
// concurrency globally; these assert the per-button label/spinner.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { PrConversation } from "./PrConversation";

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

function openPr(over: Partial<PullRequest> = {}): PullRequest {
  return {
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

beforeEach(() => {
  useUi.setState({ confirm: null });
  usePulls.setState({ prPendingActions: [] });
});

describe("PrConversation composer loaders", () => {
  it("shows a posting spinner on Comment while the comment is in flight", async () => {
    let resolveComment!: (v: string) => void;
    const commentPr = vi.fn(() => new Promise<string>((r) => (resolveComment = r)));
    usePulls.setState({ commentPr });

    render(<PrConversation pr={openPr()} />);
    await userEvent.type(screen.getByPlaceholderText("Leave a comment…"), "Looks good");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(commentPr).toHaveBeenCalledWith(42, "Looks good");
    const posting = await screen.findByRole("button", { name: "Posting…" });
    expect(posting).toHaveAttribute("aria-busy", "true");

    resolveComment("done");
    await waitFor(() => expect(screen.queryByText("Posting…")).not.toBeInTheDocument());
  });

  it("shows an approving spinner once the confirm dialog runs the review", async () => {
    let resolveReview!: (v: string) => void;
    const reviewPr = vi.fn(() => new Promise<string>((r) => (resolveReview = r)));
    usePulls.setState({ reviewPr });

    render(<PrConversation pr={openPr()} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    // Approve is confirm-gated — nothing runs until the dialog action fires.
    expect(reviewPr).not.toHaveBeenCalled();
    await act(async () => {
      useUi.getState().confirm?.onConfirm();
    });

    expect(reviewPr).toHaveBeenCalledWith(42, "approve", "");
    expect(await screen.findByText("Approving…")).toBeInTheDocument();

    resolveReview("done");
    await waitFor(() => expect(screen.queryByText("Approving…")).not.toBeInTheDocument());
  });
});
