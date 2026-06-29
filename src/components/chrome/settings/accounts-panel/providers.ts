// Pure provider catalog + connect-state derivation for the Accounts panel.
// The add-account model only ever surfaces a provider's connect path when the
// user picks it — so this maps a provider to "what's the next step" without the
// panel rendering a permanent card per provider. No React/IPC here.

import type { ForgeAuthProvider, ForgeAuthStatus } from "../../../../lib/api";

export type ProviderKey = "github" | ForgeAuthProvider;

export interface ProviderMeta {
  key: ProviderKey;
  name: string;
  /** GitLane can run pull-request workflows for this provider (GitHub only). */
  prSupported: boolean;
}

/** Every provider the picker offers, GitHub first. */
export const PROVIDERS: ProviderMeta[] = [
  { key: "github", name: "GitHub", prSupported: true },
  { key: "gitlab", name: "GitLab", prSupported: false },
  { key: "bitbucket", name: "Bitbucket", prSupported: false },
  { key: "azure-devops", name: "Azure DevOps", prSupported: false },
  { key: "gitea", name: "Gitea", prSupported: false },
  { key: "forgejo", name: "Forgejo", prSupported: false },
];

/** The connect path for a non-GitHub provider, derived from its auth probe:
 * - `manual` — no CLI to probe (Bitbucket app password + credential helper).
 * - `missing` — a CLI exists but isn't installed (an install step, not "broken").
 * - `signin` — CLI present but not authenticated (run the login command).
 * - `prunsupported` — authenticated, but GitLane has no PR support for it yet. */
export type ConnectState = "signin" | "missing" | "manual" | "prunsupported";

export function connectState(s: ForgeAuthStatus): ConnectState {
  if (s.cli === null) return "manual";
  if (!s.available) return "missing";
  return s.authenticated ? "prunsupported" : "signin";
}

/** Two-letter avatar initials for a provider name. */
export function providerInitials(name: string): string {
  return name.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
}

/** Short capability hint shown beside each provider in the picker. */
export function capabilityHint(meta: ProviderMeta): string {
  return meta.prSupported ? "Full support" : "Auth only — no PRs yet";
}
