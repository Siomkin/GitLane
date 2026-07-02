import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
import { useUi } from "@/store/ui";
import type { GitProfile } from "@/lib/profiles";
import { ProfilesPanel } from "./ProfilesPanel";

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
  useUi.setState({ settingsOpen: true, settingsTab: "profiles", profilesIntent: null });
});

describe("ProfilesPanel", () => {
  it("lists saved profiles with an Edit action — no repo required", () => {
    useRepo.setState({ summary: null });
    render(<ProfilesPanel />);
    expect(screen.getByRole("heading", { name: "Profiles" })).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Work" })).toBeInTheDocument();
  });

  it("shows an empty state with a create CTA when no profiles exist", () => {
    localStorage.clear();
    render(<ProfilesPanel />);
    expect(screen.getByText("No profiles yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("PROFILE NAME")).toBeInTheDocument();
  });

  it("saves a sign-with-default-key profile (gpgSign independent of a signing key)", () => {
    render(<ProfilesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("PROFILE NAME"), { target: { value: "Default-key signer" } });
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "Dev" } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "dev@example.com" } });
    // Turn on signing without entering a key.
    fireEvent.click(screen.getByRole("switch", { name: "Sign commits" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    const saved = useProfiles.getState().profiles.find((p) => p.label === "Default-key signer");
    expect(saved?.gpgSign).toBe(true);
    expect(saved?.signingKey).toBeUndefined();
  });

  it("saves a profile that signs tags (tag.gpgsign)", () => {
    render(<ProfilesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("PROFILE NAME"), { target: { value: "Tag signer" } });
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "Dev" } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "dev@example.com" } });
    fireEvent.click(screen.getByRole("switch", { name: "Sign tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    const saved = useProfiles.getState().profiles.find((p) => p.label === "Tag signer");
    expect(saved?.tagGpgSign).toBe(true);
  });

  it("consumes a pending edit intent from a repo-scoped handoff", () => {
    useUi.setState({ profilesIntent: { kind: "edit", id: "p2" } });
    render(<ProfilesPanel />);
    // The editor opens on the handed-off profile, and the intent is cleared.
    expect(screen.getByLabelText("PROFILE NAME")).toHaveValue("Work");
    expect(useUi.getState().profilesIntent).toBeNull();
  });

  it("consumes a create intent with a prefill (adopting an unmanaged identity)", () => {
    useUi.setState({
      profilesIntent: { kind: "new", prefill: { name: "Outside Tool", email: "ext@elsewhere.dev" } },
    });
    render(<ProfilesPanel />);
    expect(screen.getByLabelText("NAME")).toHaveValue("Outside Tool");
    expect(screen.getByLabelText("EMAIL")).toHaveValue("ext@elsewhere.dev");
  });

  it("applies an adopted profile to the open repo on save", () => {
    useAccounts.setState({ repoIdentity: { name: "Outside Tool", email: "ext@elsewhere.dev" } });
    useUi.setState({
      profilesIntent: { kind: "new", prefill: { name: "Outside Tool", email: "ext@elsewhere.dev" } },
    });
    render(<ProfilesPanel />);
    fireEvent.change(screen.getByLabelText("PROFILE NAME"), { target: { value: "Adopted" } });
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    // Saving adopts it — the new profile is applied to the repo's local config.
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Outside Tool", email: "ext@elsewhere.dev" }),
    );
  });

  it("re-applies the open repo's applied profile when it is edited", () => {
    // The repo currently commits as Work (matches the saved profile).
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    render(<ProfilesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "new@acme.io" } });
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    // The repo's local git config is kept in sync with the edited profile.
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "new@acme.io" }),
    );
  });

  it("deletes a profile from the editor", () => {
    render(<ProfilesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useProfiles.getState().profiles).toHaveLength(0);
    expect(screen.getByText("No profiles yet")).toBeInTheDocument();
  });
});
