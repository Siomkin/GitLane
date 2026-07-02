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
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useAccounts.setState({ accounts: [], repoAccountId: null });
  useRepo.setState({ forge: null });
  useUi.setState({ repoSettingsOpen: true, settingsOpen: false, settingsTab: "general" });
});

describe("PrAccountZone", () => {
  it("'add one in Accounts' closes the repo window and opens global Accounts", () => {
    render(<PrAccountZone />);
    // No account yet → open the picker, which (empty) shows the Accounts CTA.
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    fireEvent.click(screen.getByText(/add one in Accounts/));

    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("accounts");
  });

  it("disables accounts on a different host than the repo's PR remote", () => {
    useRepo.setState({ forge: githubForge });
    useAccounts.setState({
      accounts: [
        ghAccount({}),
        ghAccount({
          id: "gh:ghe.corp:2",
          host: "ghe.corp",
          accountId: "2",
          login: "worker",
          username: "worker",
          ref: { provider: "gh", host: "ghe.corp", accountId: "2", login: "worker" },
        }),
      ],
    });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    // Matching host stays selectable; the other host is visible but disabled.
    expect(screen.getByRole("radio", { name: "@octocat" })).toBeEnabled();
    const mismatched = screen.getByRole("radio", { name: "@worker" });
    expect(mismatched).toBeDisabled();
    expect(screen.getByText(/different host than this repo's remote/)).toBeInTheDocument();
    // Picking the disabled row must not bind.
    fireEvent.click(mismatched);
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("offers an Accounts CTA when no connected account matches the PR remote's host", () => {
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    expect(screen.getByText(/No accounts for ghe.corp/)).toBeInTheDocument();
  });

  it("states PRs are unsupported for a known non-GitHub forge instead of offering accounts", () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    expect(screen.getByText("Pull requests aren't supported for GitLab yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect account" })).toBeNull();
  });

  it("binds a matching-host account from the picker", () => {
    useRepo.setState({ forge: githubForge });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    fireEvent.click(screen.getByRole("radio", { name: "@octocat" }));
    expect(useAccounts.getState().repoAccountId).toBe("gh:github.com:1");
  });

  it("treats all accounts as selectable while the forge probe hasn't landed", () => {
    useRepo.setState({ forge: null });
    useAccounts.setState({ accounts: [ghAccount({ host: "ghe.corp" })] });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    expect(screen.getByRole("radio", { name: "@octocat" })).toBeEnabled();
  });

  it("rejects a pick that mismatches the forge host that loaded after render", () => {
    // Forge unknown at render → the row is enabled…
    useRepo.setState({ forge: null });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    // …but the probe lands before the user clicks. pick() checks latest state.
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    fireEvent.click(screen.getByRole("radio", { name: "@octocat" }));
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("shows a bound wrong-host account in the picker as selected but disabled", () => {
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const row = screen.getByRole("radio", { name: "@octocat" });
    expect(row).toBeChecked();
    expect(row).toBeDisabled();
    // "No account" (or a matching account) is the way out.
    fireEvent.click(screen.getByRole("radio", { name: "No account" }));
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("host-specific CTA hands off to global Accounts", () => {
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    useAccounts.setState({ accounts: [ghAccount({})] });
    render(<PrAccountZone />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    fireEvent.click(screen.getByText(/No accounts for ghe.corp/));
    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsTab).toBe("accounts");
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

  it("flags a bound account whose host no longer matches the PR remote", () => {
    useRepo.setState({ forge: { ...githubForge, host: "ghe.corp" } });
    useAccounts.setState({ accounts: [ghAccount({})], repoAccountId: "gh:github.com:1" });
    render(<PrAccountZone />);
    expect(screen.getByText("host mismatch")).toBeInTheDocument();
    expect(screen.queryByText("PRs enabled")).toBeNull();
  });
});
