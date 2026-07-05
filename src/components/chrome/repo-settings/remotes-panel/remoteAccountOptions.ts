// Which accounts can authenticate one remote — the pure view-model behind the
// per-remote account picker (GL-129). Credential-host equality is the rule the
// backend enforces for helper injection, so the picker offers exactly the
// accounts whose host matches the remote's push host; everything else falls
// back to the system git credentials, which is also the only path for forges
// GitLane can't inject tokens for yet. The note is honest about a CLI sign-in the
// Accounts page detected (e.g. glab): being signed in there is auth *status*,
// not something git pushes can use yet — saying "sign-in isn't available"
// while the Accounts page shows @you signed in read as a contradiction.

import type { ForgeAuthStatus } from "../../../../lib/api";
import { detectRemoteUrl, providerLabel, type RemoteProvider } from "../../../../lib/remotes";

/** The slice of the store's `Account` the picker needs (structural — keeps
 * this module store-free and unit-testable). */
export interface PickerAccount {
  id: string;
  host: string;
  login: string;
  healthy: boolean;
}

export interface RemoteAccountPickerModel {
  host: string | null;
  credentialHost: string | null;
  provider: RemoteProvider;
  ssh: boolean;
  username: string | null;
  /** Accounts that can authenticate this remote (host match). */
  matching: PickerAccount[];
  /** Shown instead of the picker when no account matches: why this remote
   * uses system git credentials, and what (if anything) would enable one. */
  note: string | null;
}

/** Map a remote's detected provider onto the forge-auth probe key. */
const FORGE_PROVIDER: Partial<Record<RemoteProvider, string>> = {
  gitlab: "gitlab",
  bitbucket: "bitbucket",
  azure: "azure-devops",
};

export function remoteAccountPickerModel(
  remote: { fetchUrl: string; pushUrl: string },
  accounts: PickerAccount[],
  forgeAuth: ForgeAuthStatus[] = [],
): RemoteAccountPickerModel {
  const url = remote.pushUrl || remote.fetchUrl;
  const info = detectRemoteUrl(url);
  // SSH remotes carry no account username — the SSH key IS the account
  // (gitcredentials only governs http(s) contexts). Never offer a picker.
  if (info.ssh) {
    return {
      host: info.host,
      credentialHost: info.credentialHost,
      provider: info.provider,
      ssh: true,
      username: info.user,
      matching: [],
      note: "SSH remote — the account is selected by your SSH key.",
    };
  }
  const matching = info.host
    ? accounts.filter((a) => a.host === info.credentialHost)
    : [];
  return {
    host: info.host,
    credentialHost: info.credentialHost,
    provider: info.provider,
    ssh: false,
    username: info.user,
    matching,
    note: noAccountNote(info.provider, info.host, false, forgeAuth),
  };
}

function noAccountNote(
  provider: RemoteProvider,
  host: string | null,
  ssh: boolean,
  forgeAuth: ForgeAuthStatus[],
): string {
  const credentials = ssh
    ? "your SSH key"
    : "your system git credentials (keychain / credential helper)";
  if (!host) return `Uses ${credentials}.`;
  if (provider === "github") {
    return `Use a connected GitHub account or enter a username for ${credentials}.`;
  }
  if (provider === "other") {
    return `Enter the HTTPS username this host expects, or leave blank for ${credentials}.`;
  }
  // Known non-GitHub forge: reflect the Accounts page's CLI probe so the two
  // surfaces never contradict each other.
  const status = forgeAuth.find((f) => f.provider === FORGE_PROVIDER[provider]);
  const login = status?.account?.username;
  if (status?.authenticated === true) {
    return `Signed in${login ? ` as @${login}` : ""} via ${status.cli ?? "its CLI"}. Git transport still uses this URL username plus ${credentials}.`;
  }
  return `${providerLabel(provider)} transport auth uses an HTTPS username plus ${credentials}.`;
}
