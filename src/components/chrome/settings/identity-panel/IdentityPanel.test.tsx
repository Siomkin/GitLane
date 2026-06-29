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
});
