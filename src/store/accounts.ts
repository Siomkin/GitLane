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
//
// The store composes one slice per subsystem out of `accounts/` (the slice
// contract is shared with `ui/` — see `store/slice.ts`): the `gh` account list
// (`ghAccounts`), the non-GitHub forge-auth probe (`forgeAuth`), secrets
// (`credentials`), native OAuth sign-in (`oauth`), and the pure "which
// credential authenticates this remote" resolution (`transportAuth`). What
// stays here is the per-repo binding itself — which account each remote is
// bound to, and the commit-identity read.

import { create } from "zustand";

import { createCredentialsSlice, type CredentialsSlice } from "./accounts/credentials";
import { createOauthSlice, type OauthSlice } from "./accounts/oauth";
import { createForgeAuthSlice, type ForgeAuthSlice } from "./accounts/forgeAuth";
import {
  createTransportAuthSlice,
  type TransportAuthSlice,
} from "./accounts/transportAuth";
import { captureRepoMutationTarget } from "./accounts/repoMutation";
import {
  createGhAccountsSlice,
  type Account,
  type Forge,
  type GhAccountsSlice,
} from "./accounts/ghAccounts";

import {
  api,
  type GithubAccountRef,
  type RepoIdentity,
} from "@/lib/api";
import {
  detectRemoteUrl,
} from "@/lib/remotes";
import { repoIdentityKey } from "@/lib/worktrees";
import {
  accountMatchesRemoteHost,
  legacyDefaultSelection,
} from "./accountBindings";
import { migrateStoredRemoteUsernames } from "./accountsMigrations";
import {
  migratePathKey,
  readBindings,
  readIdentities,
  writeBindings,
  writeIdentities,
} from "./accountsStorage";
import {
} from "./forgeCredentials";
import { useRepo } from "./repo";
import { useUi } from "./ui";
import { usePulls } from "./pulls";


// `RepoIdentity` is defined alongside the IPC layer (it's the shape
// `repo_identity` returns); re-export it so account/identity consumers keep a
// single import site.
export type { RepoIdentity };
export { pickProviderTokenForHost, type StoredProviderToken } from "./accountsStorage";

interface AccountsOwnState {
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
  /** Write an HTTPS username into a remote URL for non-GitHub/system-helper
   * auth. `null` strips it back to system credentials. */
  setRemoteUsername: (remote: string, username: string | null) => Promise<void>;
  /** The HTTPS URL username currently pinned on `remote`, or null (SSH, no such
   * remote, or system credentials). Used to snapshot a remote's account before an
   * OAuth sign-in pins to it, so a cancel can restore it exactly (GL-139). */
  remoteUrlUsername: (remote: string) => string | null;
  /** Carry a relocated repo's per-path entries — the account binding and the
   * cached identity read — from its stale path to the new one (GL-108
   * Locate…). An entry already stored for the new path wins; the stale path's
   * entries are dropped either way. */
  migrateRepoBindings: (fromPath: string, toPath: string) => void;
}

// Monotonic commit-identity generation. Bumped on every identity write so an
// in-flight `hydrateRepoIdentity` that predates a newer write is dropped — a
// slow reconcile read can't republish a superseded identity.
let repoIdentityGen = 0;


type AccountsState = AccountsOwnState & GhAccountsSlice & CredentialsSlice & OauthSlice & TransportAuthSlice & ForgeAuthSlice;

export type { Account, Forge };

export const useAccounts = create<AccountsState>((set, get) => ({
  ...createGhAccountsSlice(set, get),
  ...createCredentialsSlice(set, get),
  ...createOauthSlice(set, get),
  ...createTransportAuthSlice(get),
  ...createForgeAuthSlice(set, get),

  forgeAuth: [],
  forgeAuthLoading: false,
  forgeAuthError: null,
  forgeAccountsLoading: [],
  repoAccountId: null,
  repoRemoteAccountIds: {},
  repoBindingKey: null,
  repoAccountRef: null,
  repoIdentity: null,

  // Thin pass-throughs to the IPC layer: the sign-in dialog is UI and must not
  // reach `api` directly (architecture-rules-react.md §1), so the boundary lives
  // here. Account-list refresh + binding on success is the dialog's own flow.


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
    // Refresh/PR-reload describe the open repo — skip them when the user
    // moved to another repo mid-write (GL-167).
    if (!ctx.isCurrent()) return;
    // Re-read remotes → the derivation in syncRepoAccount updates every
    // consumer (picker, PR mirror) from git config, the source of truth.
    await useRepo.getState().listRemotes();
    // Setting a remote's account drives auth ONLY — it must never touch the
    // commit identity; who the repo commits as is owned by `identities.ts`.
    if (target.isDefault) void usePulls.getState().loadPullRequests();
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
  },

  remoteUrlUsername: (remote) => {
    const target = useRepo.getState().remotes.find((r) => r.name === remote);
    if (!target) return null;
    const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
    return info.ssh ? null : (info.user ?? null);
  },

  setRepoAccount: async (id) => {
    // The PR-API account (not a git operation): persisted app-side in the v2
    // shape. When the default remote is an https URL, also write the username
    // there so git pushes agree with the PR tab.
    const account = get().accounts.find((a) => a.id === id) ?? null;
    const remotes = useRepo.getState().remotes;
    const defaultRemote = remotes.find((r) => r.isDefault);
    if (defaultRemote && !detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl).ssh) {
      // For an HTTPS default remote, git config is the source of truth for both
      // transport and the PR account. Let setRemoteAccount perform the remote
      // mutation first and persist/publish only after it succeeds; otherwise a
      // failed URL write would leave the PR surface on a different account from
      // pushes and pulls.
      await get().setRemoteAccount(defaultRemote.name, id);
      return;
    }
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
    void usePulls.getState().loadPullRequests();
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
