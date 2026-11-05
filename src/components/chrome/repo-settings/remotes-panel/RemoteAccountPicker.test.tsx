import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The component only reads `providerTokens` from the store on render (no IPC),
// but the store module pulls in the api wrappers, so mock `invoke` defensively.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

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

const renderPicker = (fetchUrl: string) =>
  render(
    <RemoteAccountPicker
      remote={{ name: "origin", fetchUrl, pushUrl: fetchUrl }}
      accounts={[]}
      forgeAuth={[]}
      selectedId={null}
      busy={false}
      onPick={() => {}}
    />,
  );

beforeEach(() => {
  invokeMock.mockReset();
  useAccounts.setState({ providerTokens: {} });
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
  const renderSelect = (selectedId: string | null, onPick = vi.fn()) => {
    render(
      <RemoteAccountPicker
        remote={{ name: "origin", fetchUrl: "https://github.com/me/repo.git", pushUrl: "" }}
        accounts={[gh]}
        forgeAuth={[]}
        selectedId={selectedId}
        busy={false}
        onPick={onPick}
      />,
    );
    return onPick;
  };

  it("lists matching accounts, flags one needing re-auth, and maps the system option to null", () => {
    useAccounts.setState({
      providerTokens: { "github.com\u0000x": token({ provider: "github", credentialHost: "github.com" }) },
    });
    const onPick = renderSelect(gh.id);
    const select = screen.getByLabelText("Account for origin");

    expect(screen.getByRole("option", { name: "@octocat — needs re-auth" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "" } });
    expect(onPick).toHaveBeenLastCalledWith(null);
    fireEvent.change(select, { target: { value: gh.id } });
    expect(onPick).toHaveBeenLastCalledWith(gh.id);
  });
});
