// Ownership guards for the create-PR dialog: a submission in flight must never
// close, clear, or toast over a dialog instance that isn't the one that started
// it (reopened, or pointed at another repo). Plus the stack-targeting path from
// GL-347 — the tab only appears on GitHub, and choosing it retargets the base.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind } from "@/lib/api";
import { useNotifications } from "@/store/notifications";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { summaryToPr } from "@/lib/prs";
import { CreatePrDialog } from "./CreatePrDialog";

const realCreatePr = usePulls.getState().createPr;
const realShowToast = useUi.getState().showToast;
const realNotify = useNotifications.getState().notify;

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
      { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
      { kind: "local", name: "develop" },
    ] as never,
    forge: null,
  });
  useUi.setState({ createPrOpen: false, createPrGeneration: 0, showToast: realShowToast });
  useNotifications.setState({ notify: realNotify });
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

    expect(createPr).toHaveBeenCalledWith(
      { base: "develop", head: "feat/x", title: "My PR", body: "", draft: false, reviewers: [] },
      [], // base mode carries no stack, so nothing is linked
    );
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

describe("CreatePrDialog range read", () => {
  it("does not claim the range is empty while the read is in flight", async () => {
    // Regression: extracting `useProbe` dropped the in-flight flag, so the panel
    // rendered "Nothing to merge" before it knew anything.
    let release!: (commits: unknown[]) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "range_commits") return new Promise((r) => (release = r));
      if (command === "compare_refs")
        return Promise.resolve({ files: [], add: 0, del: 0, ahead: 0, behind: 0 });
      if (command === "default_base_branch") return Promise.resolve("develop");
      return Promise.resolve([]);
    });
    render(<CreatePrDialog />);

    await userEvent.click(await screen.findByRole("button", { name: /Commits/ }));
    expect(screen.getByText("Reading commits…")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to merge/)).not.toBeInTheDocument();

    release([{ id: "a", shortId: "aaaaaaa", summary: "One", authorName: "", authorEmail: "", timestamp: 0 }]);
    await waitFor(() => expect(screen.getByText("One")).toBeInTheDocument());
  });

  it("says the read failed rather than claiming there is nothing to merge", async () => {
    // "Nothing to merge" is a claim about the branch. Printing it over a failed
    // revparse, a moved repo, or a dead IPC call tells the user something
    // untrue about their own work.
    invokeMock.mockImplementation((command: string) => {
      if (command === "range_commits") return Promise.reject(new Error("bad revision"));
      if (command === "compare_refs") return Promise.reject(new Error("bad revision"));
      if (command === "default_base_branch") return Promise.resolve("develop");
      return Promise.resolve([]);
    });
    render(<CreatePrDialog />);

    await userEvent.click(await screen.findByRole("button", { name: /Commits/ }));
    expect(await screen.findByText(/Couldn't read the commits/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to merge/)).not.toBeInTheDocument();
    // …and no "0 commits" count, which would be an answer too.
    expect(screen.queryByText(/0 commits/)).not.toBeInTheDocument();
  });
});

