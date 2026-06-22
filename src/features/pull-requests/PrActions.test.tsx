// Finding: merging must go through the confirm dialog (it's irreversible and
// deletes the branch by default), not fire immediately on strategy click.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { PrHeaderActions } from "./PrActions";

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
  usePulls.setState({ prActionPending: false });
});

describe("PrHeaderActions merge", () => {
  it("asks for confirmation instead of merging immediately", async () => {
    const mergePr = vi.fn().mockResolvedValue("done");
    usePulls.setState({ mergePr });

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    await userEvent.click(screen.getByText("Squash and merge"));

    // Nothing merged yet — a confirm request is staged with the method + branch.
    expect(mergePr).not.toHaveBeenCalled();
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm?.title).toContain("#42");
    expect(confirm?.message).toContain("feat/thing");

    // Confirming runs the merge with the chosen strategy + delete-branch default.
    confirm?.onConfirm();
    expect(mergePr).toHaveBeenCalledWith(42, "squash", true);
  });

  it("never offers merge for a conflicting PR", () => {
    render(<PrHeaderActions pr={openPr({ mergeable: "CONFLICTING" })} />);
    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
  });
});
