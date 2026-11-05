// Pure field rules for the credential-entry form: which host it targets, when
// the host is typed vs. shown as a fact, and when the form is submittable. Kept
// out of the component so the 2-field/advanced behaviour is unit-testable.

import { DEFAULT_CREDENTIAL_HOST } from "@/lib/forgeHelp";

export interface CredentialEntryValues {
  host: string;
  /** Path scope for `git credential approve` (helper destination only). */
  path: string;
  username: string;
  password: string;
}

/** The host the form starts with: an explicitly fixed host (embedded use) wins,
 * else the provider's hosted default, else empty (self-hosted-only forges). */
export function resolveHost(provider: string, fixedHost?: string | null): string {
  return fixedHost ?? DEFAULT_CREDENTIAL_HOST[provider] ?? "";
}

/** Whether the host renders as an input from the start. A fixed host is a fact
 * (locked); a known hosted default is a fact with an Edit escape (self-hosted);
 * a forge with no default host (Gitea/Forgejo) has nothing to show — type it. */
export function hostFieldInitiallyEditable(provider: string, fixedHost?: string | null): boolean {
  return !fixedHost && !DEFAULT_CREDENTIAL_HOST[provider];
}

/** Username, token, and a host (typed or resolved) are all required; the path
 * scope is always optional. */
export function canSubmit(values: CredentialEntryValues): boolean {
  return values.host.trim() !== "" && values.username.trim() !== "" && values.password !== "";
}

/** Prefixes of every GitHub token type (classic, fine-grained, OAuth, user and
 * server-to-server). */
const GITHUB_TOKEN_PREFIXES = ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_"];

/** A soft warning when a github.com secret does not look like a token — GitHub
 * refuses account passwords for Git over HTTPS. Never blocks saving, and only
 * for github.com: GitHub Enterprise Server and older 40-hex tokens still save. */
export function githubPasswordWarning(host: string, secret: string): string | null {
  const value = secret.trim();
  if (host.trim().toLowerCase() !== "github.com" || value === "") return null;
  if (GITHUB_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  return "This doesn't look like a GitHub token. GitHub doesn't accept your account password for Git — paste a personal access token.";
}

/** The secret field's placeholder: GitHub takes a personal access token. */
export function secretPlaceholder(provider: string): string {
  return provider === "github" ? "Personal access token (fine-grained or classic)" : "Token / password";
}
