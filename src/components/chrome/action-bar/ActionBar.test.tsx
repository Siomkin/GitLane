import { fireEvent, render, screen } from "@testing-library/react";
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
  useUi.setState({ prompt: null, navOpen: false });
  usePulls.setState({ pullRequests: [] });
  useAccounts.setState({ accounts: [], accountsError: null, accountsLoading: false, repoAccountRef: null });
});

describe("ActionBar layout order", () => {
  it("places the provider indicator in the right cluster, just before Fetch (after the branch trigger)", () => {
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    const commitsTab = screen.getByRole("button", { name: /Commits/ });
    const branchTrigger = screen.getByTitle(/Branches, worktrees & stashes/);
    const provider = screen.getByRole("button", { name: /remote provider/i });
    const fetchBtn = screen.getByTitle("Fetch");

    // Segmented control → branch trigger → provider indicator → Fetch.
    expect(precedes(commitsTab, branchTrigger)).toBe(true);
    expect(precedes(branchTrigger, provider)).toBe(true);
    expect(precedes(provider, fetchBtn)).toBe(true);
  });

  it("renders no provider indicator when the repo's forge is unknown", () => {
    useRepo.setState({ forge: null });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /remote provider/i })).toBeNull();
  });

  it("still shows the provider indicator for a remote-less repo (the 'missing' state)", () => {
    useRepo.setState({ forge: { hasRemote: false, kind: null, forge: null, host: null, webUrl: null } });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remote provider/i })).toBeInTheDocument();
  });

  it("quietly loads GitHub PRs for the toolbar badge before PRs mode opens", () => {
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
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
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(invokeMock).toHaveBeenCalledWith("list_pull_requests", {
      path: SUMMARY.path,
      account: null,
    });
  });

  it("does not prefetch PRs for unsupported remotes", () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.AzureDevOps, forge: "Azure DevOps", host: "dev.azure.com" },
    });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(invokeMock).not.toHaveBeenCalledWith("list_pull_requests", expect.anything());
  });

  it("prefetches PRs for a Bitbucket remote (GL-141)", () => {
    useRepo.setState({
      forge: { ...FORGE, kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org" },
    });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    expect(screen.getByTitle("2 commits behind origin/main.")).toBeEnabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
    expect(screen.getByText("↓2")).toBeInTheDocument();
  });

  it("enables Push when the current branch is ahead of its upstream", () => {
    useRepo.setState({
      branches: [branch({ sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 } })],
    });

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    expect(
      screen.getAllByTitle("1 commit ahead of origin/main.").every((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getByText("↑1")).toBeInTheDocument();
  });

  it("disables both Pull and Push for a diverged branch (force-push is in the branch menu)", () => {
    useRepo.setState({
      branches: [branch({ sync: { status: "diverged", upstream: "origin/main", ahead: 2, behind: 3 } })],
    });

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    expect(screen.getByTitle(/Pull unavailable/)).toBeDisabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
    expect(screen.getByText("↑2 ↓3")).toBeInTheDocument();
  });

  it("keeps Pull available for an up-to-date remote-tracking ref because git pull fetches first", () => {
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.getByTitle("Up to date with origin/main.")).toBeEnabled();
    expect(screen.getByTitle(/Push unavailable/)).toBeDisabled();
  });

  it("shows no synced badge for an up-to-date branch", () => {
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Push"));

    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
    prompt!.onSubmit("origin/main");
    expect(publishBranch).toHaveBeenCalledWith("main", "origin/main");
  });

  it("does not permanently disable Pull and Push when branch sync state is unavailable", () => {
    useRepo.setState({ branches: [] });

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

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

    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    expect(screen.getByText("No commits yet")).toBeInTheDocument();
    expect(screen.queryByText("master")).not.toBeInTheDocument();
    expect(screen.queryByText("No branch")).not.toBeInTheDocument();
    // Pull/Push stay disabled — there is nothing to sync yet.
    expect(screen.getByTitle(/Pull unavailable.*no commits yet/i)).toBeDisabled();
    expect(screen.getByTitle(/Push unavailable.*no commits yet/i)).toBeDisabled();
  });
});

describe("ActionBar worktree indicator", () => {
  const MAIN_WT = { name: "repo", path: "/repo", branch: "main", isMain: true };
  const LINKED_WT = { name: "repo-wt", path: "/work/repo-wt", branch: "feature", isMain: false };

  it("renders no worktree chip when the repo has only the main worktree", () => {
    useRepo.setState({ worktrees: [MAIN_WT] });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
  });

  it("renders no worktree chip when the main worktree is open, even though linked ones exist", () => {
    // Linked worktrees are discoverable in the navigator; no permanent toolbar badge.
    useRepo.setState({ worktrees: [MAIN_WT, LINKED_WT] });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
  });

  it("identifies the open repo as a linked worktree, exposes its path, and opens the navigator", () => {
    useRepo.setState({
      summary: { ...SUMMARY, path: "/work/repo-wt", workdir: "/work/repo-wt" },
      worktrees: [MAIN_WT, LINKED_WT],
    });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

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
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to main checkout" }));
    expect(openWorktree).toHaveBeenCalledWith("/repo");
  });
});
