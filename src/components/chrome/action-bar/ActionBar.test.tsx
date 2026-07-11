import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind, type BranchInfo, type RepoForge, type RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { usePulls } from "@/store/pulls";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { ActionBar } from "./ActionBar";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc1234",
  detached: false,
};

const FORGE: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};

const branch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "main",
  kind: "local",
  target: "abc1234",
  isHead: true,
  upstream: "origin/main",
  remote: null,
  sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
  ...over,
});

// True when `a` precedes `b` in document order.
const precedes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({ summary: SUMMARY, forge: FORGE, branches: [branch()], worktrees: [], remotes: [] });
  useUi.setState({ prompt: null, navOpen: false, leftTab: "history" });
  usePulls.setState({ pullRequests: [] });
  useAccounts.setState({
    accounts: [],
    accountsError: null,
    accountsLoading: false,
    repoAccountRef: null,
    providerTokens: {},
    forgeAuth: [],
  });
});

describe("ActionBar layout order", () => {
  it("places the provider indicator in the right cluster, just before Fetch (after the branch trigger)", () => {
    render(<ActionBar />);

    const commitsTab = screen.getByRole("button", { name: /Commits/ });
    const branchTrigger = screen.getByTitle(/Branches, worktrees & stashes/);
    const provider = screen.getByRole("button", { name: /remote provider/i });
    const fetchBtn = screen.getByTitle("Fetch");

    // Segmented control → branch trigger → provider indicator → Fetch.
    expect(precedes(commitsTab, branchTrigger)).toBe(true);
    expect(precedes(branchTrigger, provider)).toBe(true);
    expect(precedes(provider, fetchBtn)).toBe(true);
  });

  it("drives the ui store's view tab from the segmented control", () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: /PRs/ }));
    expect(useUi.getState().leftTab).toBe("pulls");
    fireEvent.click(screen.getByRole("button", { name: /Commits/ }));
    expect(useUi.getState().leftTab).toBe("history");
  });

  it("renders no provider indicator when the repo's forge is unknown", () => {
    useRepo.setState({ forge: null });
    render(<ActionBar />);
    expect(screen.queryByRole("button", { name: /remote provider/i })).toBeNull();
  });

  it("still shows the provider indicator for a remote-less repo (the 'missing' state)", () => {
    useRepo.setState({ forge: { hasRemote: false, kind: null, forge: null, host: null, webUrl: null } });
    render(<ActionBar />);
    expect(screen.getByRole("button", { name: /remote provider/i })).toBeInTheDocument();
  });

  it("quietly loads GitHub PRs for the toolbar badge before PRs mode opens", () => {
    render(<ActionBar />);
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", {
      path: SUMMARY.path,
      account: null,
    });
  });

  it("quietly loads GitLab MRs for the toolbar badge before PRs mode opens", () => {
    // GitLab merge requests light up the same PR surface (GL-140); with no glab
    // or keychain token in the test env the account resolves to null (glab path).
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" },
    });
    render(<ActionBar />);
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", {
      path: SUMMARY.path,
      account: null,
    });
  });

  it("does not prefetch PRs for unsupported remotes", () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.AzureDevOps, forge: "Azure DevOps", host: "dev.azure.com" },
    });
    render(<ActionBar />);
    expect(invokeMock).not.toHaveBeenCalledWith("list_pull_requests", expect.anything());
  });

  it("prefetches PRs for a Bitbucket remote (GL-141)", () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org" },
    });
    render(<ActionBar />);
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", { path: SUMMARY.path, account: null });
  });

  it("does not treat a bare HTTPS Bitbucket remote as configured transport auth", () => {
    useRepo.setState({
      forge: {
        ...FORGE,
        kind: ForgeKind.Bitbucket,
        forge: "Bitbucket",
        host: "bitbucket.org",
        webUrl: "https://bitbucket.org/darang/gitlanebucket",
      },
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://bitbucket.org/darang/gitlanebucket.git",
          pushUrl: "https://bitbucket.org/darang/gitlanebucket.git",
          isDefault: true,
        },
      ],
    });

    render(<ActionBar />);

    expect(
      screen.getByRole("button", {
        name: /bitbucket\.org\/darang\/gitlanebucket · set up auth for pull requests/i,
      }),
    ).toBeInTheDocument();
  });

  it("treats an HTTPS Bitbucket username as configured transport auth", () => {
    useRepo.setState({
      forge: {
        ...FORGE,
        kind: ForgeKind.Bitbucket,
        forge: "Bitbucket",
        host: "bitbucket.org",
        webUrl: "https://bitbucket.org/darang/gitlanebucket",
      },
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://alice@bitbucket.org/darang/gitlanebucket.git",
          pushUrl: "https://alice@bitbucket.org/darang/gitlanebucket.git",
          isDefault: true,
        },
      ],
    });

    render(<ActionBar />);

    expect(
      screen.getByRole("button", {
        name: /bitbucket\.org\/darang\/gitlanebucket · git auth configured, pull requests unavailable/i,
      }),
    ).toBeInTheDocument();
  });

  it("keeps Pull enabled when the current branch has an upstream", () => {
    useRepo.setState({
      branches: [branch({ sync: { status: "behind", upstream: "origin/main", ahead: 0, behind: 2 } })],
    });

    render(<ActionBar />);

    expect(screen.getByTitle("2 commits behind origin/main.")).toBeEnabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
    expect(screen.getByText("↓2")).toBeInTheDocument();
  });

  it("enables Push when the current branch is ahead of its upstream", () => {
    useRepo.setState({
      branches: [branch({ sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 } })],
    });

    render(<ActionBar />);

    expect(
      screen.getAllByTitle("1 commit ahead of origin/main.").every((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getByText("↑1")).toBeInTheDocument();
  });

  it("disables both Pull and Push for a diverged branch (force-push is in the branch menu)", () => {
    useRepo.setState({
      branches: [branch({ sync: { status: "diverged", upstream: "origin/main", ahead: 2, behind: 3 } })],
    });

    render(<ActionBar />);

    expect(screen.getByTitle(/Pull unavailable/)).toBeDisabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
    expect(screen.getByText("↑2 ↓3")).toBeInTheDocument();
  });

  it("keeps Pull available for an up-to-date remote-tracking ref because git pull fetches first", () => {
    render(<ActionBar />);
    expect(screen.getByTitle("Up to date with origin/main.")).toBeEnabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
  });

  it("shows no synced badge for an up-to-date branch", () => {
    render(<ActionBar />);
    expect(screen.queryByText("synced")).not.toBeInTheDocument();
  });

  it("opens the publish prompt when pushing a branch without an upstream", () => {
    const publishBranch = vi.fn().mockResolvedValue("published");
    useRepo.setState({
      publishBranch,
      branches: [
        branch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
    });

    render(<ActionBar />);
    fireEvent.click(screen.getByTitle("This branch has no upstream configured."));

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
    prompt!.onSubmit("origin/main");
    expect(publishBranch).toHaveBeenCalledWith("main", "origin/main");
  });

  it("pre-fills a fresh publish target for a stale upstream, not the pruned ref", () => {
    const publishBranch = vi.fn().mockResolvedValue("published");
    useRepo.setState({
      publishBranch,
      branches: [
        branch({
          upstream: "origin/deleted",
          sync: { status: "staleUpstream", upstream: "origin/deleted", ahead: 0, behind: 0 },
        }),
      ],
    });

    render(<ActionBar />);
    fireEvent.click(screen.getByText("Push"));

    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
    prompt!.onSubmit("origin/main");
    expect(publishBranch).toHaveBeenCalledWith("main", "origin/main");
  });

  it("does not permanently disable Pull and Push when branch sync state is unavailable", () => {
    useRepo.setState({ branches: [] });

    render(<ActionBar />);

    const fallbackTitle = "Sync state is unavailable. Pull or push will let git validate the operation.";
    expect(screen.getAllByTitle(fallbackTitle).every((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(screen.queryByTitle(/Pull unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Push unavailable/)).not.toBeInTheDocument();
  });

  it("keeps detached HEAD Pull and Push disabled with explicit copy", () => {
    useRepo.setState({
      summary: { ...SUMMARY, headBranch: null, detached: true },
      branches: [],
    });

    render(<ActionBar />);

    expect(screen.getByText(/detached @/)).toBeInTheDocument();
    expect(screen.getByTitle(/Pull unavailable. Detached HEAD/)).toBeDisabled();
    expect(screen.getByTitle(/Push unavailable. Detached HEAD/)).toBeDisabled();
  });

  it("labels an unborn repo 'No commits yet' even though the branch name resolves", () => {
    // Fresh `git init`: the backend now resolves the branch name from HEAD's
    // symbolic target (GL-115 follow-up), so headBranch is populated *and*
    // unborn is true. The unborn guard must still win so the toolbar shows
    // "No commits yet" rather than the bare branch name.
    useRepo.setState({
      summary: { ...SUMMARY, headBranch: "master", unborn: true },
      branches: [],
    });

    render(<ActionBar />);

    expect(screen.getByText("No commits yet")).toBeInTheDocument();
    expect(screen.queryByText("master")).not.toBeInTheDocument();
    expect(screen.queryByText("No branch")).not.toBeInTheDocument();
    // Pull/Push stay disabled — there is nothing to sync yet.
    expect(screen.getByTitle(/Pull unavailable.*no commits yet/i)).toBeDisabled();
    expect(screen.getByTitle(/Push unavailable.*no commits yet/i)).toBeDisabled();
  });
});

describe("ActionBar PR badge polling (GL-182)", () => {
  const prLoads = () =>
    invokeMock.mock.calls.filter((c) => c[0] === "list_pull_requests").length;

  it("refreshes the badge on the interval and stops on unmount", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<ActionBar />);
      expect(prLoads()).toBe(1); // warm the badge immediately

      await vi.advanceTimersByTimeAsync(60_000);
      expect(prLoads()).toBe(2);

      unmount();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(prLoads()).toBe(2); // interval cleaned up — no orphan polling
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the quiet refresh while the window is hidden", async () => {
    vi.useFakeTimers();
    try {
      render(<ActionBar />);
      expect(prLoads()).toBe(1);

      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(prLoads()).toBe(1); // background window — no wasted gh calls

      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prLoads()).toBe(2);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });

  it("re-arms and refetches immediately when the repo path changes", async () => {
    render(<ActionBar />);
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", {
      path: "/repo",
      account: null,
    });

    await act(async () => {
      useRepo.setState({ summary: { ...SUMMARY, path: "/repo2", workdir: "/repo2" } });
    });

    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", {
      path: "/repo2",
      account: null,
    });
  });

  it("re-arms and refetches immediately, as the new account, when the bound PR account changes", async () => {
    render(<ActionBar />);
    expect(prLoads()).toBe(1);

    const ref = { provider: "gh", host: "github.com", accountId: "gh:alice", login: "alice" } as const;
    await act(async () => {
      useAccounts.setState({ repoAccountRef: ref });
    });

    expect(prLoads()).toBe(2);
    // The refetch must carry the NEW account, not just fire again.
    expect(invokeMock).toHaveBeenLastCalledWith("list_pull_requests", {
      path: "/repo",
      account: ref,
    });
  });

  it("re-arms when the forge switches between PR-capable kinds", async () => {
    render(<ActionBar />);
    expect(prLoads()).toBe(1);
    await act(async () => {}); // settle the initial load so the next isn't queue-merged

    await act(async () => {
      useRepo.setState({
        forge: { ...FORGE, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" },
      });
    });

    expect(prLoads()).toBe(2); // immediate warm reload for the new forge
  });

  it("stops polling when the forge switches to an unsupported kind mid-session", async () => {
    vi.useFakeTimers();
    try {
      render(<ActionBar />);
      expect(prLoads()).toBe(1);

      await act(async () => {
        useRepo.setState({
          forge: { ...FORGE, kind: ForgeKind.AzureDevOps, forge: "Azure DevOps", host: "dev.azure.com" },
        });
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(prLoads()).toBe(1); // old interval cleaned up, no new one armed
    } finally {
      vi.useRealTimers();
    }
  });

  // GL-184: for GitLab/Bitbucket the identity behind the quiet badge loads is
  // `prAccountRef()` (glab readiness / native keychain tokens), which changes
  // WITHOUT `repoAccountRef` changing. Saving or deleting a provider token must
  // re-arm polling immediately — not wait out the current 60s interval tick.
  it("re-arms and refetches immediately when a GitLab provider token is saved (GL-184)", async () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" },
    });
    render(<ActionBar />);
    expect(prLoads()).toBe(1); // warm load, zero-config (no glab, no token → null account)
    await act(async () => {}); // settle the initial load so the next isn't queue-merged

    await act(async () => {
      useAccounts.setState({
        providerTokens: {
          "gitlab.com/alice": {
            provider: "gitlab",
            credentialHost: "gitlab.com",
            accountId: "gitlab:alice",
            login: "alice",
            savedAt: 1,
          },
        },
      });
    });

    expect(prLoads()).toBe(2);
    // The refetch must authenticate as the freshly saved token, not just fire.
    expect(invokeMock).toHaveBeenLastCalledWith("list_pull_requests", {
      path: "/repo",
      account: { provider: "native", host: "gitlab.com", accountId: "gitlab:alice", login: "alice" },
    });
  });

  it("re-arms back to the zero-config account when the GitLab token is deleted (GL-184)", async () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" },
    });
    useAccounts.setState({
      providerTokens: {
        "gitlab.com/alice": {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          accountId: "gitlab:alice",
          login: "alice",
          savedAt: 1,
        },
      },
    });
    render(<ActionBar />);
    expect(prLoads()).toBe(1);
    await act(async () => {});

    await act(async () => {
      useAccounts.setState({ providerTokens: {} });
    });

    expect(prLoads()).toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("list_pull_requests", {
      path: "/repo",
      account: null,
    });
  });

  it("re-arms with the OAuth transport identity when a Bitbucket token is saved (GL-184)", async () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org" },
    });
    render(<ActionBar />);
    expect(prLoads()).toBe(1);
    await act(async () => {});

    await act(async () => {
      useAccounts.setState({
        providerTokens: {
          "bitbucket.org/alice": {
            provider: "bitbucket",
            credentialHost: "bitbucket.org",
            accountId: "bb:alice",
            login: "alice",
            // OAuth tokens authenticate as the sentinel, not the handle (GL-139).
            transportUsername: "x-token-auth",
            savedAt: 1,
          },
        },
      });
    });

    expect(prLoads()).toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("list_pull_requests", {
      path: "/repo",
      account: { provider: "native", host: "bitbucket.org", accountId: "bb:alice", login: "x-token-auth" },
    });
  });

  it("stops polling when the repo closes", async () => {
    vi.useFakeTimers();
    try {
      render(<ActionBar />);
      expect(prLoads()).toBe(1);

      await act(async () => {
        useRepo.setState({ summary: null });
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(prLoads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ActionBar network ops — one at a time (GL-182)", () => {
  it("ignores a second network op while the first is still in flight", async () => {
    let resolveFetch!: () => void;
    const fetch = vi.fn(
      () => new Promise<void>((res) => (resolveFetch = () => res())),
    );
    const pull = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ fetch, pull });

    render(<ActionBar />);
    fireEvent.click(screen.getByTitle("Fetch"));
    expect(fetch).toHaveBeenCalledTimes(1);

    // A fast second click (same or another op) must not start while the first
    // promise is unresolved — busyRef guards synchronously, before state lands.
    fireEvent.click(screen.getByTitle("Fetch"));
    fireEvent.click(screen.getByTitle("Up to date with origin/main."));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch();
    });
    fireEvent.click(screen.getByTitle("Up to date with origin/main."));
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("unlocks the guard when an op rejects, so the toolbar can never stay stuck", async () => {
    // Store actions surface their own failures and resolve; a rejection is a
    // contract violation — but even then the busy guard must release.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = vi.fn().mockRejectedValue(new Error("network down"));
      const pull = vi.fn().mockResolvedValue(undefined);
      useRepo.setState({ fetch, pull });

      render(<ActionBar />);
      fireEvent.click(screen.getByTitle("Fetch"));
      await act(async () => {});

      // The contract violation is logged, not swallowed silently.
      expect(warn).toHaveBeenCalledWith("fetch: network action rejected", expect.any(Error));

      fireEvent.click(screen.getByTitle("Up to date with origin/main."));
      expect(pull).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ActionBar navigator shortcut (GL-182)", () => {
  it("opens the navigator on ⌘⌥F (KeyF code — Option+F types ƒ on macOS)", () => {
    render(<ActionBar />);
    expect(useUi.getState().navOpen).toBe(false);

    fireEvent.keyDown(document, { metaKey: true, altKey: true, code: "KeyF" });
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("opens the navigator on Ctrl+Alt+F (Windows/Linux parity)", () => {
    render(<ActionBar />);
    expect(useUi.getState().navOpen).toBe(false);

    fireEvent.keyDown(document, { ctrlKey: true, altKey: true, code: "KeyF" });
    expect(useUi.getState().navOpen).toBe(true);
  });
});

describe("ActionBar worktree indicator", () => {
  const MAIN_WT = { name: "repo", path: "/repo", branch: "main", isMain: true };
  const LINKED_WT = { name: "repo-wt", path: "/work/repo-wt", branch: "feature", isMain: false };

  it("renders no worktree chip when the repo has only the main worktree", () => {
    useRepo.setState({ worktrees: [MAIN_WT] });
    render(<ActionBar />);
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
  });

  it("renders no worktree chip when the main worktree is open, even though linked ones exist", () => {
    // Linked worktrees are discoverable in the navigator; no permanent toolbar badge.
    useRepo.setState({ worktrees: [MAIN_WT, LINKED_WT] });
    render(<ActionBar />);
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
  });

  it("identifies the open repo as a linked worktree, exposes its path, and opens the navigator", () => {
    useRepo.setState({
      summary: { ...SUMMARY, path: "/work/repo-wt", workdir: "/work/repo-wt" },
      worktrees: [MAIN_WT, LINKED_WT],
    });
    render(<ActionBar />);

    // Icon-only chip: the worktree name is carried by the accessible label and
    // tooltip (the branch trigger to its left already shows the ref), not inline.
    const chip = screen.getByRole("button", { name: /Current worktree repo-wt/ });
    expect(chip).toHaveAttribute("title", expect.stringContaining("/work/repo-wt"));

    fireEvent.click(chip);
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("switches straight back to the main checkout from the back button", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { ...SUMMARY, path: "/work/repo-wt", workdir: "/work/repo-wt" },
      worktrees: [MAIN_WT, LINKED_WT],
      openWorktree,
    });
    render(<ActionBar />);

    fireEvent.click(screen.getByRole("button", { name: "Back to main checkout" }));
    expect(openWorktree).toHaveBeenCalledWith("/repo");
  });
});
