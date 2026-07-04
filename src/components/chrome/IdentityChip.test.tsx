import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import type { GitProfile } from "@/lib/profiles";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
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
  useProfiles.setState({ profiles: [personal, work], defaultIdentity: null });
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
    expect(screen.getByText("PULL REQUESTS AS")).toBeInTheDocument();
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
    expect(screen.queryByText(/PRs enabled/)).toBeNull();
  });

  it("flags a stale binding on an unsupported forge as host mismatch", () => {
    // Intentional wording difference: the Identity panel has room to explain
    // ("not usable here" + Clear); the chip's compact line says the same fact
    // as "host mismatch" — both agree the binding can't work.
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
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("github.com · host mismatch")).toBeInTheDocument();
  });

  it("shows needs re-auth for a bound account gh reported as broken", () => {
    // Consistency with PrAccountZone: a revoked/timed-out account must not read
    // "PRs enabled" in the chip while settings flags it as needing re-auth.
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
    expect(screen.queryByText(/PRs enabled/)).toBeNull();
  });

  it("shows the current PR account display-only and links to Identity settings", () => {
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
    expect(screen.getByText("github.com · PRs enabled")).toBeInTheDocument();
    // Changing happens on the Identity settings page.
    fireEvent.click(screen.getByText("@octocat"));
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("identity");
  });

  it("never writes git config from the popover — rows open Identity settings", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    invokeMock.mockClear();
    // The commit-as status row (first of the two Identity-settings rows).
    fireEvent.click(screen.getAllByTitle("Change on the Identity settings page")[0]);
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("identity");
    const identityWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityWrites).toHaveLength(0);
  });
});
