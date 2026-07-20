// Saved-HTTPS-credential markers for CLI-less forges (GL-132): when the user
// stores a token/password via `git credential approve`, GitLane remembers only
// the non-secret fact that it did (provider, host, username, helper name) so
// the Accounts UI can show "connected" and offer forget/sign-out. The secret
// itself lives in the user's Git credential helper, never here.

import type { ForgeAuthProvider, ForgeAuthStatus } from "@/lib/api";
import { readForgeCredentials, writeForgeCredentials } from "./accountsStorage";

const SAFE_HELPER_LABELS = new Set([
  "Git Credential Manager",
  "macOS Keychain",
  "Secret Service",
  "Windows Credential Store",
  "Plaintext store",
  "Memory cache",
  "GitHub CLI",
  "GitLab CLI",
  "Custom helper",
  "Git credential helper",
]);

/** Defense-in-depth for metadata written by an older backend. Git helper config
 * values are command syntax and may contain paths, arguments, or inline secrets;
 * only this fixed display vocabulary may enter Zustand/localStorage. */
export function safeHelperLabel(value: string): string {
  const trimmed = value.trim();
  if (SAFE_HELPER_LABELS.has(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("!gh auth git-credential")) return "GitHub CLI";
  if (lower.startsWith("!glab auth git-credential")) return "GitLab CLI";
  if (lower.startsWith("!")) return "Custom helper";

  const executable = lower.split(/\s+/, 1)[0] ?? "";
  const basename = executable.split(/[\\/]/).pop()?.replace(/\.exe$/, "") ?? "";
  const helper = basename.replace(/^git-credential-/, "");
  switch (helper) {
    case "manager":
    case "manager-core":
      return "Git Credential Manager";
    case "osxkeychain":
      return "macOS Keychain";
    case "libsecret":
      return "Secret Service";
    case "wincred":
      return "Windows Credential Store";
    case "store":
      return "Plaintext store";
    case "cache":
      return "Memory cache";
    default:
      return "Custom helper";
  }
}

/** Read and one-shot migrate markers produced before helper values were
 * sanitized at IPC. Rewriting also removes raw values for providers that are not
 * currently being rendered. */
function readSafeForgeCredentials() {
  const credentials = readForgeCredentials();
  let changed = false;
  for (const credential of Object.values(credentials)) {
    const helper = safeHelperLabel(credential.helper);
    if (helper !== credential.helper) {
      credential.helper = helper;
      changed = true;
    }
  }
  if (changed) writeForgeCredentials(credentials);
  return credentials;
}

/** Drop the saved-credential marker for `provider` (used by "forget saved
 * HTTPS credential"). Callers refresh the UI's status list separately via
 * [`withSavedForgeCredentials`]. */
export function forgetForgeCredential(provider: ForgeAuthProvider) {
  const credentials = readSafeForgeCredentials();
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
  const credentials = readSafeForgeCredentials();
  credentials[provider] = {
    provider,
    credentialHost,
    path,
    username,
    helper: safeHelperLabel(helper),
    savedAt: Date.now(),
  };
  writeForgeCredentials(credentials);
}

export function withSavedForgeCredentials(statuses: ForgeAuthStatus[]): ForgeAuthStatus[] {
  const credentials = readSafeForgeCredentials();
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
