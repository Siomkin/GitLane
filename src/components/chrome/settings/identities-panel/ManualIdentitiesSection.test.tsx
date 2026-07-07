import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useIdentities } from "@/store/identities";
import { useUi } from "@/store/ui";
import type { GitProfile } from "@/lib/profiles";
import { ManualIdentitiesSection } from "./ManualIdentitiesSection";
import { ThisComputerRow } from "./ThisComputerRow";

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
  useIdentities.setState({ manualIdentities: [work], defaultIdentity: null });
  useUi.setState({ settingsOpen: true, settingsTab: "identities", identitiesIntent: null });
});

describe("ManualIdentitiesSection", () => {
  it("lists saved profiles with an Edit action — no repo required", () => {
    useRepo.setState({ summary: null });
    render(<ManualIdentitiesSection />);
    expect(screen.getByText("Manual identities")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Work" })).toBeInTheDocument();
  });

  it("shows the read-only this-computer identity (via ThisComputerRow)", () => {
    render(<ThisComputerRow identity={{ name: "Stepan Global", email: "global@x.dev" }} />);
    expect(screen.getByText("This computer")).toBeInTheDocument();
    expect(screen.getByText("Stepan Global · global@x.dev")).toBeInTheDocument();
    // It belongs to global git config — no Edit affordance.
    expect(screen.getByText("Managed by git")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit This computer" })).toBeNull();
  });

  it("shows an empty state with a create CTA when no identities exist", () => {
    localStorage.clear();
    useIdentities.setState({ manualIdentities: [] });
    render(<ManualIdentitiesSection />);
    expect(screen.getByText("No manual identities")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New identity" }));
    expect(screen.getByLabelText("IDENTITY NAME")).toBeInTheDocument();
  });

  it("saves a sign-with-default-key profile (gpgSign independent of a signing key)", () => {
    render(<ManualIdentitiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "New identity" }));
    fireEvent.change(screen.getByLabelText("IDENTITY NAME"), { target: { value: "Default-key signer" } });
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "Dev" } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "dev@example.com" } });
    // Turn on signing without entering a key.
    fireEvent.click(screen.getByRole("switch", { name: "Sign commits" }));
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));
    const saved = useIdentities.getState().manualIdentities.find((p) => p.label === "Default-key signer");
    expect(saved?.gpgSign).toBe(true);
    expect(saved?.signingKey).toBeUndefined();
  });

  it("saves a profile that signs tags (tag.gpgsign)", () => {
    render(<ManualIdentitiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "New identity" }));
    fireEvent.change(screen.getByLabelText("IDENTITY NAME"), { target: { value: "Tag signer" } });
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "Dev" } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "dev@example.com" } });
    fireEvent.click(screen.getByRole("switch", { name: "Sign tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));
    const saved = useIdentities.getState().manualIdentities.find((p) => p.label === "Tag signer");
    expect(saved?.tagGpgSign).toBe(true);
  });

  it("consumes a pending edit intent from a repo-scoped handoff", () => {
    useUi.setState({ identitiesIntent: { kind: "edit", id: "p2" } });
    render(<ManualIdentitiesSection />);
    // The editor opens on the handed-off profile, and the intent is cleared.
    expect(screen.getByLabelText("IDENTITY NAME")).toHaveValue("Work");
    expect(useUi.getState().identitiesIntent).toBeNull();
  });

  it("consumes a create intent with a prefill (adopting an unmanaged identity)", () => {
    useUi.setState({
      identitiesIntent: { kind: "new", prefill: { name: "Outside Tool", email: "ext@elsewhere.dev" } },
    });
    render(<ManualIdentitiesSection />);
    expect(screen.getByLabelText("NAME")).toHaveValue("Outside Tool");
    expect(screen.getByLabelText("EMAIL")).toHaveValue("ext@elsewhere.dev");
  });

  it("does not couple accounts into the identity section (no account prefill row)", () => {
    // Identities author, accounts authenticate — the section no longer offers
    // account-derived prefills.
    useAccounts.setState({
      accounts: [
        {
          id: "gh:github.com:2",
          forge: "GitHub",
          provider: "gh",
          host: "github.com",
          accountId: "2",
          login: "hubot",
          label: "hubot",
          username: "hubot",
          name: "Hubot",
          email: "hubot@example.dev",
          color: "#2f9e7e",
          ref: { provider: "gh", host: "github.com", accountId: "2", login: "hubot" },
          active: false,
          healthy: true,
          healthError: "",
        },
      ],
    });

    render(<ManualIdentitiesSection />);

    expect(screen.queryByText("Prefill from account:")).toBeNull();
    expect(screen.queryByText("From @hubot")).toBeNull();
  });

  it("applies an adopted profile to the open repo on save", () => {
    useAccounts.setState({ repoIdentity: { name: "Outside Tool", email: "ext@elsewhere.dev" } });
    useUi.setState({
      identitiesIntent: { kind: "new", prefill: { name: "Outside Tool", email: "ext@elsewhere.dev" } },
    });
    render(<ManualIdentitiesSection />);
    fireEvent.change(screen.getByLabelText("IDENTITY NAME"), { target: { value: "Adopted" } });
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));
    // Saving adopts it — the new profile is applied to the repo's local config.
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Outside Tool", email: "ext@elsewhere.dev" }),
    );
  });

  it("re-applies the open repo's applied profile when it is edited", () => {
    // The repo currently commits as Work (matches the saved profile).
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    render(<ManualIdentitiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "new@acme.io" } });
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));
    // The repo's local git config is kept in sync with the edited profile.
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "new@acme.io" }),
    );
  });

  it("deletes a profile from the editor", () => {
    render(<ManualIdentitiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useIdentities.getState().manualIdentities).toHaveLength(0);
    expect(screen.getByText("No manual identities")).toBeInTheDocument();
  });
});
