// Host matching between a bound provider account and the repo's PR remote —
// the single frontend definition, shared by the Identity panel, the title-bar
// chip, and the provider indicator so their mismatch verdicts can't drift.
// Case-insensitive to match the backend's `normalize_host`; an unknown host
// (forge probe not landed / no remote) restricts nothing — the backend
// HostMismatch check remains the enforcement layer.

import type { RepoForge } from "./api";

/** The PR remote's normalized host, or null while unknown. */
export function prRemoteHost(forge: RepoForge | null): string | null {
  return forge?.host?.toLowerCase() ?? null;
}

/** Whether an account can serve this repo's PR remote (same host). */
export function accountMatchesPrRemote(
  account: { host: string },
  forge: RepoForge | null,
): boolean {
  const host = prRemoteHost(forge);
  return host === null || account.host.toLowerCase() === host;
}
