// Pure field rules for the credential-entry form: which host it targets, when
// the host is typed vs. shown as a fact, and when the form is submittable. Kept
// out of the component so the 2-field/advanced behaviour is unit-testable.

import { DEFAULT_CREDENTIAL_HOST } from "../../../../../../lib/forgeHelp";

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
