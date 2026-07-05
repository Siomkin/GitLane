// Pure helpers for the repo-level PR-account binding. Since the gitcredentials
// rework, per-REMOTE account choice lives in git itself (the https URL's
// username — see lib/remotes.ts); localStorage only keeps which account the
// **PR API** talks as (not a git operation), in the pre-GL-129 v2 shape that
// released builds already wrote. No Zustand, no IPC.

import type { GithubAccountRef } from "../lib/api";

export interface RepoAccountBindingV2 extends GithubAccountRef {
  version: 2;
}

/** Explicit "no PR account for this repo". Persisted (rather than deleting the
 * entry) so the choice is durable — on reopen it stays unbound instead of
 * silently falling back to the active `gh` account. */
export interface RepoAccountUnboundV2 {
  version: 2;
  unbound: true;
}

/** Every shape a repo's entry may hold: v2 bound/unbound, the original bare
 * string, or the GL-129-era v3 per-remote map (migrated by `syncRepoAccount`
 * into URL usernames; never written again). */
export type StoredRepoAccountEntry =
  | RepoAccountBindingV2
  | RepoAccountUnboundV2
  | { version: 3; remotes: Record<string, GithubAccountRef | { unbound: true } | string> }
  | string;

/** The subset of the store's `Account` the resolution rules need. */
export interface BindableAccount {
  id: string;
  provider: string;
  host: string;
  accountId: string;
  login: string;
  username: string;
  ref: GithubAccountRef;
}

/** Stable account key — mirrors `Account.id` construction in `accounts.ts`. */
export function accountKey(ref: GithubAccountRef): string {
  return `${ref.provider}:${ref.host}:${ref.accountId}`;
}

/** Legacy (pre-v2) bindings stored a bare username-ish string; match it against
 * everything an old build might have written. */
export function accountMatchesLegacy(account: BindableAccount, legacy: string): boolean {
  return (
    account.id === legacy ||
    account.username === legacy ||
    account.login === legacy ||
    account.accountId === legacy
  );
}

/** Resolve a stored PR-account entry against the loaded account list.
 * - v2 ref → exact id match, else the {provider, host, login} fallback (an
 *   unhealthy account's id degrades to its login — GL-119).
 * - legacy string → loose match.
 * - v2 explicit unbound → `"unbound"` (durable "no PR account").
 * - v3 map (interim GL-129 shape) → resolves as unset here; `syncRepoAccount`
 *   handles the one-shot migration into git config once remotes are known.
 * - absent / unresolvable → `"unset"` (caller decides the default). */
export function resolvePrAccount(
  entry: StoredRepoAccountEntry | undefined,
  accounts: BindableAccount[],
): BindableAccount | "unbound" | "unset" {
  if (entry === undefined) return "unset";
  if (typeof entry === "string") {
    return accounts.find((a) => accountMatchesLegacy(a, entry)) ?? "unset";
  }
  if ("remotes" in entry) return "unset";
  if ("unbound" in entry) return "unbound";
  return (
    accounts.find((a) => a.id === accountKey(entry)) ??
    (entry.login
      ? accounts.find(
          (a) => a.provider === entry.provider && a.host === entry.host && a.login === entry.login,
        )
      : undefined) ??
    "unset"
  );
}
