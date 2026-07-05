// Pure storage model for per-remote account bindings (GL-129). One repo entry
// in `gitlane.repoAccounts` maps each remote name to the account that
// authenticates it — or to an explicit "system git credentials" marker — so a
// multi-remote repo can push GitHub `origin` as one account while a Bitbucket
// or GitLab remote keeps using the keychain/SSH untouched. No Zustand, no IPC:
// `accounts.ts` owns when to read/write; these functions own the shapes,
// migrations, and resolution rules so they stay unit-testable.

import type { GithubAccountRef } from "../lib/api";

/** What one remote's slot may hold: a bound account ref, a durable explicit
 * "no account" (system git credentials), or a legacy pre-v2 string that
 * resolves lazily once the account list is loaded. */
export type StoredRemoteBinding = GithubAccountRef | { unbound: true } | string;

/** The v3 per-repo entry: bindings keyed by remote name. A remote with no key
 * has never been configured and defaults to the active account when (and only
 * when) that account's host matches the remote's host. */
export interface RepoAccountBindingsV3 {
  version: 3;
  remotes: Record<string, StoredRemoteBinding>;
}

interface RepoAccountBindingV2 extends GithubAccountRef {
  version: 2;
}

interface RepoAccountUnboundV2 {
  version: 2;
  unbound: true;
}

/** Every shape a repo's entry may have accumulated across versions: v3,
 * v2 bound/unbound, or the original bare string. */
export type StoredRepoAccountEntry =
  | RepoAccountBindingsV3
  | RepoAccountBindingV2
  | RepoAccountUnboundV2
  | string;

/** The subset of the store's `Account` the resolution rules need — structural,
 * so the pure module doesn't import from the store (no cycle). */
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

export function isV3Entry(entry: StoredRepoAccountEntry | undefined): entry is RepoAccountBindingsV3 {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "version" in entry &&
    entry.version === 3 &&
    typeof (entry as RepoAccountBindingsV3).remotes === "object"
  );
}

/** Migrate a repo's entry to the v3 per-remote shape. The old repo-wide
 * binding (v2 ref, v2 unbound, or legacy string) becomes the **default
 * remote's** binding — it drove PR/push auth for exactly that remote before.
 *
 * Returns the entry unchanged when already v3, a fresh empty v3 for a repo
 * with no entry, and `null` when migration must wait: a v2/legacy value can't
 * be attached to a remote until the remote list (and with it the default
 * remote) is known. Callers persist only when the result differs from the
 * stored entry.
 */
export function migrateRepoAccountEntry(
  entry: StoredRepoAccountEntry | undefined,
  defaultRemote: string | null,
): RepoAccountBindingsV3 | null {
  if (entry === undefined) return { version: 3, remotes: {} };
  if (isV3Entry(entry)) return entry;
  if (defaultRemote === null) return null;
  if (typeof entry === "string") {
    return { version: 3, remotes: { [defaultRemote]: entry } };
  }
  if ("unbound" in entry) {
    return { version: 3, remotes: { [defaultRemote]: { unbound: true } } };
  }
  const { version: _version, ...ref } = entry;
  return { version: 3, remotes: { [defaultRemote]: ref } };
}

export interface RemoteBindingResolution {
  /** The resolved account, or null (explicitly unbound, unresolvable, or the
   * active-account default doesn't match the remote's host). */
  account: BindableAccount | null;
  /** When a legacy string binding resolved to an account, the ref to persist
   * in its place — so the entry re-keys to the stable account id. */
  rewrite: GithubAccountRef | null;
}

/**
 * Resolve which account authenticates `remoteName`.
 *
 * Rules, in order:
 * 1. Bound ref → exact account-id match; else the {provider, host, login}
 *    fallback (an unhealthy account's id degrades to its login while the
 *    stored binding keeps the numeric id — GL-119). The stored binding is kept
 *    as-is so it re-pins once healthy.
 * 2. Legacy string → first account it matches; report a `rewrite` to the ref.
 * 3. Explicit `{unbound: true}` → null (durable "system git credentials").
 * 4. No entry → the active account, but **only if its host matches the
 *    remote's host** — a github.com account must never silently become the
 *    default for a Bitbucket/GitLab remote.
 */
export function resolveRemoteBinding(
  entry: RepoAccountBindingsV3,
  remoteName: string,
  remoteHost: string | null,
  accounts: BindableAccount[],
  activeAccountId: string | null,
): RemoteBindingResolution {
  const binding = entry.remotes[remoteName];
  if (binding === undefined) {
    const active = accounts.find((a) => a.id === activeAccountId) ?? null;
    return {
      account: active && remoteHost !== null && active.host === remoteHost ? active : null,
      rewrite: null,
    };
  }
  if (typeof binding === "string") {
    const matched = accounts.find((a) => accountMatchesLegacy(a, binding)) ?? null;
    return { account: matched, rewrite: matched ? { ...matched.ref } : null };
  }
  if ("unbound" in binding) {
    return { account: null, rewrite: null };
  }
  const matched =
    accounts.find((a) => a.id === accountKey(binding)) ??
    (binding.login
      ? accounts.find(
          (a) =>
            a.provider === binding.provider &&
            a.host === binding.host &&
            a.login === binding.login,
        )
      : undefined) ??
    null;
  return { account: matched, rewrite: null };
}
