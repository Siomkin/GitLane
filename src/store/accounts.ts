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
  ForgeKind,
  type ForgeAuthStatus,
  type ForgeAuthProvider,
  type GitTransportAuthRef,
  type GithubAccountRef,
  type GithubSignInResult,
  type OauthClientStatus,
  type ProviderOauthResult,
  type RemoteInfo,
  type RepoIdentity,
} from "@/lib/api";
import { ACCOUNT_COLORS } from "@/lib/palette";
import { supportsForgeWhoami } from "@/lib/forgeHelp";
import {
  credentialScopePath,
  detectRemoteUrl,
  forgeAuthProviderFor,
  prNoun,
  transportProviderForRemoteProvider,
} from "@/lib/remotes";
import { repoIdentityKey } from "@/lib/worktrees";
import {
  accountKey,
  accountMatchesRemoteHost,
  accountRefFromApi,
  legacyDefaultSelection,
} from "./accountBindings";
import { migrateStoredRemoteUsernames } from "./accountsMigrations";
import {
  migratePathKey,
  pickProviderTokenForHost,
  providerTokenKey,
  readBindings,
  readForgeCredentials,
  readIdentities,
  readProviderTokens,
  writeBindings,
  writeIdentities,
  writeProviderTokens,
  type StoredProviderToken,
} from "./accountsStorage";
import {
  forgetForgeCredential,
  rememberForgeCredential,
  withSavedForgeCredentials,
} from "./forgeCredentials";
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
export { pickProviderTokenForHost, type StoredProviderToken } from "./accountsStorage";

/** Host + credential authority for the open repo's default **GitLab** remote, or
 * null when the repo isn't GitLab or no host can be resolved. Shared by
 * `gitlabPr()` and `prAccountRef()` so the GitLab PR-account host resolution
 * lives in one place (GL-145). */
function gitlabRemoteHosts(): { host: string; credentialHost: string } | null {
  const forge = useRepo.getState().forge;
  if (!forge || forge.kind !== ForgeKind.GitLab) return null;
  const remotes = useRepo.getState().remotes ?? [];
  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0] ?? null;
  const info = defaultRemote ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl) : null;
  const host = info?.host ?? forge.host ?? null;
  const credentialHost = info?.credentialHost ?? host;
  return host && credentialHost ? { host, credentialHost } : null;
}

/** Host + credential authority for the open repo's default **Bitbucket** remote,
 * or null when the repo isn't Bitbucket or no host can be resolved. Shared by
 * `bitbucketPr()` and `prAccountRef()` so the Bitbucket PR-account host
 * resolution lives in one place (GL-141), mirroring {@link gitlabRemoteHosts}. */
