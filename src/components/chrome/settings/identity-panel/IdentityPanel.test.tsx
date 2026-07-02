import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
import { useUi } from "@/store/ui";
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
  useUi.setState({ settingsOpen: false, settingsTab: "general", repoSettingsOpen: true, profilesIntent: null });
});

describe("IdentityPanel", () => {
  it("prompts to open a repo when none is loaded", () => {
    useRepo.setState({ summary: null });
    render(<IdentityPanel />);
    expect(
      screen.getByText("Open a repository to choose the git profile it commits, fetches, and pushes as."),
    ).toBeInTheDocument();
  });

  it("shows both picks state-first: the current commit identity and the PR-account zone", () => {
    render(<IdentityPanel />);
    expect(screen.getByRole("heading", { name: "Identity" })).toBeInTheDocument();
    // Collapsed: the current pick (nothing pinned → default git identity) is a
    // card, not a list — so the PR zone below stays visible however many
    // profiles exist.
    expect(screen.getByText("Default git identity")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Commit as" })).toBeNull();
    expect(screen.getByText("OPEN PULL REQUESTS AS · ACCOUNT")).toBeInTheDocument();
    expect(screen.getByText("No account")).toBeInTheDocument();
  });

  it("expands the profile picker on Change and applies a profile to local config", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    const group = screen.getByRole("radiogroup", { name: "Commit as" });
    expect(within(group).getByRole("radio", { name: "Default git identity" })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("radio", { name: "Work" }));
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "work@acme.io" }),
    );
    // Picking collapses back to the state card.
    expect(screen.queryByRole("radiogroup", { name: "Commit as" })).toBeNull();
  });

  it("re-picking the current identity just collapses without rewriting git config", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Default git identity" }));
    expect(invokeMock).not.toHaveBeenCalledWith("clear_repo_identity", expect.anything());
    expect(screen.queryByRole("radiogroup", { name: "Commit as" })).toBeNull();
  });

  it("hands profile creation off to Settings → Profiles", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    // The repo window closes and the global Profiles panel opens with a create intent.
    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("profiles");
    expect(useUi.getState().profilesIntent).toEqual({ kind: "new" });
  });

  it("hands profile editing off to Settings → Profiles with the profile id", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Edit ↗" }));
    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsTab).toBe("profiles");
    expect(useUi.getState().profilesIntent).toEqual({ kind: "edit", id: "p2" });
  });

  it("lets the user set a per-repo custom commit email via setCustomEmail", () => {
    // A profile is applied (repo identity matches Work) → the commit-email field shows.
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    render(<IdentityPanel />);
    expect(screen.getByText("Commit email:")).toBeInTheDocument();
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

  it("hands adopting an unmanaged local identity off with a prefill", () => {
    useAccounts.setState({ repoIdentity: { name: "Outside Tool", email: "ext@elsewhere.dev" } });
    render(<IdentityPanel />);
    expect(screen.getByText("Unmanaged local identity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as profile" }));
    // The global Profiles panel opens with the unmanaged identity as the seed.
    expect(useUi.getState().settingsTab).toBe("profiles");
    expect(useUi.getState().profilesIntent).toEqual({
      kind: "new",
      prefill: expect.objectContaining({ name: "Outside Tool", email: "ext@elsewhere.dev" }),
    });
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
