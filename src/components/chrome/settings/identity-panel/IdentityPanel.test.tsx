import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulated repo-local git config so apply/edit/read round-trip like the real
// backend (the hydrate reconcile runs against it).
const state = vi.hoisted(() => ({ cfg: new Map<string, { name: string; email: string }>() }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts, type Account } from "@/store/accounts";
import { useIdentities } from "@/store/identities";
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

const ghAccount: Account = {
  id: "gh:github.com:1001",
  forge: "GitHub",
  provider: "gh",
  host: "github.com",
  accountId: "1001",
  login: "stepan",
  label: "stepan",
  username: "stepan",
  name: "Stepan GitHub",
  email: "stepan@github.dev",
  color: "#5b8def",
  ref: { provider: "gh", host: "github.com", accountId: "1001", login: "stepan" },
  active: true,
  healthy: true,
  healthError: "",
};

beforeEach(() => {
  state.cfg.clear();
  localStorage.clear();
  localStorage.setItem("gitlane.profiles", JSON.stringify([work]));
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    const p = args?.path as string;
    switch (cmd) {
      case "set_repo_identity":
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      case "repo_identity":
        return state.cfg.get(p) ?? null;
      case "clear_repo_identity":
        state.cfg.delete(p);
        return "ok";
      default:
        return null;
    }
  });
  useRepo.setState({ summary, remotes: [] });
  useAccounts.setState({
    accounts: [ghAccount],
    repoAccountId: null,
    repoAccountRef: null,
    repoRemoteAccountIds: {},
    repoIdentity: null,
  });
  useIdentities.setState({ manualIdentities: [], defaultIdentity: null });
  useUi.setState({
    settingsOpen: false,
    settingsTab: "general",
    repoSettingsOpen: true,
    repoSettingsSection: "identity",
    identitiesIntent: null,
  });
});

describe("IdentityPanel — one editable identity card (GL-130)", () => {
  it("prompts to open a repo when none is loaded", () => {
    useRepo.setState({ summary: null });
    render(<IdentityPanel />);
    expect(screen.getByText("Open a repository to choose the identity it commits as.")).toBeInTheDocument();
  });

  it("shows the current-state card with a hint — no second account card", () => {
    useIdentities.setState({ defaultIdentity: { name: "Stepan Global", email: "global@x.dev" } });
    render(<IdentityPanel />);
    // Nothing pinned → this computer, global values shown.
    expect(screen.getByText("Default git identity")).toBeInTheDocument();
    expect(screen.getByText("Stepan Global · global@x.dev")).toBeInTheDocument();
    expect(screen.getByText("GLOBAL CONFIG")).toBeInTheDocument();
    // Auth is the Remotes section on the same page — no duplicate card here.
    expect(screen.queryByText("OPEN PULL REQUESTS AS · ACCOUNT")).toBeNull();
  });

  it("is select-only: no inline edit or create — identities are managed on their page", () => {
    useIdentities.setState({ manualIdentities: [work] });
    render(<IdentityPanel />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New identity/ })).toBeNull();
    // The pick surface is the git-profile list, not a second inline editor.
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("group", { name: "Git profile choices" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Identity presets" })).toBeNull();
  });

  it("an externally-set custom name keeps the card link (email is the anchor)", () => {
    useIdentities.setState({ manualIdentities: [work] });
    useAccounts.setState({ repoIdentity: { name: "Renamed Outside", email: "work@acme.io" } });
    render(<IdentityPanel />);
    expect(screen.getByText("custom name")).toBeInTheDocument();
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
  });

  it("a manual git profile applies its saved values", () => {
    useIdentities.setState({ manualIdentities: [work] });
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Work", email: "work@acme.io" }),
    );
  });

  it("the default git profile clears the repo-local identity", () => {
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Default git identity/i }));
    expect(invokeMock).toHaveBeenCalledWith("clear_repo_identity", { path });
  });

  it("keeps alternate profiles hidden until the user chooses to change identity", () => {
    useIdentities.setState({ manualIdentities: [work] });
    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });

    render(<IdentityPanel />);

    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Default git identity/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: /Default git identity/i })).toBeInTheDocument();
  });

  it("an unmanaged local identity is legitimate — flagged with save and clear actions", () => {
    useAccounts.setState({ repoIdentity: { name: "Outside Tool", email: "ext@elsewhere.dev" } });
    render(<IdentityPanel />);
    expect(screen.getByText("Unmanaged local identity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear & use default" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as profile" }));
    expect(useUi.getState().settingsTab).toBe("identities");
    expect(useUi.getState().identitiesIntent).toEqual({
      kind: "new",
      prefill: expect.objectContaining({ name: "Outside Tool", email: "ext@elsewhere.dev" }),
    });
  });

  it("does not show unmanaged when repo-local identity equals the default git identity", () => {
    useIdentities.setState({
      defaultIdentity: { name: "Siomkin Alexander", email: "siomkin.alexander@gmail.com" },
    });
    useAccounts.setState({
      repoIdentity: { name: "Siomkin Alexander", email: "siomkin.alexander@gmail.com" },
    });

    render(<IdentityPanel />);

    expect(screen.queryByText("Unmanaged local identity")).toBeNull();
    expect(screen.getByText("Default git identity")).toBeInTheDocument();
  });

  it("'Manage profiles' hands off to the global Identities tab", () => {
    render(<IdentityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Manage profiles" }));
    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("identities");
    expect(useUi.getState().identitiesIntent).toBeNull();
  });

  it("binding a push/PR account never touches the commit identity (two-tier safety)", () => {
    invokeMock.mockClear();
    void useAccounts.getState().setRemoteAccount("origin", ghAccount.id);
    const identityWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity",
    );
    expect(identityWrites).toHaveLength(0);
  });
});
