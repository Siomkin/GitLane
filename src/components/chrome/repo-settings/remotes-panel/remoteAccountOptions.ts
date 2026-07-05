// Which accounts can authenticate one remote — the pure view-model behind the
// per-remote account picker (GL-129). Host equality is the rule the backend
// enforces (`git_auth_for_remote`), so the picker offers exactly the accounts
// whose host matches the remote's push host; everything else falls back to the
// system git credentials (keychain / SSH), which is also the only option for
// forges GitLane has no in-app sign-in for yet.

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
  /** Accounts that can authenticate this remote (host match). */
  matching: PickerAccount[];
  /** Shown instead of the picker when no account matches: why this remote
   * uses system git credentials, and what (if anything) would enable one. */
  note: string | null;
}

export function remoteAccountPickerModel(
  remote: { fetchUrl: string; pushUrl: string },
  accounts: PickerAccount[],
): RemoteAccountPickerModel {
  const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
  const matching = info.host ? accounts.filter((a) => a.host === info.host) : [];
  return {
    host: info.host,
    matching,
    note: matching.length > 0 ? null : noAccountNote(info.provider, info.host),
  };
}

function noAccountNote(provider: RemoteProvider, host: string | null): string {
  if (!host) return "Uses your system git credentials.";
  if (provider === "github") {
    return `No connected account for ${host} — connect one in Settings → Accounts. Until then this remote uses your system git credentials.`;
  }
  if (provider === "other") {
    return "Uses your system git credentials (keychain / SSH).";
  }
  return `${providerLabel(provider)} sign-in isn't available in GitLane yet — this remote uses your system git credentials (keychain / SSH).`;
}
