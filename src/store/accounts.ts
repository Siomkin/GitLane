// Account state for the open repo, plus the current commit-identity *read*
// (`repoIdentity`). Split out of `ui.ts` (the view-chrome store) because it
// owns a distinct subsystem: the provider-aware GitHub account list and the
// per-remote account resolution. Since the gitcredentials rework the
// per-remote choice is **git-native**: the account is the https remote URL's
// username (gitcredentials(7) — helpers resolve credentials by that
// username), so `repoRemoteAccountIds` is *derived* from the remote list, and
// `setRemoteAccount` writes the URL, never localStorage. Only the **PR API**
// account (not a git operation) keeps a localStorage binding, in the v2 shape
// released builds already wrote. Commit identity is owned by `identities.ts`;
// this store only holds/reconciles the effective `repoIdentity` read back from
// git config (via `pinRepoIdentity` / `hydrateRepoIdentity`). Transport auth
// refs never carry tokens; the only secret IPC path is the explicit
// "save HTTPS credential" action, which forwards the token/password once to
// `git credential approve` and never stores it in app state.

import { create } from "zustand";

import {
  api,
  type ForgeAuthStatus,
  type ForgeAuthProvider,
  type GitTransportAuthRef,
  type GithubAccountRef,
  type GithubSignInResult,
  type RemoteInfo,
  type RepoIdentity,
} from "../lib/api";
import { ACCOUNT_COLORS } from "../lib/palette";
import { detectRemoteUrl } from "../lib/remotes";
import { repoIdentityKey } from "../lib/worktrees";
import {
  accountKey,
  accountMatchesLegacy,
  resolvePrAccount,
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

// Per-repo PR-account bindings. Per-remote auth moved to git config (URL
// usernames); older v2 (repo-wide) and interim v3 (per-remote) values are
// migrated once the remote list is known. The commit identity (name + email)
// is stored separately so it can be edited independently of the auth account.
const LS_REPO_ACCOUNTS = "gitlane.repoAccounts";
const LS_REPO_IDENTITY = "gitlane.repoIdentity";
const LS_FORGE_CREDENTIALS = "gitlane.forgeCredentials";
const LS_PROVIDER_TOKENS = "gitlane.providerTokens";

type StoredForgeCredential = {
  provider: ForgeAuthProvider;
  credentialHost: string;
  path: string | null;
  username: string;
  helper: string;
  savedAt: number;
};

/** Non-secret metadata for a GitLane-owned provider token (GL-132). The token
 * itself lives only in the OS keychain; this record just remembers *that* a
 * token exists for an account so the transport layer can select `providerToken`
 * mode and the UI can show sign-out. Never contains token material. */
type StoredProviderToken = {
  provider: ForgeAuthProvider;
  /** Exact credential authority (`host[:port]`) — the keychain host locator. */
  credentialHost: string;
  /** Stable keychain account id (the login for a PAT sign-in). */
  accountId: string;
  login: string;
  savedAt: number;
};

/** Metadata map key: a stored token is looked up by the remote's credential host
 * + URL username, both lowercased so matching is case-insensitive. */
const providerTokenKey = (credentialHost: string, login: string) =>
  `${credentialHost.trim().toLowerCase()}\u0000${login.trim().toLowerCase()}`;

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
const readForgeCredentials = () => readJsonMap<StoredForgeCredential>(LS_FORGE_CREDENTIALS);
const writeForgeCredentials = (map: Record<string, StoredForgeCredential>) =>
  writeJsonMap(LS_FORGE_CREDENTIALS, map);
const readProviderTokens = () => readJsonMap<StoredProviderToken>(LS_PROVIDER_TOKENS);
const writeProviderTokens = (map: Record<string, StoredProviderToken>) =>
  writeJsonMap(LS_PROVIDER_TOKENS, map);

/** Drop the saved-credential marker for `provider` (used by "forget saved
 * HTTPS credential"), returning the pruned status list for the UI. */
function forgetForgeCredential(provider: ForgeAuthProvider) {
  const credentials = readForgeCredentials();
  if (credentials[provider]) {
    delete credentials[provider];
    writeForgeCredentials(credentials);
  }
}

function rememberForgeCredential(
  provider: ForgeAuthProvider,
  credentialHost: string,
  path: string | null,
  username: string,
  helper: string,
) {
  const credentials = readForgeCredentials();
  credentials[provider] = {
    provider,
    credentialHost,
    path,
    username,
    helper,
    savedAt: Date.now(),
  };
  writeForgeCredentials(credentials);
}

function withSavedForgeCredentials(statuses: ForgeAuthStatus[]): ForgeAuthStatus[] {
  const credentials = readForgeCredentials();
  return statuses.map((status) => {
    const saved = credentials[status.provider];
    if (!saved) return status;
    return {
      ...status,
      available: true,
      authenticated: true,
      account: { username: saved.username },
      notes: `${status.notes} Credential saved for ${saved.credentialHost}${
        saved.path ? `/${saved.path}` : ""
      } in ${saved.helper || "Git credential helper"}.`,
    };
  });
}

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
  /** Sign `account` out of `gh` (removes its credential-store entry) and
   * refresh the account list. Remotes whose URL still carries the login fall
   * back to the system credential lookup. */
  signOutGithub: (account: Account) => Promise<void>;
  /** Load auth-only status for non-GitHub forge providers. Skips a re-probe if
   * already loaded/loading unless `force` is set (the explicit Refresh button). */
  loadForgeAuth: (force?: boolean) => Promise<void>;
  /** Sign out of a non-GitHub provider CLI when GitLane knows a safe logout command. */
  signOutForge: (provider: ForgeAuthStatus["provider"]) => Promise<void>;
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
   * GL-129). Writes the HTTPS URL username in git config and, when `remote`
   * is the default (PR) remote, refreshes the `repoAccountId`/`repoAccountRef`
   * mirror and reloads PRs. Never writes the commit identity (that's owned by
   * git profiles / `useIdentities`). `null` binds the remote to system git
   * credentials, durably. */
  setRemoteAccount: (remote: string, id: string | null) => Promise<void>;
  /** Bind the default (PR) remote — the pre-GL-129 per-repo semantics, kept
   * for the sign-in flow and identity panel. Delegates to [`setRemoteAccount`]. */
  setRepoAccount: (id: string | null) => Promise<void>;
  /** The account ref that authenticates `remote`, or null for system git
   * credentials. What write actions send to push/fetch commands (GL-129). */
  accountRefForRemote: (remote: string) => GithubAccountRef | null;
  /** Provider-neutral git transport auth for `remote`, or null for system git
   * credentials / SSH without inline helper injection. */
  transportAuthForRemote: (remote: string) => GitTransportAuthRef | null;
  /** Write an HTTPS username into a remote URL for non-GitHub/system-helper
   * auth. `null` strips it back to system credentials. */
  setRemoteUsername: (remote: string, username: string | null) => Promise<void>;
  /** Store an HTTPS token/password in Git's configured credential helper. */
  saveHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
    provider?: ForgeAuthProvider,
  ) => Promise<void>;
  /** Store a remote's HTTPS token/password and write its username into the URL. */
  saveRemoteCredential: (remote: string, username: string, password: string) => Promise<void>;
  /** GitLane-owned provider tokens by `credentialHost login` key (GL-132). Backs
   * `providerToken` transport selection and the keychain sign-out UI. Non-secret
   * metadata only — the token itself lives in the OS keychain. */
  providerTokens: Record<string, StoredProviderToken>;
  /** True when a GitLane-owned keychain token is stored for `credentialHost` +
   * `login`. Drives the transport `providerToken` mode and the sign-out control. */
  hasProviderToken: (credentialHost: string, login: string) => boolean;
  /** Store a provider account's transport token in the OS keychain (GL-132) and
   * remember its non-secret metadata. The token is sent once and never returned.
   * After this, `transportAuthForRemote` selects `providerToken` for remotes
   * whose URL username matches. */
  saveProviderToken: (
    provider: ForgeAuthProvider,
    credentialHost: string,
    login: string,
    token: string,
  ) => Promise<void>;
  /** Provider **sign-out**: delete a GitLane-owned keychain token and forget its
   * metadata. Distinct from [`forgetHttpsCredential`] — this removes GitLane's
   * own secret and leaves the user's git credential-helper credentials alone. */
  signOutProviderToken: (
    provider: ForgeAuthProvider,
    credentialHost: string,
    login: string,
  ) => Promise<void>;
  /** **Forget saved HTTPS credential**: ask Git's credential helper to erase a
   * saved credential (`git credential reject`). Distinct from provider sign-out —
   * this touches only the user's helper, not a GitLane-owned keychain token. */
  forgetHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    provider?: ForgeAuthProvider,
  ) => Promise<void>;
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
const remoteAccountMigrations = new Set<string>();

