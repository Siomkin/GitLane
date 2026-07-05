// Account state (Tier 2) for the open repo, plus the current commit-identity
// *read* (`repoIdentity`). Split out of `ui.ts` (the view-chrome store) because
// it owns a distinct subsystem: the provider-aware GitHub account list and the
// **per-remote** account bindings that drive PR/push/fetch auth (GL-129) —
// each remote of a repo can authenticate as its own account, with the default
// (PR) remote's binding mirrored into `repoAccountId`/`repoAccountRef` for the
// PR feature surface. Commit identity is *owned* by `profiles.ts` (Tier 1) —
// it does the writes via git profiles; this store only holds/reconciles the
// effective `repoIdentity` read back from git config (via `pinRepoIdentity` /
// `hydrateRepoIdentity`). The repo path is resolved lazily via `useRepo` — the
// same cross-store pattern `pulls.ts` uses. Server-side token resolution is
// unchanged: commands receive account metadata, never a token.

import { create } from "zustand";

import {
  api,
  type ForgeAuthStatus,
  type GithubAccountRef,
  type GithubSignInResult,
  type RepoIdentity,
} from "../lib/api";
import { ACCOUNT_COLORS } from "../lib/palette";
import { detectRemoteUrl } from "../lib/remotes";
import { repoIdentityKey } from "../lib/worktrees";
import {
  accountKey,
  accountMatchesLegacy,
  isV3Entry,
  migrateRepoAccountEntry,
  resolveRemoteBinding,
  type StoredRepoAccountEntry,
} from "./accountBindings";
import { useRepo } from "./repo";
import { useUi } from "./ui";
import { usePulls } from "./pulls";

export type Forge = "GitHub" | "GitLab" | "Bitbucket" | "Azure DevOps" | "Gitea" | "Forgejo";

export interface Account {
  id: string;
  forge: Forge;
  provider: GithubAccountRef["provider"];
  host: string;
  accountId: string;
  login: string;
  label: string;
  username: string;
  name: string;
  email: string;
  color: string;
  ref: GithubAccountRef;
  /** True for the account the `gh` CLI currently treats as active. */
  active: boolean;
  /** False when `gh auth status` reported the account's credentials as broken
   * (revoked/expired token, or the check timed out) — shown as "needs re-auth". */
  healthy: boolean;
  /** Failure detail when `healthy` is false; empty otherwise. */
  healthError: string;
}

// `RepoIdentity` is defined alongside the IPC layer (it's the shape
// `repo_identity` returns); re-export it so account/identity consumers keep a
// single import site.
export type { RepoIdentity };

// Per-repo account bindings: { [repoKey]: RepoAccountBindingsV3 } — one
// binding per remote — drive PR/push/fetch auth (shapes + migration rules live
// in `accountBindings.ts`). Older v2 (repo-wide) and legacy string values are
// migrated once the remote list is known. The commit identity (name + email)
// is stored separately so it can be edited independently of the auth account
// (e.g. a private gh email vs. a public one).
const LS_REPO_ACCOUNTS = "gitlane.repoAccounts";
const LS_REPO_IDENTITY = "gitlane.repoIdentity";

function readJsonMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeJsonMap<T>(key: string, map: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

const readBindings = () => readJsonMap<StoredRepoAccountEntry>(LS_REPO_ACCOUNTS);
const writeBindings = (map: Record<string, StoredRepoAccountEntry>) =>
  writeJsonMap(LS_REPO_ACCOUNTS, map);
const readIdentities = () => readJsonMap<RepoIdentity>(LS_REPO_IDENTITY);
const writeIdentities = (map: Record<string, RepoIdentity>) =>
  writeJsonMap(LS_REPO_IDENTITY, map);

/** One-shot migration of a per-repo map entry from a worktree-path key to the
 * repository-identity key (GL-109): pre-identity builds stored bindings under
 * whatever worktree path was open, so a value under `path` moves to `key` (the
 * identity wins if both exist — the stale worktree shadow is dropped). Returns
 * true when the map changed and needs persisting. */
function migratePathKey<T>(map: Record<string, T>, key: string, path: string): boolean {
  if (key === path || map[path] === undefined) return false;
  if (map[key] === undefined) map[key] = map[path];
  delete map[path];
  return true;
}

function accountRefFromApi(a: {
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

/** The host a remote's pushes land on (push URL, falling back to fetch URL) —
 * what an account must match to authenticate it. `null` for unparsable URLs
 * (e.g. a local path remote), which no account matches. */
function remoteHost(remote: { fetchUrl: string; pushUrl: string }): string | null {
  return detectRemoteUrl(remote.pushUrl || remote.fetchUrl).host;
}

interface AccountsState {
  accounts: Account[];
  accountsLoading: boolean;
  accountsError: string | null;
  forgeAuth: ForgeAuthStatus[];
  forgeAuthLoading: boolean;
  forgeAuthError: string | null;
  /** Providers whose real account identity is still being resolved (whoami in
   * flight) — the connected forge card shows an identity skeleton meanwhile. */
  forgeAccountsLoading: string[];
  /** The `gh` active account — the default identity for unbound repos. */
  activeAccountId: string | null;
  /** The account bound to the open repo's **default (PR) remote** — the
   * binding the PR feature surface uses. Mirrors
   * `repoRemoteAccountIds[defaultRemote]` (GL-129). */
  repoAccountId: string | null;
  /** Resolved account id per remote name for the open repo (GL-129). `null` =
   * that remote uses system git credentials (explicitly unbound, unresolvable
   * binding, or no host-matching default). A missing key means the remote list
   * hasn't resolved yet. */
  repoRemoteAccountIds: Record<string, string | null>;
  /** The key per-repo state persists under for the open repo: its repository
   * identity (main checkout's path), so all worktrees of a repo share the
   * account binding and cached commit identity (GL-109). */
  repoBindingKey: string | null;
  /** Provider/account metadata sent to Rust for GitHub operations. */
  repoAccountRef: GithubAccountRef | null;
  /** Commit identity (name + email) pinned for the open repo, or null to defer
   * to git config. Editable, persisted per repo, stamped on every commit. */
  repoIdentity: RepoIdentity | null;

  /** Load the accounts the `gh` CLI is logged into. */
  loadAccounts: () => Promise<void>;
  /** Start the in-app `gh auth login --web` device flow for `host` (GL-106),
   * resolving with the newly added account once authorized. Emits
   * `github-signin-progress` events; the dialog subscribes to them. */
  signInGithub: (host: string) => Promise<GithubSignInResult>;
  /** Cancel an in-flight [`signInGithub`] (kills the gh child). Idempotent. */
  cancelGithubSignIn: () => Promise<void>;
  /** Load auth-only status for non-GitHub forge providers. Skips a re-probe if
   * already loaded/loading unless `force` is set (the explicit Refresh button). */
  loadForgeAuth: (force?: boolean) => Promise<void>;
  /** Resolve the bound account + commit identity for a repo path. Sets the
   * cached identity synchronously, then reconciles from git config. */
  syncRepoAccount: (path: string) => void;
  /** Optimistically publish the commit identity just written to git config (and
   * its cache), bumping the identity generation so any in-flight hydrate that
   * predates this write is dropped. Keeps `repoIdentity` correct in the window
   * before a reconcile read returns — commits in that window use the right
   * author. `null` = identity cleared (defer to global). */
  pinRepoIdentity: (identity: RepoIdentity | null, path: string) => void;
  /** Reconcile `repoIdentity` from the repo's local git config (the durable
   * source of truth), falling back to the localStorage cache. Bails if a newer
   * identity write superseded this hydrate (generation guard). */
  hydrateRepoIdentity: (path: string) => Promise<void>;
  /** Bind one of the open repo's remotes to a PR/push/fetch account (Tier 2,
   * GL-129). Persists into the repo's v3 entry and, when `remote` is the
   * default (PR) remote, refreshes the `repoAccountId`/`repoAccountRef` mirror
   * and reloads PRs. Never writes the commit identity (that's owned by git
   * profiles / `useProfiles`). `null` binds the remote to system git
   * credentials, durably. */
  setRemoteAccount: (remote: string, id: string | null) => Promise<void>;
  /** Bind the default (PR) remote — the pre-GL-129 per-repo semantics, kept
   * for the sign-in flow and identity panel. Delegates to [`setRemoteAccount`]. */
  setRepoAccount: (id: string | null) => Promise<void>;
  /** The account ref that authenticates `remote`, or null for system git
   * credentials. What write actions send to push/fetch commands (GL-129). */
  accountRefForRemote: (remote: string) => GithubAccountRef | null;
  /** Carry a relocated repo's per-path entries — the account binding and the
   * cached identity read — from its stale path to the new one (GL-108
   * Locate…). An entry already stored for the new path wins; the stale path's
   * entries are dropped either way. */
  migrateRepoBindings: (fromPath: string, toPath: string) => void;
}

// Providers GitLane can resolve a real account for. Keep in sync with the
// `account()` whoami dispatch in `src-tauri/src/auth_providers.rs` — adding a
// provider there without listing it here means its identity never resolves in
// the UI. Others (Gitea/Forgejo) would only make a no-op round-trip + skeleton flash.
const FORGE_WHOAMI = new Set(["gitlab", "azure-devops"]);
// Monotonic load generation. A background whoami started by an older
// loadForgeAuth is dropped (not merged) once a newer load supersedes it, so a
// stale identity can't land on a refreshed / signed-out provider row.
let forgeAuthGen = 0;
// Monotonic commit-identity generation. Bumped on every identity write so an
// in-flight `hydrateRepoIdentity` that predates a newer write is dropped — a
// slow reconcile read can't republish a superseded identity.
let repoIdentityGen = 0;

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  accountsLoading: false,
  accountsError: null,
  forgeAuth: [],
  forgeAuthLoading: false,
  forgeAuthError: null,
  forgeAccountsLoading: [],
  activeAccountId: null,
  repoAccountId: null,
  repoRemoteAccountIds: {},
  repoBindingKey: null,
  repoAccountRef: null,
  repoIdentity: null,

  // Thin pass-throughs to the IPC layer: the sign-in dialog is UI and must not
  // reach `api` directly (architecture-rules-react.md §1), so the boundary lives
  // here. Account-list refresh + binding on success is the dialog's own flow.
  signInGithub: (host) => api.githubSignIn(host),
  cancelGithubSignIn: () => api.cancelGithubSignIn(),

  loadAccounts: async () => {
    set({ accountsLoading: true, accountsError: null });
    try {
      const list = await api.githubAccounts();
      const accounts: Account[] = list.map((a, i) => {
        const ref = accountRefFromApi(a);
        return {
          id: accountKey(ref),
          forge: "GitHub",
          provider: ref.provider,
          host: ref.host,
          accountId: ref.accountId,
          login: ref.login,
          label: a.email || `${ref.login}@${ref.host}`,
          username: a.username || ref.login,
          name: a.name || ref.login,
          email: a.email,
          color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
          ref,
          active: a.active,
          healthy: a.healthy,
          healthError: a.healthError,
        };
      });
      const activeAccountId = accounts.find((a) => a.active)?.id ?? accounts[0]?.id ?? null;
      set({ accounts, activeAccountId, accountsLoading: false });
      const path = useRepo.getState().summary?.path;
      if (path) {
        get().syncRepoAccount(path);
        // Accounts may have arrived after the repo loaded — refetch PRs so they
        // reflect the now-resolved bound account.
        void usePulls.getState().loadPullRequests();
      }
    } catch (e) {
      set({ accountsLoading: false, accountsError: String(e) });
    }
  },

  loadForgeAuth: async (force = false) => {
    const { forgeAuthLoading, forgeAuth } = get();
    // A non-forced call defers to an in-flight load or an already-loaded list.
    // A forced refresh supersedes an in-flight probe (the generation counter
    // drops the older probe's result) so a rapid double-Refresh stays responsive.
    if (!force && forgeAuthLoading) return;
    if (!force && forgeAuth.length > 0) return;
    const gen = ++forgeAuthGen;
    set({ forgeAuthLoading: true, forgeAuthError: null });
    try {
      const next = await api.forgeAuthStatuses();
      if (gen !== forgeAuthGen) return; // superseded by a newer load
      // Show the authenticated forges immediately; their real identity resolves
      // in the background (a per-provider network whoami) so the card can render
      // now with an identity skeleton instead of blocking on the slow call. Only
      // providers with a whoami implementation are marked pending.
      const pending = next
        .filter((f) => f.authenticated === true && FORGE_WHOAMI.has(f.provider))
        .map((f) => f.provider);
      set({ forgeAuth: next, forgeAuthLoading: false, forgeAccountsLoading: pending });
      for (const provider of pending) {
        const done = () =>
          set((s) => ({ forgeAccountsLoading: s.forgeAccountsLoading.filter((p) => p !== provider) }));
        void api
          .forgeAccount(provider)
          .then((account) => {
            if (gen !== forgeAuthGen) return; // a newer refresh replaced this snapshot
            set((s) => ({
              // Only merge onto a row that is still this provider AND still
              // authenticated — a refresh may have signed it out meanwhile.
              forgeAuth: account
                ? s.forgeAuth.map((f) =>
                    f.provider === provider && f.authenticated ? { ...f, account } : f,
                  )
                : s.forgeAuth,
              forgeAccountsLoading: s.forgeAccountsLoading.filter((p) => p !== provider),
            }));
          })
          .catch(() => {
            if (gen === forgeAuthGen) done();
          });
      }
    } catch (e) {
      if (gen !== forgeAuthGen) return;
      set({ forgeAuthLoading: false, forgeAuthError: String(e), forgeAccountsLoading: [] });
    }
  },

  syncRepoAccount: (path) => {
    // Per-repo state keys on the repository identity — the main checkout's
    // path — not the open worktree's path, so binding an account in any
    // worktree of a repo applies to all of them (GL-109). The summary is the
    // published source of that identity; a defensive fallback to the raw path
    // covers a sync racing a repo switch (the next sync corrects it).
    const summary = useRepo.getState().summary;
    const key = summary && summary.path === path ? repoIdentityKey(summary) : path;
    const bindings = readBindings();
    // Resolve pre-identity entries stored under this worktree's own path.
    if (migratePathKey(bindings, key, path)) writeBindings(bindings);

    // Per-remote resolution needs the remote list; it loads as a secondary
    // read after open, so the first sync of a repo may run without it. A
    // v2/legacy entry then stays unmigrated (it needs the default remote) and
    // the mirror fields resolve repo-wide via the legacy rules below; the
    // re-sync fired when the remotes land migrates and resolves fully.
    const remotes = summary && summary.path === path ? useRepo.getState().remotes : [];
    const defaultRemoteName = remotes.find((r) => r.isDefault)?.name ?? null;
    const entry = bindings[key];
    const v3 = migrateRepoAccountEntry(entry, defaultRemoteName);

    let selected: Account | null = null;
    const remoteAccountIds: Record<string, string | null> = {};
    if (v3 !== null && remotes.length > 0) {
      // Persist when a v2/legacy entry actually migrated — never materialise
      // an empty v3 entry for a repo that had nothing stored.
      let changed = entry !== undefined && !Object.is(v3, entry);
      for (const remote of remotes) {
        const resolved = resolveRemoteBinding(
          v3,
          remote.name,
          remoteHost(remote),
          get().accounts,
          get().activeAccountId,
        );
        // A resolved legacy string re-keys to the stable account ref.
        if (resolved.rewrite) {
          v3.remotes[remote.name] = resolved.rewrite;
          changed = true;
        }
        remoteAccountIds[remote.name] = resolved.account?.id ?? null;
        if (remote.name === defaultRemoteName) {
          selected = (resolved.account as Account | null) ?? null;
        }
      }
      if (changed) {
        bindings[key] = v3;
        writeBindings(bindings);
      }
    } else {
      // Remote list not available yet (or the repo has no remotes): resolve
      // the mirror fields with the pre-GL-129 repo-wide rules so the PR chip
      // isn't blank while the remotes load. Exact id match first, then the
      // {provider, host, login} fallback (an unhealthy account's id degrades
      // to its login — GL-119); a legacy string matches loosely; no entry
      // defaults to the active gh account.
      const bound = entry;
      if (typeof bound === "string") {
        selected = get().accounts.find((a) => accountMatchesLegacy(a, bound)) ?? null;
      } else if (bound && bound.version === 2) {
        if (!("unbound" in bound)) {
          const list = get().accounts;
          selected =
            list.find((a) => a.id === accountKey(bound)) ??
            (bound.login
              ? list.find(
                  (a) =>
                    a.provider === bound.provider &&
                    a.host === bound.host &&
                    a.login === bound.login,
                )
              : undefined) ??
            null;
        }
        // else: explicit "No account" — leave unbound (no active-account fallback).
      } else if (!bound) {
        // Never configured → default to the active gh account for convenience.
        selected = get().accounts.find((a) => a.id === get().activeAccountId) ?? null;
      }
      // A v3 entry without a loaded remote list can't resolve per-remote
      // picks; leave the map empty (the remotes-land re-sync fills it). For
      // the PR mirror, presume the default remote is "origin" — the backend's
      // own push_target fallback — so the chip isn't blank in that window; a
      // non-origin default is corrected by the re-sync. The active-account
      // default is withheld (host unknown), hence the null activeAccountId.
      if (bound && isV3Entry(bound)) {
        const resolved = resolveRemoteBinding(bound, "origin", null, get().accounts, null);
        selected = (resolved.account as Account | null) ?? null;
      }
    }

    const identities = readIdentities();
    if (migratePathKey(identities, key, path)) writeIdentities(identities);
    set({
      repoAccountId: selected?.id ?? null,
      repoRemoteAccountIds: remoteAccountIds,
      repoBindingKey: key,
      repoAccountRef: selected?.ref ?? null,
      // Optimistic: show the cached identity immediately (avoids a flash),
      // then reconcile against git config — the build-independent truth.
      repoIdentity: identities[key] ?? null,
    });
    void get().hydrateRepoIdentity(path);
  },

  pinRepoIdentity: (identity, path) => {
    repoIdentityGen += 1;
    set({ repoIdentity: identity });
    // The cache keys on the repository identity, like the git config it
    // mirrors — `git config --local` is shared across worktrees (GL-109).
    const key = get().repoBindingKey ?? path;
    const identities = readIdentities();
    if (identity) identities[key] = identity;
    else delete identities[key];
    writeIdentities(identities);
  },

  hydrateRepoIdentity: async (path) => {
    const gen = repoIdentityGen;
    let identity: RepoIdentity | null;
    try {
      identity = await api.repoIdentity(path);
    } catch {
      return; // keep the optimistic localStorage value on read failure
    }
    // Drop this reconcile if a newer identity write superseded it, or the user
    // switched repos meanwhile.
    if (repoIdentityGen !== gen) return;
    if (useRepo.getState().summary?.path !== path) return;
    const key = get().repoBindingKey ?? path;
    if (identity) {
      // git config wins; refresh the cache so both agree.
      set({ repoIdentity: identity });
      const identities = readIdentities();
      identities[key] = identity;
      writeIdentities(identities);
    } else {
      // Nothing pinned in git config → defer to global config. Drop any stale
      // cache so a removed identity doesn't resurrect on the next open.
      set({ repoIdentity: null });
      const identities = readIdentities();
      if (identities[key]) {
        delete identities[key];
        writeIdentities(identities);
      }
    }
  },

  setRemoteAccount: async (remote, id) => {
    const account = get().accounts.find((a) => a.id === id) ?? null;
    const remotes = useRepo.getState().remotes;
    const defaultRemoteName = remotes.find((r) => r.isDefault)?.name ?? null;
    // With the remote list not loaded yet (sign-in auto-bind right after
    // open), "origin" is the presumed default — mirror + PR reload must still
    // run or the flow silently half-applies.
    const isDefault = defaultRemoteName ? remote === defaultRemoteName : remote === "origin";
    // Persist under the repository identity (set by syncRepoAccount on open)
    // so the binding covers every worktree of the repo (GL-109).
    const key = get().repoBindingKey ?? useRepo.getState().summary?.path ?? null;
    if (key) {
      const bindings = readBindings();
      const v3 = migrateRepoAccountEntry(bindings[key], defaultRemoteName) ?? {
        version: 3 as const,
        remotes: {},
      };
      // Persist an explicit unbound marker (not a delete) so "System git
      // credentials" is durable across reopen instead of reverting to the
      // active gh account.
      v3.remotes[remote] = account ? { ...account.ref } : { unbound: true };
      bindings[key] = v3;
      writeBindings(bindings);
    }
    set((s) => ({
      repoRemoteAccountIds: { ...s.repoRemoteAccountIds, [remote]: account?.id ?? null },
      // The default (PR) remote's binding is mirrored for the PR surface.
      ...(isDefault
        ? { repoAccountId: account?.id ?? null, repoAccountRef: account?.ref ?? null }
        : {}),
    }));
    // Binding an account drives PR / push / fetch auth ONLY — it must never
    // touch the commit identity. Who the repo commits as is owned by git
    // profiles (`useProfiles`); a PR account (Tier 2) and a git profile
    // (Tier 1) are independent, so picking an account here leaves the applied
    // profile's `user.name` / `user.email` untouched. See GL-27 / GL-63.
    if (account) {
      useUi
        .getState()
        .showToast(
          isDefault
            ? `Pull requests for this repo use @${account.username}`
            : `Pushes to ${remote} use @${account.username}`,
        );
    }
    if (isDefault) void usePulls.getState().loadPullRequests();
  },

  setRepoAccount: async (id) => {
    // The pre-GL-129 entry point: bind the default (PR) remote. "origin" is
    // the safe fallback when the remote list hasn't loaded yet (matching the
    // backend's push_target fallback).
    const remotes = useRepo.getState().remotes;
    const remote = remotes.find((r) => r.isDefault)?.name ?? "origin";
    await get().setRemoteAccount(remote, id);
  },

  accountRefForRemote: (remote) => {
    const id = get().repoRemoteAccountIds[remote];
    if (!id) return null;
    return get().accounts.find((a) => a.id === id)?.ref ?? null;
  },

  migrateRepoBindings: (fromPath, toPath) => {
    const bindings = readBindings();
    if (bindings[fromPath] !== undefined && bindings[toPath] === undefined) {
      bindings[toPath] = bindings[fromPath];
    }
    delete bindings[fromPath];
    writeBindings(bindings);
    const identities = readIdentities();
    if (identities[fromPath] !== undefined && identities[toPath] === undefined) {
      identities[toPath] = identities[fromPath];
    }
    delete identities[fromPath];
    writeIdentities(identities);
  },
}));
