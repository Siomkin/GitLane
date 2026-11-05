// The Connect GitHub methods as data: the switch's options, which one opens
// first, and what each one covers. Pure, so the choice rules are unit-tested
// apart from the panels.

import type { AccountsConnectReason } from "@/store/ui";
import {
  capabilityRows as caps,
  type Capability,
  type TokenStorage,
} from "@/components/chrome/settings/accounts-panel/provider-connect/methods";

export type GithubMethod = "cli" | "token" | "ssh";

export const GITHUB_METHODS: readonly { value: GithubMethod; label: string }[] = [
  { value: "cli", label: "GitHub CLI" },
  { value: "token", label: "Access token" },
  { value: "ssh", label: "SSH key" },
];

/** Opened from "Fix authentication…" (a missing, rejected or under-permissioned
 * credential), the token method leads; otherwise the recommended GitHub CLI. */
export function initialMethod(reason: AccountsConnectReason | null | undefined): GithubMethod {
  return reason === "authFailure" || reason === "permission" ? "token" : "cli";
}

const NEEDS_CLI: Capability = { label: "Pull requests", value: "Needs GitHub CLI", tone: "muted" };

/** The four capability tiles each method's panel shows; the token's "Stored
 * by" follows the storage the user picked. */
export function githubCapabilities(method: GithubMethod, storage: TokenStorage = "keychain"): Capability[] {
  if (method === "cli") return caps("Yes", { label: "Pull requests", value: "Yes", tone: "yes" }, "gh");
  if (method === "ssh") return caps("Yes", NEEDS_CLI, "Your key, ssh-agent");
  return caps("With write access", NEEDS_CLI, storage === "keychain" ? "GitLane (keychain)" : "Your helper");
}
