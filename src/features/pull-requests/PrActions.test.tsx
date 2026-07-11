// Finding: merging must go through the confirm dialog (it's irreversible and
// deletes the branch by default), not fire immediately on strategy click.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeKind } from "../../lib/api";
import type { PrAuthor, PullRequest } from "../../lib/prs";
import { PR_PENDING_ACTION, usePulls } from "../../store/pulls";
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
  // Reset the forge so suite order can't leak a GitLab/Bitbucket variant into
  // the GitHub-default tests (the provider describes set their own forge).
  useRepo.setState({ checkoutBranch: vi.fn(), forge: null });
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
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Merge, prNum: 42 }],
    });

    render(<PrHeaderActions pr={openPr()} />);

    const merge = screen.getByRole("button", { name: /Merging/ });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("aria-busy", "true");
  });

  it("does not show another PR's merge as pending", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Merge, prNum: 41 }],
    });

    render(<PrHeaderActions pr={openPr({ num: 42 })} />);

    expect(screen.queryByRole("button", { name: /Merging/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Merge/ })).toBeDisabled();
  });

  it("disables merge without the 'Merging…' label during a non-merge PR action", () => {
    // A close/comment/etc. is in flight, not a merge: don't mislabel it as
    // "Merging…", but keep merge disabled so no concurrent write can start.
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.State, prNum: 42, stateAction: "close" }],
    });

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
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Comment, prNum: 42 }],
    });

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

  it("keeps checkout progress on the trigger when the menu is dismissed", async () => {
    let resolveCheckout!: (v: string) => void;
    const checkoutBranch = vi.fn(() => new Promise<string>((r) => (resolveCheckout = r)));
    useRepo.setState({ checkoutBranch });

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Checkout branch"));
    await userEvent.click(document.body);

    expect(screen.queryByText("Checking out…")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Checking out branch…" });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toBeDisabled();

    resolveCheckout("ok");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Checking out branch…" })).not.toBeInTheDocument(),
    );
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

  it("shows a spinner on Ready once the confirm dialog runs the state change", async () => {
    let resolveState!: (v: string) => void;
    const setPrState = vi.fn(() => new Promise<string>((r) => (resolveState = r)));
    usePulls.setState({ setPrState });

    render(<PrHeaderActions pr={openPr({ draft: true })} />);
    await userEvent.click(screen.getByText("Ready"));

    expect(setPrState).not.toHaveBeenCalled();
    await act(async () => {
      useUi.getState().confirm?.onConfirm();
    });

    expect(setPrState).toHaveBeenCalledWith(42, "ready");
    expect(await screen.findByText("Marking ready…")).toBeInTheDocument();

    resolveState("ok");
    await waitFor(() => expect(screen.queryByText("Marking ready…")).not.toBeInTheDocument());
  });

  it("surfaces the close-in-flight state on the overflow trigger after confirm", async () => {
    // The menu dismisses on click, so the always-visible overflow trigger is
    // where Close's pending feedback has to land.
    let resolveState!: (v: string) => void;
    const setPrState = vi.fn(() => new Promise<string>((r) => (resolveState = r)));
    usePulls.setState({ setPrState });

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByTitle("More actions"));
    await userEvent.click(screen.getByText("Close pull request"));

    expect(setPrState).not.toHaveBeenCalled();
    await act(async () => {
      useUi.getState().confirm?.onConfirm();
    });

    expect(setPrState).toHaveBeenCalledWith(42, "close");
    const trigger = screen.getByRole("button", { name: "Closing pull request…" });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toBeDisabled();

    resolveState("ok");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Closing pull request…" })).not.toBeInTheDocument(),
    );
  });

  it("restores close feedback from the per-PR store after a header remount", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.State, prNum: 42, stateAction: "close" }],
    });

    render(<PrHeaderActions key="remounted-42" pr={openPr()} />);

    const trigger = screen.getByRole("button", { name: "Closing pull request…" });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toBeDisabled();
  });
});

