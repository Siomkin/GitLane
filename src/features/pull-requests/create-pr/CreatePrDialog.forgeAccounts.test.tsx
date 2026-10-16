// The create-PR dialog on forges whose PR account is a GitLane-owned keychain
// token (Bitbucket; GitLab without glab). There `prAccountRef()` builds a fresh
// ref on every call, and subscribing to it directly looped React until the root
// unmounted — the whole window went blank on "Open a pull request…".
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind } from "@/lib/api";
import { useAccounts, type StoredProviderToken } from "@/store/accounts";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { capabilitiesFor } from "@/test/forgeFixtures";
import { CreatePrDialog } from "./CreatePrDialog";

const token = (over: Partial<StoredProviderToken>): StoredProviderToken => ({
  provider: "bitbucket",
  credentialHost: "bitbucket.org",
  accountId: "7",
  login: "alice-display",
  transportUsername: "alice",
  savedAt: 1,
  ...over,
});

const forgeOf = (kind: ForgeKind, host: string) => ({
  hasRemote: true,
  kind,
  forge: kind === ForgeKind.Bitbucket ? "Bitbucket" : "GitLab",
  host,
  webUrl: null,
  capabilities: capabilitiesFor(kind),
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case "range_commits":
        return Promise.resolve({ commits: [], truncated: false });
      case "compare_refs":
        return Promise.resolve({ files: [], add: 0, del: 0, ahead: 0, behind: 0 });
      case "list_repo_files":
        return Promise.resolve({ paths: [], truncated: false });
      case "ancestor_refs":
      case "pull_request_reviewer_candidates":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
  usePulls.setState({ prPendingActions: [], pullRequests: [] });
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "develop",
      headOid: "aaa",
      detached: false,
      unborn: false,
      isWorktree: false,
    },
    branches: [
      { kind: "local", name: "feature/x", upstream: "origin/feature/x" },
      { kind: "local", name: "develop" },
    ] as never,
    remotes: [],
  });
  useAccounts.setState({ forgeAuth: [], providerTokens: {} });
  useUi.setState({ createPrOpen: false, createPrGeneration: 0 });
});

describe("CreatePrDialog on token-authenticated forges", () => {
  it("opens on Bitbucket with a stored token and names the account", async () => {
    useRepo.setState({ forge: forgeOf(ForgeKind.Bitbucket, "bitbucket.org") });
    useAccounts.setState({ providerTokens: { "bitbucket.org\u0000alice": token({}) } });
    useUi.getState().openCreatePr("feature/x");

    render(<CreatePrDialog />);

    expect(screen.getAllByText("feature/x").length).toBeGreaterThan(0);
    expect(screen.getByText("Opening as")).toBeInTheDocument();
    const login = screen.getByText("alice");
    expect(login.parentElement).toHaveAttribute("title", expect.stringContaining("bitbucket.org"));

    await userEvent.type(screen.getByPlaceholderText("Title"), "Profile tab");
    expect(screen.getByPlaceholderText("Title")).toHaveValue("Profile tab");
  });

  it("opens on GitLab with a stored token and no glab", async () => {
    useRepo.setState({ forge: forgeOf(ForgeKind.GitLab, "gitlab.com") });
    useAccounts.setState({
      providerTokens: {
        "gitlab.com\u0000oauth2": token({
          provider: "gitlab",
          credentialHost: "gitlab.com",
          login: "ada",
          transportUsername: "oauth2",
        }),
      },
    });
    useUi.getState().openCreatePr();

    render(<CreatePrDialog />);

    expect(screen.getByText("ada")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Title"), "Fix");
    expect(screen.getByPlaceholderText("Title")).toHaveValue("Fix");
  });
});