describe("CreatePrDialog base branch", () => {
  it("defaults to the repository's default branch, not the nearest ancestor", async () => {
    // GitHub's rule: "the default branch in a repository is the base branch for
    // new pull requests". `latest` here is not among the conventional guesses,
    // so only the backend read can supply it.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "local", name: "chore/aaa-sorts-first" },
        { kind: "local", name: "latest" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    render(<CreatePrDialog />);

    await waitFor(() => expect(screen.getByLabelText("Base branch")).toHaveValue("latest"));
  });

  it("lists branches newest first, matching the graph rather than the ref order", async () => {
    // `list_branches` hands back libgit2's alphabetical order; the picker has to
    // re-sort or it disagrees with every other branch surface in the app.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x", tipTime: 500 },
        { kind: "local", name: "aaa-oldest", tipTime: 100 },
        { kind: "local", name: "zzz-newest", tipTime: 400 },
        { kind: "local", name: "mmm-middle", tipTime: 200 },
      ] as never,
    });
    stubReads({ default_base_branch: null });
    render(<CreatePrDialog />);

    const picker = await screen.findByLabelText("Base branch");
    await userEvent.clear(picker);
    const rows = screen.getAllByRole("option").map((o) => o.textContent);
    expect(rows).toEqual(["zzz-newest", "mmm-middle", "aaa-oldest"]);
  });

  it("reopens the list when the settled field is clicked again", async () => {
    // Picking keeps focus in the field, so `onFocus` never fires a second time.
    // Without an explicit open-on-click the list could only be reopened by
    // editing the text — you had to delete your own selection to see options.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x", tipTime: 500 },
        { kind: "local", name: "latest", tipTime: 400 },
        { kind: "local", name: "release/2.4", tipTime: 300 },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    render(<CreatePrDialog />);

    const picker = await screen.findByLabelText("Base branch");
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole("button", { name: "release/2.4" }));
    expect(picker).toHaveValue("release/2.4");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Same field, clicked again — the whole list comes back, not just the row
    // matching what is already chosen.
    await userEvent.click(picker);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "latest",
      "release/2.4",
    ]);
  });

  it("filters the branch list as you type and keeps the pick", async () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
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

  it("reads the range through a ref git can resolve when the base is remote-only", async () => {
    // `default_base_branch` answers with the forge branch name. When that
    // branch was never checked out, only origin/main exists and revparse fails
    // — the form would claim there was nothing to merge.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "remote", name: "origin/main", remote: "origin" },
      ] as never,
    });
    stubReads({ default_base_branch: "main" });
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "range_commits",
        expect.objectContaining({ base: "origin/main" }),
      ),
    );

    await userEvent.type(screen.getByPlaceholderText("Title"), "Remote-only base");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    // …but the forge is still told the branch.
    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ base: "main" }), []);
  });

  it("tells the forge the branch name, not the remote-tracking ref", async () => {
    // The picker offers remote branches so an unfetched-locally base is
    // reachable, but `gh pr create --base origin/release` is not a thing.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
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

    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ base: "release/2.4" }), []);
    // The local read still used the ref that actually resolves.
    expect(invokeMock).toHaveBeenCalledWith(
      "range_commits",
      expect.objectContaining({ base: "origin/release/2.4" }),
    );
  });

  it("closes the dropdown on Escape without throwing the form away", async () => {
    // The dialog closes on Escape too. Dismissing a dropdown must not take the
    // title, description, and reviewers with it — including after a filter that
    // matched nothing, which is the state a typo lands you in and where the
    // list is already hidden.
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "local", name: "latest" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Keep me");
    const picker = await screen.findByLabelText("Base branch");
    await userEvent.click(picker);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await userEvent.clear(picker);
    await userEvent.type(picker, "no-such-branch");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().createPrOpen).toBe(true);
    expect(screen.getByPlaceholderText("Title")).toHaveValue("Keep me");

    // A second Escape, with the field no longer acting as a picker, does reach
    // the dialog — cancelling should not need an unexplained extra press.
    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().createPrOpen).toBe(false);
  });

  it("opens for the branch the graph menu named, not the checked-out one", async () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "local", name: "other/branch", upstream: "origin/other/branch" },
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

describe("CreatePrDialog on an unpublished branch", () => {
  const unpublished = () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: null },
        { kind: "local", name: "latest", upstream: "origin/latest" },
        { kind: "remote", name: "origin/latest", remote: "origin" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
  };

  it("publishes the branch before creating, and says so", async () => {
    unpublished();
    const publishBranch = vi.fn().mockResolvedValue("published");
    useRepo.setState({ publishBranch });
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    expect(screen.getByText("origin/feat/x")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Title"), "First push");
    await userEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));

    await waitFor(() => expect(publishBranch).toHaveBeenCalledWith("feat/x", "origin/feat/x"));
    await waitFor(() => expect(createPr).toHaveBeenCalled());
  });

  it("does not create the pull request when the dialog closed during the push", async () => {
    // The dialog stays interactive behind a push. Publishing then creating
    // regardless would open a pull request the user cancelled — and, after a
    // repo switch, open it against the wrong repository.
    unpublished();
    let finishPush!: () => void;
    const publishBranch = vi.fn(() => new Promise<string>((r) => (finishPush = () => r("ok"))));
    useRepo.setState({ publishBranch });
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Cancelled mid-push");
    await userEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() => expect(publishBranch).toHaveBeenCalled());

    act(() => useUi.getState().closeCreatePr());
    finishPush();

    await waitFor(() => expect(useUi.getState().createPrOpen).toBe(false));
    expect(createPr).not.toHaveBeenCalled();
  });

  it("blocks a second submit while the push is still running", async () => {
    unpublished();
    const publishBranch = vi.fn(() => new Promise<string>(() => {}));
    useRepo.setState({ publishBranch });
    deferredCreate();
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Double click");
    const button = screen.getByRole("button", { name: "Push and create pull request" });
    // Both clicks dispatched before React can re-render and disable the button —
    // the actual double-click race. A `useState` flag alone reads `false` in
    // both closures, pushes twice, and opens two pull requests; `pending` is no
    // help because it only turns true once the create reaches the store.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Pushing…" })).toBeDisabled());
    expect(publishBranch).toHaveBeenCalledTimes(1);
  });

  it("re-enables the form when the push fails", async () => {
    // A rejected push must hand the dialog back, not wedge it at "Pushing…"
    // with the user's title and description trapped behind it.
    unpublished();
    const publishBranch = vi.fn().mockRejectedValue(new Error("protected branch"));
    useRepo.setState({ publishBranch });
    const showToast = vi.fn();
    useUi.setState({ showToast });
    const { createPr } = deferredCreate();
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Rejected push");
    await userEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("protected branch"), "error"),
    );
    expect(createPr).not.toHaveBeenCalled();
    expect(useUi.getState().createPrOpen).toBe(true);
    const button = screen.getByRole("button", { name: "Push and create pull request" });
    expect(button).toBeEnabled();
  });

  it("reports the push that landed when the dialog closed mid-flight", async () => {
    // The branch is on the remote and an upstream was written — a real change
    // to the user's repository. The dialog that knew is gone and the action
    // runner deliberately drops errors nobody owns, so this is the only place
    // left to say it happened.
    unpublished();
    let finishPush!: () => void;
    const publishBranch = vi.fn(() => new Promise<string>((r) => (finishPush = () => r("ok"))));
    useRepo.setState({ publishBranch });
    const notify = vi.fn();
    useNotifications.setState({ notify });
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Closed mid-push");
    await userEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() => expect(publishBranch).toHaveBeenCalled());

    act(() => useUi.getState().closeCreatePr());
    finishPush();

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Pushed feat/x to origin/feat/x" }),
      ),
    );
  });

  it("does not publish a branch that already tracks a remote", async () => {
    useRepo.setState({
      branches: [
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "local", name: "latest", upstream: "origin/latest" },
      ] as never,
    });
    stubReads({ default_base_branch: "latest" });
    const publishBranch = vi.fn();
    useRepo.setState({ publishBranch });
    deferredCreate();
    render(<CreatePrDialog />);

    await userEvent.type(screen.getByPlaceholderText("Title"), "Already pushed");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(publishBranch).not.toHaveBeenCalled();
  });
});