type RemoteBindingV3 = Extract<StoredRepoAccountEntry, { version: 3; remotes: unknown }>;
type RemoteBindingValue = RemoteBindingV3["remotes"][string];
type ResolvedStoredAccount = Account | "unbound" | "unset" | "unresolved";

function accountMatchesRemoteHost(
  account: Pick<Account, "host">,
  info: { host: string | null; credentialHost: string | null },
) {
  if (!info.host || !info.credentialHost) return false;
  return account.host === info.credentialHost || (info.credentialHost.startsWith("www.") && account.host === info.host);
}

function isV3Binding(entry: StoredRepoAccountEntry | undefined): entry is RemoteBindingV3 {
  return typeof entry === "object" && entry !== null && "remotes" in entry;
}

function resolveRemoteBinding(
  binding: RemoteBindingValue | undefined,
  accounts: Account[],
): ResolvedStoredAccount {
  if (binding === undefined) return "unset";
  if (typeof binding === "string") {
    return accounts.find((a) => accountMatchesLegacy(a, binding)) ?? "unresolved";
  }
  if ("unbound" in binding) return "unbound";
  const resolved = resolvePrAccount({ version: 2, ...binding }, accounts);
  if (resolved === "unbound") return "unbound";
  if (resolved === "unset") return "unresolved";
  return resolved as Account;
}

