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
  useRepo.setState({ summary });
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

  it("opens a profile quick-switch with the PR account as its own section", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("COMMIT AS")).toBeInTheDocument();
    expect(screen.getByText("Default git identity")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    // The account section is always visible below the (scroll-capped) profiles.
    expect(screen.getByText("PULL REQUESTS AS")).toBeInTheDocument();
    expect(screen.getByText("No account")).toBeInTheDocument();
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
    fireEvent.click(screen.getByTitle("Change on the Identity settings page"));
    expect(useUi.getState().repoSettingsOpen).toBe(true);
    expect(useUi.getState().repoSettingsSection).toBe("identity");
  });

  it("applies a profile on click (writes the commit identity)", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    fireEvent.click(screen.getByText("Personal"));
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Personal", email: "personal@x.dev" }),
    );
  });
});
