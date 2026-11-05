// A non-GitHub provider's Connect methods as data: the switch's options (its
// CLI first when it has one, then Access token and SSH key), which one opens
// first, and what each covers. Pure, so the rules are unit-tested.

import type { ForgeAuthStatus } from "@/lib/api";
import { supportsProviderTokenAuth } from "@/lib/forgeHelp";
import { prSupportedFor } from "@/components/chrome/settings/accounts-panel/providers";
import {
  capabilityRows,
  type Capability,
  type TokenStorage,
} from "@/components/chrome/settings/accounts-panel/provider-connect/methods";

export type ForgeMethod = "cli" | "token" | "ssh";

export function forgeMethods(status: ForgeAuthStatus): { value: ForgeMethod; label: string }[] {
  const rest: { value: ForgeMethod; label: string }[] = [
    { value: "token", label: "Access token" },
    { value: "ssh", label: "SSH key" },
  ];
  return status.cli ? [{ value: "cli", label: status.authMethod }, ...rest] : rest;
}

/** The provider's CLI when it has one, else Access token. */
export function initialForgeMethod(status: ForgeAuthStatus): ForgeMethod {
  return status.cli ? "cli" : "token";
}

/** The pull-request tile: the same three cases the signed-in banner words,
 * plus a keychain token, which GitLane's GitLab and Bitbucket REST clients use. */
function prCapability(status: ForgeAuthStatus, method: ForgeMethod, storage: TokenStorage): Capability {
  const label = "Pull requests";
  if (!prSupportedFor(status.provider)) return { label, value: "Not in GitLane yet", tone: "muted" };
  if (method === "cli") return { label, value: "Yes", tone: "yes" };
  if (method === "token" && storage === "keychain" && supportsProviderTokenAuth(status.provider)) {
    return { label, value: status.provider === "gitlab" ? "With the api scope" : "With pull request access", tone: "yes" };
  }
  if (status.cli) return { label, value: `Needs ${status.authMethod}`, tone: "muted" };
  return { label, value: "Needs an API credential", tone: "muted" };
}

export function forgeCapabilities(
  status: ForgeAuthStatus,
  method: ForgeMethod,
  storage: TokenStorage = "helper",
): Capability[] {
  const prs = prCapability(status, method, storage);
  if (method === "cli") {
    // Only glab answers Git's credential prompts (transport_auth's GitlabGlab);
    // other CLIs (az, origin) sign in for pull requests, and fetch/push still
    // go through the user's helper or SSH.
    if (status.cli === "glab") return capabilityRows("Yes", prs, status.cli);
    const viaHelper: Capability = { label: "", value: "Via helper or SSH", tone: "muted" };
    return [
      { ...viaHelper, label: "Fetch, pull" },
      { ...viaHelper, label: "Push" },
      prs,
      { label: "Stored by", value: status.cli ?? "", tone: "plain" },
    ];
  }
  if (method === "token") {
    return capabilityRows("With write access", prs, storage === "keychain" ? "GitLane (keychain)" : "Your helper");
  }
  return capabilityRows("Yes", prs, "Your key, ssh-agent");
}
