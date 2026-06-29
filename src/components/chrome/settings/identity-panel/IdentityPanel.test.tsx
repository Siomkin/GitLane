import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
import type { GitProfile } from "@/lib/profiles";
import { IdentityPanel } from "./IdentityPanel";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false };

const work: GitProfile = {
  id: "p2",
  label: "Work",
  name: "Stepan Work",
  email: "work@acme.io",
  signingKey: "ABCD1234",
  gpgFormat: "openpgp",
  gpgSign: true,
  color: "#2f9e7e",
  isDefault: true,
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("gitlane.profiles", JSON.stringify([work]));
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary });
  useAccounts.setState({ accounts: [], repoAccountId: null, repoAccountRef: null, repoIdentity: null });
  useProfiles.setState({ profiles: [], defaultIdentity: null });
});

describe("IdentityPanel", () => {
  it("prompts to open a repo when none is loaded", () => {
    useRepo.setState({ summary: null });
    render(<IdentityPanel />);
    expect(
      screen.getByText("Open a repository to choose the git profile it commits, fetches, and pushes as."),
    ).toBeInTheDocument();
  });

  it("renders the default identity, saved profiles, and the optional PR-account zone", () => {
    render(<IdentityPanel />);
    expect(screen.getByRole("heading", { name: "Identity" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Commit identity" });
    expect(within(group).getByRole("radio", { name: "Default git identity" })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "Work" })).toBeInTheDocument();
    // Tier-2 framing: the PR account zone is present and starts with no account.
    expect(screen.getByText("PULL-REQUEST ACCOUNT")).toBeInTheDocument();
    expect(screen.getByText("No account")).toBeInTheDocument();
  });

  it("applies a profile to the repo's local config on selection", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Work" }));
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "work@acme.io" }),
    );
  });

  it("opens the editor when New profile is clicked", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByText("New profile", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByLabelText("PROFILE NAME")).toBeInTheDocument();
  });

  it("lets the user set a per-repo custom commit email via setCustomEmail", () => {
    // A profile is applied (repo identity matches Work) → the commit-email field shows.
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    render(<IdentityPanel />);
    expect(screen.getByText("COMMIT EMAIL FOR THIS REPO")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit commit email" }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "stepan@contractor.dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // setCustomEmail writes the override to local git config.
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "stepan@contractor.dev" }),
    );
  });

  it("surfaces an unmanaged local identity with a save-as-profile path", () => {
    useAccounts.setState({ repoIdentity: { name: "Outside Tool", email: "ext@elsewhere.dev" } });
    render(<IdentityPanel />);
    expect(screen.getByText("Unmanaged local identity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as profile" }));
    // Opens the editor prefilled with the unmanaged identity's name.
    expect(screen.getByLabelText("NAME")).toHaveValue("Outside Tool");
    expect(screen.getByLabelText("EMAIL")).toHaveValue("ext@elsewhere.dev");
  });

  it("binds a PR account from Zone B without touching the commit identity", () => {
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
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "@octocat" }));
    expect(useAccounts.getState().repoAccountId).toBe("gh:github.com:1");
    // Binding a PR account must not write the commit identity.
    const identityWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityWrites).toHaveLength(0);
  });
});
