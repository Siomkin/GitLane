// Ownership guards for the create-PR dialog: a submission in flight must never
// close, clear, or toast over a dialog instance that isn't the one that started
// it (reopened, or pointed at another repo). Plus the stack-targeting path from
// GL-347 — the tab only appears on GitHub, and choosing it retargets the base.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind } from "@/lib/api";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { summaryToPr } from "@/lib/prs";
import { CreatePrDialog } from "./CreatePrDialog";

const realCreatePr = usePulls.getState().createPr;
const realShowToast = useUi.getState().showToast;

const DESCRIPTION = "Describe your changes… (Markdown supported)";

/** Empty answers for every read the form fires on mount. */
function stubReads(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation((command: string) => {
    if (command in overrides) return Promise.resolve(overrides[command]);
    switch (command) {
      case "range_commits":
        return Promise.resolve([]);
      case "ancestor_refs":
        return Promise.resolve([]);
      case "compare_refs":
        return Promise.resolve({ files: [], add: 0, del: 0, ahead: 0, behind: 0 });
      case "default_base_branch":
        return Promise.resolve(null);
      case "list_repo_files":
        return Promise.resolve([]);
      case "pull_request_reviewer_candidates":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

/** A create that stays in flight until the returned resolver is called. */
function deferredCreate() {
  let resolve!: (value: string) => void;
  const settled = vi.fn();
  const createPr = vi.fn(() => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Create, prNum: null }],
    });
    return new Promise<string>((r) => (resolve = r)).finally(() => {
      usePulls.setState({ prPendingActions: [] });
      settled();
    });
  });
  usePulls.setState({ createPr });
  return { createPr, settled, resolve: (url: string) => resolve(url) };
}

beforeEach(() => {
  invokeMock.mockReset();
  stubReads();
  usePulls.setState({ prPendingActions: [], pullRequests: [], createPr: realCreatePr });
  useRepo.setState({
    summary: {
      path: "/repo-a",
      workdir: "/repo-a",
      headBranch: "feat/x",
      headOid: "aaa",
      detached: false,
    },
    branches: [
      { kind: "local", name: "feat/x" },
      { kind: "local", name: "develop" },
    ] as never,
    forge: null,
  });
  useUi.setState({ createPrOpen: false, createPrGeneration: 0, showToast: realShowToast });
  useUi.getState().openCreatePr();
});