describe("CreatePrDialog templates", () => {
  const withTemplate = (overrides: Record<string, unknown> = {}) =>
    stubReads({
      default_base_branch: "develop",
      list_repo_files: [".github/pull_request_template.md"],
      ...overrides,
    });

  it("seeds the description from the template's committed text", async () => {
    // Deliberately the HEAD blob, not the worktree file — a description is
    // published, and local edits are not what the forge would have used.
    withTemplate({ repo_file_head_text: "## Why\n\n## How\n" });
    render(<CreatePrDialog />);

    await userEvent.click(await screen.findByRole("button", { name: /template/i }));
    await userEvent.click(await screen.findByRole("button", { name: /pull_request_template\.md/ }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText(DESCRIPTION)).toHaveValue("## Why\n\n## How\n"),
    );
  });

  it("explains an uncommitted template instead of doing nothing", async () => {
    // `list_repo_files` includes untracked paths, so a template written but not
    // yet committed is offered as a chip and reads as empty from HEAD. Silence
    // there is indistinguishable from a dead button.
    withTemplate({ repo_file_head_text: null });
    const showToast = vi.fn();
    useUi.setState({ showToast });
    render(<CreatePrDialog />);

    await userEvent.click(await screen.findByRole("button", { name: /template/i }));
    await userEvent.click(await screen.findByRole("button", { name: /pull_request_template\.md/ }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("no committed content"),
        "error",
      ),
    );
    expect(screen.getByPlaceholderText(DESCRIPTION)).toHaveValue("");
  });

  it("surfaces a failed template read", async () => {
    withTemplate();
    invokeMock.mockImplementation((command: string) => {
      if (command === "repo_file_head_text") return Promise.reject(new Error("object missing"));
      if (command === "list_repo_files")
        return Promise.resolve([".github/pull_request_template.md"]);
      if (command === "default_base_branch") return Promise.resolve("develop");
      if (command === "compare_refs")
        return Promise.resolve({ files: [], add: 0, del: 0, ahead: 0, behind: 0 });
      return Promise.resolve([]);
    });
    const showToast = vi.fn();
    useUi.setState({ showToast });
    render(<CreatePrDialog />);

    await userEvent.click(await screen.findByRole("button", { name: /template/i }));
    await userEvent.click(await screen.findByRole("button", { name: /pull_request_template\.md/ }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("object missing"), "error"),
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
        { kind: "local", name: "feat/x", upstream: "origin/feat/x" },
        { kind: "local", name: "develop" },
        { kind: "remote", name: "origin/fix/scroll", remote: "origin" },
      ] as never,
    });
    stubReads({ ancestor_refs: ["origin/fix/scroll"] });
  };

  it("refreshes the pull request list on open, so the graph sees stacks too", async () => {
    // From the graph the list is whatever the repo-open prefetch left behind —
    // older than the PR this branch was cut from, in which case the stack tab
    // never appears. The PRs panel force-loads on open; the dialog must not
    // depend on having been raised from there.
    const loadPullRequests = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests });
    render(<CreatePrDialog />);

    await waitFor(() => expect(loadPullRequests).toHaveBeenCalledWith(true, true));
  });

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
    // Bottom-first: the layer below, then the new PR appended by the store.
    // Without this second argument the branch chain is right but GitHub never
    // links the pull requests into a stack.
    expect(createPr).toHaveBeenCalledWith(
      expect.objectContaining({ base: "fix/scroll" }),
      [141],
    );
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