function bitbucketRemoteHosts(): { host: string; credentialHost: string } | null {
  const forge = useRepo.getState().forge;
  if (!forge || forge.kind !== ForgeKind.Bitbucket) return null;
  const remotes = useRepo.getState().remotes ?? [];
  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0] ?? null;
  const info = defaultRemote ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl) : null;
  const host = info?.host ?? forge.host ?? null;
  const credentialHost = info?.credentialHost ?? host;
  return host && credentialHost ? { host, credentialHost } : null;
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
  /** Native OAuth sign-in for a non-GitHub provider (GL-139): GitLab's device
   * flow or Bitbucket's PKCE loopback. Records the resulting keychain-token
   * account (the token itself is stored in Rust) and, when `remote` is given,
   * pins the OAuth transport username into that remote's URL so it immediately
   * authenticates via `providerToken`. Emits `provider-oauth-progress` events. */
  signInProviderOauth: (
    provider: ForgeAuthProvider,
    host: string,
    remote?: string,
  ) => Promise<ProviderOauthResult>;
  /** Cancel an in-flight [`signInProviderOauth`], discarding any codes. */
  cancelProviderOauthSignIn: () => Promise<void>;
  /** Fully undo a completed OAuth sign-in after a *late* cancel (GL-139) — one
   * that finished (token stored, remote pinned) before the cancel registered.
   * Restores `remote`'s prior URL username (`priorUsername`, snapshotted before
   * the pin via [`remoteUrlUsername`]) so the pin is reverted rather than left
   * dangling, then deletes the keychain token + metadata. Mirrors exactly what
   * [`signInProviderOauth`] changed, so a cancel leaves no trace. */
  rollbackProviderOauthSignIn: (
    provider: ForgeAuthProvider,
    result: ProviderOauthResult,
    remote: string | undefined,
    priorUsername: string | null,
  ) => Promise<void>;
  /** Whether native OAuth is configured for a provider/host (GL-139) — a client
   * id resolves. Drives whether the OAuth sign-in path is offered vs the PAT
   * fallback. Read-through to the backend; never returns the client id. */
  oauthClientStatus: (provider: ForgeAuthProvider, host: string) => Promise<OauthClientStatus>;
  /** Set (or clear, when empty) the per-host public OAuth client id (GL-139). */
  setOauthClientId: (
    provider: ForgeAuthProvider,
    host: string,
    clientId: string,
  ) => Promise<void>;
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
  /** PR-auth readiness + display label for the open repo's default **GitLab**
   * remote (GL-145): `ready` is true when glab is signed in for the host or a
   * GitLane-owned keychain token exists; `label` is the account handle to show
   * (`@login`, or `glab`), else null. `{ ready: false, label: null }` for a
   * non-GitLab repo. Shared by the toolbar provider popover (connected vs
   * needs-auth) and the remotes-settings card. Never carries token material. */
  gitlabPr: () => { ready: boolean; label: string | null };
  /** Whether Bitbucket pull requests can be fetched for the open repo — a stored
   * Bitbucket token (OAuth or API token) exists for the host — plus its display
   * label. Bitbucket has no CLI, so a token is the only path (GL-141). */
  bitbucketPr: () => { ready: boolean; label: string | null };
  /** The account ref the PR surface passes for the open repo. For a GitHub repo
   * it's the gh-derived `repoAccountRef`. For a GitLab repo (GL-140) it prefers
   * glab's zero-config transport — returning `null` so the backend uses glab —
   * else a GitLab keychain-token account (OAuth from GL-139 or a PAT from GL-132)
   * so the backend's REST client can resolve the token by its non-secret locator;
   * `null` when neither is available (the backend then reports how to sign in).
   * Never carries token material. */
  prAccountRef: () => GithubAccountRef | null;
  /** The account ref that authenticates `remote`, or null for system git
   * credentials. What write actions send to push/fetch commands (GL-129). */
  accountRefForRemote: (remote: string) => GithubAccountRef | null;
  /** Provider-neutral git transport auth for `remote`, or null for system git
   * credentials / SSH without inline helper injection. */
  transportAuthForRemote: (remote: string) => GitTransportAuthRef | null;
  /** The `gitlabGlab` transport ref for a GitLab host, or null when glab can't
   * serve it (not GitLab, glab not installed/authed, or an HTTPS credential is
   * saved for GitLab). Shared by `transportAuthForRemote` and the clone flow so
   * both wire glab identically (GL-139). */
  gitlabGlabAuth: (
    host: string,
    credentialHost: string,
    provider: GitTransportAuthRef["provider"],
  ) => GitTransportAuthRef | null;
  /** Write an HTTPS username into a remote URL for non-GitHub/system-helper
   * auth. `null` strips it back to system credentials. */
  setRemoteUsername: (remote: string, username: string | null) => Promise<void>;
  /** The HTTPS URL username currently pinned on `remote`, or null (SSH, no such
   * remote, or system credentials). Used to snapshot a remote's account before an
   * OAuth sign-in pins to it, so a cancel can restore it exactly (GL-139). */
  remoteUrlUsername: (remote: string) => string | null;
  /** Store an HTTPS token/password in Git's configured credential helper. */
  saveHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
    provider?: ForgeAuthProvider,
  ) => Promise<boolean>;
  /** Store a remote's HTTPS token/password and write its username into the URL. */
  saveRemoteCredential: (remote: string, username: string, password: string) => Promise<boolean>;
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
   * whose URL username matches. Resolves `true` when the token reached the
   * keychain, `false` on a validation/IPC failure (already toasted) — callers
   * that then switch auth to `providerToken` mode must check this so a failed
   * write doesn't leave them pointing at a token that was never stored. */
  saveProviderToken: (
    provider: ForgeAuthProvider,
    credentialHost: string,
    login: string,
    token: string,
    options?: { silent?: boolean },
  ) => Promise<boolean>;
  /** Store a keychain token **for a specific remote** and pin `login` into the
   * remote's HTTPS URL, so `transportAuthForRemote` immediately selects
   * `providerToken` — even for a bare `https://host/owner/repo.git` URL with no
   * embedded username. The git-native username is the account selector. Kept for
   * the OAuth flow and Accounts-page keychain management (the per-remote
   * credential-entry UI was removed — remotes only *select* an account). */
  saveRemoteProviderToken: (remote: string, login: string, token: string) => Promise<void>;
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
  /** Sign out of a saved-credential forge (no CLI, e.g. Bitbucket): look up the
   * saved HTTPS credential and forget it (git credential reject + drop the local
   * marker), so the connected-account card offers sign-out for CLI-less providers. */
  signOutForgeCredential: (provider: ForgeAuthProvider) => Promise<void>;
  /** Prune keychain-token metadata that no longer has a backing secret — e.g. a
   * token deleted outside GitLane (Keychain Access, `secret-tool`). Best-effort,
   * so a transient keychain error never drops a still-valid entry. Keeps the
   * "signed in" UI + `providerToken` selection honest. */
  reconcileProviderTokens: () => Promise<void>;
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
// Monotonic load generation. A background whoami started by an older
// loadForgeAuth is dropped (not merged) once a newer load supersedes it, so a
// stale identity can't land on a refreshed / signed-out provider row.
let forgeAuthGen = 0;
// Monotonic commit-identity generation. Bumped on every identity write so an
// in-flight `hydrateRepoIdentity` that predates a newer write is dropped — a
// slow reconcile read can't republish a superseded identity.
let repoIdentityGen = 0;
// Monotonic gh-account load generation (GL-169, mirroring forgeAuthGen). App
// bootstrap and the Accounts panel refresh can overlap; only the newest
// loadAccounts may publish the list, its error, or clear the loading flag, so
// an older snapshot landing late can't restore signed-out metadata and its
// late failure can't replace a newer success.
let accountsLoadGen = 0;

