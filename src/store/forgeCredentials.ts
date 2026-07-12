// Saved-HTTPS-credential markers for CLI-less forges (GL-132): when the user
// stores a token/password via `git credential approve`, GitLane remembers only
// the non-secret fact that it did (provider, host, username, helper name) so
// the Accounts UI can show "connected" and offer forget/sign-out. The secret
// itself lives in the user's Git credential helper, never here.

import type { ForgeAuthProvider, ForgeAuthStatus } from "@/lib/api";
import { readForgeCredentials, writeForgeCredentials } from "./accountsStorage";

/** Drop the saved-credential marker for `provider` (used by "forget saved
 * HTTPS credential"). Callers refresh the UI's status list separately via
 * [`withSavedForgeCredentials`]. */
export function forgetForgeCredential(provider: ForgeAuthProvider) {
  const credentials = readForgeCredentials();
  if (credentials[provider]) {
    delete credentials[provider];
    writeForgeCredentials(credentials);
  }
}

export function rememberForgeCredential(
  provider: ForgeAuthProvider,
  credentialHost: string,
  path: string | null,
  username: string,
  helper: string,
) {
  const credentials = readForgeCredentials();
  credentials[provider] = {
    provider,
    credentialHost,
    path,
    username,
    helper,
    savedAt: Date.now(),
  };
  writeForgeCredentials(credentials);
}

export function withSavedForgeCredentials(statuses: ForgeAuthStatus[]): ForgeAuthStatus[] {
  const credentials = readForgeCredentials();
  return statuses.map((status) => {
    const saved = credentials[status.provider];
    if (!saved) return status;
    return {
      ...status,
      available: true,
      authenticated: true,
      account: { username: saved.username },
      notes: `${status.notes} Credential saved for ${saved.credentialHost}${
        saved.path ? `/${saved.path}` : ""
      } in ${saved.helper || "Git credential helper"}.`,
    };
  });
}
