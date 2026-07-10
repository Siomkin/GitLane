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

// ---- v3 per-remote bindings (interim GL-129 shape, read for migration only) ----

export type RemoteBindingV3 = Extract<StoredRepoAccountEntry, { version: 3; remotes: unknown }>;
export type RemoteBindingValue = RemoteBindingV3["remotes"][string];
/** A per-remote resolution outcome: a matched account, an explicit unbound,
 * no stored value, or a stored value no loaded account matches. */
export type ResolvedStoredAccount<A extends BindableAccount> = A | "unbound" | "unset" | "unresolved";

/** Whether `account` can serve the remote described by `info` — the account's
 * host is the remote's credential authority (or the bare host when the remote
 * URL carries a `www.` prefix the account list normalizes away). */
export function accountMatchesRemoteHost(
  account: Pick<BindableAccount, "host">,
  info: { host: string | null; credentialHost: string | null },
) {
  if (!info.host || !info.credentialHost) return false;
  return account.host === info.credentialHost || (info.credentialHost.startsWith("www.") && account.host === info.host);
}

export function isV3Binding(entry: StoredRepoAccountEntry | undefined): entry is RemoteBindingV3 {
  // Check the version tag too, not just the `remotes` key: corrupt/foreign
  // localStorage shaped like `{ remotes: … }` must not enter the v3 migration
  // path (it falls through to the v2/legacy rules, which fail closed).
  return (
    typeof entry === "object" &&
    entry !== null &&
    "remotes" in entry &&
    "version" in entry &&
    entry.version === 3
  );
}

export function resolveRemoteBinding<A extends BindableAccount>(
  binding: RemoteBindingValue | undefined,
  accounts: A[],
): ResolvedStoredAccount<A> {
  if (binding === undefined) return "unset";
  if (typeof binding === "string") {
    return accounts.find((a) => accountMatchesLegacy(a, binding)) ?? "unresolved";
  }
  if ("unbound" in binding) return "unbound";
  const resolved = resolvePrAccount({ version: 2, ...binding }, accounts);
  if (resolved === "unbound") return "unbound";
  if (resolved === "unset") return "unresolved";
  return resolved as A;
}

export function prEntryFromRemoteBinding(
  binding: RemoteBindingValue | undefined,
  accounts: BindableAccount[],
): StoredRepoAccountEntry | undefined {
  const resolved = resolveRemoteBinding(binding, accounts);
  if (resolved === "unbound") return { version: 2, unbound: true };
  if (resolved === "unset" || resolved === "unresolved") return undefined;
  return { version: 2, ...resolved.ref };
}

/** The default-remote selection a legacy (pre-gitcredentials) binding encodes:
 * v3 maps resolve their default-remote entry; v2/legacy entries resolve
 * repo-wide. `"unresolved"` (unlike `resolvePrAccount`'s bare `"unset"`)
 * distinguishes "a binding exists but no loaded account matches it" so the
 * caller can wait instead of silently switching identity. */
export function legacyDefaultSelection<A extends BindableAccount>(
  entry: StoredRepoAccountEntry | undefined,
  defaultRemoteName: string | null,
  accounts: A[],
): ResolvedStoredAccount<A> {
  if (isV3Binding(entry)) {
    return defaultRemoteName ? resolveRemoteBinding(entry.remotes[defaultRemoteName], accounts) : "unset";
  }
  const resolved = resolvePrAccount(entry, accounts);
  if (resolved === "unset" && entry !== undefined) return "unresolved";
  return resolved as ResolvedStoredAccount<A>;
}

export function accountRefFromApi(a: {
  provider?: GithubAccountRef["provider"];
  host?: string;
  accountId?: string;
  login?: string;
  username: string;
}): GithubAccountRef {
  return {
    provider: a.provider ?? "gh",
    host: a.host ?? "github.com",
    accountId: a.accountId || a.login || a.username,
    login: a.login || a.username,
  };
}
