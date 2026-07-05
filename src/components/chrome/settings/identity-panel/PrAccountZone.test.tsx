import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoForge } from "@/lib/api";
import { useAccounts, type Account } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { PrAccountZone } from "./PrAccountZone";

const ghAccount = (over: Partial<Account>): Account => ({
  id: "gh:github.com:1",
  forge: "GitHub",
  provider: "gh",
  host: "github.com",
  accountId: "1",
  login: "octocat",
  label: "octocat",
  username: "octocat",
  name: "Octo Cat",
  email: "octo@example.com",
  color: "#5b8def",
  ref: { provider: "gh", host: "github.com", accountId: "1", login: "octocat" },
  active: true,
  healthy: true,
  healthError: "",
  ...over,
});

const githubForge: RepoForge = {
  hasRemote: true,
  kind: "github",
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useAccounts.setState({ accounts: [], repoAccountId: null, repoRemoteAccountIds: {} });
  useRepo.setState({ forge: null, remotes: [] });
  useUi.setState({ repoSettingsOpen: true, repoSettingsSection: "identity" });
});

// Since GL-129 the zone is a read-only summary of the default (PR) remote's
// binding; the picker lives on the Remotes rows. Every edit affordance here
// deep-links to the Remotes section of the same window.
describe("PrAccountZone", () => {
  it("'Choose account' switches to the Remotes section without closing the window", () => {
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Choose account" }));

    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("remotes");
  });

  it("'Change' on a bound account deep-links to Remotes too", () => {
    useRepo.setState({ forge: githubForge });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);

    expect(screen.getByText("PRs enabled")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(useUi.getState().repoSettingsSection).toBe("remotes");
  });

  it("names the default remote PRs follow", () => {
    useRepo.setState({
      forge: githubForge,
      remotes: [
        { name: "upstream", fetchUrl: "https://github.com/o/r.git", pushUrl: "https://github.com/o/r.git", isDefault: true },
      ],
    });
    render(<PrAccountZone />);
    expect(screen.getByText("(upstream)")).toBeInTheDocument();
  });

  it("states PRs are unsupported for a known non-GitHub forge", () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    expect(screen.getByText("Pull requests aren't supported for GitLab yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose account" })).toBeNull();
  });

  it("surfaces and clears a stale binding on an unsupported forge", () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);
    // The leftover GitHub binding is visible, flagged, and clearable.
    expect(screen.getByText("not usable here")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("clearing a stale binding never touches the commit identity (two-tier safety)", () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    const identityCmds = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityCmds).toHaveLength(0);
  });

  it("flags a bound account whose host no longer matches the PR remote", () => {
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);
    expect(screen.getByText("host mismatch")).toBeInTheDocument();
    expect(screen.queryByText("PRs enabled")).toBeNull();
  });
});