describe("PrHeaderActions merge options", () => {
  it("passes deleteBranch=false and drops the branch line when the checkbox is unchecked", async () => {
    const mergePr = vi.fn().mockResolvedValue("done");
    usePulls.setState({ mergePr });

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    await userEvent.click(screen.getByText("Delete branch after merge"));
    await userEvent.click(screen.getByText("Create a merge commit"));

    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm?.message).not.toContain("feat/thing");
    // Confirm runs an async store action (toast on resolve) — flush through act.
    await act(async () => {
      confirm?.onConfirm();
    });
    expect(mergePr).toHaveBeenCalledWith(42, "merge", false);
  });

  it("offers all three merge strategies on GitHub (the default forge)", async () => {
    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    expect(screen.getByText("Create a merge commit")).toBeInTheDocument();
    expect(screen.getByText("Rebase and merge")).toBeInTheDocument();
  });

  it("closes the merge dropdown on an outside mousedown without merging", async () => {
    usePulls.setState({ mergePr: vi.fn() });
    render(<PrHeaderActions pr={openPr()} />);

    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Squash and merge")).toBeInTheDocument();

    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByText("Squash and merge")).not.toBeInTheDocument());
    expect(useUi.getState().confirm).toBeNull();
  });

  it("toggles the dropdown closed on a second trigger click", async () => {
    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Merge"));
    expect(screen.queryByText("Squash and merge")).not.toBeInTheDocument();
  });

  it("resets the open menu and delete-branch choice when the PR changes", async () => {
    const first = openPr();
    const second = openPr({ num: 43, branch: "feat/next" });
    const view = render(<PrHeaderActions key={first.num} pr={first} />);

    await userEvent.click(screen.getByText("Merge"));
    await userEvent.click(screen.getByText("Delete branch after merge"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();

    view.rerender(<PrHeaderActions key={second.num} pr={second} />);
    expect(screen.queryByText("Squash and merge")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});

describe("PrHeaderActions overflow menu", () => {
  it("closes the overflow menu on an outside mousedown without acting", async () => {
    render(<PrHeaderActions pr={openPr()} />);

    await userEvent.click(screen.getByTitle("More actions"));
    expect(screen.getByText("Checkout branch")).toBeInTheDocument();

    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByText("Checkout branch")).not.toBeInTheDocument());
    expect(useUi.getState().confirm).toBeNull();
  });

  it("toasts the error and keeps the menu open when checkout fails", async () => {
    const realShowToast = useUi.getState().showToast;
    const showToast = vi.fn();
    const checkoutBranch = vi.fn().mockRejectedValue(new Error("worktree is dirty"));
    useRepo.setState({ checkoutBranch });
    useUi.setState({ showToast });
    try {
      render(<PrHeaderActions pr={openPr()} />);
      await userEvent.click(screen.getByTitle("More actions"));
      await userEvent.click(screen.getByText("Checkout branch"));

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith("Error: worktree is dirty", "error"),
      );
      // Only a successful checkout dismisses the menu — a failure leaves it
      // open so the user can retry.
      expect(screen.getByText("Checkout branch")).toBeInTheDocument();
      expect(screen.queryByText("Checking out…")).not.toBeInTheDocument();
    } finally {
      // The store is a shared singleton — restore the real action.
      useUi.setState({ showToast: realShowToast });
    }
  });
});