function prEntryFromRemoteBinding(
  binding: RemoteBindingValue | undefined,
  accounts: Account[],
): StoredRepoAccountEntry | undefined {
  const resolved = resolveRemoteBinding(binding, accounts);
  if (resolved === "unbound") return { version: 2, unbound: true };
  if (resolved === "unset" || resolved === "unresolved") return undefined;
  return { version: 2, ...resolved.ref };
}

function legacyDefaultSelection(
  entry: StoredRepoAccountEntry | undefined,
  defaultRemoteName: string | null,
  accounts: Account[],
): ResolvedStoredAccount {
  if (isV3Binding(entry)) {
    return defaultRemoteName ? resolveRemoteBinding(entry.remotes[defaultRemoteName], accounts) : "unset";
  }
  const resolved = resolvePrAccount(entry, accounts);
  if (resolved === "unset" && entry !== undefined) return "unresolved";
  return resolved as ResolvedStoredAccount;
}

async function migrateStoredRemoteUsernames(
  repoPath: string,
  key: string,
  entry: StoredRepoAccountEntry | undefined,
  remotes: RemoteInfo[],
  accounts: Account[],
  defaultRemoteName: string | null,
) {
  if (!entry || remotes.length === 0) return;
  if (isV3Binding(entry) && accounts.length === 0) return;

  const writes: Array<{ remote: string; username: string | null }> = [];
  const addWrite = (remote: RemoteInfo, username: string | null) => {
    const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
    if (!info.valid || info.ssh) return;
    const current = info.user?.toLowerCase() ?? null;
    const next = username?.toLowerCase() ?? null;
    if (current === next) return;
    if (current !== null) return; // git config already has the new source of truth; do not overwrite it.
    writes.push({ remote: remote.name, username });
  };

  let nextEntry: StoredRepoAccountEntry | undefined = entry;
  if (isV3Binding(entry)) {
    for (const remote of remotes) {
      const resolved = resolveRemoteBinding(entry.remotes[remote.name], accounts);
      if (resolved === "unresolved") return;
      if (resolved === "unset") continue;
      addWrite(remote, resolved === "unbound" ? null : resolved.login);
    }
    nextEntry = defaultRemoteName
      ? prEntryFromRemoteBinding(entry.remotes[defaultRemoteName], accounts)
      : undefined;
  } else {
    const defaultRemote = remotes.find((r) => r.name === defaultRemoteName);
    const resolved = resolvePrAccount(entry, accounts);
    if (defaultRemote && resolved !== "unset") {
      addWrite(defaultRemote, resolved === "unbound" ? null : (resolved as Account).login);
    }
  }

  if (writes.length === 0) {
    if (isV3Binding(entry)) {
      const bindings = readBindings();
      if (nextEntry) bindings[key] = nextEntry;
      else delete bindings[key];
      writeBindings(bindings);
    }
    return;
  }

  const migrationKey = `${key}\0${writes.map((w) => `${w.remote}:${w.username ?? ""}`).join("\0")}`;
  if (remoteAccountMigrations.has(migrationKey)) return;
  remoteAccountMigrations.add(migrationKey);
  try {
    await Promise.all(writes.map((w) => api.setRemoteUsername(repoPath, w.remote, w.username)));
    if (isV3Binding(entry)) {
      const bindings = readBindings();
      if (nextEntry) bindings[key] = nextEntry;
      else delete bindings[key];
      writeBindings(bindings);
    }
    await useRepo.getState().listRemotes();
  } catch (e) {
    useUi.getState().showToast(String(e), "error");
  } finally {
    remoteAccountMigrations.delete(migrationKey);
  }
}

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
  providerTokens: readProviderTokens(),

  // Thin pass-throughs to the IPC layer: the sign-in dialog is UI and must not
  // reach `api` directly (architecture-rules-react.md §1), so the boundary lives
  // here. Account-list refresh + binding on success is the dialog's own flow.
  signInGithub: (host) => api.githubSignIn(host),
  cancelGithubSignIn: () => api.cancelGithubSignIn(),

  signOutGithub: async (account) => {
    try {
      await api.githubSignOut(account.host, account.login);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    useUi.getState().showToast(`Signed @${account.username} out of GitHub`);
    await get().loadAccounts();
  },

  signOutForge: async (provider) => {
    const status = get().forgeAuth.find((f) => f.provider === provider);
    try {
      await api.forgeSignOut(provider);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    useUi.getState().showToast(`Signed out of ${status?.forge ?? provider}`);
    await get().loadForgeAuth(true);
  },

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
        // Accounts may arrive before remotes. The repo-open flow performs a
        // quiet PR load after remotes resolve; only refetch here when the
        // remote-derived account context is already present.
        if (useRepo.getState().remotes.length > 0) void usePulls.getState().loadPullRequests();
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
      const next = withSavedForgeCredentials(await api.forgeAuthStatuses());
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
    // path — not the open worktree's path, so per-repo state applies to all
    // worktrees (GL-109). The summary is the published source of that
    // identity; a defensive fallback to the raw path covers a sync racing a
    // repo switch (the next sync corrects it).
    const summary = useRepo.getState().summary;
    const key = summary && summary.path === path ? repoIdentityKey(summary) : path;
    const bindings = readBindings();
    // Resolve pre-identity entries stored under this worktree's own path.
    if (migratePathKey(bindings, key, path)) writeBindings(bindings);

    // Per-remote accounts are DERIVED from git config (the https URL's
    // username), never stored app-side — gitcredentials(7) semantics, so the
    // same choice works in a terminal. SSH remotes and URLs without a
    // username resolve to null (system credential lookup / SSH key).
    const remotes = summary && summary.path === path ? useRepo.getState().remotes : [];
    const accounts = get().accounts;
    const remoteAccountIds: Record<string, string | null> = {};
    for (const remote of remotes) {
      const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
      const match =
        info.user !== null && info.credentialHost !== null
          ? accounts.find(
              (a) =>
                accountMatchesRemoteHost(a, info) && a.login.toLowerCase() === info.user!.toLowerCase(),
            ) ?? null
          : null;
      remoteAccountIds[remote.name] = match?.id ?? null;
    }

    // The PR/API account follows the default HTTPS remote's URL username. That
    // keeps fetch/push auth and PR auth as one provider-account choice. Legacy
    // v2/v3 bindings are used only as an upgrade bridge when the default HTTPS
    // remote has not yet been rewritten with a username.
    const defaultRemote = remotes.find((r) => r.isDefault) ?? null;
    const defaultRemoteName = defaultRemote?.name ?? null;
    const defaultInfo = defaultRemote ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl) : null;
    const derivedDefault = defaultRemoteName
      ? accounts.find((a) => a.id === remoteAccountIds[defaultRemoteName]) ?? null
      : null;
    const storedDefault = legacyDefaultSelection(bindings[key], defaultRemoteName, accounts);
    let selected: Account | null;
    if (defaultRemote && defaultInfo && !defaultInfo.ssh) {
      selected =
        derivedDefault ??
        (storedDefault !== "unset" && storedDefault !== "unbound" && storedDefault !== "unresolved"
          ? storedDefault
          : null);
    } else {
      selected =
        storedDefault === "unbound" || storedDefault === "unresolved"
          ? null
          : storedDefault === "unset"
            ? accounts.find((a) => a.id === get().activeAccountId) ?? null
            : storedDefault;
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
    void migrateStoredRemoteUsernames(path, key, bindings[key], remotes, accounts, defaultRemoteName);
    void get().hydrateRepoIdentity(path);
  },

  pinRepoIdentity: (identity, path) => {
    if (useRepo.getState().summary?.path !== path) return;
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
    const target = remotes.find((r) => r.name === remote);
    if (!target) return;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    if (info.ssh) {
      // SSH remotes select their account via the SSH key, not a username —
      // the picker disables this path; this is a race backstop.
      useUi
        .getState()
        .showToast(`${remote} is an SSH remote — its account is your SSH key`, "error");
      return;
    }
    // Git-native (gitcredentials(7)): the account IS the URL's username. The
    // credential helper resolves that user's token; the choice is visible in
    // `git remote -v` and works in a terminal too. `null` strips the username
    // (back to the default credential lookup) — durable in git config itself.
    try {
      await api.setRemoteUsername(useRepo.getState().summary?.path ?? "", remote, account?.login ?? null);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    if (target.isDefault) {
      const key = get().repoBindingKey ?? useRepo.getState().summary?.path ?? null;
      if (key) {
        const bindings = readBindings();
        bindings[key] = account ? { version: 2, ...account.ref } : { version: 2, unbound: true };
        writeBindings(bindings);
      }
    }
    // Re-read remotes → the derivation in syncRepoAccount updates every
    // consumer (picker, PR mirror) from git config, the source of truth.
    await useRepo.getState().listRemotes();
    // Setting a remote's account drives auth ONLY — it must never touch the
    // commit identity; who the repo commits as is owned by `identities.ts`.
    const isDefault = target.isDefault;
    if (account) {
      useUi
        .getState()
        .showToast(
          isDefault
            ? `${remote} (and pull requests) authenticate as @${account.username}`
            : `${remote} authenticates as @${account.username}`,
        );
    } else {
      useUi
        .getState()
        .showToast(
          isDefault
            ? `${remote} (and pull requests) use system git credentials`
            : `${remote} uses system git credentials`,
        );
    }
    if (isDefault) void usePulls.getState().loadPullRequests();
  },

  setRemoteUsername: async (remote, username) => {
    const remotes = useRepo.getState().remotes;
    const target = remotes.find((r) => r.name === remote);
    if (!target) return;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    if (info.ssh) {
      useUi
        .getState()
        .showToast(`${remote} is an SSH remote — its account is your SSH key`, "error");
      return;
    }
    const clean = username?.trim() || null;
    try {
      await api.setRemoteUsername(useRepo.getState().summary?.path ?? "", remote, clean);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    await useRepo.getState().listRemotes();
    useUi
      .getState()
      .showToast(clean ? `${remote} uses @${clean} via system git credentials` : `${remote} uses system git credentials`);
  },

  saveHttpsCredential: async (credentialHost, path, username, password, provider) => {
    const cleanUser = username.trim();
    const cleanHost = credentialHost.trim();
    if (!cleanHost) {
      useUi.getState().showToast("Credential host is missing.", "error");
      return;
    }
    if (!cleanUser) {
      useUi.getState().showToast("Enter the HTTPS username for this provider.", "error");
      return;
    }
    if (!password) {
      useUi.getState().showToast("Enter the token or password.", "error");
      return;
    }
    try {
      const result = await api.approveHttpsCredential(cleanHost, path, cleanUser, password);
      if (provider) {
        rememberForgeCredential(provider, cleanHost, path, result.username, result.helper);
        set((s) => ({
          forgeAuth: withSavedForgeCredentials(s.forgeAuth),
        }));
      }
      useUi
        .getState()
        .showToast(
          provider
            ? `Saved @${result.username} for ${cleanHost} in Git credential helper${
                result.helper ? ` (${result.helper})` : ""
              }`
            : `Saved @${result.username} in Git credential helper${result.helper ? ` (${result.helper})` : ""}`,
        );
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  saveRemoteCredential: async (remote, username, password) => {
    const remotes = useRepo.getState().remotes;
    const target = remotes.find((r) => r.name === remote);
    if (!target) return;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    if (!info.valid || info.ssh || !info.credentialHost) {
      useUi
        .getState()
        .showToast(`${remote} must be an HTTPS remote to save credentials.`, "error");
      return;
    }
    const clean = username.trim();
    if (!clean) {
      useUi.getState().showToast("Enter the HTTPS username for this remote.", "error");
      return;
    }
    if (!password) {
      useUi.getState().showToast("Enter the token or password.", "error");
      return;
    }
    try {
      await api.approveHttpsCredential(info.credentialHost, info.path, clean, password);
      await api.setRemoteUsername(useRepo.getState().summary?.path ?? "", remote, clean);
      await useRepo.getState().listRemotes();
      useUi
        .getState()
        .showToast(`${remote} now authenticates as @${clean} via Git credential helper`);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  hasProviderToken: (credentialHost, login) =>
    get().providerTokens[providerTokenKey(credentialHost, login)] !== undefined,

  saveProviderToken: async (provider, credentialHost, login, token) => {
    const host = credentialHost.trim();
    const user = login.trim();
    if (!host) {
      useUi.getState().showToast("Credential host is missing.", "error");
      return;
    }
    if (!user) {
      useUi.getState().showToast("Enter the account username for this token.", "error");
      return;
    }
    if (!token) {
      useUi.getState().showToast("Enter the token to store in your keychain.", "error");
      return;
    }
    // For a personal-access-token sign-in the login is the stable account id.
    const accountId = user;
    try {
      // The token crosses IPC exactly once, straight into the OS keychain; only
      // non-secret status comes back.
      await api.saveProviderToken(provider, host, accountId, user, token);
      const entry: StoredProviderToken = {
        provider,
        credentialHost: host,
        accountId,
        login: user,
        savedAt: Date.now(),
      };
      const next = { ...get().providerTokens, [providerTokenKey(host, user)]: entry };
      writeProviderTokens(next);
      set({ providerTokens: next });
      useUi.getState().showToast(`Stored a keychain token for @${user} on ${host}`);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  signOutProviderToken: async (provider, credentialHost, login) => {
    const host = credentialHost.trim();
    const user = login.trim();
    const accountId = user;
    try {
      await api.deleteProviderToken(provider, host, accountId);
      const next = { ...get().providerTokens };
      delete next[providerTokenKey(host, user)];
      writeProviderTokens(next);
      set({ providerTokens: next });
      useUi.getState().showToast(`Signed out of @${user} on ${host} (keychain token removed)`);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  forgetHttpsCredential: async (credentialHost, path, username, provider) => {
    const host = credentialHost.trim();
    const user = username.trim();
    if (!host) {
      useUi.getState().showToast("Credential host is missing.", "error");
      return;
    }
    if (!user) {
      useUi.getState().showToast("Enter the HTTPS username to forget.", "error");
      return;
    }
    try {
      await api.rejectHttpsCredential(host, path, user);
      if (provider) {
        forgetForgeCredential(provider);
        set((s) => ({ forgeAuth: withSavedForgeCredentials(s.forgeAuth) }));
      }
      useUi.getState().showToast(`Forgot the saved credential for @${user} on ${host}`);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  setRepoAccount: async (id) => {
    // The PR-API account (not a git operation): persisted app-side in the v2
    // shape. When the default remote is an https URL, also write the username
    // there so git pushes agree with the PR tab.
    const account = get().accounts.find((a) => a.id === id) ?? null;
    const key = get().repoBindingKey ?? useRepo.getState().summary?.path ?? null;
    if (key) {
      const bindings = readBindings();
      // An explicit unbound marker (not a delete) keeps "no account" durable.
      bindings[key] = account
        ? { version: 2, ...account.ref }
        : { version: 2, unbound: true };
      writeBindings(bindings);
    }
    set({ repoAccountId: account?.id ?? null, repoAccountRef: account?.ref ?? null });
    const remotes = useRepo.getState().remotes;
    const defaultRemote = remotes.find((r) => r.isDefault);
    if (defaultRemote && !detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl).ssh) {
      await get().setRemoteAccount(defaultRemote.name, id);
      return;
    }
    if (account) {
      useUi.getState().showToast(`Pull requests for this repo use @${account.username}`);
    }
    void usePulls.getState().loadPullRequests();
  },

  accountRefForRemote: (remote) => {
    const id = get().repoRemoteAccountIds[remote];
    if (!id) return null;
    return get().accounts.find((a) => a.id === id)?.ref ?? null;
  },

  transportAuthForRemote: (remote) => {
    const target = useRepo.getState().remotes.find((r) => r.name === remote);
    if (!target) return null;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    if (!info.valid || info.ssh || !info.host || !info.credentialHost || !info.user) return null;
    const provider =
      info.provider === "azure"
        ? "azure-devops"
        : info.provider === "github" || info.provider === "gitlab" || info.provider === "bitbucket"
          ? info.provider
          : "other";
    const account = get().accounts.find(
      (a) => accountMatchesRemoteHost(a, info) && a.login.toLowerCase() === info.user!.toLowerCase(),
    );
    if (account) {
      return {
        mode: "githubGh",
        provider: "github",
        host: info.host,
        credentialHost: info.credentialHost,
        username: info.user,
        accountRef: account.ref,
      };
    }
    // GitLane-owned keychain token for this account (GL-132): the backend feeds
    // it to git via GIT_ASKPASS. The stored provider wins over URL classification
    // (it knows a "other"-classified self-hosted host is really GitLab/Gitea).
    const token = get().providerTokens[providerTokenKey(info.credentialHost, info.user)];
    if (token) {
      return {
        mode: "providerToken",
        provider: token.provider,
        host: info.host,
        credentialHost: info.credentialHost,
        username: info.user,
        providerAccountId: token.accountId,
      };
    }
    return {
      mode: "credentialHelper",
      provider,
      host: info.host,
      credentialHost: info.credentialHost,
      username: info.user,
    };
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
