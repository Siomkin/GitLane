import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import type { GitProfile } from "@/lib/profiles";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
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

  it("quick-switches the PR account inline from its section", () => {
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
      repoAccountId: null,
    });
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    // Collapsed row shows the current binding; expanding it lists accounts.
    fireEvent.click(screen.getByText("Change"));
    invokeMock.mockClear();
    fireEvent.click(screen.getByText("@octocat"));
    expect(useAccounts.getState().repoAccountId).toBe("gh:github.com:1");
    // Binding a PR account must not write the commit identity.
    const identityWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityWrites).toHaveLength(0);
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
