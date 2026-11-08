import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The component only reads `providerTokens` from the store on render (no IPC),
// but the store module pulls in the api wrappers, so mock `invoke` defensively.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts, type StoredProviderToken } from "@/store/accounts";
import { RemoteAccountPicker } from "./RemoteAccountPicker";

const KEYCHAIN_NOTE = "Authenticates with a token stored in your OS keychain.";
const SSH_NOTE = "SSH remote — the account is selected by your SSH key.";

const token = (over: Partial<StoredProviderToken> = {}): StoredProviderToken => ({
  provider: "gitlab",
  credentialHost: "gitlab.com",
  accountId: "42",
  login: "ada",
  transportUsername: "oauth2",
  savedAt: 1,
  ...over,
});

const renderPicker = (fetchUrl: string, onConnect = vi.fn()) =>
  render(
    <RemoteAccountPicker
      remote={{ name: "origin", fetchUrl, pushUrl: fetchUrl }}
      accounts={[]}
      forgeAuth={[]}
      busy={false}
      onPick={() => {}}
      onConnect={onConnect}
    />,
  );

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  useRepo.setState({ summary: null });
  useAccounts.setState({ providerTokens: {}, repoBindingKey: null });
});

describe("RemoteAccountPicker keychain-token note", () => {
  it("keeps the SSH-key note for an SSH remote even when a keychain token exists for the host", () => {
    // `git@gitlab.com:…` is SSH, but detectRemoteUrl still derives credentialHost
    // "gitlab.com" — so without the ssh guard the host-matched token would wrongly
    // claim to authenticate this remote. SSH uses the key; the token is never read.
    useAccounts.setState({ providerTokens: { "gitlab.com\u0000oauth2": token() } });
    renderPicker("git@gitlab.com:me/repo.git");

    expect(screen.getByText(SSH_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(KEYCHAIN_NOTE)).toBeNull();
  });

  it("shows the keychain note for an HTTPS remote whose host has a token", () => {
    // The guard is narrow: an HTTPS remote on the same host still reports the token,
    // so this asserts the fix didn't over-suppress the keychain note.
    useAccounts.setState({ providerTokens: { "gitlab.com\u0000oauth2": token() } });
    renderPicker("https://gitlab.com/me/repo.git");

    expect(screen.getByText(KEYCHAIN_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(SSH_NOTE)).toBeNull();
  });
});

describe("RemoteAccountPicker account select", () => {
  const gh = { id: "gh:github.com:1", host: "github.com", login: "octocat", healthy: false };
  const tokenKey = "github.com\u0000octocat";
  const githubToken = token({
    provider: "github",
    credentialHost: "github.com",
    login: "octocat",
    transportUsername: undefined,
  });
  const renderSelect = (onPick = vi.fn(), onConnect = vi.fn(), accounts = [gh]) => {
    render(
      <RemoteAccountPicker
        remote={{ name: "origin", fetchUrl: "https://github.com/me/repo.git", pushUrl: "" }}
        accounts={accounts}
        forgeAuth={[]}
        busy={false}
        onPick={onPick}
        onConnect={onConnect}
      />,
    );
    return onPick;
  };

  it("lists matching accounts, flags one needing re-auth, and maps the system option to null", () => {
    const onPick = renderSelect();
    const select = screen.getByLabelText("Account for origin");

    expect(screen.getByRole("option", { name: "@octocat · GitHub CLI — needs re-auth" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "" } });
    expect(onPick).toHaveBeenLastCalledWith(null);
    fireEvent.change(select, { target: { value: gh.id } });
    expect(onPick).toHaveBeenLastCalledWith(gh.id);
  });

  it("offers a same-login keychain token, shows it as selected, and passes its choice on pick", () => {
    useAccounts.setState({ providerTokens: { [tokenKey]: githubToken } });
    const onPick = renderSelect();
    const select = screen.getByLabelText<HTMLSelectElement>("Account for origin");
    const value = `token:${tokenKey}`;

    expect(screen.getByRole("option", { name: "@octocat · Keychain token" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "System git credentials" })).toBeNull();
    expect(select.value).toBe(value);
    fireEvent.change(select, { target: { value: gh.id } });
    expect(onPick).toHaveBeenLastCalledWith(gh.id);
    fireEvent.change(select, { target: { value } });
    expect(onPick).toHaveBeenLastCalledWith(value);
  });

  it("offers this computer's tokens on no repository opened over SSH", () => {
    useRepo.setState({ summary: { path: "ssh://me@box/srv/repo" } as RepoSummary });
    useAccounts.setState({ providerTokens: { [tokenKey]: githubToken } });
    renderSelect();

    expect(screen.queryByRole("option", { name: "@octocat · Keychain token" })).toBeNull();
    expect(screen.getByRole("option", { name: "System git credentials" })).toBeInTheDocument();
  });

  it("shows the token this remote chose over a newer one", () => {
    const newerKey = "github.com\u0000newer";
    useRepo.setState({ summary: { path: "/repo" } as RepoSummary });
    localStorage.setItem("gitlane.remoteTokenChoices", JSON.stringify({ "/repo\u0000origin": tokenKey }));
    useAccounts.setState({
      providerTokens: { [tokenKey]: githubToken, [newerKey]: { ...githubToken, login: "newer", savedAt: 2 } },
    });
    renderSelect();

    expect(screen.getByLabelText<HTMLSelectElement>("Account for origin").value).toBe(`token:${tokenKey}`);
  });

  it("keeps 'Connect another…' beside the picker while a token is selected", () => {
    useAccounts.setState({ providerTokens: { [tokenKey]: githubToken } });
    renderSelect();
    expect(screen.getByRole("button", { name: "Connect another…" })).toBeInTheDocument();
  });

  it("shows the keychain note and no picker when a token is the only account", () => {
    useAccounts.setState({ providerTokens: { [tokenKey]: githubToken } });
    renderSelect(vi.fn(), vi.fn(), []);
    expect(screen.queryByLabelText("Account for origin")).toBeNull();
    expect(screen.getByText(KEYCHAIN_NOTE)).toBeInTheDocument();
  });

  it("shows the SSH note and no picker for an SSH remote with a gh account and a token", () => {
    useAccounts.setState({ providerTokens: { [tokenKey]: githubToken } });
    render(
      <RemoteAccountPicker
        remote={{ name: "origin", fetchUrl: "git@github.com:me/repo.git", pushUrl: "" }}
        accounts={[gh]}
        forgeAuth={[]}
        busy={false}
        onPick={() => {}}
        onConnect={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Account for origin")).toBeNull();
    expect(screen.getByText(SSH_NOTE)).toBeInTheDocument();
  });
});

describe("RemoteAccountPicker connect action", () => {
  it("offers to connect a GitHub account when none matches", () => {
    const onConnect = vi.fn();
    renderPicker("https://github.com/me/repo.git", onConnect);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub account…" }));
    expect(onConnect).toHaveBeenCalledWith("github");
  });

  it("offers 'Connect another…' next to the account select", () => {
    const onConnect = vi.fn();
    render(
      <RemoteAccountPicker
        remote={{ name: "origin", fetchUrl: "https://github.com/me/repo.git", pushUrl: "" }}
        accounts={[{ id: "gh:github.com:1", host: "github.com", login: "octocat", healthy: true }]}
        forgeAuth={[]}
        busy={false}
        onPick={() => {}}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect another…" }));
    expect(onConnect).toHaveBeenCalledWith("github");
  });

  it("maps a GitLab remote to the GitLab connect view", () => {
    const onConnect = vi.fn();
    renderPicker("https://gitlab.com/me/repo.git", onConnect);
    fireEvent.click(screen.getByRole("button", { name: /Connect GitLab account/ }));
    expect(onConnect).toHaveBeenCalledWith("gitlab");
  });

  it("offers no connect action for SSH remotes or unknown hosts", () => {
    renderPicker("git@github.com:me/repo.git");
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    renderPicker("https://git.example.org/me/repo.git");
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  });
});