/** The repo a remote-auth mutation targets, captured once before the first
 * await (GL-167). All IPC uses `path` so a mid-operation repo switch can't
 * retarget the write; the app-side binding persists under `bindingKey` (the
 * modified repo's key, never the then-current repo's); refreshes and success
 * toasts check `isCurrent()` so a newly-opened repo never receives another
 * repo's side effects. Error toasts stay unconditional — a failed write must
 * surface even after a switch. */
interface RepoMutationTarget {
  path: string;
  bindingKey: string | null;
  remote: RemoteInfo | null;
  isCurrent: () => boolean;
}

function captureRepoMutationTarget(remoteName?: string): RepoMutationTarget {
  const path = useRepo.getState().summary?.path ?? "";
  const bindingKey = useAccounts.getState().repoBindingKey ?? (path || null);
  const remote = remoteName
    ? (useRepo.getState().remotes.find((r) => r.name === remoteName) ?? null)
    : null;
  return {
    path,
    bindingKey,
    remote,
    isCurrent: () => (useRepo.getState().summary?.path ?? "") === path,
  };
}

/** The remote pin the last OAuth sign-in wrote, so a late-cancel rollback
 * un-pins the SAME repo's remote even when the user switched repos during the
 * user-length browser flow (GL-167). Keyed by the signed-in account's identity
 * (provider + accountId), not just the remote name, so only a rollback of the
 * exact sign-in that wrote the pin may consume it — any other caller skips the
 * un-pin instead of stripping a repo it never touched. Module state: the OAuth
 * dialog is single-flight and rollback follows its own sign-in. */