describe("CreatePrDialog", () => {
  it("mounts a fresh form when reopened", async () => {
    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "Stale title");
    await userEvent.type(screen.getByPlaceholderText(DESCRIPTION), "Stale body");

    act(() => useUi.getState().closeCreatePr());
    act(() => useUi.getState().openCreatePr());

    expect(screen.getByPlaceholderText("Title")).toHaveValue("");
    expect(screen.getByPlaceholderText(DESCRIPTION)).toHaveValue("");
  });

  it("shows a creating spinner and disables submit while the PR is created", async () => {
    const { createPr, resolve } = deferredCreate();

    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "My PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(createPr).toHaveBeenCalledWith({
      base: "develop",
      head: "feat/x",
      title: "My PR",
      body: "",
      draft: false,
      reviewers: [],
    });
    const creating = await screen.findByRole("button", { name: "Creating…" });
    expect(creating).toHaveAttribute("aria-busy", "true");
    expect(creating).toBeDisabled();

    resolve("https://github.com/x/y/pull/99");
    await waitFor(() => expect(screen.queryByText("Creating…")).not.toBeInTheDocument());
  });

  it("does not let a deferred submission close a same-repo reopened dialog", async () => {
    const { settled, resolve } = deferredCreate();
    const showToast = vi.fn();
    useUi.setState({ showToast });

    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "My PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => useUi.getState().openCreatePr());

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    resolve("https://github.com/x/y/pull/99");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(useUi.getState().createPrOpen).toBe(true);
    expect(screen.getByPlaceholderText("Title")).toHaveValue("");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not let repo A's deferred completion touch repo B's new dialog", async () => {
    const { settled, resolve } = deferredCreate();
    const showToast = vi.fn();
    useUi.setState({ showToast });

    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "Repo A PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    act(() => {
      useRepo.setState({
        summary: {
          path: "/repo-b",
          workdir: "/repo-b",
          headBranch: "feat/b",
          headOid: "bbb",
          detached: false,
        },
        branches: [
          { kind: "local", name: "feat/b" },
          { kind: "local", name: "main" },
        ] as never,
      });
      usePulls.setState({ prPendingActions: [] });
      useUi.getState().onRepoSwitched();
    });
    expect(screen.queryByPlaceholderText("Title")).not.toBeInTheDocument();

    act(() => useUi.getState().openCreatePr());
    await userEvent.type(screen.getByPlaceholderText("Title"), "Repo B PR");

    resolve("https://github.com/x/y/pull/99");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(useUi.getState().createPrOpen).toBe(true);
    expect(screen.getByPlaceholderText("Title")).toHaveValue("Repo B PR");
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("CreatePrDialog base branch", () => {
  it("defaults to the repository's default branch, not the nearest ancestor", async () => {
    // GitHub's rule: "the default branch in a repository is the base branch for
    // new pull requests". `latest` here is not among the conventional guesses,
    // so only the backend read can supply it.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x" },
        { kind: "local", name: "chore/aaa-sorts-first" },
        { kind: "local", name: "latest" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    render(<CreatePrDialog />);

    await waitFor(() => expect(screen.getByLabelText("Base branch")).toHaveValue("latest"));
  });

  it("filters the branch list as you type and keeps the pick", async () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x" },
        { kind: "local", name: "latest" },
        { kind: "local", name: "release/2.4" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    render(<CreatePrDialog />);

    const picker = await screen.findByLabelText("Base branch");
    await userEvent.clear(picker);
    await userEvent.type(picker, "rele");
    // The list narrows to the match; `latest` is filtered out.
    expect(screen.getByRole("option", { name: /release\/2.4/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /latest/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "release/2.4" }));
    expect(picker).toHaveValue("release/2.4");
  });

  it("tells the forge the branch name, not the remote-tracking ref", async () => {
    // The picker offers remote branches so an unfetched-locally base is
    // reachable, but `gh pr create --base origin/release` is not a thing.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x" },
        { kind: "remote", name: "origin/release/2.4", remote: "origin" },
      ] as never,
    });
    stubReads({ default_base_branch: null });
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    const picker = await screen.findByLabelText("Base branch");
    await userEvent.clear(picker);
    await userEvent.type(picker, "release");
    await userEvent.click(screen.getByRole("button", { name: /origin\/release\/2.4/ }));

    await userEvent.type(screen.getByPlaceholderText("Title"), "From a remote base");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ base: "release/2.4" }));
    // The local read still used the ref that actually resolves.
    expect(invokeMock).toHaveBeenCalledWith(
      "range_commits",
      expect.objectContaining({ base: "origin/release/2.4" }),
    );
  });

  it("opens for the branch the graph menu named, not the checked-out one", async () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x" },
        { kind: "local", name: "other/branch" },
        { kind: "local", name: "latest" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    act(() => useUi.getState().closeCreatePr());
    act(() => useUi.getState().openCreatePr("other/branch"));
    render(<CreatePrDialog />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "range_commits",
        expect.objectContaining({ head: "other/branch" }),
      ),
    );
  });
});

describe("CreatePrDialog stack targeting", () => {
  /** An open PR on `fix/scroll` that `feat/x` was branched from. */
  const openParent = () =>
    summaryToPr({
      number: 141,
      title: "Restore scroll position",
      state: "OPEN",
      headRef: "fix/scroll",
      baseRef: "develop",
      author: { login: "octocat", name: "Octo Cat" },
      createdAt: new Date().toISOString(),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      isDraft: false,
      url: "https://github.com/o/r/pull/141",
      mergeable: "MERGEABLE",
    });

  const asGitHubStack = () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: ForgeKind.GitHub, forge: "GitHub", host: "github.com", webUrl: null },
    });
    usePulls.setState({ pullRequests: [openParent()] });
    // The head isn't pushed yet, so the remote comes from the tracking branches.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x" },
        { kind: "local", name: "develop" },
        { kind: "remote", name: "origin/fix/scroll", remote: "origin" },
      ] as never,
    });
    stubReads({ ancestor_refs: ["origin/fix/scroll"] });
  };

  it("offers the stack tab and retargets the base onto the parent's branch", async () => {
    asGitHubStack();
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    const stackTab = await screen.findByRole("button", { name: "Stack on #141" });
    await userEvent.click(stackTab);

    // The base picker gives way to the fixed stack target, and the map gains
    // the layer between the new PR and the trunk.
    expect(screen.queryByLabelText("Base branch")).not.toBeInTheDocument();
    expect(screen.getByText("base fix/scroll")).toBeInTheDocument();
    expect(screen.getByText("Merges bottom-up: #141, then this one.")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Title"), "Stacked PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ base: "fix/scroll" }));
  });

  it("hides stacking on a non-GitHub forge even when the ancestry matches", async () => {
    asGitHubStack();
    useRepo.setState({
      forge: { hasRemote: true, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com", webUrl: null },
    });
    render(<CreatePrDialog />);

    await screen.findByLabelText("Base branch");
    expect(screen.queryByRole("button", { name: /^Stack on/ })).not.toBeInTheDocument();
  });
});
