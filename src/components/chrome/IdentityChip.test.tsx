import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import type { GitProfile } from "@/lib/profiles";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useIdentities } from "@/store/identities";
import { useUi } from "@/store/ui";
import { IdentityChip } from "./IdentityChip";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false };

const personal: GitProfile = { id: "p1", label: "Personal", name: "Stepan Personal", email: "personal@x.dev", color: "#5b8def" };
const work: GitProfile = { id: "p2", label: "Work", name: "Stepan Work", email: "work@acme.io", color: "#2f9e7e" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("gitlane.profiles", JSON.stringify([personal, work]));
  localStorage.setItem("gitlane.repoProfile", JSON.stringify({ [path]: "p2" }));
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary, forge: null });
  useAccounts.setState({
    accounts: [],
    repoAccountId: null,
    repoIdentity: { name: "Stepan Work", email: "work@acme.io" },
  });
  // Seed state directly (not only localStorage) so the label doesn't depend on
  // the mount effect's timing.
  useIdentities.setState({ manualIdentities: [personal, work], defaultIdentity: null });
  useUi.setState({ repoSettingsOpen: false, repoSettingsSection: "remotes" });
});

describe("IdentityChip", () => {
  it("leads with the commit identity (applied profile), not the account", () => {
    render(<IdentityChip />);
    expect(screen.getByTitle("Commit identity for this repository")).toHaveTextContent("Work");
  });

  it("opens a status card: only the current picks, no switcher lists", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    // Commit-as shows the applied profile only — other profiles aren't listed.
    expect(screen.getByText("COMMIT AS")).toBeInTheDocument();
    // "Work" appears twice: the chip trigger and the popover's current-pick row.
    expect(screen.getAllByText("Work")).toHaveLength(2);
    expect(screen.getByText("Stepan Work · work@acme.io")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.getByText("REMOTE & PR AS")).toBeInTheDocument();
    expect(screen.getByText("No account")).toBeInTheDocument();
  });

  it("mirrors the host-mismatch semantics of the Identity panel", () => {
    useRepo.setState({
      summary,
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "ghe.corp", webUrl: "https://ghe.corp/o/r" },
    });
    useAccounts.setState({
      accounts: [
        {
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
        },
      ],
      repoAccountId: "gh:github.com:1",
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("github.com · host mismatch")).toBeInTheDocument();
    expect(screen.queryByText(/remote \+ PRs/)).toBeNull();
  });

  it("ignores a stale gh binding on a GitLab repo — shows the MR state, not the gh account (GL-146)", () => {
    // GitLab authenticates via glab / a stored token, not a gh account, so a
    // legacy gh binding is irrelevant: the row reads an honest "merge requests
    // off" rather than the gh @octocat or "host mismatch".
    useRepo.setState({
      summary,
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({
      accounts: [
        {
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
        },
      ],
      repoAccountId: "gh:github.com:1",
      forgeAuth: [],
      providerTokens: {},
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("System git credentials; merge requests off")).toBeInTheDocument();
    expect(screen.queryByText("@octocat")).toBeNull();
    expect(screen.queryByText(/host mismatch/)).toBeNull();
  });

  it("shows the GitLab glab/token account + 'merge requests' for a GitLab repo (GL-146)", () => {
    useRepo.setState({
      summary,
      forge: { hasRemote: true, kind: "gitlab", forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/o/r" },
    });
    useAccounts.setState({
      accounts: [],
      repoAccountId: null,
      forgeAuth: [],
      providerTokens: {
        "gitlab.com ada": {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          accountId: "42",
          login: "ada",
          savedAt: 1,
        },
      },
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.getByText("gitlab.com · remote + merge requests")).toBeInTheDocument();
  });

  it("shows the Bitbucket token account + 'pull requests' for a Bitbucket repo (GL-141)", () => {
    useRepo.setState({
      summary,
      forge: { hasRemote: true, kind: "bitbucket", forge: "Bitbucket", host: "bitbucket.org", webUrl: "https://bitbucket.org/team/app" },
    });
    useAccounts.setState({
      accounts: [],
      repoAccountId: null,
      forgeAuth: [],
      providerTokens: {
        "bitbucket.org ada": {
          provider: "bitbucket",
          credentialHost: "bitbucket.org",
          accountId: "uuid-1",
          login: "ada",
          transportUsername: "x-token-auth",
          savedAt: 1,
        },
      },
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.getByText("bitbucket.org · remote + pull requests")).toBeInTheDocument();
    // A false "PRs off" must NOT appear for a signed-in Bitbucket repo.
    expect(screen.queryByText(/pull requests off/)).toBeNull();
  });

  it("shows 'pull requests off' for a Bitbucket repo with no stored token (GL-141)", () => {
    useRepo.setState({
      summary,
      forge: { hasRemote: true, kind: "bitbucket", forge: "Bitbucket", host: "bitbucket.org", webUrl: "https://bitbucket.org/team/app" },
    });
    useAccounts.setState({ accounts: [], repoAccountId: null, forgeAuth: [], providerTokens: {} });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("System git credentials; pull requests off")).toBeInTheDocument();
  });

  it("shows needs re-auth for a bound account gh reported as broken", () => {
    // Consistency with PrAccountZone: a revoked/timed-out account must not read
    // "remote + PRs" in the chip while settings flags it as needing re-auth.
    useAccounts.setState({
      accounts: [
        {
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
          healthy: false,
          healthError: "token invalid (HTTP 401)",
        },
      ],
      repoAccountId: "gh:github.com:1",
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("github.com · needs re-auth")).toBeInTheDocument();
    expect(screen.queryByText(/remote \+ PRs/)).toBeNull();
  });

  it("shows the current provider account display-only and links to Remote access", () => {
    useAccounts.setState({
      accounts: [
        {
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
        },
      ],
      repoAccountId: "gh:github.com:1",
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    // The current binding is shown, not an inline switcher.
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.getByText("github.com · remote + PRs")).toBeInTheDocument();
    // Changing happens on the Remote access settings page.
    fireEvent.click(screen.getByText("@octocat"));
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("remotes");
  });

  it("never writes git config from the popover — rows only navigate to settings", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    invokeMock.mockClear();
    // The commit-as status row opens Commit author settings.
    fireEvent.click(screen.getByTitle("Change on the Commit author settings page"));
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("identity");
    const identityWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityWrites).toHaveLength(0);
  });

  it("opens Remote access from the provider-account row", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    fireEvent.click(screen.getByTitle("Change on the Remote access settings page"));
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("remotes");
  });
});