let lastOauthRemotePin: {
  path: string;
  remote: string;
  provider: string;
  accountId: string;
} | null = null;

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

  signInProviderOauth: async (provider, host, remote) => {
    // Capture the repo the pin will target BEFORE the user-length browser flow
    // (GL-167): the user may switch repos while authorizing, and the pin must
    // land on the repo whose picker started this sign-in — never on whichever
    // repo happens to be open when the flow returns.
    const target = remote ? captureRepoMutationTarget(remote) : null;
    // A new sign-in invalidates any previous flow's pin record — only a pin
    // THIS flow writes may be rolled back by its own late cancel.
    lastOauthRemotePin = null;
    // The backend runs the flow and writes the token to the OS keychain; only
    // non-secret metadata comes back. We record *that* an account exists so the
    // transport layer can select `providerToken` and the UI can show sign-out.
    const result = await api.providerOauthSignIn(provider, host);
    const credentialHost = result.host;
    // An OAuth token authenticates git as a sentinel username, not the human
    // handle — key by (and pin) that, but display the real login.
    const entry: StoredProviderToken = {
      provider,
      credentialHost,
      accountId: result.accountId,
      login: result.login,
      transportUsername: result.transportUsername,
      savedAt: Date.now(),
    };
    const key = providerTokenKey(credentialHost, result.transportUsername);
    // OAuth metadata keys on the sentinel transport username (same for every
    // account on a host), but the keychain token keys on the account id. Signing
    // in as a *different* account on the same host would overwrite this metadata
    // and orphan the previous keychain token — invisible and unreachable by
    // reconcile. Delete the superseded token first (best-effort).
    const existing = get().providerTokens[key];
    if (existing && existing.accountId !== result.accountId) {
      try {
        await api.deleteProviderToken(existing.provider, existing.credentialHost, existing.accountId);
      } catch {
        // Transactional replacement: if the old token can't be removed, roll the
        // new sign-in back — delete the token the backend just wrote and keep the
        // previous account intact — rather than overwrite its metadata and orphan
        // the old secret (unreachable by reconcile). The old account stays usable.
        try {
          await api.deleteProviderToken(provider, credentialHost, result.accountId);
        } catch {
          /* both keychain deletes failed — leave the old account signed in */
        }
        throw new Error(
          `Couldn't replace the ${existing.credentialHost} account — its previous token is still in the keychain, so the old account is still signed in. Try again.`,
        );
      }
    }
    const next = { ...get().providerTokens, [key]: entry };
    writeProviderTokens(next);
    set({ providerTokens: next });
    if (remote && target && target.path) {
      // Pin the OAuth transport username into the remote's URL — the git-native
      // account selector — so fetch/push immediately resolve `providerToken`.
      // Written to the CAPTURED repo, and remembered so a late-cancel rollback
      // un-pins the same repo (GL-167).
      await api.setRemoteUsername(target.path, remote, result.transportUsername);
      lastOauthRemotePin = { path: target.path, remote, provider, accountId: result.accountId };
      if (target.isCurrent()) await useRepo.getState().listRemotes();
    }
    return result;
  },
  cancelProviderOauthSignIn: () => api.cancelProviderOauthSignIn(),
  rollbackProviderOauthSignIn: async (provider, result, remote, priorUsername) => {
    // Un-pin first: restore the account the remote carried before the sign-in
    // pinned this token's sentinel — not just strip it, since the remote may have
    // named a different account. Best-effort; the token removal below runs
    // regardless so a failed un-pin can't strand the keychain entry.
    if (remote) {
      // Target the repo the sign-in actually pinned (GL-167) — the user may be
      // in another repo by now. The pin must match this rollback's exact
      // sign-in (remote + provider + account); no match means that sign-in
      // never pinned (no repo was open), so there is nothing to un-pin.
      const pin = lastOauthRemotePin;
      const path =
        pin && pin.remote === remote && pin.provider === provider && pin.accountId === result.accountId
          ? pin.path
          : null;
      if (path) {
        try {
          await api.setRemoteUsername(path, remote, priorUsername);
          lastOauthRemotePin = null;
          if ((useRepo.getState().summary?.path ?? "") === path) {
            await useRepo.getState().listRemotes();
          }
        } catch {
          /* leave the URL as-is; still remove the rolled-back token */
        }
      }
    }
    // Delete the keychain token + metadata (keyed by the sentinel transport
    // username, exactly as `signInProviderOauth` wrote it).
    await get().signOutProviderToken(provider, result.host, result.transportUsername);
  },
  oauthClientStatus: (provider, host) => api.oauthClientStatus(provider, host),
  setOauthClientId: async (provider, host, clientId) => {
    await api.setOauthClientId(provider, host, clientId);
  },

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
    const gen = ++accountsLoadGen;
    set({ accountsLoading: true, accountsError: null });
    try {
      const list = await api.githubAccounts();
      if (gen !== accountsLoadGen) return; // superseded by a newer load
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
      if (gen !== accountsLoadGen) return; // a stale failure never clobbers a newer result
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
        .filter((f) => f.authenticated === true && supportsForgeWhoami(f.provider))
        .map((f) => f.provider);
      set({ forgeAuth: next, forgeAuthLoading: false, forgeAccountsLoading: pending });
      // Drop any keychain-token metadata whose secret vanished outside GitLane,
      // so a "signed in" row can't linger while transport silently fails.
      void get().reconcileProviderTokens();
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
    // Capture the target repo once, before any await (GL-167): the write, the
    // binding persist, and the refresh all track the repo whose picker started
    // this — never the repo that happens to be open afterwards.
    const ctx = captureRepoMutationTarget(remote);
    const target = ctx.remote;
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
      await api.setRemoteUsername(ctx.path, remote, account?.login ?? null);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    if (target.isDefault) {
      // Persist under the MODIFIED repo's key (captured) — it reflects what the
      // user chose for that repo even if they've since opened another (GL-167).
      if (ctx.bindingKey) {
        const bindings = readBindings();
        bindings[ctx.bindingKey] = account
          ? { version: 2, ...account.ref }
          : { version: 2, unbound: true };
        writeBindings(bindings);
      }
    }
    // Refresh/toast/PR-reload describe the open repo — skip them when the user
    // moved to another repo mid-write (GL-167).
    if (!ctx.isCurrent()) return;
    // Re-read remotes → the derivation in syncRepoAccount updates every
    // consumer (picker, PR mirror) from git config, the source of truth.
    await useRepo.getState().listRemotes();
    // Setting a remote's account drives auth ONLY — it must never touch the
    // commit identity; who the repo commits as is owned by `identities.ts`.
    const isDefault = target.isDefault;
    // The default remote also drives the PR surface — name the forge's requests
    // ("merge requests" on GitLab) so the toast reads correctly (GL-145).
    const requests = prNoun(info.provider);
    if (account) {
      useUi
        .getState()
        .showToast(
          isDefault
            ? `${remote} (and ${requests}) authenticate as @${account.username}`
            : `${remote} authenticates as @${account.username}`,
        );
    } else {
      useUi
        .getState()
        .showToast(
          isDefault
            ? `${remote} (and ${requests}) use system git credentials`
            : `${remote} uses system git credentials`,
        );
    }
    if (isDefault) void usePulls.getState().loadPullRequests();
  },

  setRemoteUsername: async (remote, username) => {
    // Pinned to the repo that started the edit (GL-167) — see setRemoteAccount.
    const ctx = captureRepoMutationTarget(remote);
    const target = ctx.remote;
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
      await api.setRemoteUsername(ctx.path, remote, clean);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    if (!ctx.isCurrent()) return;
    await useRepo.getState().listRemotes();
    useUi
      .getState()
      .showToast(clean ? `${remote} uses @${clean} via system git credentials` : `${remote} uses system git credentials`);
  },

  remoteUrlUsername: (remote) => {
    const target = useRepo.getState().remotes.find((r) => r.name === remote);
    if (!target) return null;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    return info.ssh ? null : (info.user ?? null);
  },

  saveHttpsCredential: async (credentialHost, path, username, password, provider) => {
    const cleanUser = username.trim();
    const cleanHost = credentialHost.trim();
    if (!cleanHost) {
      useUi.getState().showToast("Credential host is missing.", "error");
      return false;
    }
    if (!cleanUser) {
      useUi.getState().showToast("Enter the HTTPS username for this provider.", "error");
      return false;
    }
    if (!password) {
      useUi.getState().showToast("Enter the token or password.", "error");
      return false;
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
      return true;
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return false;
    }
  },

  saveRemoteCredential: async (remote, username, password) => {
    // Pinned to the repo that started the save (GL-167) — see setRemoteAccount.
    const ctx = captureRepoMutationTarget(remote);
    const target = ctx.remote;
    if (!target) return false;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    if (!info.valid || info.ssh || !info.credentialHost) {
      useUi
        .getState()
        .showToast(`${remote} must be an HTTPS remote to save credentials.`, "error");
      return false;
    }
    const clean = username.trim();
    if (!clean) {
      useUi.getState().showToast("Enter the HTTPS username for this remote.", "error");
      return false;
    }
    if (!password) {
      useUi.getState().showToast("Enter the token or password.", "error");
      return false;
    }
    try {
      // Azure Repos scopes credentials by org (dev.azure.com/{org}); other
      // providers keep the remote's own path scope.
      const scopePath = credentialScopePath(info) ?? info.path;
      await api.approveHttpsCredential(info.credentialHost, scopePath, clean, password);
      // The captured repo's remote, not the then-current one (GL-167).
      await api.setRemoteUsername(ctx.path, remote, clean);
      if (!ctx.isCurrent()) return true;
      await useRepo.getState().listRemotes();
      useUi
        .getState()
        .showToast(`${remote} now authenticates as @${clean} via Git credential helper`);
      return true;
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return false;
    }
  },

  hasProviderToken: (credentialHost, login) =>
    get().providerTokens[providerTokenKey(credentialHost, login)] !== undefined,

  saveProviderToken: async (provider, credentialHost, login, token, options) => {
    const host = credentialHost.trim();
    const user = login.trim();
    if (!host) {
      useUi.getState().showToast("Credential host is missing.", "error");
      return false;
    }
    if (!user) {
      useUi.getState().showToast("Enter the account username for this token.", "error");
      return false;
    }
    if (!token) {
      useUi.getState().showToast("Enter the token to store in your keychain.", "error");
      return false;
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
      // A clone drives this mid-flow (`silent`) and speaks for itself on the
      // progress/opened screen — the standalone Accounts save announces itself.
      if (!options?.silent) {
        useUi.getState().showToast(`Stored a keychain token for @${user} on ${host}`);
      }
      return true;
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return false;
    }
  },

  saveRemoteProviderToken: async (remote, login, token) => {
    // Pinned to the repo that started the save (GL-167) — see setRemoteAccount.
    const ctx = captureRepoMutationTarget(remote);
    const target = ctx.remote;
    if (!target) return;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    const provider = forgeAuthProviderFor(info.provider);
    if (!info.valid || info.ssh || !info.credentialHost || !provider) {
      useUi
        .getState()
        .showToast(`${remote} isn't a supported HTTPS remote for a keychain token.`, "error");
      return;
    }
    const user = login.trim();
    if (!user) {
      useUi.getState().showToast("Enter the account username for this token.", "error");
      return;
    }
    if (!token) {
      useUi.getState().showToast("Enter the token to store in your keychain.", "error");
      return;
    }
    const host = info.credentialHost;
    const accountId = user;
    try {
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
      // Pin the account into the remote URL — the git-native account selector —
      // so fetch/push actually resolve `providerToken` mode. Without this a
      // bare `https://host/owner/repo.git` would keep using system credentials.
      // The captured repo's remote, not the then-current one (GL-167).
      await api.setRemoteUsername(ctx.path, remote, user);
      if (!ctx.isCurrent()) return;
      await useRepo.getState().listRemotes();
      useUi.getState().showToast(`${remote} now authenticates as @${user} with a keychain token`);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  signOutProviderToken: async (provider, credentialHost, login) => {
    const host = credentialHost.trim();
    // `login` here is the entry's key component — the transport username (a
    // sentinel for OAuth accounts, the handle for PAT accounts). Resolve the
    // real keychain locator from the stored entry so an OAuth token (keyed by
    // its provider account id, not the sentinel) is deleted correctly; fall back
    // to the username for a legacy entry with no recorded id.
    const key = providerTokenKey(host, login);
    const entry = get().providerTokens[key];
    const accountId = entry?.accountId ?? login.trim();
    const shown = entry?.login ?? login.trim();
    try {
      await api.deleteProviderToken(provider, host, accountId);
      const next = { ...get().providerTokens };
      delete next[key];
      writeProviderTokens(next);
      set({ providerTokens: next });
      useUi.getState().showToast(`Signed out of @${shown} on ${host} (keychain token removed)`);
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

  signOutForgeCredential: async (provider) => {
    const saved = readForgeCredentials()[provider];
    if (!saved) {
      // No local record left — just clear any stale "signed in" marker.
      forgetForgeCredential(provider);
      set((s) => ({ forgeAuth: withSavedForgeCredentials(s.forgeAuth) }));
      return;
    }
    await get().forgetHttpsCredential(saved.credentialHost, saved.path, saved.username, provider);
  },

  reconcileProviderTokens: async () => {
    const entries = Object.entries(get().providerTokens);
    if (entries.length === 0) return;
    // Ask the backend (keychain is authoritative) which tokens still exist. A
    // check that throws is treated as "keep" — never prune on a transient error.
    const results = await Promise.all(
      entries.map(async ([key, t]) => {
        try {
          const status = await api.providerTokenStatus(t.provider, t.credentialHost, t.accountId, t.login);
          return status.hasToken ? null : ([key, t] as const);
        } catch {
          return null;
        }
      }),
    );
    const stale = results.filter((r): r is readonly [string, StoredProviderToken] => r !== null);
    if (stale.length === 0) return;
    // Compare-and-delete (GL-168): drop a key only while its entry is still the
    // exact object that was probed. Every writer builds a fresh entry object, so
    // identity pins the probe to one generation of metadata — a sign-in that
    // replaced the key mid-probe (its keychain token DOES exist) survives, and
    // the overlapping reconciles the Accounts panel triggers stay idempotent
    // (the second run's delete no-ops on the already-removed entry).
    const next = { ...get().providerTokens };
    let changed = false;
    for (const [key, probed] of stale) {
      if (next[key] !== probed) continue;
      delete next[key];
      changed = true;
    }
    if (!changed) return;
    writeProviderTokens(next);
    set({ providerTokens: next });
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

  gitlabPr: () => {
    const hosts = gitlabRemoteHosts();
    if (!hosts) return { ready: false, label: null };
    // glab (zero-config, single account per host) — label from its whoami if known.
    if (get().gitlabGlabAuth(hosts.host, hosts.credentialHost, "gitlab")) {
      const glab = get().forgeAuth.find(
        (f) => f.provider === "gitlab" && f.cli === "glab" && f.authenticated === true,
      );
      const username = glab?.account?.username;
      return { ready: true, label: username ? `@${username}` : "glab" };
    }
    // A stored OAuth/PAT token authenticates the REST client.
    const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "gitlab");
    if (token) return { ready: true, label: `@${token.login}` };
    return { ready: false, label: null };
  },

  bitbucketPr: () => {
    const hosts = bitbucketRemoteHosts();
    if (!hosts) return { ready: false, label: null };
    // Bitbucket has no first-party CLI, so readiness depends solely on a stored
    // Bitbucket token (OAuth from GL-139 or an API token) for the host (GL-141).
    const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "bitbucket");
    if (token) return { ready: true, label: `@${token.login}` };
    return { ready: false, label: null };
  },

  prAccountRef: () => {
    const forge = useRepo.getState().forge;
    // GitHub — or an unknown forge still loading — uses the gh binding, which is
    // the historical behaviour (the store's PR gate treats unknown as capable).
    if (!forge || forge.kind === ForgeKind.GitHub) return get().repoAccountRef;
    // Bitbucket (GL-141): a GitLane-owned keychain token is required (no CLI
    // fallback). Pass the token's non-secret keychain locator — the `native`
    // provider tag routes to the Bitbucket provider (dispatch is by the repo's
    // forge, not this field); the token itself never leaves Rust.
    if (forge.kind === ForgeKind.Bitbucket) {
      const hosts = bitbucketRemoteHosts();
      if (!hosts) return null;
      const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "bitbucket");
      // `login` carries the git HTTPS *username* the backend authenticates as,
      // which picks the REST auth scheme: an OAuth token's `x-token-auth` sentinel
      // → Bearer; a manually-stored API token / app password's real username →
      // Basic. The token itself never leaves Rust.
      return token
        ? {
            provider: "native",
            host: token.credentialHost,
            accountId: token.accountId,
            login: token.transportUsername ?? token.login,
          }
        : null;
    }
    // Only GitLab has a native PR provider besides GitHub/Bitbucket today.
    const hosts = gitlabRemoteHosts();
    if (!hosts) return null;
    // Prefer glab: a null ref makes the backend use glab's zero-config transport
    // (it owns its own token + host). `gitlabGlabAuth` is non-null exactly when
    // glab can serve this host, mirroring how git transport resolves for GitLab.
    if (get().gitlabGlabAuth(hosts.host, hosts.credentialHost, "gitlab")) return null;
    // Otherwise a GitLane-owned keychain token (OAuth/PAT) authenticates the
    // backend's REST client. Pass the token's non-secret keychain locator — the
    // `native` provider tag routes to the GitLab provider (dispatch is by the
    // repo's forge, not this field); the token itself never leaves Rust.
    const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "gitlab");
    if (token) {
      return {
        provider: "native",
        host: token.credentialHost,
        accountId: token.accountId,
        login: token.login,
      };
    }
    return null;
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
    if (!info.valid || info.ssh || !info.host || !info.credentialHost) return null;
    // Capture the narrowed authority so the glab closure below keeps the
    // non-null types (closures don't inherit the guard's narrowing).
    const host = info.host;
    const credentialHost = info.credentialHost;
    // Map the remote's classified provider to the transport provider tag. Azure
    // normalizes "azure" → "azure-devops"; github/gitlab/bitbucket/gitea/forgejo
    // pass through (all valid transport providers now they classify); "other"
    // stays "other".
    const provider = transportProviderForRemoteProvider(info.provider);

    const glabAuth = get().gitlabGlabAuth(host, credentialHost, provider);

    // A GitLane-owned keychain token (OAuth or PAT, GL-132/GL-139) is fed to git
    // by the backend via GIT_ASKPASS and authenticates *by host*, so it activates
    // for a bare remote URL too — no username binding needed. `transportUsername`
    // is the sentinel for OAuth (oauth2 / x-token-auth), the handle for a PAT.
    const tokenRef = (t: StoredProviderToken): GitTransportAuthRef => ({
      mode: "providerToken",
      provider: t.provider,
      host,
      credentialHost,
      username: t.transportUsername ?? t.login,
      providerAccountId: t.accountId,
    });
    const tokenForHost = pickProviderTokenForHost(get().providerTokens, credentialHost);

    // The HTTPS account mode selects the identity by the URL username; without
    // one, a keychain token or glab (both host-scoped) authenticate.
    if (!info.user) return tokenForHost ? tokenRef(tokenForHost) : glabAuth;

    const account = get().accounts.find(
      (a) => accountMatchesRemoteHost(a, info) && a.login.toLowerCase() === info.user!.toLowerCase(),
    );
    if (account) {
      return {
        mode: "githubGh",
        provider: "github",
        host,
        credentialHost,
        username: info.user,
        accountRef: account.ref,
      };
    }
    // An explicitly stored keychain token beats glab and the system helper —
    // prefer one keyed by the URL username, else any token for the host (an OAuth
    // token keyed by its sentinel username, not the human handle in the URL).
    const token = get().providerTokens[providerTokenKey(credentialHost, info.user)] ?? tokenForHost;
    if (token) return tokenRef(token);

    return (
      glabAuth ?? {
        mode: "credentialHelper",
        provider,
        host,
        credentialHost,
        username: info.user,
      }
    );
  },

  // GitLab: when glab is signed in, inject `glab auth git-credential` per
  // invocation — the same zero-config transport gh gives GitHub (GL-139). glab is
  // single-account and answers by host, so a URL username is optional. Gated on
  // glab CLI actually installed *and* authenticated (not a saved-credential
  // override), and skipped when an HTTPS credential is saved for GitLab — that
  // lives in the user's own helper, and glab's reset would shadow it.
  gitlabGlabAuth: (host, credentialHost, provider) => {
    if (provider !== "gitlab" || readForgeCredentials()["gitlab"] !== undefined) return null;
    const glab = get().forgeAuth.find(
      (f) => f.provider === "gitlab" && f.cli === "glab" && f.available === true && f.authenticated === true,
    );
    if (!glab) return null;
    return { mode: "gitlabGlab", provider: "gitlab", host, credentialHost, username: null };
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
