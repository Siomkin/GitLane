// Finding: merging must go through the confirm dialog (it's irreversible and
// deletes the branch by default), not fire immediately on strategy click.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useRepo } from "../../store/repo";
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
  useRepo.setState({ checkoutBranch: vi.fn() });
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

  it("shows a busy merge label while a merge is pending", () => {
    usePulls.setState({ prPendingActions: ["merge"] });

    render(<PrHeaderActions pr={openPr()} />);

    const merge = screen.getByRole("button", { name: /Merging/ });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("aria-busy", "true");
  });

  it("disables merge without the 'Merging…' label during a non-merge PR action", () => {
    // A close/comment/etc. is in flight, not a merge: don't mislabel it as
    // "Merging…", but keep merge disabled so no concurrent write can start.
    usePulls.setState({ prPendingActions: ["state"] });

    render(<PrHeaderActions pr={openPr()} />);

    expect(screen.queryByRole("button", { name: /Merging/ })).not.toBeInTheDocument();
    const merge = screen.getByRole("button", { name: /Merge/ });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("aria-busy", "false");
  });

  it("keeps checkout in the overflow menu instead of the primary action row", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue("checked out");
    useRepo.setState({ checkoutBranch });

    render(<PrHeaderActions pr={openPr()} />);

    expect(screen.queryByText("Checkout branch")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Checkout branch"));

    expect(checkoutBranch).toHaveBeenCalledWith("feat/thing");
  });

  it("disables the overflow Close action while another PR write is pending", async () => {
    usePulls.setState({ prPendingActions: ["comment"] });

    render(<PrHeaderActions pr={openPr()} />);

    await userEvent.click(screen.getByTitle("More actions"));
    // Close is a setPrState write — it must not start concurrently with the
    // in-flight comment.
    expect(screen.getByText("Close pull request").closest("button")).toBeDisabled();
  });

  it("shows a spinner on the overflow Checkout while the checkout is in flight", async () => {
    // Checkout is a repo write, not a `gh` PR action, so it tracks its own
    // pending flag; the menu stays open to host the spinner until it resolves.
    let resolveCheckout!: (v: string) => void;
    const checkoutBranch = vi.fn(() => new Promise<string>((r) => (resolveCheckout = r)));
    useRepo.setState({ checkoutBranch });

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Checkout branch"));

    expect(checkoutBranch).toHaveBeenCalledWith("feat/thing");
    expect(screen.getByText("Checking out…")).toBeInTheDocument();

    // Resolving closes the menu and clears the pending label.
    resolveCheckout("ok");
    await waitFor(() => expect(screen.queryByText("Checking out…")).not.toBeInTheDocument());
  });

  it("shows a spinner on Reopen once the confirm dialog runs the state change", async () => {
    let resolveState!: (v: string) => void;
    const setPrState = vi.fn(() => new Promise<string>((r) => (resolveState = r)));
    usePulls.setState({ setPrState });

    render(<PrHeaderActions pr={openPr({ state: "closed" })} />);
    await userEvent.click(screen.getByText("Reopen"));

    // Nothing runs until the confirm dialog's action fires.
    expect(setPrState).not.toHaveBeenCalled();
    const confirm = useUi.getState().confirm;
    await act(async () => {
      confirm?.onConfirm();
    });

    expect(setPrState).toHaveBeenCalledWith(42, "reopen");
    expect(await screen.findByText("Reopening…")).toBeInTheDocument();

    resolveState("ok");
    await waitFor(() => expect(screen.queryByText("Reopening…")).not.toBeInTheDocument());
  });
});
