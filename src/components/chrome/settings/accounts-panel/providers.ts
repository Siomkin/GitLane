// Pure provider catalog + connect-state derivation for the Accounts panel.
// The add-account model only ever surfaces a provider's connect path when the
// user picks it — so this maps a provider to "what's the next step" without the
// panel rendering a permanent card per provider. No React/IPC here.

import type { ForgeAccount, ForgeAuthProvider, ForgeAuthStatus } from "../../../../lib/api";
import { supportsPullRequests } from "../../../../lib/forgeHelp";

export type ProviderKey = "github" | ForgeAuthProvider;

export interface ProviderMeta {
  key: ProviderKey;
  name: string;
  /** GitLane can run pull/merge-request workflows for this provider — GitHub PRs,
   * GitLab MRs (GL-140), and Bitbucket PRs (GL-141). */
  prSupported: boolean;
}

/** Providers surfaced on the Accounts page and its picker today. Gitea/Forgejo
 * stay in the full catalog for labels and `prSupportedFor` lookups, but are not
 * shown until their auth story is more concrete. */
export const VISIBLE_PROVIDER_KEYS: ProviderKey[] = ["github", "gitlab", "bitbucket", "azure-devops"];

/** Every provider the picker offers, GitHub first. */
export const PROVIDERS: ProviderMeta[] = [
  { key: "github", name: "GitHub", prSupported: supportsPullRequests("github") },
  { key: "gitlab", name: "GitLab", prSupported: supportsPullRequests("gitlab") },
  { key: "bitbucket", name: "Bitbucket", prSupported: supportsPullRequests("bitbucket") },
  { key: "azure-devops", name: "Azure DevOps", prSupported: supportsPullRequests("azure-devops") },
  { key: "gitea", name: "Gitea", prSupported: supportsPullRequests("gitea") },
  { key: "forgejo", name: "Forgejo", prSupported: supportsPullRequests("forgejo") },
];

export function providerLabel(provider: ProviderKey): string {
  return PROVIDERS.find((p) => p.key === provider)?.name ?? provider;
}

/** The connect path for a non-GitHub provider, derived from its auth probe:
 * - `manual` — no CLI to probe (GCM/helper or SSH setup).
 * - `missing` — a CLI exists but isn't installed (an install step, not "broken").
 * - `signin` — CLI present but not authenticated (run the login command).
 * - `prunsupported` — authenticated, but GitLane has no PR support for it yet. */
export type ConnectState = "signin" | "missing" | "manual" | "prunsupported";

export function connectState(s: ForgeAuthStatus): ConnectState {
  if (s.cli === null) return "manual";
  if (!s.available) return "missing";
  return s.authenticated ? "prunsupported" : "signin";
}

/** Whether GitLane runs pull/merge-request workflows for this provider (GitHub,
 * GitLab, Bitbucket today). Drives copy that must not claim PRs are unavailable
 * for a forge that actually supports them. Unknown keys default to unsupported. */
export function prSupportedFor(provider: ProviderKey): boolean {
  return PROVIDERS.find((p) => p.key === provider)?.prSupported ?? false;
}

/** Two-letter avatar initials for a provider name. */
export function providerInitials(name: string): string {
  return name.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
}

/** Short capability hint shown beside each provider in the picker. */
export function capabilityHint(meta: ProviderMeta): string {
  return meta.prSupported ? "Full support" : "Sign-in only";
}

/** One-line CLI status for a picker row: which CLI drives this provider and
 * whether it's installed / signed in. `null` while the probe hasn't landed. */
export function cliStatusLine(status: ForgeAuthStatus | undefined): string | null {
  if (!status) return null;
  if (status.cli === null) {
    return status.authenticated
      ? `Credential saved${status.account ? ` for ${accountHandle(status.account)}` : ""}`
      : "No CLI — use GCM or SSH";
  }
  if (!status.available) return `${status.cli} CLI not installed`;
  return status.authenticated ? `Signed in via ${status.cli}` : `${status.cli} installed — not signed in`;
}

/** Display form for a forge account: `@handle` for handle-style identities,
 * the raw value for email/UPN-style ones (e.g. Azure's AAD account). */
export function accountHandle(account: ForgeAccount): string {
  return account.username.includes("@") ? account.username : `@${account.username}`;
}