describe("PrHeaderActions state gating", () => {
  it("does not label reopen pending as close", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.State, prNum: 42, stateAction: "reopen" }],
    });

    render(<PrHeaderActions pr={openPr({ state: "closed" })} />);

    expect(screen.getByText("Reopening…")).toBeInTheDocument();
    expect(screen.getByTitle("More actions")).toBeInTheDocument();
    expect(screen.queryByTitle("Closing pull request…")).not.toBeInTheDocument();
  });

  it("does not label ready pending as close", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.State, prNum: 42, stateAction: "ready" }],
    });

    render(<PrHeaderActions pr={openPr({ draft: true })} />);

    expect(screen.getByText("Marking ready…")).toBeInTheDocument();
    expect(screen.getByTitle("More actions")).toBeInTheDocument();
    expect(screen.queryByTitle("Closing pull request…")).not.toBeInTheDocument();
  });

  it("does not label close pending as ready on a draft PR", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.State, prNum: 42, stateAction: "close" }],
    });

    render(<PrHeaderActions pr={openPr({ draft: true })} />);

    expect(screen.getByTitle("Closing pull request…")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Marking ready…")).not.toBeInTheDocument();
  });

  it("shows Ready but no Merge for an open draft PR", () => {
    render(<PrHeaderActions pr={openPr({ draft: true })} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
  });

  it("shows neither lifecycle nor merge nor Close for a merged PR (checkout stays)", async () => {
    render(<PrHeaderActions pr={openPr({ state: "merged" })} />);

    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
    expect(screen.queryByText("Reopen")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTitle("More actions"));
    expect(screen.getByText("Checkout branch")).toBeInTheDocument();
    expect(screen.queryByText("Close pull request")).not.toBeInTheDocument();
  });
});

describe("PrHeaderActions — Bitbucket (GL-141)", () => {
  beforeEach(() => {
    useRepo.setState({
      forge: {
        hasRemote: true,
        kind: ForgeKind.Bitbucket,
        forge: "Bitbucket",
        host: "bitbucket.org",
        webUrl: "https://bitbucket.org/x/y",
      },
    });
  });

  it("labels the external link 'Open on Bitbucket'", () => {
    render(<PrHeaderActions pr={openPr()} />);
    expect(screen.getByTitle("Open on Bitbucket")).toBeInTheDocument();
  });

  it("drops 'Rebase and merge' — Bitbucket has no rebase-merge strategy", async () => {
    usePulls.setState({ mergePr: vi.fn() });
    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    expect(screen.getByText("Create a merge commit")).toBeInTheDocument();
    expect(screen.queryByText("Rebase and merge")).toBeNull();
  });

  it("hides the reopen/ready/close lifecycle actions (unsupported for Bitbucket PRs)", async () => {
    const closed = render(<PrHeaderActions pr={openPr({ state: "closed" })} />);
    expect(screen.queryByText("Reopen")).toBeNull();
    closed.unmount();

    const draft = render(<PrHeaderActions pr={openPr({ draft: true })} />);
    expect(screen.queryByText("Ready")).toBeNull();
    draft.unmount();

    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByTitle("More actions"));
    expect(screen.getByText("Checkout branch")).toBeInTheDocument();
    expect(screen.queryByText("Close pull request")).toBeNull();
  });
});

describe("PrHeaderActions — GitLab (GL-145)", () => {
  beforeEach(() => {
    useRepo.setState({
      forge: {
        hasRemote: true,
        kind: ForgeKind.GitLab,
        forge: "GitLab",
        host: "gitlab.com",
        webUrl: "https://gitlab.com/x/y",
      },
    });
  });

  it("labels the external link 'Open on GitLab'", () => {
    render(<PrHeaderActions pr={openPr()} />);
    expect(screen.getByTitle("Open on GitLab")).toBeInTheDocument();
  });

  it("drops 'Rebase and merge' from the merge menu — GitLab has no rebase-merge", async () => {
    usePulls.setState({ mergePr: vi.fn() });
    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    expect(screen.getByText("Create a merge commit")).toBeInTheDocument();
    expect(screen.queryByText("Rebase and merge")).toBeNull();
  });

  it("hides the reopen/ready/close lifecycle actions (unsupported for GitLab MRs)", async () => {
    const closed = render(<PrHeaderActions pr={openPr({ state: "closed" })} />);
    expect(screen.queryByText("Reopen")).toBeNull();
    closed.unmount();

    const draft = render(<PrHeaderActions pr={openPr({ draft: true })} />);
    expect(screen.queryByText("Ready")).toBeNull();
    draft.unmount();

    // The overflow menu keeps the local "Checkout branch" op but drops "Close".
    render(<PrHeaderActions pr={openPr()} />);
    await userEvent.click(screen.getByTitle("More actions"));
    expect(screen.getByText("Checkout branch")).toBeInTheDocument();
    expect(screen.queryByText("Close pull request")).toBeNull();
  });
});
